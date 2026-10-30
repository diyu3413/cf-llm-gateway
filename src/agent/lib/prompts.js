// 系统提示词。工具的参数格式由 tools schema 声明，这里只讲策略和工作区现状。
// 刻意保持简短：系统提示每轮都发，长了白烧 token。

import { truncateChars } from './textutil.js';

const BASE = `你是一个运行在网页里的文件工作区助手。用户的工作区是一块对象存储（R2）上的平铺路径空间，没有真实文件系统：没有终端、不能执行代码或命令、没有 git。你能做的事就是通过工具读写和检索工作区里的文本文件。

工作守则：
- 改已有文件一律优先 workspace_edit（精确替换），整体重写才用 workspace_write。
- workspace_edit 的 old_string 必须与原文逐字符一致且只命中一处；先 workspace_read 确认原文再改。
- 长文件读不完时用返回的 next_offset 继续，别凭想象补全没读到的部分。
- 动手前先想清楚要改哪些文件；一批相关修改做完后，可以用 workspace_search 抽查结果。
- 回答里引用文件时给出路径。找不到信息就直说，不要编造工作区里不存在的内容。
- 你的定时能力只有 schedule_task（到点把你唤醒继续干活），没有后台进程。
- 用中文回复用户。`;

/** 组装系统提示。fileOverview 是本轮开始时的工作区顶层文件清单（帮模型建立方位感）。 */
export function buildSystemPrompt({ systemPrompt, fileOverview, web }) {
  let out = BASE;
  if (web && (web.search || web.fetch)) {
    const parts = [];
    if (web.search) parts.push('web_search（联网搜索，问时效性问题：新闻/价格/版本/天气等）');
    if (web.fetch) parts.push('web_fetch（抓取网页正文）');
    out += '\n\n联网能力：你有 ' + parts.join(' 和 ') + '。引用网络结果时给出链接；工作区里的问题优先用工作区工具。';
  }
  if (fileOverview) {
    out += '\n\n当前工作区顶层内容（路径 大小/字节）：\n' + fileOverview;
  } else {
    out += '\n\n当前工作区是空的。';
  }
  if (systemPrompt && String(systemPrompt).trim()) {
    out += '\n\n用户附加要求（优先级高于上面的一般守则）：\n' + truncateChars(String(systemPrompt).trim(), 4000);
  }
  return out;
}

/** 顶层文件清单：压到 60 行以内，超出折叠计数。 */
export function fileOverviewText(files) {
  if (!files || !files.length) return '';
  const lines = files.slice(0, 60).map((f) => f.path + '  ' + f.size + 'B');
  if (files.length > 60) lines.push('…另有 ' + (files.length - 60) + ' 个文件未列出');
  return lines.join('\n');
}
