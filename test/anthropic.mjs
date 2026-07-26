// Anthropic 协议桥接测试（Claude Code 走的就是这条路）。

import worker from '../dist/_worker.js';

class MemKV {
  constructor() { this.m = new Map(); }
  async get(k, o) { const v = this.m.get(k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}

const env = { admin_password: 'pw', KV: new MemKV(), SILENCE_ERRORS: '1' };
const ORIGIN = 'https://gw.example.com';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' → ' + e : '')); } };

function call(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set('cookie', cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return worker.fetch(new Request(ORIGIN + path, { ...init, headers }), env, { waitUntil() {} });
}

const realFetch = globalThis.fetch;
let upstream = () => new Response('x', { status: 500 });
let lastUpstreamBody = null;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(ORIGIN)) return realFetch(input, init);
  if (init && init.body) { try { lastUpstreamBody = JSON.parse(init.body); } catch {} }
  return upstream(url, init);
};

const sse = (lines) => new ReadableStream({
  start(c) { const e = new TextEncoder(); lines.forEach((l) => c.enqueue(e.encode(l))); c.close(); },
});

async function readEvents(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((block) => {
    const ev = /event: (.+)/.exec(block);
    const dt = /data: (.+)/.exec(block);
    return { event: ev ? ev[1] : null, data: dt ? JSON.parse(dt[1]) : null };
  });
}

