// 【覆盖实现】内嵌模型通道：直接调用网关的故障转移链（runChain），不走 HTTP、
// 不需要地址和密钥 —— 网关「提供商/模型链」页配置了什么，agent 就能用什么。
// 本文件只存在于合并部署（cf-llm-gateway 仓库）；独立部署的原始版本在
// cf-agent-web 仓库，同步脚本（scripts/sync-agent.mjs）刻意不覆盖这里。
// 两边签名一致：buildFetchChat(env, settings) => ({messages, tools, onDelta}) => 解析结果

import { loadConfig } from '../../lib/config.js';
import { runChain, chainFailureResponse, streamTailError, accountCall } from '../../lib/proxy.js';
import { meterBody, flushUsage } from '../../lib/usage.js';
import { consumeOpenAIStream } from './sse.js';
import { chatStream } from './llm.js';

// 内嵌调用的用量都记在这把虚拟密钥上，「用量」页能看到 agent 消耗了多少
const AGENT_AUTH = { id: 'agent-internal', name: '内置 Agent' };

// 关键的 isolate 细节：内嵌调用发生在 DO 的 isolate 里，recordUsage 累加的是
// DO 私有的内存 delta —— worker 侧的用量页读不到它。所以这里必须由 DO 主动
// 把 delta 落进 KV（30 秒节流），worker 侧的 usageSnapshot 读 KV 基线才能看到。
// 独立 worker 侧的 /v1/* 流量仍走原来的 maybeFlushUsage，两边互不重复计算。
function noteAgentUsage(env, config, model, body, usage, outChars, outCjk) {
  accountCall({ config, auth: AGENT_AUTH, model, endpoint: 'chat', body, usage, outChars, outCjk });
  flushUsage(env, { intervalSeconds: 30 }).catch(() => {});
}

export function buildFetchChat(env, settings) {
  // 没绑 KV 就不可能是合并部署，退回独立部署的远端通道（理论上到不了这里）
  if (!env.KV) {
    return ({ messages, tools, onDelta }) =>
      chatStream({ baseUrl: settings.gatewayBaseUrl, apiKey: settings.gatewayKey, model: settings.model, messages, tools, onDelta });
  }
  return async ({ messages, tools, onDelta, onReasoning }) => {
    const config = await loadConfig(env);
    const body = { model: settings.model || 'auto', messages, stream: true, ...(tools && tools.length ? { tools } : {}) };
    const result = await runChain({ env, config, body, path: 'chat/completions' });
    if (!result.ok) {
      const failure = chainFailureResponse(result);
      const detail = await failure.json();
      throw new Error((detail && detail.error && detail.error.message) || '网关调用失败');
    }
    // 流尾错误收口、SSE 内错误识别（runChain 已做首块）、用量记账，全部与网关转发路径同一套
    let stream = streamTailError(result.body || result.res.body);
    stream = meterBody(stream, {
      stream: true,
      onDone: ({ usage, outChars, outCjk }) => noteAgentUsage(env, config, result.model, body, usage, outChars, outCjk),
    });
    return consumeOpenAIStream(stream, { onDelta, onReasoning });
  };
}
