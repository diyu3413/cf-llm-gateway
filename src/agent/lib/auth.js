// 鉴权：管理员用环境变量 admin_password（纯文本）登录，签发 HMAC 会话 Cookie。
// 和 cf-llm-gateway 同一套思路；本项目没有网关密钥这层，会话即全部权限。

import { b64urlEncode, b64urlDecode, hmacSign, randomToken, timingSafeEqual } from './crypto.js';

const SESSION_COOKIE = 'agent_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// 登录限速：纯内存，不占任何配额。isolate 重启会清零，够挡脚本爆破。
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX = 8;

export function getAdminPassword(env) {
  return env.admin_password || env.ADMIN_PASSWORD || '';
}

function sessionSecret(env) {
  return 'agent|' + getAdminPassword(env) + '|' + (env.SESSION_SALT || 'default-salt');
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

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
