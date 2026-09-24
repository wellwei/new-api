package helper

import (
	"errors"
	"net/http"
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/stretchr/testify/require"
)

// Typed-nil *NewAPIError passed through an error interface must be a no-op,
// not a nil dereference (2026-09-24 data handler goroutine panic).
func TestStreamResultIgnoresTypedNilAPIError(t *testing.T) {
	status := relaycommon.NewStreamStatus()
	sr := newStreamResult(status)

	require.NotPanics(t, func() {
		sr.Error((*types.NewAPIError)(nil))
		sr.Stop((*types.NewAPIError)(nil))
	})

	require.Equal(t, 0, status.TotalErrorCount())
	require.Nil(t, status.EndError)
	require.True(t, sr.IsStopped())
}

func TestStreamResultRecordsRealAPIError(t *testing.T) {
	status := relaycommon.NewStreamStatus()
	sr := newStreamResult(status)

	sr.Stop(types.NewOpenAIError(errors.New("boom"), types.ErrorCodeBadResponse, http.StatusInternalServerError))

	require.Equal(t, 1, status.TotalErrorCount())
	require.Equal(t, "boom", status.Errors[0].Message)
	require.Equal(t, relaycommon.StreamEndReasonHandlerStop, status.EndReason)
	require.True(t, status.ResponseFailed())
}
