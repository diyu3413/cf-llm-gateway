// AgentSession：每个会话对应一个 Durable Object 实例。
//
// 职责：
//  - 消息历史的唯一事实源（DO 自带 SQLite，D1 只存会话列表的标题/时间戳）
//  - WebSocket（可休眠式）：打字机增量、工具卡片事件实时推给浏览器
//  - 工具循环：接 agentloop.js，把 R2/D1 能力注入进去
//  - 定时任务：schedule_task 落本实例存储，用 alarm 到点唤醒自己继续干活
//
// 单飞约束：一个会话同一时刻只跑一轮回复（busy 锁），后来的消息直接拒绝，
// 前端在 busy 期间把输入框换成停止按钮 —— 简单、可预期，比排队好解释。

import { DurableObject } from 'cloudflare:workers';
import { getSettings } from '../lib/settings.js';
import { runAgentTurn, chatTools, trimHistory } from '../lib/agentloop.js';
import { buildFetchChat } from '../lib/fetchchat.js';
import { buildSystemPrompt, fileOverviewText } from '../lib/prompts.js';
import { wsList, wsRead, wsWrite, wsEdit, wsDelete, wsSearch } from '../lib/workspace.js';
import { webToolsSchema, webFetchEnabled, webSearchEnabled, execWebTool } from '../lib/webtools.js';
import { normalizeWorkspacePath, truncateChars } from '../lib/textutil.js';