async function main() {
  console.log('\n[准备] 建一个提供商 + 模型 + 密钥');
  let r = await call('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'pw' }) });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  r = await call('/admin/api/providers/save', {
    method: 'POST',
    body: JSON.stringify({ provider: { type: 'custom', name: 'Up', baseUrl: 'https://up.test/v1', apiKey: 'k1' } }),
  });
  const prov = (await r.json()).provider;
  await call('/admin/api/models/add', { method: 'POST', body: JSON.stringify({ providerId: prov.id, models: [{ id: 'glm-4.6' }] }) });
  r = await call('/admin/api/keys/create', { method: 'POST', body: JSON.stringify({ name: 'claude-code' }) });
  const KEY = (await r.json()).key;
  const auth = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };
  ok('准备完成', Boolean(prov.id && KEY));

  console.log('\n[1] 非流式：文本往返');
  upstream = () => new Response(JSON.stringify({
    id: 'chatcmpl-1', model: 'glm-4.6',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好，我在。' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  r = await call('/v1/messages', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'glm-4.6', max_tokens: 100, system: '你是助手', messages: [{ role: 'user', content: '在吗' }] }),
  });
  const m = await r.json();
  ok('返回 Anthropic message 结构', m.type === 'message' && m.role === 'assistant');
  ok('内容块正确', m.content[0].type === 'text' && m.content[0].text === '你好，我在。');
  ok('stop_reason 映射为 end_turn', m.stop_reason === 'end_turn');
  ok('usage 字段转成 input/output_tokens', m.usage.input_tokens === 12 && m.usage.output_tokens === 5);
  ok('system 被转成 OpenAI 的 system 消息', lastUpstreamBody.messages[0].role === 'system' && lastUpstreamBody.messages[0].content === '你是助手');
  ok('max_tokens 透传', lastUpstreamBody.max_tokens === 100);

  console.log('\n[2] 鉴权');
  r = await call('/v1/messages', { method: 'POST', headers: { 'x-api-key': 'sk-gw-bogus' }, body: JSON.stringify({ model: 'x', messages: [] }) });
  const e = await r.json();
  ok('无效密钥返回 Anthropic 错误结构', r.status === 401 && e.type === 'error' && e.error.type === 'authentication_error');

  console.log('\n[3] 工具调用往返');
  upstream = () => new Response(JSON.stringify({
    id: 'chatcmpl-2', model: 'glm-4.6',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"东京"}' } }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  r = await call('/v1/messages', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      model: 'glm-4.6', max_tokens: 100,
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: '东京天气' }],
    }),
  });
  const t = await r.json();
  ok('tools 转成 OpenAI function 格式', lastUpstreamBody.tools[0].type === 'function' && lastUpstreamBody.tools[0].function.name === 'get_weather');
  ok('input_schema 变成 parameters', lastUpstreamBody.tools[0].function.parameters.properties.city.type === 'string');
  ok('返回 tool_use 块', t.content.some((c) => c.type === 'tool_use' && c.name === 'get_weather'));
  ok('参数被解析成对象', t.content.find((c) => c.type === 'tool_use').input.city === '东京');
  ok('stop_reason 为 tool_use', t.stop_reason === 'tool_use');

  console.log('\n[4] tool_result 回传');
  upstream = () => new Response(JSON.stringify({ choices: [{ message: { content: '晴' }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  await call('/v1/messages', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      model: 'glm-4.6', max_tokens: 50,
      messages: [
        { role: 'user', content: '东京天气' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '东京' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴 28 度' }] },
      ],
    }),
  });
  const msgs = lastUpstreamBody.messages;
  ok('assistant 的 tool_use 转成 tool_calls', msgs[1].tool_calls[0].function.name === 'get_weather');
  ok('tool_result 转成独立的 tool 消息', msgs[2].role === 'tool' && msgs[2].tool_call_id === 'call_1');

  console.log('\n[5] 图片输入');
  await call('/v1/messages', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      model: 'glm-4.6', max_tokens: 50,
      messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
    }),
  });
  const parts = lastUpstreamBody.messages[0].content;
  ok('图片转成 data URI 的 image_url', parts[1].type === 'image_url' && parts[1].image_url.url.startsWith('data:image/png;base64,'));

  console.log('\n[6] 流式');
  upstream = () => new Response(sse([
    'data: {"choices":[{"delta":{"role":"assistant","content":"你"},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  r = await call('/v1/messages', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'glm-4.6', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  ok('Content-Type 是 SSE', (r.headers.get('content-type') || '').includes('text/event-stream'));
  const evs = await readEvents(r);
  const names = evs.map((x) => x.event);
  ok('事件顺序符合 Anthropic 规范',
    names[0] === 'message_start' && names[1] === 'content_block_start' &&
    names.includes('content_block_delta') && names[names.length - 2] === 'message_delta' && names[names.length - 1] === 'message_stop',
    names.join(','));
  const deltas = evs.filter((x) => x.event === 'content_block_delta').map((x) => x.data.delta.text).join('');
  ok('文本增量拼回原文', deltas === '你好');
  ok('message_delta 带 stop_reason', evs.find((x) => x.event === 'message_delta').data.delta.stop_reason === 'end_turn');
  ok('输出 token 数被带出', evs.find((x) => x.event === 'message_delta').data.usage.output_tokens === 2);

  console.log('\n[7] 流式工具调用');
  upstream = () => new Response(sse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"search","arguments":""}}]},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cf\\"}"}}]},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
    'data: [DONE]\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  r = await call('/v1/messages', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'glm-4.6', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const ev2 = await readEvents(r);
  const blockStart = ev2.find((x) => x.event === 'content_block_start');
  ok('工具块以 tool_use 开启', blockStart && blockStart.data.content_block.type === 'tool_use' && blockStart.data.content_block.name === 'search');
  const json = ev2.filter((x) => x.event === 'content_block_delta').map((x) => x.data.delta.partial_json).join('');
  ok('input_json_delta 拼起来是合法 JSON', JSON.parse(json).q === 'cf');
  ok('stop_reason 为 tool_use', ev2.find((x) => x.event === 'message_delta').data.delta.stop_reason === 'tool_use');

  console.log('\n[8] count_tokens');
  r = await call('/v1/messages/count_tokens', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: '你好世界' }] }),
  });
  const ct = await r.json();
  ok('返回 input_tokens 估算值', typeof ct.input_tokens === 'number' && ct.input_tokens > 0);

  console.log('\n[9] 全链失败');
  upstream = () => new Response('down', { status: 500 });
  await call('/admin/api/settings/save', { method: 'POST', body: JSON.stringify({ settings: { cooldownSeconds: 0 } }) });
  r = await call('/v1/messages', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'glm-4.6', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) });
  const errj = await r.json();
  ok('全部失败返回 403 + Anthropic 错误结构', r.status === 403 && errj.type === 'error');

  console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
