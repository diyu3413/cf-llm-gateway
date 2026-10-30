// 整个前端就是一个 HTML 文档，CSS/JS 全内联 —— 打开页面只算 1 次请求。
// 写法与 cf-llm-gateway 一致：前端逻辑是一个函数，用 Function.toString() 内联进来，
// 源文件里可以正常用模板字符串，不需要满屏转义。

import { UI_CSS } from './css.js';
import { uiApp } from './app.js';
import { renderMarkdown } from './md.js';

const FAVICON =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E%F0%9F%A4%96%3C/text%3E%3C/svg%3E';

export function renderAppPage(opts = {}) {
  const base = String(opts.basePath || '');
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<meta name="robots" content="noindex,nofollow">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    '<title>Agent Workspace</title>\n' +
    '<link rel="icon" href="' + FAVICON + '">\n' +
    '<style>' + UI_CSS + '</style>\n' +
    '</head>\n<body data-base="' + base + '" data-embedded="' + (opts.embedded ? '1' : '') + '">\n<div id="root"></div>\n<div id="snack" role="status" aria-live="polite"></div>\n' +
    // wrangler 用 esbuild 打包，函数体里会被注入 __name() 注解调用；函数经
    // toString() 内联进浏览器后拿不到模块作用域里的那个 helper，这里垫一个等价物。
    // markdown 渲染器同理：toString() 内联成全局 mdRender，uiApp 里直接调用。
    '<script>window.__name=window.__name||function(f){return f;};var mdRender=' + renderMarkdown.toString() + ';<' + '/script>\n' +
    '<script>(' + uiApp.toString() + ')();<' + '/script>\n' +
    '</body>\n</html>'
  );
}
