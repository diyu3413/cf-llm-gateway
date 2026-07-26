// 首页伪装。
//
// 环境变量 url 指定一个域名，访问网关根路径 / 时直接把那个站点的首页吐回去，
// 从外面看不出这是个 LLM 网关。控制台仍然在 /admin，接口仍然在 /v1/*。
//
// 几个设计取舍：
//  - 只代理根路径这一个页面，不做通用反代 —— Cloudflare 服务条款不允许把 Workers 当开放代理。
//  - 注入 <base href="目标站点/">，页面里的图片/CSS/JS 由浏览器直接去目标站点取，
//    不经过 Worker，所以伪装本身只花 1 次请求，不会拖累免费额度。
//  - 回源结果走边缘缓存（cacheTtl 30 分钟），对外再挂 10 分钟 Cache-Control，
//    重复访问大多命中缓存，连 Worker 都不用醒。
//  - 一律不透传目标站点的 Set-Cookie 和 CSP，避免把别人的 cookie 写到你的域名下。

const OFF_VALUES = new Set(['off', 'none', 'no', 'false', '0', 'self', 'local', 'landing', 'disable', 'disabled']);
const DEFAULT_TARGET = 'https://www.bing.com/';

/** 返回要伪装的目标 URL；返回 null 表示关闭伪装、显示网关自带落地页。 */
export function disguiseTarget(env) {
  const raw = String((env && (env.url || env.URL || env.DISGUISE_URL)) || '').trim();
  if (!raw) return DEFAULT_TARGET; // 没设就默认伪装成 bing
  if (OFF_VALUES.has(raw.toLowerCase())) return null;

  let s = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_TARGET;
    return u.toString();
  } catch {
    return DEFAULT_TARGET;
  }
}

export function disguiseInfo(env) {
  const target = disguiseTarget(env);
  return {
    enabled: Boolean(target),
    target: target || '',
    fromDefault: !String((env && (env.url || env.URL || env.DISGUISE_URL)) || '').trim(),
  };
}

function injectBase(html, baseHref) {
  // 先干掉页面自带的 base，免得两条 base 打架（浏览器只认第一条）
  let out = String(html).replace(/<base\b[^>]*>/gi, '');
  const tag = '<base href="' + baseHref + '">';
  const head = out.match(/<head[^>]*>/i);
  if (head) return out.replace(head[0], head[0] + tag);
  const htmlTag = out.match(/<html[^>]*>/i);
  if (htmlTag) return out.replace(htmlTag[0], htmlTag[0] + '<head>' + tag + '</head>');
  return tag + out;
}

function neutralPage(hostname) {
  // 回源失败时的兜底：一个不带任何网关痕迹的空页面。
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + String(hostname || '').replace(/[<>&"]/g, '') + '</title></head><body></body></html>'
  );
}

/** 伪装页面的 404：不暴露任何网关信息。 */
export function neutralNotFound() {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>404 Not Found</title></head>' +
      '<body><h1>404 Not Found</h1></body></html>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } }
  );
}

export async function serveDisguise(target, request) {
  const method = (request && request.method) || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  let origin = '';
  let hostname = '';
  try {
    const u = new URL(target);
    origin = u.origin;
    hostname = u.hostname;
  } catch {
    return new Response(neutralPage(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const headers = new Headers({
    'Cache-Control': 'public, max-age=600',
    'X-Robots-Tag': 'noindex, nofollow',
  });

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: {
        'User-Agent': (request && request.headers.get('user-agent')) || 'Mozilla/5.0',
        Accept: (request && request.headers.get('accept')) || 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': (request && request.headers.get('accept-language')) || 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      cf: { cacheTtl: 1800, cacheEverything: true },
    });

    const ct = upstream.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) {
      headers.set('Content-Type', ct || 'application/octet-stream');
      return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
    }

    const html = await upstream.text();
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(method === 'HEAD' ? null : injectBase(html, origin + '/'), { status: 200, headers });
  } catch {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response(method === 'HEAD' ? null : neutralPage(hostname), { status: 200, headers });
  }
}
