-- 会话列表：只存标题和时间戳（消息正文在各自 DO 的 SQLite 里）。
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 文件索引：正文在 R2，这里只存路径和元信息，供文件树与工具调用快速列目录。
CREATE TABLE IF NOT EXISTS files (
  path    TEXT PRIMARY KEY,
  size    INTEGER NOT NULL DEFAULT 0,
  mtime   INTEGER NOT NULL DEFAULT 0,
  is_text INTEGER NOT NULL DEFAULT 1
);

-- 全文索引：只收文本类文件（is_text=1 且正文不超过 FTS_INDEX_MAX_BYTES）。
-- unicode61 分词对中英文都能用；CJK 没有分词，靠 bigram-ish 的连续匹配兜底。
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  path UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
