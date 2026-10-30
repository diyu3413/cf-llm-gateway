// 极简 Markdown 渲染器。
//
// 安全模型：先整体 HTML 转义、再在自己生成的标签上做替换 —— 模型输出里的任何
// HTML（含 <script>）都会被当成纯文本显示，天然免疫注入，不需要额外 sanitizer。
// 支持对话场景够用的子集：标题(#{1,4})/粗斜体/删除线/行内代码/围栏代码块/
// 有序无序列表/引用/分割线/链接（仅 http(s)，新窗口打开）。表格暂不支持。
//
// 独立成模块是为了能在 Node 里直接单测；html.js 构建时把它 toString() 内联进
// 页面脚本，前端通过全局 mdRender 调用。

export function renderMarkdown(src) {
  src = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 围栏代码块先摘出来存占位符，块内容只做转义，避免被行内规则二次加工
  const fences = [];
  src = src.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    const label = String(lang || '').trim();
    fences.push(
      '<pre class="code mdcode">' +
        (label ? '<span class="mdlang">' + esc(label) + '</span>' : '') +
        esc(code.replace(/\n$/, '')) +
        '</pre>'
    );
    return '\u0000F' + (fences.length - 1) + '\u0000';
  });

  const inline = (s) => {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code class="mdcode-i">$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  };

  const lines = src.split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  let quote = false;
  const closeList = () => {
    if (list) {
      out.push('</' + list + '>');
      list = null;
    }
  };
  const closeQuote = () => {
    if (quote) {
      out.push('</blockquote>');
      quote = false;
    }
  };

  for (const raw of lines) {
    const t = raw.trim();
    const fence = t.match(/^\u0000F(\d+)\u0000$/);
    if (fence) {
      closeList();
      closeQuote();
      out.push(fences[Number(fence[1])]);
      continue;
    }
    if (!t) {
      closeList();
      closeQuote();
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      closeQuote();
      const lv = h[1].length;
      out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
      continue;
    }
    if (/^(---+|\*\*\*+|___+)\s*$/.test(t)) {
      closeList();
      closeQuote();
      out.push('<hr>');
      continue;
    }
    // 块级检测在转义前做（此时 '>' 还是原字符），行内内容再转义
    const q = t.match(/^>\s?(.*)$/);
    if (q) {
      closeList();
      if (!quote) {
        out.push('<blockquote>');
        quote = true;
      }
      out.push('<p>' + inline(q[1]) + '</p>');
      continue;
    }
    closeQuote();
    const ul = t.match(/^[-*+]\s+(.*)$/);
    // 点号后必须有空格（防止 3.14 被当成列表）；顿号/右括号后可无空格（中文习惯 2、x / 2) x）
    const ol = t.match(/^(\d+)(?:[.]\s+|[、)]\s*)(.*)$/);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push('<li>' + inline(ul[1]) + '</li>');
      continue;
    }
    if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push('<li>' + inline(ol[2]) + '</li>');
      continue;
    }
    closeList();
    out.push('<p>' + inline(t) + '</p>');
  }
  closeList();
  closeQuote();
  return out.join('\n');
}
