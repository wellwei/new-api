const IMAGE_MODEL = "hy-image-3.5-wb";
const VIDEO_MODEL = "minimax-h3-iOA";

const ASPECT_RATIO_TO_SIZE = {
  "1:1": "1024x1024",
  "3:4": "768x1024",
  "4:3": "1024x768",
  "9:16": "720x1280",
  "16:9": "1280x720",
};

const VALID_IMAGE_SIZES = ["1024x1024", "768x1024", "1024x768", "720x1280", "1280x720"];
const VALID_VIDEO_RESOLUTIONS = ["768P", "2K"];
const VALID_VIDEO_RATIOS = ["16:9", "9:16", "1:1"];

export const meta = {
  apiVersion: 1,
  key: "workbuddy",
  name: "Tencent WorkBuddy",
  icon: "Tencent.Color",
  description: {
    en: "Tencent WorkBuddy cloud image (Hunyuan Image 3.5) and video (MiniMax H3) generation",
    zh: "腾讯 WorkBuddy 云端图像生成/编辑（混元 Image 3.5）与视频生成（MiniMax H3）",
  },
  version: "1.0.0",
  author: { name: "wellwei" },
  models: [IMAGE_MODEL, VIDEO_MODEL],
  fetchMode: "per_task",
  upstreams: ["vendor", "new_api"],
  usageSchema: {
    image_count: {
      type: "number",
      unit: "count",
      description: { en: "Generated image count", zh: "生成图片张数" },
    },
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Generated video duration in seconds", zh: "生成视频时长（秒）" },
    },
    resolution: {
      enum: ["768P", "2K"],
      enumLabels: {
        "768P": { en: "768P", zh: "768P" },
        "2K": { en: "2K", zh: "2K" },
      },
      description: { en: "Output video resolution", zh: "输出视频清晰度" },
    },
  },
  protocols: [
    { name: "openai_responses", supports: ["stream", "sync", "background"] },
    { name: "openai_image", models: [IMAGE_MODEL] },
    { name: "openai_video", models: [VIDEO_MODEL] },
  ],
  workbench: {
    schemaVersion: 1,
    capabilities: [
      {
        id: "workbuddy:" + IMAGE_MODEL,
        model: IMAGE_MODEL,
        mediaType: "image",
        operations: ["generate", "edit"],
        deferSchema: true,
        referenceLimits: { maxImages: 4 },
        parameterSchema: {
          type: "object",
          required: ["prompt"],
          additionalProperties: false,
          properties: {
            prompt: {
              type: "string",
              title: "画面与视觉描述 (Prompt)",
              minLength: 1,
              maxLength: 2000,
              "x-append": "保持主体清晰、构图完整、光影自然统一",
            },
            size: {
              type: "string",
              title: "画幅尺寸 (Size)",
              enum: VALID_IMAGE_SIZES,
              default: "1024x1024",
            },
            quality: {
              type: "string",
              title: "画质档位 (Quality)",
              enum: ["standard", "hd"],
              default: "standard",
            },
            image: {
              type: "array",
              title: "参考图 / 待编辑原图 URL（可选，填则走改图链路）",
              maxItems: 4,
              items: { type: "string" },
            },
          },
        },
        presets: [
          {
            id: "wb-kv-square",
            name: "品牌主视觉方图 (1024x1024)",
            role: "主视觉",
            parameters: { size: "1024x1024", quality: "hd" },
          },
          {
            id: "wb-poster-portrait",
            name: "竖版海报视觉 (768x1024)",
            role: "主视觉海报",
            parameters: { size: "768x1024", quality: "hd" },
          },
          {
            id: "wb-banner-landscape",
            name: "横版专题横幅 (1280x720)",
            role: "专题横幅",
            parameters: { size: "1280x720", quality: "hd" },
          },
        ],
        delivery: { canvas: "gallery" },
      },
      {
        id: "workbuddy:" + VIDEO_MODEL,
        model: VIDEO_MODEL,
        mediaType: "video",
        operations: ["generate"],
        deferSchema: true,
        referenceLimits: { maxImages: 3 },
        parameterSchema: {
          type: "object",
          required: ["prompt"],
          additionalProperties: false,
          properties: {
            prompt: {
              type: "string",
              title: "镜头与运动描述 (Prompt)",
              minLength: 1,
              maxLength: 2000,
              "x-append": "镜头运动平滑稳定，主体动作自然连贯",
            },
            aspect_ratio: {
              type: "string",
              title: "画面比例 (Aspect Ratio)",
              enum: VALID_VIDEO_RATIOS,
              default: "16:9",
            },
            resolution: {
              type: "string",
              title: "清晰度 (Resolution)",
              enum: VALID_VIDEO_RESOLUTIONS,
              default: "768P",
            },
            duration: {
              type: "integer",
              title: "时长（秒）",
              enum: [5, 6, 10],
              default: 5,
            },
            first_frame_image: {
              type: "string",
              title: "首帧锚定图 URL（可选）",
            },
            last_frame_image: {
              type: "string",
              title: "尾帧锚定图 URL（可选）",
            },
            reference_images: {
              type: "array",
              title: "主体参考图 URL（可选，最多 3 张）",
              maxItems: 3,
              items: { type: "string" },
            },
          },
        },
        presets: [
          {
            id: "wb-video-landscape",
            name: "横屏叙事主镜头 (16:9 · 768P · 5s)",
            role: "横屏主镜头",
            parameters: { aspect_ratio: "16:9", resolution: "768P", duration: 5 },
          },
          {
            id: "wb-video-vertical",
            name: "竖屏短视频镜头 (9:16 · 768P · 5s)",
            role: "竖屏短视频",
            parameters: { aspect_ratio: "9:16", resolution: "768P", duration: 5 },
          },
          {
            id: "wb-video-2k",
            name: "超清高画质主镜头 (16:9 · 2K · 5s)",
            role: "超清主镜头",
            parameters: { aspect_ratio: "16:9", resolution: "2K", duration: 5 },
          },
        ],
        delivery: { canvas: "player" },
      },
    ],
  },
};

