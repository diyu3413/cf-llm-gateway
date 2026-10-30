-- 运行时配置（网关地址/密钥/模型等），settings.js 的 k/v 存储。
-- 0001 里漏了这张表：读取时有 try/catch 兜底所以没暴露，写入时才炸出来。
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
