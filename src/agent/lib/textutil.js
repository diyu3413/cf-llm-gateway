// 工作区路径与文本的小工具。路径校验是安全边界：所有工具调用和 REST 接口
// 都必须先过 normalizeWorkspacePath，防目录穿越和写入 R2 意外位置。

// 常见文本扩展名。没列出的（含无扩展名）也允许当文本，但要过二进制嗅探。
const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc',
  'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue',
  'svelte', 'astro', 'xml', 'svg', 'proto', 'graphql', 'gql', 'dockerfile', 'makefile', 'cmake', 'gradle', 'env',
  'gitignore', 'editorconfig', 'license', 'readme', 'patch', 'diff', 'tex', 'bib', 'srt', 'vtt', 'sub',
]);

export function extOf(path) {
  const base = String(path || '').split('/').pop() || '';
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return base.toLowerCase(); // Dockerfile / Makefile 这类
  return base.slice(idx + 1).toLowerCase();
}

export function isTextPath(path) {
  return TEXT_EXTS.has(extOf(path));
}

// 粗暴但有效的二进制嗅探：前 8KB 里出现 NUL 或高比例控制字符就不当文本处理。
export function looksBinary(text) {
  const head = String(text || '').slice(0, 8192);
  if (head.includes('\0')) return true;
  let ctrl = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if ((c < 9 && c >= 0) || (c > 13 && c < 32 && c !== 27)) ctrl += 1;
  }
  return head.length > 0 && ctrl / head.length > 0.06;
}

/**
 * 规范化工作区相对路径。规则：
 *  - 统一正斜杠；去首尾斜杠；折叠连续斜杠
 *  - 拒绝空路径、. / .. 段、控制字符、超过 512 字符
 * 返回规范化后的路径，不合法直接抛错（错误信息给模型看，让它自己修正）。
 */
export function normalizeWorkspacePath(input) {
  const raw = String(input == null ? '' : input).trim().replace(/\\/g, '/');
  if (!raw) throw new Error('路径不能为空');
  if (raw.length > 512) throw new Error('路径过长（最多 512 字符）');
  const parts = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw new Error('路径不允许包含 ..（工作区是平的相对路径，不是文件系统）');
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(seg)) throw new Error('路径包含非法控制字符');
    parts.push(seg);
  }
  if (!parts.length) throw new Error('路径不能为空');
  return parts.join('/');
}

// 子串出现次数。workspace_edit 要求恰好命中一次，多了让模型把 old_string 写长一点。
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const hit = haystack.indexOf(needle, i);
    if (hit < 0) break;
    n += 1;
    i = hit + needle.length;
    if (n > 1000) break; // 防御极端情况吃满 CPU
  }
  return n;
}

export function truncateChars(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  return s.slice(0, n);
}

// 给模型看的 diff 摘要：改了哪几行（按替换点的行号粗算），不生成完整 diff。
export function diffSummary(before, oldString, newString) {
  const upto = before.indexOf(oldString);
  if (upto < 0) return '';
  const line = before.slice(0, upto).split('\n').length;
  const removedLines = oldString.split('\n').length;
  const addedLines = newString.split('\n').length;
  return '第 ' + line + ' 行起替换 ' + removedLines + ' 行 → ' + addedLines + ' 行';
}

const CJK_RE = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u3000-\u303F]/;

// FTS 内容预处理：unicode61 分词器不切 CJK，一整段中文会粘成一个 token，
// 查询永远命中不了。这里把连续 CJK 切成「单字 + 相邻二字组」，查询侧做同样的
// 变换，两端对齐后 2 字以上的中文词都能命中；1 个字靠单字 token 兜底。
// 拉丁文按空白分词本就没问题，原样保留。
export function cjkSegment(text) {
  let out = '';
  let run = '';
  const flush = () => {
    if (!run) return;
    for (let i = 0; i < run.length; i++) {
      out += ' ' + run[i];
      if (i + 1 < run.length) out += ' ' + run[i] + run[i + 1];
    }
    run = '';
  };
  for (const ch of String(text || '')) {
    if (CJK_RE.test(ch)) run += ch;
    else {
      flush();
      out += ' ' + ch;
    }
  }
  flush();
  return out;
}

// FTS5 MATCH 的安全构造：把查询拆词、每词加引号、AND 连接。
// 直接透传用户/模型给的 MATCH 表达式会撞上语法错误（比如带连字符的词）。
export function ftsMatchExpression(query) {
  const tokens = String(query || '')
    .split(/\s+/)
    .map((t) => t.replace(/^"+|"+$/g, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return '';
  const parts = [];
  for (const t of tokens) {
    if (CJK_RE.test(t)) {
      for (const s of new Set(cjkSegment(t).trim().split(/\s+/).filter(Boolean))) {
        parts.push('"' + s.replace(/"/g, '""') + '"');
      }
    } else {
      parts.push('"' + t.replace(/"/g, '""') + '"');
    }
  }
  if (!parts.length) return '';
  return [...new Set(parts)].join(' AND ');
}