function trimmed(value) {
  return String(value || "").trim();
}

function modelKey(ctx) {
  const raw = trimmed((ctx && (ctx.upstreamModel || ctx.model)) || "");
  return raw.replace(/^cn:/i, "");
}

function isImageModel(ctx) {
  const m = modelKey(ctx);
  if (m === IMAGE_MODEL) return true;
  const action = trimmed(ctx && ctx.action);
  return action === "text_to_image" || action === "image_to_image";
}

function toMioraImageObject(item) {
  if (!item) return null;
  if (typeof item === "object" && !Array.isArray(item)) {
    if (trimmed(item.url)) return { url: trimmed(item.url) };
    if (trimmed(item.base64)) return { base64: trimmed(item.base64) };
    return null;
  }
  const s = trimmed(item);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return { url: s };
  return { base64: s };
}

function collectImageInputs(req) {
  const out = [];
  const rawList = [];
  if (Array.isArray(req.images)) rawList.push.apply(rawList, req.images);
  if (Array.isArray(req.image)) rawList.push.apply(rawList, req.image);
  else if (req.image !== undefined && req.image !== null && trimmed(req.image) !== "") rawList.push(req.image);
  for (const item of rawList) {
    const obj = toMioraImageObject(item);
    if (obj) out.push(obj);
  }
  return out;
}

function resolveImageSize(req) {
  const s = trimmed(req.size);
  if (VALID_IMAGE_SIZES.includes(s)) return s;
  const ratio = trimmed(req.aspect_ratio);
  if (ASPECT_RATIO_TO_SIZE[ratio]) return ASPECT_RATIO_TO_SIZE[ratio];
  return "1024x1024";
}

function resolveVideoResolution(req) {
  const r = trimmed(req.resolution).toUpperCase();
  if (r === "2K" || r === "1080P" || r === "4K") return "2K";
  return "768P";
}

