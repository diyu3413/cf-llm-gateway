// 联网工具：web_search / web_fetch。
//
// 搜索走设置页配置的「Tavily 兼容」REST 端点。Tavily 的 MCP 链接本质是同一个
// 服务的另一层协议包装，直连 REST（POST {query} → {results:[{title,url,content}]})
// 少一层握手、零依赖就能解析；换其他服务商只要请求/响应形状兼容即可。
// 抓取（web_fetch）由 Worker 原生完成：拉网页 → 剥 HTML → 纯文本，独立于搜索
// 配置，免费额度内随便用。两个工具都可独立开关。

import { truncateChars } from './textutil.js';

export function webSearchEnabled(settings) {
  return Boolean(settings && settings.webSearchUrl);
}

export function webFetchEnabled(settings) {
  return settings ? settings.webFetchEnabled !== false : true;
}

/** 按配置动态生成联网工具的 schema（空数组 = 都没开）。 */
export function webToolsSchema(settings) {
  const tools = [];
  if (webSearchEnabled(settings)) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息，返回网页标题、链接和内容摘录。遇到时效性问题（新闻/价格/版本/天气/近期事件）时用它。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
    });
  }
  if (webFetchEnabled(settings)) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取一个网页的正文纯文本（自动去 HTML 标签）。常与 web_search 配合：先搜到链接，再抓全文细读。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整的 http(s) 网页地址' },
          },
          required: ['url'],
        },
      },
    });
  }
  return tools;
}

export async function execWebTool(name, args, settings) {
  if (name === 'web_search') return webSearch(args, settings);
  if (name === 'web_fetch') return webFetch(args);
  return { ok: false, error: '没有这个工具：' + name };
}

async function webSearch(args, settings) {
  const query = String((args && args.query) || '').trim();
  if (!query) return { ok: false, error: 'query 不能为空。' };
  if (!webSearchEnabled(settings)) return { ok: false, error: '搜索接口未配置：请到设置页「联网」填搜索端点。' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(settings.webSearchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.webSearchKey ? { Authorization: 'Bearer ' + settings.webSearchKey } : {}),
      },
      body: JSON.stringify({ query, max_results: 5 }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: '搜索接口返回 ' + res.status + '：' + truncateChars(text, 200) };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: '搜索接口返回的不是 JSON，检查端点地址是否指向搜索 API。' };
    }
    const arr = Array.isArray(data.results) ? data.results : Array.isArray(data.data) ? data.data : [];
    const results = arr.slice(0, 5).map((r) => ({
      title: String((r && r.title) || ''),
      url: String((r && r.url) || ''),
      snippet: truncateChars(String((r && (r.content || r.snippet)) || ''), 400),
    }));
    if (data.answer) {
      // Tavily 的直接回答一并带上，模型可以少抓一次网页
      results.unshift({ title: '(搜索接口的直接回答)', url: '', snippet: truncateChars(String(data.answer), 500) });
    }
    if (!results.length) return { ok: true, query, count: 0, results: [], note: '搜索接口没有返回结果。' };
    return { ok: true, query, count: results.length, results };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { ok: false, error: aborted ? '搜索超时（25s）。' : '搜索失败：' + String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function webFetch(args) {
  let target = String((args && args.url) || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '只支持 http(s) 网页地址。' };
  target = target.split(/\s/)[0]; // 只取 URL 本体，参数里夹带别的东西一律丢弃

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; cf-agent-web/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    let raw = await res.text();
    if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const content = ct.includes('html') ? htmlToText(raw) : raw;
    if (!content.trim()) {
      return { ok: res.ok, status: res.status, url: target, content: '(页面没有可提取的文本，可能是纯 JS 渲染的页面。)' };
    }
    return { ok: res.ok, status: res.status, url: target, chars: content.length, content: truncateChars(content, 24_000) };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { ok: false, error: aborted ? '抓取超时（25s）。' : '抓取失败：' + String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// 剥 HTML 成可读文本：去脚本样式注释、块级标签转换行、实体还原、压空白
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
