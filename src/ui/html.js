// 整个后台就是一个 HTML 文档，CSS/JS 全内联，浏览器只发一次请求。
// 单独引 css/js 文件的话每次开面板要多花 2 次 Worker 请求，免费额度是按请求数算的。

import { UI_CSS } from './css.js';
import { uiApp } from './app.js';

const FAVICON =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E%F0%9F%9B%B0%EF%B8%8F%3C/text%3E%3C/svg%3E';

export function renderAdminPage() {
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<meta name="robots" content="noindex,nofollow">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    '<title>LLM Gateway 控制台</title>\n' +
    '<link rel="icon" href="' + FAVICON + '">\n' +
    '<style>' + UI_CSS + '</style>\n' +
    '</head>\n<body>\n<div id="root"></div>\n<div id="snack" role="status" aria-live="polite"></div>\n' +
    // wrangler 的 esbuild 会往函数体注入 __name() 注解；函数经 toString() 内联进
    // 浏览器后拿不到模块作用域里的那个 helper。Pages 产物（build.mjs）没有这一层，
    // 垫片在这里是空操作，两种部署都安全。
    '<script>window.__name=window.__name||function(f){return f;};<' + '/script>\n' +
    '<script>(' + uiApp.toString() + ')();<' + '/script>\n' +
    '</body>\n</html>'
  );
}

export function renderLanding(origin) {
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>LLM Gateway</title><link rel="icon" href="' + FAVICON + '">' +
    '<style>' + UI_CSS + '</style></head><body>' +
    '<div class="login"><div class="card elev">' +
    '<div class="logo">🛰️</div><h1 class="headline-s">LLM Gateway</h1>' +
    '<p class="body-m muted" style="margin:8px 0 20px">OpenAI 兼容的多模型聚合网关，跑在 Cloudflare 上。</p>' +
    '<pre class="code" style="text-align:left">' + origin + '/v1/chat/completions</pre>' +
    '<div style="margin-top:20px"><a class="btn" href="/admin" style="text-decoration:none;justify-content:center;width:100%">打开控制台</a></div>' +
    '</div></div></body></html>'
  );
}
