// 鉴权：
//  - 管理员：环境变量 admin_password（纯文本），登录后签发 HMAC 签名的会话 Cookie。
//  - 网关 key：随机生成，KV 里只存 SHA-256，明文只在创建时返回一次。

import { b64urlEncode, b64urlDecode, hmacSign, sha256Hex, randomToken, timingSafeEqual, newId } from './crypto.js';
import { loadKeys } from './config.js';

const SESSION_COOKIE = 'gw_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// 登录限速：纯内存，不占 KV 写额度。isolate 重启会清零，够挡脚本爆破。
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX = 8;

export function getAdminPassword(env) {
  return env.admin_password || env.ADMIN_PASSWORD || '';
}

function sessionSecret(env) {
  return 'gw|' + getAdminPassword(env) + '|' + (env.SESSION_SALT || 'default-salt');
}

export function checkLoginRate(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.at > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { at: now, n: 0 });
    return { ok: true, remaining: LOGIN_MAX };
  }
  if (rec.n >= LOGIN_MAX) return { ok: false, remaining: 0 };
  return { ok: true, remaining: LOGIN_MAX - rec.n };
}

export function noteLoginFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.at > LOGIN_WINDOW_MS) loginAttempts.set(ip, { at: now, n: 1 });
  else rec.n += 1;
}

export function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

export async function createSession(env) {
  const payload = { exp: Date.now() + SESSION_TTL_MS, n: randomToken(8) };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(sessionSecret(env), body);
  return body + '.' + sig;
}

export async function verifySessionToken(env, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  let expected;
  try {
    expected = await hmacSign(sessionSecret(env), body);
  } catch {
    return false;
  }
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function sessionCookieHeader(token, secure) {
  const attrs = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookieHeader(secure) {
  const attrs = [SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export async function isAdmin(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  return verifySessionToken(env, token);
}

// ---------- 网关自签发的 API key ----------

export function generateApiKey() {
  return 'sk-gw-' + randomToken(44);
}

export async function hashApiKey(key) {
  return sha256Hex('gwkey|' + key);
}

export function extractBearer(request) {
  const auth = request.headers.get('authorization') || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const xkey = request.headers.get('x-api-key') || request.headers.get('api-key');
  if (xkey) return xkey.trim();
  return '';
}

export async function verifyGatewayKey(request, env) {
  const presented = extractBearer(request);
  if (!presented) return { ok: false, reason: 'missing' };
  const keys = await loadKeys(env);
  if (!keys.length) return { ok: false, reason: 'no_keys' };
  const hash = await hashApiKey(presented);
  for (const k of keys) {
    if (k.enabled !== false && timingSafeEqual(k.hash, hash)) {
      return { ok: true, key: k };
    }
  }
  return { ok: false, reason: 'invalid' };
}

export function makeKeyRecord(name, plain, hash) {
  return {
    id: newId('key'),
    name: name || '未命名',
    hash,
    prefix: plain.slice(0, 12),
    tail: plain.slice(-4),
    createdAt: Date.now(),
    enabled: true,
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
