package middleware

import (
	"bufio"
	"bytes"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
)

// ResponseModelProjection reports the model the caller asked for in place of the
// model that actually served the request.
//
// A relayed response echoes whatever model name upstream declared: a routing
// alias, a provider path, or a variant it picked on its own. That is operator
// detail — it names internal routing and invites callers to depend on which
// pool answered — so callers below the operator roles are told the model they
// requested. Admins and root keep the upstream name for diagnostics.
//
// The projection happens once, at the response boundary, because every relay
// path writes through c.Writer: chat completions, Messages and Responses,
// streaming and not, whatever converter ran. Nothing above this layer needs to
// know about it, and the request the upstream receives is untouched.
func ResponseModelProjection() gin.HandlerFunc {
	return projectResponseModel
}

// projectResponseModel is the handler itself, named so a test can assert which
// route chains carry it: some surfaces (the plugin-protocol routes) are
// registered outside the middleware groups that install it.
func projectResponseModel(c *gin.Context) {
	if common.GetContextKeyInt(c, constant.ContextKeyUserRole) >= common.RoleAdminUser {
		c.Next()
		return
	}
	projected := newProjectingWriter(c.Writer, func() string {
		return c.GetString(string(constant.ContextKeyOriginalModel))
	})
	c.Writer = projected
	c.Next()
	projected.finish()
}

// modelMember is the JSON member whose value is projected. Every protocol this
// gateway serves spells it "model": chat completions, Responses, Messages.
const modelMember = `"model"`

// bufferedBodyLimit caps how much of a non-stream body is held to recompute its
// length. Past it the response drops to chunked framing rather than growing an
// unbounded copy of something like a base64 image payload.
const bufferedBodyLimit = 8 << 20

// writerMode is decided from the response's content type (or, when absent, from
// its first bytes) on the first write.
type writerMode int

const (
	modeUndecided writerMode = iota
	// modeBuffer holds the body so the rewrite can be measured: these responses
	// declare a Content-Length, which the rewrite would invalidate.
	modeBuffer
	// modeStream rewrites as bytes arrive. Event streams are chunked and have
	// no declared length to go stale.
	modeStream
	// modePassthrough leaves the body byte-for-byte alone: non-JSON payloads
	// (audio, images) carry no model member and must not be scanned.
	modePassthrough
)

// projectingWriter rewrites model names on their way to a non-operator caller.
// It feeds every byte through the rewriter and routes the result, holding the
// body only long enough to restate a length-accurate Content-Length.
type projectingWriter struct {
	gin.ResponseWriter

	// requested reports the model the caller asked for. It is resolved on the
	// first write, once channel selection has recorded it.
	requested func() string

	mode     writerMode
	status   int
	headSent bool
	hijacked bool
	rewriter modelNameRewriter
	buffered bytes.Buffer
}

func newProjectingWriter(inner gin.ResponseWriter, requested func() string) *projectingWriter {
	return &projectingWriter{ResponseWriter: inner, requested: requested}
}

func (w *projectingWriter) WriteHeader(code int) {
	// Held until the body's shape is known, so a rewritten length can replace
	// the declared one before the head leaves.
	if w.status == 0 {
		w.status = code
	}
}

func (w *projectingWriter) WriteHeaderNow() {}

func (w *projectingWriter) Write(p []byte) (int, error) {
	if w.hijacked {
		return w.ResponseWriter.Write(p)
	}
	w.ensureMode(p)
	if w.mode == modePassthrough {
		w.sendHead()
		return w.ResponseWriter.Write(p)
	}
	w.rewriter.Write(p, w.emit)
	return len(p), nil
}

func (w *projectingWriter) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

func (w *projectingWriter) Flush() {
	// While the body is held, a flush would release a prefix of a rewrite that
	// has not been measured yet; the head is released with the complete body.
	if w.mode == modeBuffer {
		return
	}
	w.sendHead()
	w.ResponseWriter.Flush()
}

