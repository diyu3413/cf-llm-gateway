// OpenAI 流式响应解析：把上游 SSE 增量流消费成「文本增量 + 工具调用累积」。
//
// 为什么自己写而不用 SDK：零依赖原则，而且这里的语义比通用 SDK 窄得多 ——
// 只认 chat.completions 的 chunk 结构。解析按行切分，与 cf-llm-gateway 同一套手法。

/**
 * 消费一条 OpenAI chat.completions SSE 流。
 * @param readable  Response.body
 * @param handlers  文本增量回调 onDelta(text)；或对象 { onDelta, onReasoning }
 * @returns {{content, reasoning, toolCalls, finishReason, usage, error}}
 *   toolCalls: [{ id, type:'function', function:{ name, arguments } }]（按 index 合并增量）
 *   reasoning: 思考过程全文（reasoning_content / reasoning 增量合并），没有则为空串
 *   usage:     { prompt, completion, cached }，cached 是缓存命中 token（各家字段名不一，
 *              OpenAI prompt_tokens_details.cached_tokens / DeepSeek prompt_cache_hit_tokens /
 *              Anthropic 兼容层 cache_read_input_tokens，取到哪个算哪个），不支持则为 0
 *   error:     流里出现的错误消息（含网关合成的中途错误），没有则为空串
 */
export async function consumeOpenAIStream(readable, handlers) {
  const h = typeof handlers === 'function' ? { onDelta: handlers } : handlers || {};
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  let error = '';
  const toolAcc = new Map(); // openai tool index -> { id, name, arguments }
  let order = []; // 保持出现顺序

  function handleData(payload) {
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return; // 不完整的块，跳过
    }
    if (json.error && !Array.isArray(json.choices)) {
      const e = json.error;
      error = String((e && (e.message || e.msg)) || e) || '上游流返回错误。';
      return;
    }
    if (json.usage && typeof json.usage === 'object') {
      const u = json.usage;
      usage = {
        prompt: Number(u.prompt_tokens) || 0,
        completion: Number(u.completion_tokens) || 0,
        cached:
          Number((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0) ||
          Number(u.prompt_cache_hit_tokens) ||
          Number(u.cache_read_input_tokens) ||
          0,
      };
    }
    const choice = (json.choices && json.choices[0]) || {};
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      if (h.onDelta) {
        try {
          h.onDelta(delta.content);
        } catch {
          /* UI 回调出错不能打断解析 */
        }
      }
    }
    // 推理模型的思考增量：DeepSeek-R1 / GLM / QwQ 等用 reasoning_content，个别用 reasoning
    const think = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (think) {
      reasoning += think;
      if (h.onReasoning) {
        try {
          h.onReasoning(think);
        } catch {
          /* 同上 */
        }
      }
    }
    for (const tc of delta.tool_calls || []) {
      const idx = typeof tc.index === 'number' ? tc.index : 0;
      let acc = toolAcc.get(idx);
      if (!acc) {
        acc = { id: '', name: '', arguments: '' };
        toolAcc.set(idx, acc);
        order.push(idx);
      }
      if (tc.id) acc.id = tc.id;
      const fn = tc.function || {};
      if (fn.name) acc.name += fn.name; // 个别上游会把函数名拆进多个增量
      if (fn.arguments) acc.arguments += fn.arguments;
    }
  }

  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) handleData(line.slice(5).trim());
    }
    if (buf.length > 1_048_576) {
      // 上游不按 SSE 规矩发换行时防缓冲无限涨
      const idx = buf.lastIndexOf('\n');
      const keep = idx >= 0 ? buf.slice(idx + 1) : '';
      const drop = idx >= 0 ? buf.slice(0, idx + 1) : buf;
      for (const l of drop.split('\n')) {
        const t = l.trim();
        if (t.startsWith('data:')) handleData(t.slice(5).trim());
      }
      buf = keep;
    }
  }
  buf += dec.decode();
  for (const l of buf.split('\n')) {
    const t = l.trim();
    if (t.startsWith('data:')) handleData(t.slice(5).trim());
  }

  const toolCalls = order
    .sort((a, b) => a - b)
    .map((idx, i) => {
      const acc = toolAcc.get(idx);
      return {
        id: acc.id || 'call_' + String(i),
        type: 'function',
        function: { name: acc.name, arguments: acc.arguments || '{}' },
      };
    })
    .filter((tc) => tc.function.name);

  return { content, reasoning, toolCalls, finishReason, usage, error };
}