export class AgentSession extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    // index.js 用 idFromName(会话id) 定位实例，这里把名字记下来，
    // alarm 唤醒时没有请求上下文也能更新 D1 里的会话时间戳。
    this._sessionId = (state.id && state.id.name) || '';
    this.busy = false;
    this.abortCtl = null;
    this.sql = state.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS messages (' +
        'seq INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'role TEXT NOT NULL, ' +
        'content TEXT NOT NULL DEFAULT "", ' +
        'tool_calls TEXT NOT NULL DEFAULT "", ' +
        'tool_call_id TEXT NOT NULL DEFAULT "", ' +
        'created_at INTEGER NOT NULL, ' +
        'reasoning TEXT NOT NULL DEFAULT ""' +
        ')'
    );
    // 旧库补列：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，靠异常吞掉重复执行
    try {
      this.sql.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ""');
    } catch {
      /* 列已存在 */
    }
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS tasks (' +
        'id TEXT PRIMARY KEY, ' +
        'instruction TEXT NOT NULL, ' +
        'due_at INTEGER NOT NULL, ' +
        'status INTEGER NOT NULL DEFAULT 1, ' + // 1 待执行 2 已执行 3 已取消
        'created_at INTEGER NOT NULL' +
        ')'
    );
  }

  // ---------- 对内 HTTP ----------

  async fetch(request) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/stream':
          return this.upgradeStream(request);
        case '/history':
          return this.json({ messages: this.loadMessages() });
        case '/tasks':
          return this.json({ tasks: this.pendingTasks() });
        case '/usage':
          return this.json({ usage: (await this.state.storage.get('session_usage')) || null });
        case '/message':
          return await this.restMessage(request);
        case '/stop':
          if (this.abortCtl) this.abortCtl.abort(new Error('stopped'));
          return this.json({ ok: true });
        case '/reset':
          this.sql.exec('DELETE FROM messages');
          this.sql.exec('UPDATE tasks SET status = 3 WHERE status = 1');
          await this.state.storage.deleteAlarm();
          this.broadcast({ type: 'tasks', tasks: [] });
          return this.json({ ok: true });
        case '/delete':
          await this.state.storage.deleteAlarm();
          await this.state.storage.deleteAll();
          return this.json({ ok: true });
        default:
          return this.json({ error: 'DO 里没有这个路径：' + url.pathname }, 404);
      }
    } catch (err) {
      return this.json({ error: String((err && err.message) || err) }, 500);
    }
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  upgradeStream() {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // 连上先报个到，让前端确认会话还活着、当前是否在忙
    this.send(pair[1], { type: 'hello', busy: this.busy });
    this.send(pair[1], { type: 'tasks', tasks: this.pendingTasks() });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async restMessage(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      /* 空体按参数缺失处理 */
    }
    const text = String(body.text || '').trim();
    if (!text) return this.json({ ok: false, error: '消息不能为空。' }, 400);
    if (this.busy) return this.json({ ok: false, error: '会话正在处理上一条消息。', busy: true }, 409);
    const events = [];
    const result = await this.runTurn(text, (e) => events.push(e));
    return this.json({ ok: result.ok, events, result: { usage: result.usage, filesTouched: result.filesTouched, error: result.error || '' } });
  }

  // ---------- WebSocket（可休眠） ----------

  async webSocketMessage(ws, raw) {
    let msg = null;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong', t: Date.now() });
      return;
    }
    if (msg.type === 'stop') {
      if (this.abortCtl) this.abortCtl.abort(new Error('已手动停止。'));
      return;
    }
    if (msg.type === 'user_message') {
      const text = String(msg.text || '').trim();
      if (!text) return;
      if (this.busy) {
        this.send(ws, { type: 'error', message: '上一条还没处理完，先等它说完，或点停止。' });
        return;
      }
      // 不 await：轮次可能跑几分钟，WebSocket 消息处理必须立刻返回
      this.runTurn(text, (e) => this.broadcast(e)).catch(() => {});
    }
  }

  webSocketClose() {
    /* 回合不因断线而中断：模型调用继续跑，结果照常入库，重连后看得到 */
  }

  webSocketError() {
    /* 同上 */
  }

  send(ws, event) {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      /* 连接已死，忽略 */
    }
  }

  broadcast(event) {
    for (const ws of this.state.getWebSockets()) this.send(ws, event);
  }

  // ---------- 历史与任务 ----------

  loadMessages() {
    const rows = this.sql
      .exec('SELECT seq, role, content, tool_calls, tool_call_id, created_at, reasoning FROM messages ORDER BY seq')
      .toArray();
    return rows;
  }

  pendingTasks() {
    return this.sql
      .exec('SELECT id, instruction, due_at, created_at FROM tasks WHERE status = 1 ORDER BY due_at')
      .toArray();
  }

  // ---------- 工具执行 ----------

  makeExecTool(settings) {
    return async (name, args) => {
      const r2 = this.env.WORKSPACE;
      const db = this.env.DB;
      switch (name) {
        case 'workspace_list':
          return wsList(r2, args.prefix, args.cursor);
        case 'workspace_read':
          return wsRead(r2, args.path, args.offset, settings.readMaxChars);
        case 'workspace_write':
          return wsWrite(r2, db, args.path, args.content, settings.writeMaxChars);
        case 'workspace_edit':
          return wsEdit(r2, db, args.path, args.old_string, args.new_string, settings.writeMaxChars);
        case 'workspace_delete':
          return wsDelete(r2, db, args.paths);
        case 'workspace_search':
          return wsSearch(db, args.query);
        case 'web_search':
        case 'web_fetch':
          return execWebTool(name, args, settings);
        case 'schedule_task':
          return this.scheduleTask(args, settings);
        default:
          return { ok: false, error: '没有这个工具：' + name };
      }
    };
  }

  async scheduleTask(args, settings) {
    if (settings.scheduleEnabled === false) return { ok: false, error: '定时任务功能已在设置里关闭。' };
    const minutes = Math.round(Number(args.delay_minutes));
    const instruction = String(args.instruction || '').trim();
    if (!Number.isFinite(minutes) || minutes < 1) return { ok: false, error: 'delay_minutes 至少 1 分钟。' };
    if (minutes > 43_200) return { ok: false, error: '最多安排 30 天内（43200 分钟）。' };
    if (!instruction) return { ok: false, error: 'instruction 不能为空，未来的你只能看到这段话。' };
    const id = 'task_' + Math.random().toString(36).slice(2, 10);
    const dueAt = Date.now() + minutes * 60_000;
    this.sql.exec('INSERT INTO tasks (id, instruction, due_at, status, created_at) VALUES (?1, ?2, ?3, 1, ?4)', id, instruction, dueAt, Date.now());
    const existing = await this.state.storage.getAlarm();
    if (!existing || dueAt < existing) await this.state.storage.setAlarm(dueAt);
    return { ok: true, id, due_at: dueAt, delay_minutes: minutes };
  }

  // ---------- 回合 ----------

  async runTurn(userText, emit) {
    this.busy = true;
    this.abortCtl = new AbortController();
    const touched = { paths: [] };
    try {
      const settings = await getSettings(this.env.DB);

      emit({ type: 'busy', on: true });
      const list = await wsList(this.env.WORKSPACE).catch(() => ({ files: [] }));
      const overview = fileOverviewText(list.files);

      const history = [];
      for (const row of this.loadMessages()) {
        if (row.role === 'user') history.push({ role: 'user', content: row.content });
        else if (row.role === 'assistant') {
          const calls = row.tool_calls ? JSON.parse(row.tool_calls) : [];
          if (row.content || calls.length) {
            history.push(calls.length ? { role: 'assistant', content: row.content, tool_calls: calls } : { role: 'assistant', content: row.content });
          }
        } else if (row.role === 'tool') {
          history.push({ role: 'tool', tool_call_id: row.tool_call_id, content: row.content });
        }
      }

      const persist = (msg) => {
        this.sql.exec(
          'INSERT INTO messages (role, content, tool_calls, tool_call_id, created_at, reasoning) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
          msg.role,
          String(msg.content || ''),
          msg.tool_calls ? JSON.stringify(msg.tool_calls) : '',
          msg.tool_call_id || '',
          Date.now(),
          String(msg.reasoning || '')
        );
      };

      const result = await runAgentTurn({
        history,
        userText,
        emit,
        execTool: this.makeExecTool(settings),
        onAppend: persist,
        maxToolCalls: settings.maxToolCalls,
        maxHistoryChars: settings.maxHistoryChars,
        systemPrompt: settings.systemPrompt,
        fileOverview: overview,
        // 联网工具按设置动态注册；提示词里也告诉模型有这些能力
        tools: chatTools().concat(webToolsSchema(settings)),
        web: { search: webSearchEnabled(settings), fetch: webFetchEnabled(settings) },
        // 模型通道的独立/内嵌切换收敛在装配点里（独立版走 HTTP 调网关，合并版直调 runChain）
        fetchChat: buildFetchChat(this.env, settings),
      });

      // 首条消息定会话标题；顺手把会话列表的时间戳顶上去
      if (this.env.DB) {
        try {
          const title = truncateChars(userText.replace(/\s+/g, ' '), 40);
          this.env.DB.prepare(
            'UPDATE sessions SET updated_at = ?1, title = CASE WHEN title = \'\' THEN ?2 ELSE title END WHERE id = ?3'
          )
            .bind(Date.now(), title, this.sessionId())
            .run();
        } catch {
          /* 会话列表更新失败不影响对话本身 */
        }
      }

      // 整轮 token 累计进本会话（DO 自带存储，跨休眠持久），随 turn_done 发给前端
      let sessionUsage = (await this.state.storage.get('session_usage')) || { prompt: 0, completion: 0, cached: 0 };
      if (result.usageTotal && (result.usageTotal.prompt || result.usageTotal.completion)) {
        sessionUsage = {
          prompt: sessionUsage.prompt + (result.usageTotal.prompt || 0),
          completion: sessionUsage.completion + (result.usageTotal.completion || 0),
          cached: sessionUsage.cached + (result.usageTotal.cached || 0),
        };
        await this.state.storage.put('session_usage', sessionUsage);
      }

      emit({ type: 'turn_done', ok: result.ok, usage: result.usage || null, sessionUsage, error: result.error || '' });
      if (result.filesTouched && result.filesTouched.length) {
        emit({ type: 'files_changed', paths: result.filesTouched });
      }
      return result;
    } finally {
      this.busy = false;
      this.abortCtl = null;
      emit({ type: 'busy', on: false });
    }
  }

  sessionId() {
    return this._sessionId || '';
  }

  // ---------- 定时唤醒 ----------

  async alarm() {
    const now = Date.now();
    const due = this.sql
      .exec('SELECT id, instruction FROM tasks WHERE status = 1 AND due_at <= ?1 ORDER BY due_at', now)
      .toArray();
    for (const t of due) {
      this.sql.exec('UPDATE tasks SET status = 2 WHERE id = ?1', t.id);
      try {
        await this.runTurn('[定时任务] ' + t.instruction, (e) => this.broadcast(e));
      } catch {
        /* 单个任务失败不拖累后面的 */
      }
    }
    // 还有没到点的任务就把闹钟再上到最近的一个
    const next = this.sql.exec('SELECT MIN(due_at) AS due_at FROM tasks WHERE status = 1').toArray()[0];
    if (next && next.due_at) await this.state.storage.setAlarm(next.due_at);
  }
}
