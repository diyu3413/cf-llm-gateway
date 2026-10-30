// 网关客户端：agent 的所有模型调用都走 OpenAI 兼容网关（cf-llm-gateway）。
// 好处是白拿的：多提供商故障转移、失败冷却、流内错误识别都在网关侧做好了，
// 这里只需要老老实实发请求、流式读回。

import { consumeOpenAIStream } from './sse.js';

// 用户在设置里粘贴的地址可能是 origin（https://gw.example.com）也可能带 /v1。
// 网关同时接受 /v1/chat/completions 和 /chat/completions，这里统一归一成 origin，
// 永远拼 /v1/chat/completions，避免出现 /v1/v1/... 这种地址。
export function normalizeBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1$/i, '');
  return s;
}

/**
 * 发一次流式 chat/completions 并把流消费完。
 * 超时设计：只限时"等到响应头"（推理模型首包慢，60s 宽裕）；流开始后改判
 * "空闲超时"——每收到一个 chunk 就续期，上游停摆 120s 才掐断。
 */
export async function chatStream({ baseUrl, apiKey, model, messages, tools, onDelta, onReasoning, headerTimeoutMs = 60_000, idleTimeoutMs = 120_000 }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('还没有配置网关地址，请先到「设置」页填写。');
  if (!apiKey) throw new Error('还没有配置网关密钥，请先到「设置」页填写。');

  const controller = new AbortController();
  let headersDone = false;
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('idle')), idleTimeoutMs);
  };
  const headerTimer = setTimeout(() => {
    if (!headersDone) controller.abort(new Error('header-timeout'));
  }, headerTimeoutMs);

  let res;
  try {
    res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model || 'auto',
        messages,
        stream: true,
        ...(tools && tools.length ? { tools } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(headerTimer);
    clearTimeout(idleTimer);
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    throw new Error(
      aborted
        ? headersDone
          ? '上游流停摆超过 ' + Math.round(idleTimeoutMs / 1000) + ' 秒，已中断。'
          : '等待网关响应头超时（' + Math.round(headerTimeoutMs / 1000) + ' 秒）。'
        : '调用网关失败：' + String((err && err.message) || err)
    );
  }
  headersDone = true;
  clearTimeout(headerTimer);

  if (!res.ok) {
    clearTimeout(idleTimer);
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      detail = '';
    }
    throw new Error('网关返回 ' + res.status + '：' + (detail || res.statusText));
  }
  if (!res.body) {
    clearTimeout(idleTimer);
    throw new Error('网关没有返回响应体。');
  }

  try {
    armIdle();
    // 给读循环包一层：每读到数据就喂一次空闲计时器
    const tracked = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, ctrl) {
          armIdle();
          ctrl.enqueue(chunk);
        },
        flush() {
          clearTimeout(idleTimer);
        },
      })
    );
    const parsed = await consumeOpenAIStream(tracked, { onDelta, onReasoning });
    clearTimeout(idleTimer);
    return parsed;
  } catch (err) {
    clearTimeout(idleTimer);
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    // 流已经吐了一部分的中断，把已有内容带回去，让上层决定算成功还是报错
    const partial = await salvageParsed(err);
    if (partial) return partial;
    throw new Error(aborted ? '流式响应中断。' : '读取流式响应失败：' + String((err && err.message) || err));
  }
}

// 中断时尽量把已解析的部分捞回来 —— consumeOpenAIStream 是黑盒拿不到中间态，
// 所以这里退而求其次：中断就当失败处理，partial 留给未来改进。
async function salvageParsed(_err) {
  return null;
}
