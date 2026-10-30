// Agent 工具循环。
//
// 每一轮：把完整对话历史发给网关 → 文本增量边收边推给前端 → 若模型要调工具，
// 逐个执行并把结果喂回去 → 直到模型给出不含工具调用的最终回答，或触及单轮
// 工具次数上限（免费版每次 Worker 调用最多 50 个子请求，模型调用是这里唯一的
// 子请求大头，上限就是防打爆的）。
//
// 本模块不碰 R2/D1/DO —— 执行工具靠注入的 execTool，发消息靠注入的 fetchChat，
// 推送靠注入的 emit。这样整个循环可以在 Node 里用假网关完整测试。

import { toolsSchema, toolResultText } from './workspace.js';
import { buildSystemPrompt, fileOverviewText } from './prompts.js';

export { toolsSchema };

/** 组装一次性模型调用参数里用到的 tools（收尾强制总结时不带工具）。 */
export function chatTools() {
  return toolsSchema();
}

/**
 * 历史裁剪：按「用户消息开启的一段对话」成组丢弃最旧段，保住 assistant/tool
 * 消息的配对完整（OpenAI 协议不允许 tool 消息脱离它的 tool_calls 前驱单独存在）。
 * system 提示不在 history 里（每轮由 prompts.js 现拼），不用管。
 */
export function trimHistory(history, budget) {
  const size = (m) => String(m.content || '').length + JSON.stringify(m.tool_calls || '').length;
  let total = 0;
  for (const m of history) total += size(m);

  // 找到每段的开头（user 消息下标）
  const starts = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') starts.push(i);
  }
  if (!starts.length) return history;

  // 至少保留最后一段；前面的段从旧到新逐段丢，直到达标
  let cut = 0; // 可以安全丢弃的前缀长度
  for (let s = 0; s < starts.length - 1 && total > budget; s++) {
    const end = starts[s + 1];
    for (let i = cut; i < end; i++) total -= size(history[i]);
    cut = end;
  }
  return cut ? history.slice(cut) : history;
}

// 工具结果的 UI 摘要：一两句话，给前端工具卡片用。
export function toolBrief(name, args, result) {
  if (!result) return '';
  if (result.ok === false) return truncate(result.error || '执行失败');
  switch (name) {
    case 'workspace_list':
      return (result.count || 0) + ' 个文件' + (result.truncated ? '（还有更多）' : '');
    case 'workspace_read':
      return result.path + '（' + (result.total_chars || 0) + ' 字符' + (result.truncated ? '，未读完' : '') + '）';
    case 'workspace_write':
      return result.path + '（写入 ' + (result.size || 0) + ' 字符）';
    case 'workspace_edit':
      return result.path + '（' + (result.change || '已修改') + '）';
    case 'workspace_delete':
      return (result.deleted || []).join('、');
    case 'workspace_search':
      return '命中 ' + (result.count || 0) + ' 个文件';
    case 'web_search':
      return '搜索到 ' + (result.count || 0) + ' 条结果';
    case 'web_fetch':
      return truncate((result.url || '') + '（' + (result.chars || 0) + ' 字符）');
    case 'schedule_task':
      return '已安排：' + truncate(args && args.instruction);
    default:
      return truncate(JSON.stringify(result));
  }
}

function truncate(s, n = 80) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 跑一轮完整的 agent 回复。
 * @param opts.history   OpenAI messages 数组（不含 system），会被原地追加
 * @param opts.userText  用户这条消息的文本
 * @param opts.emit      事件回调：{type:'delta'|'tool_start'|'tool_end'|'notice'}
 * @param opts.execTool  async (name, args) => result 对象
 * @param opts.fetchChat async ({messages, tools, onDelta}) => sse.js 的解析结果
 * @param opts.onAppend  每追加一条消息时的持久化回调（DO 存 SQLite 用）
 * @returns {{ok, usage, iterations, filesTouched, error?}}
 */
