// 环境里没有无头浏览器，所以用一个最小 DOM 桩把后台前端跑一遍：
// 逐个标签页触发渲染，把生成的 HTML 抓出来做标签配对校验。
// 目的是挡住"某个视图少个 </div> 导致整页塌掉"这类只在浏览器里才暴露的问题。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// ---------- 标签配对 ----------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'stop']);
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

function checkBalance(html) {
  const stack = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const raw = m[0];
    const tag = m[1].toLowerCase();
    const selfClosed = m[2] === '/';
    if (raw.startsWith('</')) {
      if (!stack.length) return '多出一个闭合标签 </' + tag + '>';
      const top = stack.pop();
      if (top !== tag) return '标签交叉：期望 </' + top + '>，实际 </' + tag + '>';
    } else if (!selfClosed && !VOID.has(tag)) {
      stack.push(tag);
    }
  }
  if (stack.length) return '未闭合：' + stack.map((t) => '<' + t + '>').join(' ');
  return null;
}

// ---------- 最小 DOM ----------

const captured = [];
const themeState = { theme: 'light' };

function makeEl(tag) {
  const e = {
    tagName: (tag || 'div').toUpperCase(),
    _html: '',
    id: '',
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    checked: false,
    disabled: false,
    type: 'text',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    offsetWidth: 1,
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    remove() {},
    click() {},
    showModal() {},
    close() {},
    addEventListener() {},
    appendChild() {},
    querySelector() { return makeEl(); },
    querySelectorAll(sel) { return fakeList(sel); },
  };
  Object.defineProperty(e, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); captured.push(String(v)); },
  });
  return e;
}

// 只有导航按钮需要"能被点到"。必须记忆化：bindShell 绑事件和测试里取按钮
// 得拿到同一批对象，否则 onclick 绑了个寂寞。
const listCache = new Map();
function fakeList(sel) {
  if (sel && sel.indexOf('.navitem[data-tab]') >= 0) {
    if (!listCache.has('nav')) {
      listCache.set('nav', ['overview', 'providers', 'models', 'keys', 'usage', 'settings', 'edge'].map((id) => {
        const b = makeEl('button');
        b.dataset.tab = id;
        return b;
      }));
    }
    return listCache.get('nav');
  }
  return [];
}

const singletons = new Map();
function pick(sel) {
  if (!singletons.has(sel)) singletons.set(sel, makeEl());
  return singletons.get(sel);
}

globalThis.document = {
  documentElement: { dataset: themeState },
  body: makeEl('body'),
  querySelector: pick,
  querySelectorAll: fakeList,
  createElement: (t) => makeEl(t),
  addEventListener() {},
};
globalThis.location = { origin: 'https://gw.example.com', hostname: 'gw.example.com' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
if (!globalThis.navigator) globalThis.navigator = {};
if (!globalThis.navigator.clipboard) {
  try { Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true }); }
  catch { /* Node 自带 navigator 只读，测试里用不到剪贴板 */ }
}
globalThis.matchMedia = () => ({ matches: false });
globalThis.window = { matchMedia: globalThis.matchMedia, localStorage: globalThis.localStorage };
globalThis.confirm = () => false;
globalThis.Blob = globalThis.Blob || class {};
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.URL.revokeObjectURL = () => {};

// ---------- 假后端 ----------