function resolveVideoAspectRatio(req) {
  const ratio = trimmed(req.aspect_ratio || req.ratio);
  if (VALID_VIDEO_RATIOS.includes(ratio)) return ratio;
  const size = trimmed(req.size);
  if (size === "720x1280" || size === "1024x1792") return "9:16";
  if (size === "1024x1024") return "1:1";
  return "16:9";
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  const prompt = trimmed(req.prompt);
  if (!prompt) throw new Error("field prompt is required");

  const headers = {
    Authorization: "Bearer " + ctx.apiKey,
    "Content-Type": "application/json",
  };

  if (isImageModel(ctx)) {
    const images = collectImageInputs(req);
    const size = resolveImageSize(req);
    const quality = trimmed(req.quality) === "hd" ? "hd" : "standard";
    if (images.length > 0) {
      return {
        url: ctx.baseUrl + "/api/ai/workbuddy-proxy/image/edit/submit",
        method: "POST",
        headers: headers,
        body: {
          prompt: prompt,
          images: images,
          size: size,
        },
      };
    }
    return {
      url: ctx.baseUrl + "/api/ai/workbuddy-proxy/image/generate/submit",
      method: "POST",
      headers: headers,
      body: {
        prompt: prompt,
        size: size,
        quality: quality,
      },
    };
  }

  const durationRaw = Number(req.duration || req.seconds || 5);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : 5;
  const body = {
    prompt: prompt,
    duration: duration,
    resolution: resolveVideoResolution(req),
    aspect_ratio: resolveVideoAspectRatio(req),
  };

  const firstFrame = toMioraImageObject(req.first_frame_image || req.input_reference || req.image);
  const lastFrame = toMioraImageObject(req.last_frame_image);
  const refList = [];
  if (Array.isArray(req.reference_images)) {
    for (const item of req.reference_images) {
      const obj = toMioraImageObject(item);
      if (obj) refList.push(obj);
    }
  }
  if (firstFrame) {
    body.input = { first_frame_image: firstFrame };
    if (lastFrame) body.input.last_frame_image = lastFrame;
  } else if (refList.length > 0) {
    body.input = { reference_images: refList.slice(0, 3) };
  }

  return {
    url: ctx.baseUrl + "/api/ai/workbuddy-proxy/video/submit",
    method: "POST",
    headers: headers,
    body: body,
  };
}

function extractResultFiles(raw) {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw.resultFiles)) return raw.resultFiles;
  const data = raw.data;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.resultFiles)) return data.resultFiles;
  for (const key of Object.keys(data)) {
    const entry = data[key];
    if (entry && typeof entry === "object" && Array.isArray(entry.resultFiles)) {
      return entry.resultFiles;
    }
  }
  return [];
}

export function parseSubmitResponse(ctx, resp) {
  const body = (resp && resp.body) || {};
  if (body.failed || (body.code !== undefined && body.code !== 0)) {
    throw new Error(trimmed(body.message || body.msg) || "workbuddy miora submit failed");
  }
  const data = body.data || {};
  const taskId = trimmed(data.upstreamTaskId) || trimmed(ctx && ctx.publicTaskId);
  if (!taskId) throw new Error("upstreamTaskId is empty");

  const status = trimmed(data.status).toLowerCase();
  if (data.mode === "sync" || status === "completed" || status === "succeeded") {
    const files = extractResultFiles(body);
    const firstUrl = files.length > 0 && files[0] ? trimmed(files[0].signedUrl) : "";
    if (!firstUrl) throw new Error("synchronous response has no signedUrl in resultFiles");
    return {
      taskId: taskId,
      taskData: body,
      immediate: {
        status: "SUCCESS",
        progress: "100%",
        url: firstUrl,
      },
    };
  }
  return {
    taskId: taskId,
    taskData: body,
  };
}

export function extractUsage(ctx) {
  const req = (ctx && ctx.requestBody) || {};
  if (isImageModel(ctx)) {
    return { image_count: 1 };
  }
  const durationRaw = Number(req.duration || req.seconds || 5);
  const seconds = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : 5;
  return { seconds: seconds, resolution: resolveVideoResolution(req) };
}

export function extractUsageOnComplete(task, _taskResult, body) {
  if (isImageModel(task)) {
    const files = extractResultFiles(body || {});
    return { image_count: files.length > 0 ? files.length : 1 };
  }
  return {};
}