func (w *projectingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.hijacked = true
	return w.ResponseWriter.Hijack()
}

func (w *projectingWriter) Status() int {
	if w.status != 0 {
		return w.status
	}
	return w.ResponseWriter.Status()
}

func (w *projectingWriter) Size() int {
	if w.mode == modeBuffer {
		return w.buffered.Len()
	}
	return w.ResponseWriter.Size()
}

func (w *projectingWriter) Written() bool {
	return w.buffered.Len() > 0 || w.status != 0 || w.ResponseWriter.Written()
}

// ensureMode decides how this response is treated, once per request.
func (w *projectingWriter) ensureMode(first []byte) {
	if w.mode != modeUndecided {
		return
	}
	switch contentType := strings.ToLower(w.Header().Get("Content-Type")); {
	case strings.Contains(contentType, "event-stream"):
		w.mode = modeStream
	case strings.Contains(contentType, "json"):
		w.mode = modeBuffer
	case contentType != "":
		// A declared non-JSON type is never rewritten: no model member lives
		// there, and its framing must not be disturbed.
		w.mode = modePassthrough
	default:
		w.mode = sniffMode(first)
	}
	if w.mode != modeBuffer && w.mode != modeStream {
		return
	}
	model := w.requested()
	if model == "" {
		// No channel selection recorded a requested model, so there is nothing
		// to project onto: leave the response untouched.
		w.mode = modePassthrough
		return
	}
	w.rewriter = newModelNameRewriter(model)
}

// sniffMode infers the body shape when no content type was set.
func sniffMode(first []byte) writerMode {
	trimmed := bytes.TrimLeft(first, " \t\r\n")
	if len(trimmed) == 0 {
		return modePassthrough
	}
	if trimmed[0] == '{' || trimmed[0] == '[' {
		return modeBuffer
	}
	if bytes.HasPrefix(trimmed, []byte("data:")) {
		return modeStream
	}
	return modePassthrough
}

// sendHead releases the response headers. A streamed rewrite has no computable
// length, so a declared one is dropped and the framework chunks instead; a
// buffered body arrives here with its length already restated by finish.
func (w *projectingWriter) sendHead() {
	if w.headSent || w.hijacked {
		return
	}
	w.headSent = true
	if w.mode == modeStream {
		w.Header().Del("Content-Length")
	}
	status := w.status
	if status == 0 {
		status = http.StatusOK
	}
	w.ResponseWriter.WriteHeader(status)
}

// emit routes rewritten bytes: into the buffer while the body is held, straight
// to the client once it is not.
func (w *projectingWriter) emit(p []byte) {
	if len(p) == 0 {
		return
	}
	if w.mode != modeBuffer {
		w.sendHead()
		if _, err := w.ResponseWriter.Write(p); err != nil {
			common.SysError("failed to write projected response: " + err.Error())
		}
		return
	}
	w.buffered.Write(p)
	if w.buffered.Len() <= bufferedBodyLimit {
		return
	}
	// Past the cap, stop holding the body: release what is buffered and switch
	// to chunked framing for the rest.
	w.mode = modeStream
	w.sendHead()
	if _, err := w.ResponseWriter.Write(w.buffered.Bytes()); err != nil {
		common.SysError("failed to write projected response: " + err.Error())
	}
	w.buffered.Reset()
}

// finish releases the held body with a corrected length, and any bytes the
// rewriter still withholds because they might have completed a match.
func (w *projectingWriter) finish() {
	if w.hijacked {
		return
	}
	if w.mode == modeUndecided {
		// No body was written; let any recorded status through as it stands.
		if w.status != 0 {
			w.sendHead()
		}
		return
	}
	w.rewriter.Flush(w.emit)
	if w.mode != modeBuffer {
		if w.status != 0 {
			w.sendHead()
		}
		w.ResponseWriter.Flush()
		return
	}
	body := w.buffered.Bytes()
	if len(body) > 0 {
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	}
	w.sendHead()
	if len(body) > 0 {
		if _, err := w.ResponseWriter.Write(body); err != nil {
			common.SysError("failed to write projected response body: " + err.Error())
		}
	}
	w.ResponseWriter.Flush()
}

