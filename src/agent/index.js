// 入口路由。前端是单 HTML 文档（CSS/JS 内联），静态部分只有 / 这一个请求；
// 其余全是 /api/* 的 JSON 接口和 /ws 的 WebSocket 升级。
//
// 存储分工（对免费额度友好）：
//  - R2 (WORKSPACE)：文件正文
//  - D1 (DB)：settings、会话列表、文件索引 + FTS5 —— 全是行数很小的元数据
//  - DO (SESSIONS)：每会话一个实例，消息历史存它自带 SQLite，不占 D1 额度

import { jsonResponse, htmlResponse, apiError, readJsonBody, clientIp } from './lib/http.js';
import { timingSafeEqual } from './lib/crypto.js';
import {
  getAdminPassword,
  isAdmin,
  createSession,
  verifySessionToken,
  checkLoginRate,
  noteLoginFailure,
  clearLoginFailures,
  sessionCookieHeader,
  clearCookieHeader,
} from './lib/auth.js';
import { getSettings, saveSettings, redactSettings, isMaskedKey, DEFAULT_AGENT_SETTINGS } from './lib/settings.js';
import { agentFeatures } from './lib/features.js';
import { wsList, wsRead, wsWrite, wsDelete, wsSearch } from './lib/workspace.js';
import { normalizeWorkspacePath } from './lib/textutil.js';
import { renderAppPage } from './ui/html.js';
import { AgentSession } from './do/session.js';

export { AgentSession };

// 独立部署入口。合并部署（cf-llm-gateway 的 src/agent/）会用 handleAgent 并传 basePath '/agent'。
export default {
  fetch: (request, env, ctx) => handleAgent(request, env, ctx),
};

export async function handleAgent(request, env, ctx, opts = {}) {
  try {
    return await route(request, env, ctx, opts);
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (!env || env.SILENCE_ERRORS !== '1') console.error('agent error:', message);
    return apiError(500, '服务内部错误：' + message);
  }
}