export function buildQueryRequest(ctx) {
  const taskId = trimmed(ctx && ctx.taskId);
  const path =
    isImageModel(ctx) || taskId.startsWith("wb-")
      ? "/api/ai/workbuddy-proxy/image/query-task"
      : "/api/ai/workbuddy-proxy/video/query-task";
  return {
    url: ctx.baseUrl + path,
    method: "POST",
    headers: {
      Authorization: "Bearer " + ctx.apiKey,
      "Content-Type": "application/json",
    },
    body: {
      upstreamTaskIds: [taskId],
    },
  };
}

export function parseTaskResult(ctx, body) {
  if (!body || typeof body !== "object") {
    return { status: "UNKNOWN", reason: "empty poll response" };
  }
  if (body.failed || (body.code !== undefined && body.code !== 0)) {
    return {
      status: "FAILURE",
      reason: trimmed(body.message || body.msg) || "upstream query failed",
    };
  }
  const data = body.data || {};
  const taskId = trimmed(ctx && ctx.taskId);
  let entry = data[taskId];
  if (!entry) {
    const keys = Object.keys(data);
    if (keys.length > 0 && typeof data[keys[0]] === "object") {
      entry = data[keys[0]];
    } else if (data.status) {
      entry = data;
    }
  }
  if (!entry || typeof entry !== "object") {
    return { status: "IN_PROGRESS" };
  }
  const rawStatus = trimmed(entry.status).toLowerCase();
  if (rawStatus === "pending" || rawStatus === "queued" || rawStatus === "submitted") {
    return { status: "QUEUED" };
  }
  if (rawStatus === "processing" || rawStatus === "running" || rawStatus === "in_progress") {
    return { status: "IN_PROGRESS" };
  }
  if (rawStatus === "completed" || rawStatus === "succeeded" || rawStatus === "success") {
    const files = Array.isArray(entry.resultFiles) ? entry.resultFiles : extractResultFiles(body);
    const firstUrl = files.length > 0 && files[0] ? trimmed(files[0].signedUrl) : "";
    if (!firstUrl) {
      return { status: "FAILURE", reason: "task completed without resultFiles" };
    }
    return { status: "SUCCESS", url: firstUrl };
  }
  if (rawStatus === "failed" || rawStatus === "error" || rawStatus === "canceled" || rawStatus === "cancelled") {
    return {
      status: "FAILURE",
      reason: trimmed(entry.errorMessage || body.message) || "task failed",
    };
  }
  return { status: "IN_PROGRESS" };
}

function artifactData(ctx) {
  const data = (ctx && ctx.data) || {};
  if (data.data && typeof data.data === "object" && data.data.task_id && Object.prototype.hasOwnProperty.call(data.data, "data")) {
    return data.data.data || {};
  }
  return data;
}

export function listArtifacts(task) {
  if (!task || task.status !== "SUCCESS") return [];
  const files = extractResultFiles(artifactData(task)).filter(function (f) {
    return f && trimmed(f.signedUrl);
  });
  if (files.length === 0) return [];
  const firstMime = trimmed(files[0].mimeType).toLowerCase();
  if (firstMime.startsWith("video/") || (!firstMime.startsWith("image/") && !isImageModel(task))) {
    return [{ key: "video", type: "video" }];
  }
  return files.map(function (_, idx) {
    return { key: "image-" + (idx + 1), type: "image" };
  });
}

export function buildContentRequest(ctx) {
  const files = extractResultFiles(artifactData(ctx)).filter(function (f) {
    return f && trimmed(f.signedUrl);
  });
  let url = "";
  if (ctx.artifactKey === "video") {
    url = files[0] ? trimmed(files[0].signedUrl) : "";
  } else if (String(ctx.artifactKey || "").startsWith("image-")) {
    const index = Number(String(ctx.artifactKey).slice("image-".length)) - 1;
    if (index >= 0 && index < files.length) {
      url = trimmed(files[index].signedUrl);
    }
  }
  if (!url) throw new Error("artifact_not_found");
  return {
    url: url,
    method: (ctx.clientRequest && ctx.clientRequest.method) || "GET",
    credentialless: true,
  };
}

