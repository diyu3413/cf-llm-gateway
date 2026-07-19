import { getApiKeys, touchApiKeyUsage } from "./kv.js";
import { sha256Hex, getBearerToken } from "./utils.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

// ---- 管理员会话：使用 HMAC 签名的无状态 token，不需要写 KV，节省请求额度 ----

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createAdminSession(env) {
  const secret = env.admin_password || "";
  const expireAt = Date.now() + SESSION_TTL_MS;
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expireAt)));
  const sig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${expireAt}.${sig}`;
}

export async function verifyAdminSession(env, token) {
  if (!token || !token.includes(".")) return false;
  const [expireAtStr, sig] = token.split(".");
  const expireAt = Number(expireAtStr);
  if (!expireAt || Date.now() > expireAt) return false;
  const secret = env.admin_password || "";
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expireAt)));
  const expectedSig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(sig, expectedSig);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function getSessionCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function requireAdmin(request, env) {
  // 支持 Cookie 会话（webui 用）或直接 Authorization: Bearer <admin_password>（脚本/curl 用）
  const bearer = getBearerToken(request);
  if (bearer && bearer === env.admin_password) return true;
  const token = getSessionCookie(request);
  return verifyAdminSession(env, token);
}

// ---- 对外 API Key 校验（存储的是 sha256 哈希，明文只在创建时展示一次） ----

function getApiKeyFromRequest(request) {
  // OpenAI 风格客户端使用 Authorization: Bearer <key>
  const bearer = getBearerToken(request);
  if (bearer) return bearer;
  // Anthropic 风格客户端（含 Claude Code）使用 x-api-key: <key>
  const xApiKey = request.headers.get("x-api-key");
  return xApiKey ? xApiKey.trim() : null;
}

export async function verifyApiKey(request, env) {
  const token = getApiKeyFromRequest(request);
  if (!token) return { ok: false, reason: "missing_authorization" };
  const hash = await sha256Hex(token);
  const keys = await getApiKeys(env);
  const found = keys.find((k) => k.hash === hash && !k.revoked);
  if (!found) return { ok: false, reason: "invalid_api_key" };
  // 使用节流写入，避免每次请求都消耗一次 KV 写额度
  await touchApiKeyUsage(env, hash);
  return { ok: true, key: found };
}
