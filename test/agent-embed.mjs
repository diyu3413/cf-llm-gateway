// 内嵌 Agent 的模型通道测试：buildFetchChat 的内嵌分支（直调 runChain）。
// 覆盖：工具调用往返、内容+usage 记账（虚拟密钥「内置 Agent」）、模型别名映射、
// 链路故障转移、全链失败报错、空配置报错。
// 运行：node test/agent-embed.mjs

import { buildFetchChat } from '../src/agent/lib/fetchchat.js';
import { pendingUsageEvents } from '../src/lib/usage.js';
import { invalidateCaches } from '../src/lib/config.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

const enc = new TextEncoder();
function sseResponse(lines) {
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + '\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const chunk = (delta, finish = null, usage = null) => ({
  choices: [{ delta, finish_reason: finish, index: 0 }],
  ...(usage ? { usage } : {}),
});

class MemKV {
  constructor() {
    this.m = new Map();
  }
  async get(key, opts) {
    const v = this.m.get(key);
    if (v === undefined) return null;
    return opts && opts.type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value) {
    this.m.set(key, String(value));
  }
}

function configWith(models, providers) {
  return {
    version: 1,
    providers,
    models,
    defaultModel: models.length ? models[0].id : '',
    settings: {},
    updatedAt: Date.now(),
  };
}
const provider = (id, baseUrl) => ({ id, name: id, type: 'custom', baseUrl, apiKey: 'k-' + id, authStyle: 'bearer', enabled: true });
const model = (id, providerId, alias, upstream) => ({
  id,
  providerId,
  model: upstream,
  alias,
  enabled: true,
  kind: 'chat',
  caps: {},
  dropParams: [],
  paramOverrides: {},
  createdAt: Date.now(),
});

function envWith(config) {
  // loadConfig 有模块级 30s 缓存（进程内全局一份），用例之间必须清掉，
  // 否则上一个用例的配置会串进下一个用例。
  invalidateCaches();
  const KV = new MemKV();
  KV.put('gw:config', JSON.stringify(config));
  return { KV };
}

// ---------- 上游模拟 ----------

const realFetch = globalThis.fetch;
let upstreamCalls = [];
function mockUpstream(handler) {
  upstreamCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('upstream.test')) return realFetch(input, init);
    upstreamCalls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return handler(url, init);
  };
}

const SETTINGS = { model: 'auto', trackUsage: true };

console.log('\n[1] 工具调用往返 + 别名映射');
{
  const env = envWith(
    configWith([model('m1', 'p1', 'gw-mock', 'upstream-real-model')], [provider('p1', 'http://upstream.test/v1')])
  );
  mockUpstream(() =>
    sseResponse([
      'data: ' + JSON.stringify(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'workspace_write', arguments: '{"path":"a.md"}' } }] })),
      'data: ' + JSON.stringify(chunk({}, 'tool_calls')),
      'data: [DONE]',
    ])
  );
  const fetchChat = buildFetchChat(env, SETTINGS);
  const parsed = await fetchChat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'workspace_write', parameters: {} } }],
  });
  ok('工具调用被解析', parsed.toolCalls.length === 1 && parsed.toolCalls[0].function.name === 'workspace_write', JSON.stringify(parsed));
  ok('别名映射成上游模型名', upstreamCalls[0].body.model === 'upstream-real-model', upstreamCalls[0].body.model);
  ok('tools 参数原样透传', Array.isArray(upstreamCalls[0].body.tools) && upstreamCalls[0].body.tools.length === 1);
  ok('流式开关打开', upstreamCalls[0].body.stream === true);
}

console.log('\n[2] 内容 + usage 记账（虚拟密钥「内置 Agent」）');
{
  const before = pendingUsageEvents();
  const env = envWith(
    configWith([model('m1', 'p1', 'gw-mock', 'upstream-real-model')], [provider('p1', 'http://upstream.test/v1')])
  );
  mockUpstream(() =>
    sseResponse([
      'data: ' + JSON.stringify(chunk({ content: '你好' })),
      'data: ' + JSON.stringify(chunk({}, 'stop', { prompt_tokens: 11, completion_tokens: 7 })),
      'data: [DONE]',
    ])
  );
  const fetchChat = buildFetchChat(env, SETTINGS);
  const parsed = await fetchChat({ messages: [{ role: 'user', content: 'hi' }] });
  ok('内容增量解析', parsed.content === '你好');
  ok('usage 解析', parsed.usage && parsed.usage.prompt === 11 && parsed.usage.completion === 7, JSON.stringify(parsed.usage));
  ok('用量记账落账（内置 Agent）', pendingUsageEvents() > before, 'delta=' + (pendingUsageEvents() - before));
}

console.log('\n[3] 链路故障转移');
{
  const env = envWith(
    configWith(
      [model('m1', 'p1', 'dead', 'dead-model'), model('m2', 'p2', 'alive', 'alive-model')],
      [provider('p1', 'http://upstream.test/v1/dead'), provider('p2', 'http://upstream.test/v1/alive')]
    )
  );
  mockUpstream((url) => {
    if (url.includes('/dead/')) return new Response('boom', { status: 500 });
    return sseResponse(['data: ' + JSON.stringify(chunk({ content: '活的' })), 'data: ' + JSON.stringify(chunk({}, 'stop')), 'data: [DONE]']);
  });
  const fetchChat = buildFetchChat(env, SETTINGS);
  const parsed = await fetchChat({ messages: [{ role: 'user', content: 'hi' }] });
  ok('第一个失败后第二个接住', parsed.content === '活的', JSON.stringify(parsed));
  ok('确实尝试了两个上游', upstreamCalls.length === 2, 'calls=' + upstreamCalls.length);
  ok('第二个用的是 alive 模型名', upstreamCalls[1].body.model === 'alive-model');
}

console.log('\n[4] 失败路径');
{
  const envAll = envWith(
    configWith([model('m1', 'p1', 'dead', 'dead-model')], [provider('p1', 'http://upstream.test/v1')])
  );
  mockUpstream(() => new Response('nope', { status: 503 }));
  const fetchChatAll = buildFetchChat(envAll, SETTINGS);
  let threw = '';
  try {
    await fetchChatAll({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (e) {
    threw = e.message;
  }
  ok('全链失败抛可读错误', threw.includes('所有已配置的模型都调用失败'), threw);

  const envEmpty = envWith(configWith([], []));
  mockUpstream(() => new Response('x', { status: 200 }));
  const fetchChatEmpty = buildFetchChat(envEmpty, SETTINGS);
  threw = '';
  try {
    await fetchChatEmpty({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (e) {
    threw = e.message;
  }
  ok('空配置抛引导错误', threw.includes('没有任何可用模型'), threw);
}

globalThis.fetch = realFetch;
console.log('\n✅ 内嵌通道测试通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
