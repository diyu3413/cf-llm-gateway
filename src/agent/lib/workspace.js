// 工作区工具层：R2 存正文，D1 存索引（files 表 + files_fts 全文索引）。
//
// 这是 agent 工具和 REST 文件接口共用的唯一实现，两边行为完全一致。
// 一致性策略：先写 R2，成功后再同步 D1 索引；索引失败只降级（搜不到）不回滚，
// 下次对同一文件写入会自动把索引补齐 —— 比起分布式事务，个人工作区里
// "偶尔要重写一次文件才搜得到" 是更划算的取舍。

import {
  normalizeWorkspacePath,
  looksBinary,
  countOccurrences,
  truncateChars,
  diffSummary,
  ftsMatchExpression,
  cjkSegment,
  isTextPath,
} from './textutil.js';

// 超过这个大小的文本不进全文索引：FTS 行写放大明显，大文件的价值也低。
const FTS_INDEX_MAX_BYTES = 131_072;
const LIST_PAGE = 100;

/** 给模型用的工具 schema（OpenAI function 格式）。 */
export function toolsSchema() {
  return [
    {
      type: 'function',
      function: {
        name: 'workspace_list',
        description: '列出工作区里的文件。返回路径、大小和修改时间。可用 prefix 只看某个目录前缀。',
        parameters: {
          type: 'object',
          properties: {
            prefix: { type: 'string', description: '可选。路径前缀过滤，如 "docs/"' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'workspace_read',
        description:
          '读取工作区里一个文本文件的内容。文件过长时只返回前一段并带 offset 字段，用 offset 继续读后面。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，如 "notes/todo.md"' },
            offset: { type: 'number', description: '可选。从第几个字符开始读（上一段结果的 next_offset）' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'workspace_write',
        description: '创建或整体覆盖一个文本文件。修改已有文件请优先用 workspace_edit，只传要改的部分。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
            content: { type: 'string', description: '完整的文件内容（会整体覆盖）' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'workspace_edit',
        description:
          '精确替换文件里的一段文本。old_string 必须在文件里恰好出现一次；命中多次时会报错，请把 old_string 写得更长以定位。这是修改文件的首选方式。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
            old_string: { type: 'string', description: '要被替换的原文（精确匹配，含缩进和换行）' },
            new_string: { type: 'string', description: '替换后的文本' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'workspace_delete',
        description: '删除一个或多个文件。路径之间用数组给出，删除不可撤销。',
        parameters: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' }, description: '要删除的路径列表' },
          },
          required: ['paths'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'workspace_search',
        description:
          '全文检索工作区里的文本文件（所有词都要命中），返回命中文件和摘录。想找"哪个文件提到了 X"时用它，比逐个读文件快得多。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词，多个词用空格分开（AND 语义）' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_task',
        description:
          '给自己安排一个稍后执行的任务：到点后会以一条系统消息唤醒你继续处理。适合"一小时后提醒我检查 xx""明天继续写第 3 章"这类事。',
        parameters: {
          type: 'object',
          properties: {
            delay_minutes: { type: 'number', description: '多少分钟后执行（1 ~ 43200，即最多 30 天）' },
            instruction: { type: 'string', description: '到点后要做什么的完整说明，未来的你只能看到这段话' },
          },
          required: ['delay_minutes', 'instruction'],
        },
      },
    },
  ];
}

// ---------- 内部：D1 索引 ----------

async function indexUpsert(db, path, size, mtime, text) {
  const isText = 1;
  const indexable = isTextPath(path) && size <= FTS_INDEX_MAX_BYTES && !looksBinary(text);
  const stmts = [
    db
      .prepare(
        'INSERT INTO files (path, size, mtime, is_text) VALUES (?1, ?2, ?3, ?4) ' +
          'ON CONFLICT(path) DO UPDATE SET size = ?2, mtime = ?3, is_text = ?4'
      )
      .bind(path, size, mtime, isText),
    db.prepare('DELETE FROM files_fts WHERE path = ?1').bind(path),
  ];
  if (indexable) {
    stmts.push(db.prepare('INSERT INTO files_fts (path, content) VALUES (?1, ?2)').bind(path, cjkSegment(text)));
  }
  await db.batch(stmts);
}

async function indexRemove(db, path) {
  await db.batch([
    db.prepare('DELETE FROM files WHERE path = ?1').bind(path),
    db.prepare('DELETE FROM files_fts WHERE path = ?1').bind(path),
  ]);
}

// ---------- 工具实现 ----------

export async function wsList(r2, prefix, cursor) {
  let pre = '';
  if (prefix) {
    try {
      pre = normalizeWorkspacePath(prefix);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    pre += '/';
  }
  const res = await r2.list({ prefix: pre, cursor: cursor || undefined, limit: LIST_PAGE });
  return {
    ok: true,
    count: res.objects.length,
    truncated: Boolean(res.truncated),
    next_cursor: res.truncated ? res.cursor : '',
    files: res.objects.map((o) => ({
      path: o.key,
      size: o.size,
      mtime: o.uploaded ? Math.floor(o.uploaded.getTime() / 1000) : 0,
    })),
  };
}

export async function wsRead(r2, path, offset, maxChars = 48_000) {
  let p;
  try {
    p = normalizeWorkspacePath(path);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const obj = await r2.get(p);
  if (!obj) return { ok: false, error: '文件不存在：' + p };
  const body = await obj.text();
  if (looksBinary(body)) return { ok: false, error: '这是二进制文件，读不了文本。' };
  const start = Math.max(0, Math.min(Number(offset) || 0, body.length));
  const chunk = body.slice(start, start + maxChars);
  const next = start + chunk.length;
  return {
    ok: true,
    path: p,
    total_chars: body.length,
    offset: start,
    next_offset: next < body.length ? next : null,
    truncated: next < body.length,
    content: chunk,
  };
}

export async function wsWrite(r2, db, path, content, maxChars) {
  let p;
  try {
    p = normalizeWorkspacePath(path);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const text = String(content == null ? '' : content);
  if (text.length > maxChars) {
    return { ok: false, error: '内容太长（' + text.length + ' 字符，上限 ' + maxChars + '）。请拆成多个文件或分次写入。' };
  }
  if (looksBinary(text)) return { ok: false, error: '内容像是二进制数据，工作区只收文本。' };
  const now = Date.now();
  await r2.put(p, text);
  try {
    await indexUpsert(db, p, text.length, now, text);
  } catch {
    /* 索引失败不挡写入本身，见文件头注释 */
  }
  return { ok: true, path: p, size: text.length, created_or_updated: 'written' };
}

export async function wsEdit(r2, db, path, oldString, newString, maxChars) {
  let p;
  try {
    p = normalizeWorkspacePath(path);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!oldString) return { ok: false, error: 'old_string 不能为空。' };
  if (oldString === newString) return { ok: false, error: 'old_string 和 new_string 一样，没有可改的。' };

  // 并发保护：拿着读到的 etag 做条件写（R2 onlyIf），有人抢先改过就重读重试。
  for (let attempt = 0; attempt < 2; attempt++) {
    const obj = await r2.get(p);
    if (!obj) return { ok: false, error: '文件不存在：' + p };
    const text = await obj.text();
    if (looksBinary(text)) return { ok: false, error: '这是二进制文件，改不了。' };
    const hits = countOccurrences(text, oldString);
    if (hits === 0) return { ok: false, error: 'old_string 在文件里没有命中，检查缩进、换行和标点是否与原文完全一致。' };
    if (hits > 1) {
      return { ok: false, error: 'old_string 命中了 ' + hits + ' 处，要求恰好 1 处。请把它写得更长、带上前后文来唯一定位。' };
    }
    const next = text.replace(oldString, newString);
    if (next.length > maxChars) return { ok: false, error: '改完超出单文件上限（' + maxChars + ' 字符）。' };
    const put = await r2.put(p, next, { onlyIf: { etag: obj.etag } });
    if (!put) continue; // etag 过期，重读一遍再试
    try {
      await indexUpsert(db, p, next.length, Date.now(), next);
    } catch {
      /* 同上，索引失败不回滚正文 */
    }
    return { ok: true, path: p, change: diffSummary(text, oldString, newString), size: next.length };
  }
  return { ok: false, error: '文件正在被并发修改，连续两次都没写进去，请稍后重试。' };
}

export async function wsDelete(r2, db, paths) {
  const list = [];
  try {
    for (const p of Array.isArray(paths) ? paths : [paths]) list.push(normalizeWorkspacePath(p));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!list.length) return { ok: false, error: '没有给出要删除的路径。' };
  if (list.length > 50) return { ok: false, error: '一次最多删 50 个文件。' };
  await r2.delete(list);
  for (const p of list) {
    try {
      await indexRemove(db, p);
    } catch {
      /* 同上 */
    }
  }
  return { ok: true, deleted: list };
}

export async function wsSearch(db, query, limit = 10) {
  const match = ftsMatchExpression(query);
  if (!match) return { ok: false, error: '检索词为空。' };
  try {
    const { results } = await db
      .prepare(
        "SELECT path, snippet(files_fts, 1, '『', '』', '…', 12) AS snippet " +
          'FROM files_fts WHERE files_fts MATCH ?1 LIMIT ?2'
      )
      .bind(match, Math.min(20, Math.max(1, limit)))
      .all();
    return { ok: true, query, count: results.length, hits: results };
  } catch (err) {
    return { ok: false, error: '检索出错：' + String((err && err.message) || err) };
  }
}

// ---------- 给模型的结果序列化 ----------

// 工具结果要进模型上下文，超长的一律截断 —— 尤其是报错明细和文件列表。
export function toolResultText(obj, cap = 24_000) {
  const json = JSON.stringify(obj);
  if (json.length <= cap) return json;
  return JSON.stringify({ ok: obj.ok, truncated: true, content: truncateChars(json, cap) });
}
