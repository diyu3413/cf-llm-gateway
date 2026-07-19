// 通用工具函数集合

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function errorResponse(message, status = 400, code = "invalid_request_error") {
  return json(
    {
      error: {
        message,
        type: code,
        code: status,
      },
    },
    status
  );
}

export function uuid() {
  return crypto.randomUUID();
}

// 生成形如 sk-cfg-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 的 API Key
export async function generateApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `sk-cfg-${hex}`;
  const hash = await sha256Hex(key);
  return { key, hash, prefix: key.slice(0, 12) };
}

export async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function slugify(name) {
  return (
    (name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "provider"
  );
}

export function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// 简单的带超时的 fetch 封装，避免单个上游模型卡死拖垮整体调用链
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

export function guessCapabilities(modelId = "") {
  const id = modelId.toLowerCase();
  const vision = /(vision|4o|gpt-4o|gemini|vl|-v\b|image)/.test(id);
  const audio = /(audio|realtime|whisper|voice)/.test(id);
  const video = /(video|sora)/.test(id);
  const tools = !/(embedding|whisper|tts|moderation)/.test(id);
  return { text: true, vision, audio, video, tools };
}
