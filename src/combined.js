// 合并版入口：cf-llm-gateway 网关 + 内嵌 Agent，一个 Worker 全包。
//
// 仅用于 Workers 部署（wrangler deploy / GitHub Workers Builds，见 wrangler.toml）。
// Pages 纯网关产物由 build.mjs 生成（只含网关文件），不包含本文件与 src/agent/。
//
// 路由关系：
//   /agent、/agent/api/*、/agent/ws   → 内嵌 Agent（会话页/文件页/设置页）
//   其余一切                           → 网关原样不动（/v1/*、/admin、伪装首页……）
//
// 两边用同一个 admin_password，但会话 Cookie 各自独立（gw_session / agent_session），
// 首次进 /agent 需要用同一密码再登一次 —— 换来的是完全互不干扰的会话生命周期。
//
// 特性检测驱动一切：合并部署绑定了 KV/D1/R2/SESSIONS，
//  - agent 据 env.KV 启用内嵌模型通道（直调 runChain，复用「提供商/模型链」配置）
//  - 管理台据 state.agent 在左侧 rail 显示「Agent」入口（Pages 产物自动隐藏）

import gateway from './index.js';
import { handleAgent } from './agent/index.js';
import { AgentSession } from './agent/do/session.js';

export { AgentSession };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/agent' || path.startsWith('/agent/')) {
      try {
        return await handleAgent(request, env, ctx, { basePath: '/agent', embedded: true });
      } catch (err) {
        // handleAgent 内部已兜底；这层只防路由级意外
        const message = (err && err.message) || String(err);
        return new Response(
          JSON.stringify({ error: { message: 'Agent 内部错误：' + message } }),
          { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }
    }
    return gateway.fetch(request, env, ctx);
  },
};
