#!/usr/bin/env node
// 把 src/ 下的 ES 模块拼成一个 dist/_worker.js。
//
// 为什么不用 esbuild/rollup：Pages 的 Git 构建环境装依赖要时间，
// 而这个项目模块之间只有单向依赖、顶层标识符互不重名，
// 顺序拼接 + 去掉 import/export 关键字就够了，零依赖、构建 0.1 秒。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 严格按依赖顺序排列，被依赖的在前。
const ORDER = [
  'src/lib/crypto.js',
  'src/lib/http.js',
  'src/lib/presets.js',
  'src/lib/caps.js',
  'src/lib/config.js',
  'src/lib/usage.js',
  'src/lib/disguise.js',
  'src/lib/auth.js',
  'src/lib/discovery.js',
  'src/lib/chain.js',
  'src/lib/proxy.js',
  'src/ui/tokens.js',
  'src/ui/css.js',
  'src/ui/app.js',
  'src/ui/html.js',
  'src/routes/openai.js',
  'src/routes/anthropic.js',
  'src/routes/admin.js',
  'src/index.js',
];

const IMPORT_RE = /^import\s[\s\S]*?from\s*['"][^'"]*['"];?[ \t]*\r?\n/gm;
const REEXPORT_RE = /^export\s*\{[^}]*\}\s*;?[ \t]*\r?\n/gm;

function transform(source, file) {
  let out = source.replace(IMPORT_RE, '').replace(REEXPORT_RE, '');
  out = out.replace(/^export\s+(default\s+)/gm, (m, d) => 'export ' + d); // default 保留
  out = out.replace(/^export\s+(?!default)(async\s+function|function|const|let|var|class)\b/gm, '$1');
  return '// ---------- ' + file + ' ----------\n' + out.trim() + '\n';
}

const banner = `/**
 * LLM Gateway — OpenAI 兼容的多提供商聚合网关（Cloudflare Worker / Pages）
 * 由 build.mjs 从 src/ 自动生成，不要直接改这个文件。
 * 源码与说明：见仓库 README。MIT License.
 * 生成时间：${new Date().toISOString()}
 */

`;

const chunks = ORDER.map((f) => transform(readFileSync(join(here, f), 'utf8'), f));
const bundle = banner + chunks.join('\n');

mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist/_worker.js'), bundle);

// 顺手做几项健全性检查，避免拼出一个静默坏掉的包。
const problems = [];
if (/^import\s/m.test(bundle)) problems.push('产物里还有残留的 import 语句');
if ((bundle.match(/^export default/gm) || []).length !== 1) problems.push('必须且只能有一个 export default');
if (!/fetch\s*\(request, env, ctx\)/.test(bundle)) problems.push('没找到 fetch 入口');
if (problems.length) {
  console.error('构建失败：\n - ' + problems.join('\n - '));
  process.exit(1);
}

console.log('dist/_worker.js  ' + (bundle.length / 1024).toFixed(1) + ' KB  ' + bundle.split('\n').length + ' 行');