async function route(request, env, ctx, opts = {}) {
  const basePath = String(opts.basePath || '').replace(/\/+$/, '');
  const url = new URL(request.url);
  let path = url.pathname;
  if (basePath) {
    // 挂在子路径下（如合并版的 /agent）：剥掉前缀，后续逻辑与独立部署完全一致
    if (path === basePath) path = '/';
    else if (path.startsWith(basePath + '/')) path = path.slice(basePath.length);
    else return apiError(404, '没有这个路径：' + url.pathname);
  }
  path = path.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204 });

  if (path === '/healthz') return jsonResponse({ ok: true, ts: Date.now() });
  if (path === '/' && method === 'GET') {
    return htmlResponse(renderAppPage({ basePath, embedded: Boolean(opts.embedded) }));
  }

  // ---- 登录/登出（唯一不需要会话的接口）----
  if (path === '/api/login' && method === 'POST') {
    const password = getAdminPassword(env);
    if (!password) return apiError(500, '还没有设置管理员密码。请用 wrangler secret put admin_password 配置。', 'no_admin_password');
    const ip = clientIp(request);
    const rate = checkLoginRate(ip);
    if (!rate.ok) return apiError(429, '尝试次数过多，请等 10 分钟再试。');
    let body = {};
    try {
      body = await readJsonBody(request);
    } catch {
      body = {};
    }
    if (!timingSafeEqual(String(body.password || ''), password)) {
      noteLoginFailure(ip);
      return apiError(401, '密码不对。');
    }
    clearLoginFailures(ip);
    const token = await createSession(env);
    const secure = url.protocol === 'https:';
    return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(token, secure) } });
  }
  if (path === '/api/logout' && method === 'POST') {
    const secure = url.protocol === 'https:';
    return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': clearCookieHeader(secure) } });
  }
  if (path === '/api/session' && method === 'GET') {
    return jsonResponse({ authed: await isAdmin(request, env), hasPassword: Boolean(getAdminPassword(env)) });
  }

  // ---- WebSocket 升级：校验会话后转交 DO ----
  if (path === '/ws' && method === 'GET') {
    const sessionId = url.searchParams.get('session') || '';
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return apiError(400, '会话 id 不合法。');
    // 浏览器连 WS 会自动带 Cookie；非浏览器客户端（脚本、测试）可以改用 ?t=<会话令牌>。
    // 注意令牌进 URL 可能留存在访问日志里，个人自用可接受，浏览器端请继续用 Cookie。
    const token = url.searchParams.get('t') || '';
    const authed = token ? await verifySessionToken(env, token) : await isAdmin(request, env);
    if (!authed) return apiError(401, '未登录或会话已过期。');
    // 整个 Request 原样转交（Upgrade 头跟着走），只把路径改成 DO 内部的 /stream
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    return stub.fetch(new Request('https://do/stream', request));
  }

  // ---- 以下全部要登录 ----
  if (!(await isAdmin(request, env))) return apiError(401, '未登录或会话已过期。');

  if (path === '/api/state' && method === 'GET') {
    const settings = await getSettings(env.DB);
    let sessions = [];
    try {
      const { results } = await env.DB.prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all();
      sessions = results || [];
    } catch {
      sessions = [];
    }
    // features 由装配点决定：独立版返回非内嵌；合并版返回网关模型链的别名列表
    const features = await agentFeatures(env);
    return jsonResponse({
      ok: true,
      embedded: features.embedded,
      models: features.models,
      defaultModel: features.defaultModel,
      settings: redactSettings(settings),
      defaults: DEFAULT_AGENT_SETTINGS,
      sessions,
    });
  }

  if (path === '/api/settings' && method === 'POST') {
    const body = await readJsonBody(request);
    const patch = body.settings || {};
    // 掩码回传 = 没改，别把掩码存进去
    if (isMaskedKey(patch.gatewayKey)) delete patch.gatewayKey;
    if (isMaskedKey(patch.webSearchKey)) delete patch.webSearchKey;
    const saved = await saveSettings(env.DB, patch);
    return jsonResponse({ ok: true, settings: redactSettings(saved) });
  }

  // ---- 会话 ----
  if (path === '/api/sessions' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all();
    return jsonResponse({ ok: true, sessions: results || [] });
  }
  if (path === '/api/sessions' && method === 'POST') {
    const body = await readJsonBody(request).catch(() => ({}));
    const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)').bind(
      id,
      String(body.title || '').slice(0, 60),
      now
    ).run();
    return jsonResponse({ ok: true, id });
  }

  let m = /^\/api\/sessions\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/.exec(path);
  if (m) {
    const sessionId = m[1];
    const sub = m[2] || '';
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));

    if (method === 'DELETE' && !sub) {
      await stub.fetch(new Request('https://do/delete', { method: 'POST' })).catch(() => {});
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(sessionId).run();
      return jsonResponse({ ok: true });
    }
    if (method === 'GET' && sub === '/messages') {
      const res = await stub.fetch('https://do/history');
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    if (method === 'GET' && sub === '/tasks') {
      const res = await stub.fetch('https://do/tasks');
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    if (method === 'GET' && sub === '/usage') {
      const res = await stub.fetch('https://do/usage');
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    if (method === 'POST' && sub === '/message') {
      // REST 兜底通道：WebSocket 不可用（或测试脚本）时也能对话
      const res = await stub.fetch('https://do/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await readJsonBody(request)),
      });
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    if (method === 'POST' && sub === '/reset') {
      const res = await stub.fetch('https://do/reset', { method: 'POST' });
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }

  // ---- 文件 ----
  if (path === '/api/files' && method === 'GET') {
    const result = await wsList(env.WORKSPACE, url.searchParams.get('prefix') || '', url.searchParams.get('cursor') || '');
    return jsonResponse(result);
  }
  if (path === '/api/file' && method === 'GET') {
    const result = await wsRead(env.WORKSPACE, url.searchParams.get('path') || '', Number(url.searchParams.get('offset') || 0), 524_288);
    return jsonResponse(result);
  }
  if (path === '/api/file' && method === 'PUT') {
    const body = await readJsonBody(request);
    const result = await wsWrite(env.WORKSPACE, env.DB, body.path, body.content, 2_000_000);
    return jsonResponse(result, { status: result.ok ? 200 : 400 });
  }
  if (path === '/api/file' && method === 'DELETE') {
    const result = await wsDelete(env.WORKSPACE, env.DB, url.searchParams.get('path') || '');
    return jsonResponse(result, { status: result.ok ? 200 : 400 });
  }
  if (path === '/api/upload' && method === 'POST') {
    // 文本文件直传：路径走查询参数，正文是原始请求体
    const p = normalizeWorkspacePath(url.searchParams.get('path') || '');
    const text = await request.text();
    if (text.length > 2_000_000) return apiError(400, '单文件上限 200 万字符。');
    const result = await wsWrite(env.WORKSPACE, env.DB, p, text, 2_000_000);
    return jsonResponse(result, { status: result.ok ? 200 : 400 });
  }
  if (path === '/api/search' && method === 'GET') {
    const result = await wsSearch(env.DB, url.searchParams.get('q') || '');
    return jsonResponse(result);
  }
  if (path === '/api/download' && method === 'GET') {
    // R2 绑定直接流式回传：零拷贝、不走内存、不需要预签名凭证；同源 Cookie 鉴权天然生效
    let p;
    try {
      p = normalizeWorkspacePath(url.searchParams.get('path') || '');
    } catch (err) {
      return apiError(400, err.message);
    }
    const obj = await env.WORKSPACE.get(p);
    if (!obj) return apiError(404, '文件不存在：' + p);
    const name = p.split('/').pop() || p;
    const headers = new Headers();
    if (obj.writeHttpMetadata) obj.writeHttpMetadata(headers);
    headers.set('Content-Type', 'application/octet-stream'); // 一律按附件下载，浏览器不预览
    // RFC 5987：中文文件名用 filename*；ASCII 兜底名给不认 filename* 的老客户端
    headers.set(
      'Content-Disposition',
      "attachment; filename*=UTF-8''" + encodeURIComponent(name) + "; filename=\"" + name.replace(/[^\x20-\x7e]/g, '_') + '"'
    );
    headers.set('Cache-Control', 'no-store');
    return new Response(obj.body, { headers });
  }

  return apiError(404, '没有这个路径：' + path);
}
