// 用 Node 直接跑构建产物：模拟 KV 绑定和上游 API，把整条链路走一遍。
// 运行：npm test

import worker from '../dist/_worker.js';

class MemKV {
  constructor() { this.m = new Map(); this.reads = 0; this.writes = 0; }
  async get(key, opts) {
    this.reads++;
    const v = this.m.get(key);
    if (v === undefined) return null;
    return opts && opts.type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value) { this.writes++; this.m.set(key, String(value)); }
  async delete(key) { this.m.delete(key); }
}

const KV = new MemKV();
const env = { admin_password: 'hunter2', KV, SILENCE_ERRORS: '1' };
const ORIGIN = 'https://gw.example.com';

let cookie = '';
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function call(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set('cookie', cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const req = new Request(ORIGIN + path, { ...init, headers });
  return worker.fetch(req, env, { waitUntil() {} });
}

// ---- 上游模拟 ----
const realFetch = globalThis.fetch;
let upstream = () => new Response('not mocked', { status: 500 });
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(ORIGIN)) return realFetch(input, init);
  return upstream(url, init);
};

function sse(lines) {
  return new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
}

async function main() {
  console.log('\n[1] 公共路由');
  // 首页伪装默认是开的，先关掉验证自带落地页；伪装本身在 [12] 单独测。
  env.url = 'off';
  let r = await call('/');
  ok('伪装关闭时 GET / 返回落地页', r.status === 200 && (await r.text()).includes('LLM Gateway'));
  r = await call('/healthz');
  ok('GET /healthz 报告 KV 已绑定', (await r.json()).kv === true);
  r = await call('/admin');
  const adminHtml = await r.text();
  ok('GET /admin 返回单文档面板', r.status === 200 && adminHtml.includes('md-sys-color-primary'));
  ok('面板 CSS/JS 全部内联（无外部资源请求）', !/<link rel="stylesheet"|<script src=/.test(adminHtml));
  r = await call('/nope');
  ok('未知路径 404', r.status === 404);

  console.log('\n[2] 管理员登录');
  r = await call('/admin/api/state');
  ok('未登录访问 state 被拒', r.status === 401);
  r = await call('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  ok('错误密码 401', r.status === 401);
  r = await call('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'hunter2' }) });
  const setCookie = r.headers.get('set-cookie') || '';
  cookie = setCookie.split(';')[0];
  ok('正确密码签发会话 Cookie', r.status === 200 && setCookie.includes('HttpOnly'));
  r = await call('/admin/api/state');
  const state = await r.json();
  ok('登录后可读取状态', r.status === 200 && state.kvBound === true);
  ok('预设里包含 deepseek / nvidia / gemini / mimo',
    ['deepseek', 'nvidia', 'gemini', 'mimo'].every((id) => state.presets.some((p) => p.id === id)));

  console.log('\n[3] 提供商与模型搜索');
  r = await call('/admin/api/providers/save', {
    method: 'POST',
    body: JSON.stringify({ provider: { type: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-upstream-1' } }),
  });
  const provA = (await r.json()).provider;
  ok('保存提供商 A', r.status === 200 && provA.id);
  ok('面板拿到的是掩码不是明文', provA.apiKey === undefined && provA.keyMask.includes('****'));

  r = await call('/admin/api/providers/save', {
    method: 'POST',
    body: JSON.stringify({ provider: { type: 'nvidia', name: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-upstream-2' } }),
  });
  const provB = (await r.json()).provider;
  ok('保存提供商 B', r.status === 200 && provB.id);

  // 模拟上游 /models
  upstream = (url, init) => {
    if (url.endsWith('/models')) {
      const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
      if (!auth.includes('sk-upstream-1') && !auth.includes('nvapi-upstream-2')) return new Response('bad key', { status: 401 });
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'qwen2.5-vl-72b-instruct' }, { id: 'text-embedding-3-small' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  };

  r = await call('/admin/api/providers/discover', { method: 'POST', body: JSON.stringify({ id: provA.id }) });
  const disc = await r.json();
  ok('搜索到模型列表', disc.ok && disc.count === 4);
  const vl = disc.models.find((m) => m.id.includes('vl'));
  ok('vl 模型被标为支持视觉', vl && vl.caps.vision === true);
  const emb = disc.models.find((m) => m.id.includes('embedding'));
  ok('embedding 模型被识别为 embedding 类型', emb && emb.kind === 'embedding');
  ok('chat 模型被标为支持工具调用', disc.models.find((m) => m.id === 'deepseek-chat').caps.tools === true);

  r = await call('/admin/api/models/add', {
    method: 'POST',
    body: JSON.stringify({ providerId: provA.id, models: [{ id: 'deepseek-chat' }] }),
  });
  ok('把 deepseek-chat 加入调用链', (await r.json()).added === 1);
  r = await call('/admin/api/models/add', {
    method: 'POST',
    body: JSON.stringify({ providerId: provB.id, models: [{ id: 'meta/llama-3.3-70b-instruct' }] }),
  });
  ok('把 NVIDIA 模型加入调用链', (await r.json()).added === 1);

  r = await call('/admin/api/state');
  const st2 = await r.json();
  ok('链上有 2 个模型且顺序即添加顺序',
    st2.config.models.length === 2 && st2.config.models[0].model === 'deepseek-chat');
  ok('第一个模型自动成为默认模型', st2.config.defaultModel === st2.config.models[0].id);
  const [m1, m2] = st2.config.models;

  console.log('\n[4] 关闭冷却，方便逐条验证转发');
  r = await call('/admin/api/settings/save', {
    method: 'POST',
    body: JSON.stringify({ settings: { ...st2.config.settings, cooldownSeconds: 0 } }),
  });
  ok('冷却时间设为 0', (await r.json()).settings.cooldownSeconds === 0);

  console.log('\n[5] 网关密钥');
  r = await call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'x', messages: [] }) });
  ok('没有任何密钥时调用被拒（403）', r.status === 403);
  r = await call('/admin/api/keys/create', { method: 'POST', body: JSON.stringify({ name: '   ' }) });
  ok('备注为空时拒绝创建密钥', r.status === 400);
  r = await call('/admin/api/keys/create', { method: 'POST', body: JSON.stringify({ name: 'astrbot' }) });
  const created = await r.json();
  const GW_KEY = created.key;
  ok('创建密钥返回明文一次', typeof GW_KEY === 'string' && GW_KEY.startsWith('sk-gw-'));
  r = await call('/admin/api/state');
  const st3 = await r.json();
  ok('后续状态里只有前缀和尾号，没有明文', JSON.stringify(st3.keys).indexOf(GW_KEY) === -1 && st3.keys[0].prefix.startsWith('sk-gw-'));
  ok('KV 里存的是哈希不是明文', JSON.stringify([...KV.m.values()]).indexOf(GW_KEY) === -1);

  const authed = { Authorization: 'Bearer ' + GW_KEY };

  console.log('\n[6] 模型列表');
  r = await call('/v1/models');
  ok('不带 key 拉模型列表被拒', r.status === 401);
  r = await call('/v1/models', { headers: authed });
  const list = await r.json();
  ok('带 key 能拿到 OpenAI 格式列表', list.object === 'list' && list.data.length === 2);
  ok('列表里是别名，AstrBot 能直接选', list.data[0].id === 'deepseek-chat');
  ok('列表附带能力标注', list.data[0].gateway.capabilities.tools === true);

  console.log('\n[7] 逐层故障转移');
  let hits = [];
  upstream = (url, init) => {
    hits.push(url);
    const body = JSON.parse(init.body);
    if (url.includes('deepseek')) return new Response(JSON.stringify({ error: 'insufficient balance' }), { status: 402 });
    return new Response(JSON.stringify({ id: 'cmpl-1', object: 'chat.completion', model: body.model, choices: [{ message: { role: 'assistant', content: 'pong' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const out = await r.json();
  ok('第一个模型 402 后自动降级到第二个', r.status === 200 && r.headers.get('X-Gateway-Model') === m2.alias);
  ok('确实按顺序试了 2 个上游', hits.length === 2 && hits[0].includes('deepseek'));
  ok('尝试次数写在响应头里', r.headers.get('X-Gateway-Attempts') === '2');
  ok('响应体里的 model 已回写成客户端要的名字', out.model === 'auto' || out.model === m2.alias);

  hits = [];
  upstream = (url) => { hits.push(url); return new Response('boom', { status: 503 }); };
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const errBody = await r.json();
  ok('全部上游失败返回 403', r.status === 403);
  ok('403 里带上每一次尝试的明细', Array.isArray(errBody.error.details) && errBody.error.details.length === 2);

  console.log('\n[8] 点名模型 + 成功后不再回头');
  hits = [];
  upstream = (url, init) => {
    hits.push(url);
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: body.model, choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: m2.alias, messages: [{ role: 'user', content: 'hi' }] }),
  });
  ok('点名第二个模型时它排到最前', r.headers.get('X-Gateway-Model') === m2.alias && hits.length === 1);
  ok('命中后不再尝试后面的模型', hits.length === 1);

  console.log('\n[9] 流式转发');
  // 别名默认就等于上游模型名，这时回写是空操作。改个别名才能验证回写真的发生了。
  r = await call('/admin/api/models/save', {
    method: 'POST',
    body: JSON.stringify({ model: { id: m2.id, alias: 'llama-70b', model: m2.model } }),
  });
  ok('把第二个模型改名为 llama-70b', (await r.json()).model.alias === 'llama-70b');
  upstream = () => new Response(sse([
    'data: {"id":"1","model":"meta/llama-3.3-70b-instruct","choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"id":"1","model":"meta/llama-3.3-70b-instruct","choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'llama-70b', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const streamed = await r.text();
  ok('流式响应保持 SSE 格式', r.headers.get('content-type').includes('text/event-stream') && streamed.includes('[DONE]'));
  ok('流里的上游模型名被回写成别名', !streamed.includes('meta/llama-3.3-70b-instruct') && streamed.includes('llama-70b'));
  ok('流内容完整', streamed.includes('你') && streamed.includes('好'));

  console.log('\n[10] 停用与顺序调整');
  r = await call('/admin/api/models/reorder', { method: 'POST', body: JSON.stringify({ ids: [m2.id, m1.id] }) });
  const reordered = await r.json();
  ok('调整顺序生效', reordered.models[0].id === m2.id);
  r = await call('/admin/api/models/save', {
    method: 'POST', body: JSON.stringify({ model: { id: m2.id, alias: 'llama-70b', model: m2.model, enabled: false } }),
  });
  ok('停用模型', (await r.json()).model.enabled === false);
  hits = [];
  upstream = (url, init) => {
    hits.push(url);
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: body.model, choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  });
  ok('停用的模型不会被尝试', hits.length === 1 && hits[0].includes('deepseek'));

  console.log('\n[11] 200 但错误藏在流里');
  hits = [];
  // 先把两个模型都启用回来，并恢复到「deepseek 在前」的顺序
  await call('/admin/api/models/save', {
    method: 'POST', body: JSON.stringify({ model: { id: m2.id, alias: 'llama-70b', model: m2.model, enabled: true } }),
  });
  await call('/admin/api/models/reorder', { method: 'POST', body: JSON.stringify({ ids: [m1.id, m2.id] }) });
  upstream = (url) => {
    hits.push(url);
    if (url.includes('deepseek')) {
      // 状态码 200，错误却在第一个 SSE 事件里 —— 只看 status 会误判成功
      return new Response(sse(['data: {"error":{"message":"insufficient quota"}}\n\n']),
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(sse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const peeked = await r.text();
  ok('识破流内错误并转到下一个模型', r.headers.get('X-Gateway-Model') === 'llama-70b');
  ok('客户端拿到的是正常内容，不是那坨错误', peeked.includes('ok') && !peeked.includes('insufficient quota'));
  ok('确实两个上游都打过', hits.length === 2);

  // 正常的流不该被误伤：首块就是内容时必须原样放行，一个字节都不能丢
  hits = [];
  upstream = (url) => { hits.push(url); return new Response(sse([
    'data: {"choices":[{"delta":{"content":"第一块"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"第二块"}}]}\n\n',
    'data: [DONE]\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const intact = await r.text();
  ok('预读不会吞掉首块', intact.includes('第一块') && intact.includes('第二块') && intact.includes('[DONE]'));
  ok('正常流只打一个上游', hits.length === 1);

  console.log('\n[12] developer 角色映射');
  let sentBody = null;
  upstream = (url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: sentBody.model, choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }] }),
  });
  await r.text();
  ok('developer 被改写成 system 再发给上游', sentBody.messages[0].role === 'system');
  ok('消息内容原样保留', sentBody.messages[0].content === 'be terse' && sentBody.messages[1].role === 'user');

  r = await call('/admin/api/settings/save', {
    method: 'POST', body: JSON.stringify({ settings: { mapDeveloperRole: false, cooldownSeconds: 0 } }),
  });
  ok('可以在设置里关掉映射', (await r.json()).settings.mapDeveloperRole === false);
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'developer', content: 'x' }] }),
  });
  await r.text();
  ok('关掉后原样透传 developer', sentBody.messages[0].role === 'developer');
  await call('/admin/api/settings/save', {
    method: 'POST', body: JSON.stringify({ settings: { mapDeveloperRole: true, cooldownSeconds: 0 } }),
  });

  console.log('\n[13] 用量统计');
  r = await call('/admin/api/state');
  const beforeU = (await r.json()).usage;
  const before = beforeU.keys.find((k) => k.id === created.record.id) || { calls: 0, prompt: 0, completion: 0 };

  upstream = (url, init) => {
    const b = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: b.model,
      choices: [{ message: { role: 'assistant', content: '你好世界' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await r.text(); // 计量在响应体读完时结算，必须消费掉
  await new Promise((res) => setTimeout(res, 0));

  r = await call('/admin/api/state');
  const afterU = (await r.json()).usage;
  const after = afterU.keys.find((k) => k.id === created.record.id);
  ok('调用次数按密钥累加', after && after.calls === before.calls + 1);
  ok('上游给了 usage 就直接采信（+11 输入 / +7 输出）',
    after.prompt === before.prompt + 11 && after.completion === before.completion + 7);
  ok('用量能按模型细分', after.byModel.length >= 1 && after.byModel[0].calls >= 1);
  ok('用量能按接口细分', after.byEndpoint.some((e) => e.name === 'chat'));
  ok('面板拿到的用量行带密钥名和掩码', after.name === 'astrbot' && after.prefix.startsWith('sk-gw-'));

  // 上游不返回 usage 的流式响应 —— 走估算路径
  upstream = () => new Response(sse([
    'data: {"choices":[{"delta":{"content":"你好世界你好世界你好世界"}}]}\n\n',
    'data: [DONE]\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: '你好' }] }),
  });
  await r.text();
  await new Promise((res) => setTimeout(res, 0));
  r = await call('/admin/api/state');
  const estRow = (await r.json()).usage.keys.find((k) => k.id === created.record.id);
  ok('上游不给 usage 时按字数估算补上', estRow.completion > after.completion);
  ok('估算过的条数单独标出来，不会被当成账单依据', estRow.estimatedCalls >= 1);

  r = await call('/v1/messages/count_tokens', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '你好世界' }] }),
  });
  const ct = await r.json();
  ok('count_tokens 给出估算值', typeof ct.input_tokens === 'number' && ct.input_tokens > 0);
  r = await call('/admin/api/state');
  const ctRow = (await r.json()).usage.keys.find((k) => k.id === created.record.id);
  ok('count_tokens 也计进该密钥的调用次数', ctRow.byEndpoint.some((e) => e.name === 'count_tokens'));

  const writesBeforeFlush = KV.writes;
  upstream = (url, init) => new Response(JSON.stringify({
    model: JSON.parse(init.body).model, choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  r = await call('/v1/chat/completions', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await r.text();
  await new Promise((res) => setTimeout(res, 0));
  ok('转发这一步本身不写 KV（计数只在内存里攒着）', KV.writes === writesBeforeFlush);
  r = await call('/admin/api/usage/flush', { method: 'POST', body: '{}' });
  ok('强制落盘成功', (await r.json()).flushed === true);
  ok('用量落在单独一个 KV key 里，不和配置抢空间', KV.m.has('gw:usage'));

  r = await call('/admin/api/usage/reset', { method: 'POST', body: '{}' });
  ok('重置用量', r.status === 200);
  r = await call('/admin/api/state');
  ok('重置后计数归零', (await r.json()).usage.totals.calls === 0);

  console.log('\n[14] 首页伪装');
  delete env.url;
  upstream = (url) => {
    if (url.startsWith('https://www.bing.com')) {
      return new Response('<html><head><title>Bing</title></head><body>search</body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'MUID=abc; Path=/' } });
    }
    return new Response('nope', { status: 404 });
  };
  r = await call('/');
  const masked = await r.text();
  ok('不设 url 变量时默认伪装成 www.bing.com', r.status === 200 && masked.includes('Bing'));
  ok('注入 <base>，静态资源由浏览器直连目标站，不经过 Worker',
    masked.includes('<base href="https://www.bing.com/">'));
  ok('不把目标站的 Set-Cookie 透传到你的域名下', !r.headers.get('set-cookie'));
  ok('伪装页面里没有任何网关痕迹', !masked.includes('LLM Gateway'));
  r = await call('/some/random/path');
  const notFound = await r.text();
  ok('开了伪装后未知路径给中性 404，不暴露 /admin', r.status === 404 && !notFound.includes('/admin'));
  r = await call('/admin');
  ok('伪装不影响控制台', r.status === 200);
  r = await call('/v1/models', { headers: authed });
  ok('伪装不影响接口', r.status === 200);

  env.url = 'example.org';
  upstream = (url) => url.startsWith('https://example.org')
    ? new Response('<html><head></head><body>EX</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    : new Response('x', { status: 404 });
  r = await call('/');
  const ex = await r.text();
  ok('url 不带协议时自动补 https', ex.includes('EX') && ex.includes('<base href="https://example.org/">'));

  env.url = 'https://down.example';
  upstream = () => { throw new Error('connect ECONNREFUSED'); };
  r = await call('/');
  const fallback = await r.text();
  ok('回源失败时给中性空白页，不泄露报错也不暴露网关',
    r.status === 200 && !fallback.includes('LLM Gateway') && !fallback.includes('ECONNREFUSED'));

  env.url = 'off';
  r = await call('/');
  ok('url=off 时恢复自带落地页', (await r.text()).includes('LLM Gateway'));

  console.log('\n[15] 密钥吊销');
  r = await call('/admin/api/keys/delete', { method: 'POST', body: JSON.stringify({ id: created.record.id }) });
  ok('删除密钥', r.status === 200);
  r = await call('/v1/chat/completions', { method: 'POST', headers: authed, body: JSON.stringify({ model: 'auto', messages: [] }) });
  ok('被删的密钥立刻失效', r.status === 403 || r.status === 401);

  console.log('\n[16] KV 写入总量');
  console.log('  写入次数：' + KV.writes + '（后台改配置 + 用量落盘，转发热路径 0 写入）');
  ok('整轮跑下来 KV 写次数远低于免费额度', KV.writes < 30);

  console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
