#!/usr/bin/env node
// 把 ../cf-agent-web 的 agent 源码同步进本仓库 src/agent/（合并部署用）。
//
// 【不要手工改 src/agent/ 下的同步文件】——下次同步会被覆盖。
// 需要改 agent 行为时：改 cf-agent-web 仓库，跑本脚本同步。
//
// 同步时有两个"覆盖实现"被刻意排除（本仓库自有，同步不覆盖）：
//   src/agent/lib/fetchchat.js  内嵌模型通道：直调网关 runChain
//   src/agent/lib/features.js   内嵌特性：模型列表来自网关「模型链」
// 这两个文件在 cf-agent-web 里有同名但更简单的独立版本，两边签名保持一致。
//
// 用法：node scripts/sync-agent.mjs [源目录，默认 ../cf-agent-web]

import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const srcRoot = process.argv[2] ? join(process.argv[2], 'src') : join(repo, '../cf-agent-web/src');
const destRoot = join(repo, 'src/agent');

if (!existsSync(join(srcRoot, 'index.js'))) {
  console.error('找不到 agent 源码：' + srcRoot + '（clone cf-agent-web 到同级目录，或传入路径参数）');
  process.exit(1);
}

// 同步目录；覆盖实现文件用 filter 跳过
const OVERLAYS = [/lib[/\\]fetchchat\.js$/, /lib[/\\]features\.js$/];
cpSync(srcRoot, destRoot, {
  recursive: true,
  filter: (from) => !OVERLAYS.some((re) => re.test(from)),
});

// 健全性检查：覆盖实现必须还在，且签名与独立版一致
const problems = [];
for (const overlay of ['lib/fetchchat.js', 'lib/features.js']) {
  const p = join(destRoot, overlay);
  if (!existsSync(p)) problems.push('覆盖实现缺失：' + overlay);
}
if (!problems.length) {
  const fc = readFileSync(join(destRoot, 'lib/fetchchat.js'), 'utf8');
  const ft = readFileSync(join(srcRoot, 'lib/fetchchat.js'), 'utf8');
  if (!/export function buildFetchChat/.test(fc) || !/export function buildFetchChat/.test(ft)) {
    problems.push('fetchchat.js 两边都必须导出 buildFetchChat');
  }
  const fe = readFileSync(join(destRoot, 'lib/features.js'), 'utf8');
  const feSrc = readFileSync(join(srcRoot, 'lib/features.js'), 'utf8');
  if (!/export async function agentFeatures/.test(fe) || !/export async function agentFeatures/.test(feSrc)) {
    problems.push('features.js 两边都必须导出 agentFeatures');
  }
}
if (problems.length) {
  console.error('同步后校验失败：\n - ' + problems.join('\n - '));
  process.exit(1);
}

console.log('已同步 src/agent/ ← ' + srcRoot + '（fetchchat.js / features.js 保留本仓库覆盖实现）');
