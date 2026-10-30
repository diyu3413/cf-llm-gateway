#!/usr/bin/env node
// 合并版（网关 + 内嵌 Agent）的全栈冒烟，对 wrangler dev 实例跑。
//
// 前置：
//   1. node ../cf-agent-web/scripts/mock-gw.mjs   （假上游，:8999）
//   2. npx wrangler dev                            （合并版，:8787）
//   3. npx wrangler d1 migrations apply DB --local （建过表）
//   4. .dev.vars 里有 admin_password=dev123
//
// 流程：网关管理台配一个指向假上游的提供商和模型 → /agent 应显示内嵌模型下拉
// → 对话触发工具写入 → 文件落在工作区 → 用量页出现「内置 Agent」。
// 用法：node scripts/smoke-combined.mjs

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8787';
const PW = process.env.SMOKE_PW || 'dev123';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
};

function cookieJar() {
  const jars = {};
  return {
    get: (k) => jars[k] || '',
    set: (k, res) => {
      const sc = res.headers.get('set-cookie');
      if (sc) jars[k] = sc.split(';')[0];
    },
  };
}
const jar = cookieJar();

async function api(which, path, opts = {}) {
  const cookieKey = which === 'admin' ? 'gw' : 'agent';
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(jar.get(cookieKey) ? { cookie: jar.get(cookieKey) } : {}), ...(opts.headers || {}) },
  });
  jar.set(cookieKey, res);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

async function main() {
  console.log('\n[1] 双端登录（同一密码、两把独立会话 Cookie）');
  const badAdmin = await api('admin', '/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  ok('管理台错误密码被拒', badAdmin.status === 401);
  const admin = await api('admin', '/admin/api/login', { method: 'POST', body: JSON.stringify({ password: PW }) });
  ok('管理台登录', admin.status === 200);
  const agentLogin = await api('agent', '/agent/api/login', { method: 'POST', body: JSON.stringify({ password: PW }) });
  ok('Agent 页登录', agentLogin.status === 200);

  console.log('\n[2] 管理台特性标志与内嵌模型链');
  const state = await api('admin', '/admin/api/state');
  ok('state.agent = true（rail 显示 Agent 入口）', state.data.agent === true, JSON.stringify(state.data.agent));
  ok('合并版有 KV（复用模型链）', state.data.kvBound === true);

  console.log('\n[3] 配置指向假上游的提供商与模型');
  const prov = await api('admin', '/admin/api/providers/save', {
    method: 'POST',
    body: JSON.stringify({ provider: { type: 'custom', name: 'Mock 上游', baseUrl: 'http://127.0.0.1:8999', apiKey: 'sk-mock-12345678' } }),
  });
  ok('保存提供商', prov.status === 200 && prov.data.ok, JSON.stringify(prov.data));
  const providerId = prov.data.provider.id;
  const addModels = await api('admin', '/admin/api/models/add', {
    method: 'POST',
    body: JSON.stringify({ providerId, models: [{ id: 'mock-model', alias: 'mock' }] }),
  });
  ok('加入模型链', addModels.status === 200 && addModels.data.added === 1, JSON.stringify(addModels.data));

  console.log('\n[4] Agent 感知网关模型链');
  const astate = await api('agent', '/agent/api/state');
  ok('embedded = true', astate.data.embedded === true);
  ok('模型列表来自网关', (astate.data.models || []).some((m) => m.id === 'mock'), JSON.stringify(astate.data.models));
  const setModel = await api('agent', '/agent/api/settings', { method: 'POST', body: JSON.stringify({ settings: { model: 'mock' } }) });
  ok('选择模型 mock', setModel.status === 200 && setModel.data.settings.model === 'mock');

  console.log('\n[5] 内嵌对话：直调 runChain → 工具写文件');
  const sess = await api('agent', '/agent/api/sessions', { method: 'POST', body: JSON.stringify({}) });
  const sid = sess.data.id;
  ok('创建会话', Boolean(sid));
  const msg = await api('agent', '/agent/api/sessions/' + sid + '/message', {
    method: 'POST',
    body: JSON.stringify({ text: '请创建一个文件记录合并版冒烟测试' }),
  });
  const events = (msg.data && msg.data.events) || [];
  ok('回合成功', msg.status === 200 && msg.data.ok === true, JSON.stringify(events.map((e) => e.type)));
  ok('工具调用发生', events.some((e) => e.type === 'tool_start' && e.name === 'workspace_write'));
  ok('流式增量存在', events.some((e) => e.type === 'delta'));
  const files = await api('agent', '/agent/api/files');
  ok('文件真实写入工作区', (files.data.files || []).some((f) => f.path === 'agent.md'), JSON.stringify((files.data.files || []).map((f) => f.path)));
  const search = await api('agent', '/agent/api/search?q=' + encodeURIComponent('冒烟'));
  ok('工作区检索可用', search.data.ok && search.data.count >= 1);

  console.log('\n[6] 用量记账到「内置 Agent」');
  const state2 = await api('admin', '/admin/api/state');
  const agentUsage = (state2.data.usage.keys || []).find((k) => k.id === 'agent-internal');
  ok('用量页出现内置 Agent', Boolean(agentUsage) && agentUsage.calls >= 1, JSON.stringify(state2.data.usage.keys.map((k) => k.id)));
  ok('模型归到 mock', agentUsage && (agentUsage.byModel || []).some((m) => m.name === 'mock'), JSON.stringify(agentUsage && agentUsage.byModel));

  console.log('\n[7] 网关原生接口不受影响');
  const keyCreate = await api('admin', '/admin/api/keys/create', { method: 'POST', body: JSON.stringify({ name: 'smoke' }) });
  ok('创建网关密钥', keyCreate.status === 200 && keyCreate.data.key, JSON.stringify(keyCreate.data));
  const gwKey = keyCreate.data.key;
  const badChat = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-gw-definitely-wrong' },
    body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }] }),
  });
  ok('错误网关密钥被拒（401）', badChat.status === 401, 'got ' + badChat.status);
  const goodChat = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + gwKey },
    body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const goodText = await goodChat.text();
  // 假上游永远回 SSE 流（带工具调用），网关原样透传就是正确行为
  ok('正确密钥走通转发（200，SSE 原样透传）', goodChat.status === 200 && goodText.includes('"choices"') && goodText.includes('data:'), 'got ' + goodChat.status + ' ' + goodText.slice(0, 120));

  console.log('\n' + (fail ? '❌' : '✅') + ' 合并版冒烟通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('合并版冒烟中断：', e.message);
  process.exit(1);
});