const STATE = {
  ok: true,
  kvBound: true,
  presets: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', authStyle: 'bearer', note: '示例' }],
  config: {
    providers: [{ id: 'p1', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', keyMask: 'nvap****abcd', authStyle: 'bearer', enabled: true }],
    models: [{ id: 'm1', providerId: 'p1', alias: 'llama-70b', model: 'meta/llama-3.3-70b-instruct', kind: 'chat', enabled: true, caps: { tools: true, vision: false }, dropParams: [] }],
    defaultModel: 'm1',
    settings: {
      strictModelRouting: false, rewriteModelName: true, maxAttempts: 6, headerTimeoutMs: 25000,
      cooldownSeconds: 180, allowAnonymousModels: false, exposeProviderInList: true,
      trackUsage: true, usageFlushSeconds: 300,
    },
    updatedAt: Date.now(),
  },
  keys: [{ id: 'k1', name: 'astrbot', prefix: 'sk-gw-abcdef', tail: 'wxyz', createdAt: Date.now(), enabled: true }],
  cooldown: [{ modelId: 'm1', secondsLeft: 42, status: 402, message: 'no balance' }],
  usage: {
    keys: [{
      id: 'k1', name: 'astrbot', prefix: 'sk-gw-abcdef', tail: 'wxyz', exists: true,
      calls: 12, prompt: 3400, completion: 1200, total: 4600, estimatedCalls: 3, lastAt: Date.now(),
      byModel: [{ name: 'llama-70b', calls: 12, tokens: 4600 }],
      byEndpoint: [{ name: 'chat', calls: 10 }, { name: 'count_tokens', calls: 2 }],
    }],
    totals: { calls: 12, prompt: 3400, completion: 1200, total: 4600, estimatedCalls: 3 },
    persisted: true, tracking: true, flushSeconds: 300, updatedAt: Date.now(), pending: 0,
  },
  disguise: { enabled: true, target: 'https://www.bing.com/', fromDefault: true },
  stats: { startedAt: Date.now(), requests: 5, success: 4, failed: 1, byModel: {} },
  defaults: {},
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/admin/api/session')) return jsonRes({ authed: true, hasPassword: true });
  if (u.includes('/admin/api/state')) return jsonRes(STATE);
  if (u.includes('/cdn-cgi/trace')) return new Response('colo=HKG\nip=1.2.3.4\nloc=HK\nhttp=http/2\n');
  return jsonRes({ ok: true });
};
function jsonRes(o) {
  return new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---------- 跑起来 ----------

const src = readFileSync(join(here, '../src/ui/app.js'), 'utf8');
const body = src.replace(/^export function uiApp\(\)\s*\{/m, '(function uiApp(){').replace(/\}\s*$/, '})');
const uiApp = new Function('return (\n' + body + '\n);')();

console.log('\n[1] 启动与登录页');
const root = pick('#root');
uiApp();
await new Promise((r) => setTimeout(r, 20));
ok('渲染出了内容', captured.length > 0);

const shellHtml = captured.find((h) => h.includes('class="topbar"'));
ok('顶栏渲染出来了', Boolean(shellHtml));
if (shellHtml) {
  ok('顶栏有汉堡按钮', shellHtml.includes('id="menuBtn"'));
  ok('刷新按钮用 SVG 不是 emoji', shellHtml.includes('id="reloadBtn"') && shellHtml.includes('<svg class="i"'));
  ok('退出按钮带 tonal 圆弧背景', shellHtml.includes('btn tonal small logout'));
  ok('抽屉里有夜间模式切换项', shellHtml.includes('id="themeBtn"') && shellHtml.includes('夜间模式切换'));
  ok('抽屉有遮罩层', shellHtml.includes('class="scrim"'));
  const err = checkBalance(shellHtml);
  ok('外壳标签配对正确', !err, err);
}

console.log('\n[2] 逐页渲染 + 标签配对');
// bindShell 里把 onclick 绑在 fakeList 返回的按钮上，这里挨个点一遍
const navButtons = root.querySelectorAll('.navitem[data-tab]');
const seen = {};
for (const btn of navButtons) {
  captured.length = 0;
  // 重新触发一次 bindShell 绑定：直接调用 render 路径
  const before = captured.length;
  try { btn.onclick && btn.onclick(); } catch (e) { /* 部分交互在桩环境下不可用 */ }
  await new Promise((r) => setTimeout(r, 5));
  const paneHtml = captured.filter((h) => !h.includes('class="topbar"')).pop() || '';
  seen[btn.dataset.tab] = paneHtml;
}

for (const tab of ['overview', 'providers', 'models', 'keys', 'usage', 'settings', 'edge']) {
  const html = seen[tab] || '';
  if (!html) { ok(tab + ' 页渲染出内容', false, '空'); continue; }
  const err = checkBalance(html);
  ok(tab + ' 页标签配对正确', !err, err);
}

console.log('\n[3] 关键内容');
ok('提供商页的操作按钮包在 .acts 里（移动端才能整行换行）', (seen.providers || '').includes('<div class="acts">'));
ok('模型链页也用 .acts', (seen.models || '').includes('<div class="acts">'));
ok('密钥页也用 .acts', (seen.keys || '').includes('<div class="acts">'));
ok('用量页有按密钥的表格', (seen.usage || '').includes('<table class="md">'));
ok('用量页显示调用次数与 token', (seen.usage || '').includes('调用次数') && (seen.usage || '').includes('输入'));
ok('用量页有重置按钮', (seen.usage || '').includes('id="resetUsage"'));
ok('设置页显示伪装域名状态', (seen.settings || '').includes('首页伪装') && (seen.settings || '').includes('www.bing.com'));
ok('设置页有用量开关', (seen.settings || '').includes('trackUsage'));
ok('列表项里的 chip 不会被挤成竖排（有 grow 容器兜底）', (seen.providers || '').includes('class="grow"'));

writeFileSync('/tmp/ui-panes.json', JSON.stringify(seen, null, 2));
console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
