// 统一的响应构造工具。所有对外错误都套 OpenAI 的 error 结构，
// 这样 Claude Code / AstrBot / Cherry Studio 之类的客户端能正常解析。

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, api-key, anthropic-version, x-requested-with, OpenAI-Organization, OpenAI-Beta',
  'Access-Control-Max-Age': '86400',
};

export function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { status: init.status || 200, headers });
}

export function htmlResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // 后台是单文档（CSS/JS 全部内联），一次请求就够，不产生额外静态资源请求。
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(body, { status: init.status || 200, headers });
}

export function apiError(status, message, type = 'invalid_request_error', code = null, extra) {
  const body = { error: { message, type, param: null, code } };
  if (extra) body.error.details = extra;
  return jsonResponse(body, { status });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function readJsonBody(request, limitBytes = 8 * 1024 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limitBytes) throw new Error('请求体过大');
  const raw = await request.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown'
  );
}