export async function runAgentTurn(opts) {
  const { history, userText, emit, execTool, fetchChat, onAppend, maxToolCalls = 12, maxHistoryChars = 96_000, systemPrompt = '', fileOverview = '', web = null, tools = null } = opts;

  const push = (msg) => {
    history.push(msg);
    if (onAppend) onAppend(msg);
  };

  push({ role: 'user', content: userText });
  const trimmed = trimHistory(history, maxHistoryChars);
  if (trimmed !== history) {
    history.length = 0;
    history.push(...trimmed);
    if (emit) emit({ type: 'notice', text: '会话太长，已丢弃最早的几段对话。' });
  }

  const messages = () => [{ role: 'system', content: buildSystemPrompt({ systemPrompt, fileOverview, web }) }].concat(history);
  // 工具集由调用方注入（DO 会按设置拼上联网工具）；不传就是纯工作区工具
  const toolset = tools && tools.length ? tools : chatTools();
  const filesTouched = new Set();
  let iterations = 0;
  let usage = null; // 最后一次模型调用的 usage（保留给旧行为）
  const usageTotal = { prompt: 0, completion: 0, cached: 0 }; // 整轮所有模型调用累计

  for (;;) {
    iterations += 1;
    const allowTools = iterations <= maxToolCalls;
    if (!allowTools && emit) emit({ type: 'notice', text: '已达单轮工具调用上限（' + maxToolCalls + ' 次），不再执行工具，直接总结。' });

    let res;
    try {
      res = await fetchChat({
        messages: messages(),
        tools: allowTools ? toolset : undefined,
        onDelta: (t) => emit && emit({ type: 'delta', text: t }),
        // 推理模型的思考过程：显示用，不入库也不回传给上游
        onReasoning: (t) => emit && emit({ type: 'reasoning', text: t }),
      });
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (emit) emit({ type: 'error', message: msg });
      return { ok: false, error: msg, iterations, filesTouched: [...filesTouched], usage, usageTotal };
    }

    if (res.error && !res.content && !res.toolCalls.length) {
      // 流里报了错且没产出任何内容：这轮作废
      const msg = '模型流返回错误：' + res.error;
      if (emit) emit({ type: 'error', message: msg });
      return { ok: false, error: msg, iterations, filesTouched: [...filesTouched], usage, usageTotal };
    }
    if (res.usage) {
      usage = res.usage;
      usageTotal.prompt += res.usage.prompt || 0;
      usageTotal.completion += res.usage.completion || 0;
      usageTotal.cached += res.usage.cached || 0;
    }

    if (res.toolCalls.length && allowTools) {
      // reasoning 随 assistant 消息持久化：刷新/切页回来还能展开回看
      if (res.content) push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls, reasoning: res.reasoning || '' });
      else push({ role: 'assistant', content: '', tool_calls: res.toolCalls, reasoning: res.reasoning || '' });

      for (const call of res.toolCalls) {
        const name = call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = null;
        }
        if (emit) emit({ type: 'tool_start', name, args: safePreview(args) });
        const startedAt = Date.now();

        let result;
        if (!args) {
          result = { ok: false, error: '工具参数不是合法 JSON。' };
        } else if (name === 'schedule_task') {
          result = await execTool(name, args);
        } else {
          result = await execTool(name, args);
          if (result && result.ok) {
            const touched =
              result.path || (Array.isArray(result.deleted) ? result.deleted : null);
            if (touched) for (const p of [].concat(touched)) filesTouched.add(p);
          }
        }
        // ms 让前端在工具卡片上标出「做了这件事，花了多久」，行动可查证
        if (emit) emit({ type: 'tool_end', name, ok: Boolean(result && result.ok), brief: toolBrief(name, args, result), ms: Date.now() - startedAt });
        push({ role: 'tool', tool_call_id: call.id, content: toolResultText(result || { ok: false, error: '工具没有返回结果。' }) });
      }
      continue; // 带着工具结果再问一轮
    }

    // 没有工具调用：这就是最终回答
    push({ role: 'assistant', content: res.content || '', reasoning: res.reasoning || '' });
    return { ok: true, usage, usageTotal, iterations, filesTouched: [...filesTouched] };
  }
}

function safePreview(args) {
  if (!args || typeof args !== 'object') return '';
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return '';
  }
}