// modelNameRewriter replaces the value of every "model" member it sees with one
// model name. It is incremental: the member, its colon, or its value may arrive
// split across writes. Bytes that cannot begin or continue a match are released
// immediately, so the only withheld bytes are a live partial match, which Flush
// releases verbatim when the body ends and no match can complete.
type modelNameRewriter struct {
	replacement []byte // a JSON string literal, quotes and escaping included
	state       int
	matched     []byte
}

const (
	stateScanning = iota
	stateBeforeColon
	stateBeforeValue
	stateInValue
	stateAfterEscape
)

func newModelNameRewriter(model string) modelNameRewriter {
	quoted, err := common.Marshal(model)
	if err != nil {
		quoted = []byte(`""`)
	}
	return modelNameRewriter{replacement: quoted}
}

func (r *modelNameRewriter) Write(p []byte, emit func([]byte)) {
	for _, b := range p {
		r.step(b, emit)
	}
}

// Flush releases a partial match verbatim and resets, so a rewriter can be
// reused for a body that continues the scan.
func (r *modelNameRewriter) Flush(emit func([]byte)) {
	if len(r.matched) > 0 {
		emit(r.matched)
		r.matched = nil
	}
	r.state = stateScanning
}

func (r *modelNameRewriter) step(b byte, emit func([]byte)) {
	switch r.state {
	case stateScanning:
		if b == modelMember[len(r.matched)] {
			r.matched = append(r.matched, b)
			if len(r.matched) == len(modelMember) {
				r.state = stateBeforeColon
			}
			return
		}
		// Only a leading quote can begin a match, so a mismatch inside `"` plus
		// its first letter continues rather than ends it.
		matched := r.matched
		r.matched = nil
		if len(matched) == 1 && b == modelMember[1] {
			r.matched = append(r.matched, modelMember[0], b)
			return
		}
		emit(matched)
		r.restart(b, emit)

	case stateBeforeColon, stateBeforeValue:
		switch {
		case b == ' ' || b == '\t' || b == '\n' || b == '\r':
			r.matched = append(r.matched, b)
		case r.state == stateBeforeColon && b == ':':
			r.matched = append(r.matched, b)
			r.state = stateBeforeValue
		case r.state == stateBeforeValue && b == '"':
			// Key and separator are re-emitted in canonical form; the original
			// spacing between them does not survive the rewrite.
			emit(append([]byte(modelMember+":"), r.replacement...))
			r.matched = nil
			r.state = stateInValue
		default:
			// Not a model member after all: release the matched bytes verbatim
			// and rescan this byte on its own.
			emit(r.matched)
			r.matched = nil
			r.state = stateScanning
			r.restart(b, emit)
		}

	case stateInValue, stateAfterEscape:
		if r.state == stateAfterEscape {
			r.state = stateInValue
			return
		}
		switch b {
		case '\\':
			r.state = stateAfterEscape
		case '"':
			// End of the projected value: the original name is dropped.
			r.state = stateScanning
		}
	}
}

// restart begins a fresh match with b after a failed one.
func (r *modelNameRewriter) restart(b byte, emit func([]byte)) {
	if b == modelMember[0] {
		r.matched = append(r.matched, b)
		return
	}
	emit([]byte{b})
}

// ProjectModelNames replaces every "model" member's value in a complete JSON
// payload. WebSocket frames arrive whole, so they need no incremental state.
func ProjectModelNames(payload []byte, model string) []byte {
	if model == "" || len(payload) == 0 {
		return payload
	}
	rewriter := newModelNameRewriter(model)
	var out bytes.Buffer
	out.Grow(len(payload))
	rewriter.Write(payload, func(p []byte) { out.Write(p) })
	rewriter.Flush(func(p []byte) { out.Write(p) })
	return out.Bytes()
}
