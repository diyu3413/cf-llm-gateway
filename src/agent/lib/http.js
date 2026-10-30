// 统一的响应构造工具。
// 本项目前端永远同源部署，不开 CORS —— 管理类服务没必要把响应开放给任意来源。

export function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status: init.status || 200, headers });
}

export function htmlResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // 整站是单文档（CSS/JS 全内联），一次请求就够，不产生额外静态资源请求。
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(body, { status: init.status || 200, headers });
}

export function apiError(status, message, code = null) {
  return jsonResponse({ error: { message, code } }, { status });
}

export async function readJsonBody(request, limitBytes = 12 * 1024 * 1024) {
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