function responsesOutputHtml(ctx, task) {
  const artifacts = (ctx && ctx.artifacts) || {};
  let url = "";
  if (artifacts.video && trimmed(artifacts.video.url)) {
    url = trimmed(artifacts.video.url);
  } else if (artifacts["image-1"] && trimmed(artifacts["image-1"].url)) {
    url = trimmed(artifacts["image-1"].url);
  } else {
    const files = extractResultFiles(artifactData(task)).filter(function (f) {
      return f && trimmed(f.signedUrl);
    });
    url = files[0] ? trimmed(files[0].signedUrl) : "";
  }
  if (!url) return "";
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (isImageModel(ctx) || (artifacts["image-1"] && !artifacts.video)) {
    return "![image](" + escaped + ")";
  }
  return '<video controls src="' + escaped + '"></video>';
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const model = trimmed(ctx.model || req.model);
      if (!model) throw new Error("model is required");
      const prompt = typeof req.input === "string" ? trimmed(req.input) : trimmed(req.prompt);
      if (!prompt) throw new Error("input or prompt is required");
      const requestBody = Object.assign({}, req, { model: model, prompt: prompt });
      const action = model.replace(/^cn:/i, "") === IMAGE_MODEL ? "text_to_image" : "text_to_video";
      return { kind: "submit", model: model, action: action, requestBody: requestBody };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const state = { status: status, progress: null };
      if (status === "SUCCESS") {
        const text = responsesOutputHtml(ctx, task);
        const events = previousState && previousState.status === status ? [] : text ? [{ type: "output", data: text }] : [];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE") {
        return { events: [{ type: "error", code: "task_failed", message: task.fail_reason || "task failed" }], state: state, done: true };
      }
      return { events: [{ type: "progress", message: status.toLowerCase() }], state: state, done: false };
    },
    renderFinal: function (ctx, task) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: responsesOutputHtml(ctx, task), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "workbuddy" },
      };
    },
  },
  openai_image: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const prompt = trimmed(req.prompt);
      if (!prompt) throw new Error("prompt is required");
      const images = collectImageInputs(req);
      if (ctx.operation === "edit" && images.length === 0) {
        throw new Error("image is required for edit operation");
      }
      const requestBody = Object.assign({}, req, {
        model: trimmed(ctx.model || req.model || IMAGE_MODEL),
        prompt: prompt,
      });
      return {
        kind: "submit",
        model: requestBody.model,
        action: images.length > 0 ? "image_to_image" : "text_to_image",
        requestBody: requestBody,
      };
    },
    render: function (ctx, task) {
      const files = extractResultFiles(artifactData(task));
      const data = [];
      for (const file of files) {
        if (file && trimmed(file.signedUrl)) {
          data.push({ url: trimmed(file.signedUrl) });
        }
      }
      return { created: task.created_at, data: data, metadata: artifactData(task) };
    },
  },
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const prompt = trimmed(req.prompt);
      if (!prompt) throw new Error("prompt is required");
      const requestBody = Object.assign({}, req, {
        model: trimmed(ctx.model || req.model || VIDEO_MODEL),
        prompt: prompt,
      });
      const hasImage = Boolean(
        trimmed(req.first_frame_image) ||
          trimmed(req.input_reference) ||
          trimmed(req.image) ||
          (Array.isArray(req.reference_images) && req.reference_images.length > 0)
      );
      return {
        kind: "submit",
        model: requestBody.model,
        action: hasImage ? "image_to_video" : "text_to_video",
        requestBody: requestBody,
      };
    },
    render: function (ctx, task) {
      const statuses = {
        NOT_START: "queued",
        SUBMITTED: "queued",
        QUEUED: "queued",
        IN_PROGRESS: "in_progress",
        SUCCESS: "completed",
        FAILURE: "failed",
      };
      const output = {
        id: task.task_id,
        object: "video",
        model: (task.properties || {}).origin_model_name || VIDEO_MODEL,
        status: statuses[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: Number(task.created_at || 0),
      };
      const completedAt = Number(task.finished_at || task.updated_at || 0);
      if (completedAt > 0) output.completed_at = completedAt;
      if (task.status === "FAILURE") {
        output.error = { code: "video_generation_failed", message: task.fail_reason || "The video generation task failed." };
      }
      return output;
    },
  },
};
