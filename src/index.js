// 入口。Worker 和 Pages Functions 用的是同一份代码。
//
// 省请求数的几个地方：
//  - 后台是单个 HTML 文档，CSS/JS 全内联 —— 打开面板只算 1 次请求，不是 3 次。
//  - favicon 直接用内联 data URI，浏览器不会再单独去要一次。
//  - /robots.txt 和 /favicon.ico 给极短响应，不落到业务逻辑。
//  - 首页伪装的回源结果走边缘缓存，重复访问基本不用醒 Worker。
//  - /v1/models 带 Cache-Control，客户端一分钟内不会反复来问。
//  - 上游调用是子请求，Cloudflare 不计入请求数，所以故障转移本身不花额度。

import { jsonResponse, htmlResponse, apiError, preflight, CORS_HEADERS } from './lib/http.js';
import { handleAdminApi } from './routes/admin.js';
import { handleOpenAI, isOpenAiPath } from './routes/openai.js';
import { handleAnthropic, isAnthropicPath } from './routes/anthropic.js';
import { renderAdminPage, renderLanding } from './ui/html.js';
import { hasKv } from './lib/config.js';
import { disguiseTarget, serveDisguise, neutralNotFound } from './lib/disguise.js';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      const message = (err && err.message) || String(err);
      if (!env || env.SILENCE_ERRORS !== '1') console.error('gateway error:', message);
      const res = apiError(500, '网关内部错误：' + message, 'server_error');
      // 管理台路径的任何响应（包括 500）都不带 CORS，理由见 withoutCors。
      try {
        if (new URL(request.url).pathname.startsWith('/admin')) return withoutCors(res);
      } catch {
        /* URL 解析不了就按普通响应给 */
      }
      return res;
    }
  },
};

// 管理台只被同源访问，不需要 CORS。以前所有响应统一套 ACAO:*，虽然 SameSite=Strict
// 的会话 Cookie 让跨站请求带不上凭证、实际读不到东西，但这个安全取决于 Cookie 属性
// 不被改动。现在管理台响应一律剥掉 CORS 头，把口子彻底关死；/v1/* 保持放开（浏览器
// 端的第三方客户端要直连）。
function withoutCors(res) {
  const headers = new Headers(res.headers);
  for (const k of Object.keys(CORS_HEADERS)) headers.delete(k);
  return new Response(res.body, { status: res.status, headers });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    // 管理台不接受跨域预检，返回体保持干净。
    if (path === '/admin' || path.startsWith('/admin/')) return new Response(null, { status: 204 });
    return preflight();
  }

  if (path === '/favicon.ico') {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=604800' } });
  }
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' },
    });
  }
  if (path === '/healthz') {
    return jsonResponse({ ok: true, kv: hasKv(env), ts: Date.now() });
  }

  if (path === '/admin/api' || path.startsWith('/admin/api/')) {
    return withoutCors(await handleAdminApi(request, env, ctx, url));
  }
  if (path === '/admin') {
    return withoutCors(htmlResponse(renderAdminPage()));
  }

  if (isAnthropicPath(path)) {
    return handleAnthropic(request, env, ctx, new URL(url.origin + path + url.search));
  }

  if (isOpenAiPath(path)) {
    return handleOpenAI(request, env, ctx, new URL(url.origin + path + url.search));
  }

  // 首页伪装：环境变量 url 指向哪个站点，根路径就显示那个站点的首页。
  // 没设默认伪装成 www.bing.com；设成 off 则显示网关自带落地页。
  const masquerade = disguiseTarget(env);

  if (path === '/') {
    if (!masquerade) return htmlResponse(renderLanding(url.origin));
    return serveDisguise(masquerade, request);
  }

  // 开了伪装就别在 404 里把网关的存在抖出去；接口路径仍然返回可读的错误。
  if (masquerade && !path.startsWith('/v1') && !path.startsWith('/admin')) {
    return neutralNotFound();
  }

  return apiError(404, '没有这个路径：' + path + '。OpenAI 接口在 /v1/chat/completions，Anthropic 接口在 /v1/messages，控制台在 /admin。', 'invalid_request_error', 'not_found');
}
