// 后台前端。写成一个函数，构建时用 Function.prototype.toString() 内联进 HTML，
// 这样这里可以正常用模板字符串，不需要满屏转义。组件与设计令牌和
// cf-llm-gateway 同源，视觉上两套面板是一家人。
//
// 会话流走 WebSocket（/ws?session=id，DO 可休眠式），WS 连不上时退回 REST
// 整段拉取。流式增量用 textContent 追加而不是 innerHTML +=，避免长回答时反复解析。

export function uiApp() {
  var S = {
    authed: false, hasPassword: true,
    settings: null, defaults: {},
    embedded: EMBEDDED, models: [], defaultModel: '',
    sessions: [], tab: 'chat',
    cur: null, // 当前会话 { id, ws, wsOk, busy, streamEl, toolCard, history }
    files: [],
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var root = $('#root');
  // 独立部署 BASE=''；合并部署挂在网关的 /agent 下，所有接口调用都带前缀
  var BASE = (document.body.dataset && document.body.dataset.base) || '';
  var EMBEDDED = Boolean(document.body.dataset && document.body.dataset.embedded === '1');
  // markdown 渲染器由 html.js 内联成全局 mdRender；桩环境/异常时退化为转义纯文本
  var md = typeof mdRender === 'function' ? mdRender : function (s) { return esc(s); };

  // ---------- 图标（手写 24x24 描边 SVG，与网关同一套风格） ----------

  var ICONS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M18 6l-.9-3.4M18 6l-3.4-.9"/>',
    logout: '<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M16 8l4 4-4 4M20 12H9"/>',
    back: '<path d="M20 12H5M11 6l-6 6 6 6"/>',
    moon: '<path d="M20 13.5A8.5 8.5 0 1 1 10.5 4a7 7 0 0 0 9.5 9.5Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4M2.5 12h2"/>',
    chat: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5H9l-4.6 3.6c-.5.4-.9.2-.9-.4V5.5Z"/><path d="M8 9h8M8 12.5h5"/>',
    folder: '<path d="M4 7a2 2 0 0 1 2-2h3.2l2 2.4H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/>',
    tune: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.6"/><circle cx="8" cy="17" r="2.6"/>',
    send: '<path d="M4.5 11.4 19 5.2c.6-.3 1.2.3 1 .9l-5 13.6c-.2.6-1.1.6-1.3-.1l-1.6-5.1a1 1 0 0 0-.7-.7l-6.8-1.2c-.7-.1-.7-1 -.1-1.2Z"/><path d="M11.5 13.5 19 5.5"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
    search: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6 21 21"/>',
    edit: '<path d="M4 20h4L19 9a2.12 2.12 0 0 0-3-3L5 17v3Z"/><path d="M14.5 6.5l3 3"/>',
    upload: '<path d="M12 16V5M7.5 9 12 4.5 16.5 9"/><path d="M5 16.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1.5"/>',
    bolt: '<path d="M13 2.5 5.5 13.5H11l-1 8 7.5-11H12l1-8Z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    doc: '<path d="M7 3.5h7L19 8.5V19a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7.5 3.5Z"/><path d="M13.5 3.5V9H19"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 18.5h14"/>',
    mark: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.2v3.4M12 18.4v3.4M2.2 12h3.4M18.4 12h3.4"/><path d="M5.1 5.1l2.4 2.4M16.5 16.5l2.4 2.4M18.9 5.1l-2.4 2.4M7.5 16.5l-2.4 2.4"/>',
  };

  function svg(name, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  // ---------- 工具 ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function when(ts) {
    if (!ts) return '';
    try {
      var d = new Date(Number(ts));
      var today = new Date();
      return d.toDateString() === today.toDateString()
        ? d.toTimeString().slice(0, 5)
        : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toTimeString().slice(0, 5);
    } catch (e) { return ''; }
  }

  function humanSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function toast(msg, ms) {
    var el = $('#snack');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.classList.remove('on');
      setTimeout(function () { if (!el.classList.contains('on')) el.textContent = ''; }, 300);
    }, ms || 3200);
  }

  async function api(path, body, method) {
    var res = await fetch(BASE + '/api/' + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401 && path !== 'login') { S.authed = false; render(); throw new Error('会话已过期，请重新登录。'); }
    if (!res.ok) throw new Error((data && data.error && data.error.message) || ('请求失败 ' + res.status));
    return data;
  }

  // ---------- 主题 ----------

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('agent-theme', t); } catch (e) { /* 隐身模式之类 */ }
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('agent-theme'); } catch (e) { /* 同上 */ }
    applyTheme(saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  }
  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }

  // ---------- 登录 ----------

  function renderLogin() {
    root.innerHTML =
      '<div class="login"><div class="card elev">' +
      '<div class="logo">' + svg('bolt') + '</div>' +
      '<h1 class="headline-s">Agent Workspace</h1>' +
      '<p class="body-m muted" style="margin:8px 0 20px">R2 工作区文件 agent，模型走网关。</p>' +
      '<div class="field"><label for="pw">管理员密码</label>' +
      '<input id="pw" type="password" autocomplete="current-password" placeholder="admin_password"></div>' +
      '<button class="btn" id="loginBtn" style="width:100%;justify-content:center">登录</button>' +
      '</div></div>';
    var go = async function () {
      var btn = $('#loginBtn');
      btn.disabled = true;
      try {
        await api('login', { password: $('#pw').value });
        await boot();
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
      }
    };
    $('#loginBtn').onclick = go;
    $('#pw').onkeydown = function (e) { if (e.key === 'Enter') go(); };
  }

  // ---------- 外壳 ----------

  var TABS = [
    { id: 'chat', icon: 'chat', label: '会话' },
    { id: 'files', icon: 'folder', label: '文件' },
    { id: 'settings', icon: 'tune', label: '设置' },
  ];

  function render() {
    root.innerHTML =
      '<header class="topbar">' +
      '<button class="icon menubtn" id="menuBtn" aria-label="打开菜单">' + svg('menu') + '</button>' +
      '<button class="icon sessbtn" id="sessBtn" aria-label="会话列表">' + svg('list') + '</button>' +
      '<div class="brand"><span class="mark">' + svg('bolt') + '</span><b>Agent Workspace</b></div>' +
      '<span class="spacer"></span>' +
      '<span class="chip" id="wsState" style="display:none"></span>' +
      (EMBEDDED ? '<button class="icon" id="backBtn" aria-label="返回控制台" title="返回网关控制台">' + svg('back') + '</button>' : '') +
      '<button class="icon" id="themeBtn" aria-label="夜间模式切换">' + svg(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon') + '</button>' +
      '<button class="icon" id="logoutBtn" aria-label="退出登录">' + svg('logout') + '</button>' +
      '</header>' +
      '<div class="shell">' +
      '<nav class="rail">' +
      '<div class="drawerhead"><span class="t">导航</span></div>' +
      TABS.map(function (t) {
        return '<button class="navitem" data-tab="' + t.id + '"><span class="pill">' + svg(t.icon) + '</span><span class="rl">' + t.label + '</span></button>';
      }).join('') +
      '</nav>' +
      '<main><div id="pane" class="enter"></div></main>' +
      '</div>' +
      '<div class="scrim" id="scrim"></div>';

    $('#themeBtn').onclick = function () {
      toggleTheme();
      this.innerHTML = svg(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
    };
    $('#logoutBtn').onclick = async function () {
      try { await api('logout', {}); } catch (e) { /* 无所谓 */ }
      closeWs();
      S.authed = false;
      renderLogin();
    };
    $('#menuBtn').onclick = function () { document.body.classList.toggle('nav-open'); };
    $('#sessBtn').onclick = function () { document.body.classList.toggle('sess-open'); };
    $('#scrim').onclick = function () { document.body.classList.remove('nav-open'); document.body.classList.remove('sess-open'); };
    if (EMBEDDED) $('#backBtn').onclick = function () { location.href = '/admin'; };

    var btns = root.querySelectorAll('.navitem[data-tab]');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.onclick = function () { showTab(btn.dataset.tab); };
      })(btns[i]);
    }
    showTab(S.tab || 'chat');
  }

  function markSelected(tab) {
    var btns = root.querySelectorAll('.navitem[data-tab]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-selected', btns[i].dataset.tab === tab ? 'true' : 'false');
    }
    document.body.classList.remove('nav-open');
  }

  function showTab(tab) {
    S.tab = tab;
    markSelected(tab);
    // 会话视图独占视口、禁止页面级滚动（否则会在页面下方拖出大片空白）
    document.body.classList.toggle('view-chat', tab === 'chat');
    var mainEl = document.querySelector('main');
    if (mainEl) mainEl.classList.toggle('chatmode', tab === 'chat');
    var pane = $('#pane');
    if (!pane) return;
    if (tab === 'chat') renderChat(pane);
    else if (tab === 'files') renderFiles(pane);
    else if (tab === 'settings') renderSettings(pane);
  }

  // ---------- 会话视图 ----------

  function renderChat(pane) {
    pane.innerHTML =
      '<div class="chatwrap">' +
      '<aside class="sesscol" id="sesscol">' +
      '<div class="sesshead"><span class="t">会话</span>' +
      '<button class="icon" id="newSess" aria-label="新建会话">' + svg('plus') + '</button>' +
      '<button class="icon" id="refreshSess" aria-label="刷新会话列表">' + svg('refresh') + '</button>' +
      '</div>' +
      '<div class="sesslist" id="sesslist"></div>' +
      '</aside>' +
      '<section class="chatcol">' +
      '<div class="msgs" id="msgs"><div class="inner" id="msglist"></div></div>' +
      '<div class="composer"><div class="taskchips" id="sessUsage"></div><div class="taskchips" id="taskchips"></div>' +
      '<div class="inner">' +
      '<textarea id="input" rows="1" placeholder="给 agent 派活…（Enter 发送，Shift+Enter 换行）"></textarea>' +
      '<button class="btn send" id="sendBtn" aria-label="发送">' + svg('send') + '</button>' +
      '</div>' +
      '<div class="hintbar"><span>' + esc('工具：读写/编辑/删除/检索工作区文件、定时任务') + '</span></div>' +
      '</div>' +
      '</section>' +
      '</div>';

    $('#newSess').onclick = async function () {
      try {
        var r = await api('sessions', {});
        await loadSessions();
        openSession(r.id);
      } catch (e) { toast(e.message); }
    };
    $('#refreshSess').onclick = function () { loadSessions(); };
    $('#sendBtn').onclick = sendCurrent;
    var ta = $('#input');
    ta.onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrent();
      }
    };
    ta.oninput = function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(180, ta.scrollHeight) + 'px';
    };

    paintSessions();
    if (S.sessions.length && !S.cur) openSession(S.sessions[0].id);
    else if (S.cur) { paintSessions(); }
  }

  async function loadSessions() {
    try {
      var r = await api('sessions');
      S.sessions = r.sessions || [];
      paintSessions();
    } catch (e) { /* 未登录等，render 会处理 */ }
  }

  function paintSessions() {
    var list = $('#sesslist');
    if (!list) return;
    if (!S.sessions.length) {
      list.innerHTML = '<div class="sessempty">还没有会话。<br>点右上角 + 新建一个。</div>';
      return;
    }
    list.innerHTML = S.sessions.map(function (s) {
      return '<div class="sessitem" role="button" data-id="' + esc(s.id) + '"' + (S.cur && S.cur.id === s.id ? ' aria-current="true"' : '') + '>' +
        '<span class="t">' + esc(s.title || '新会话') + '</span>' +
        '<span class="body-s muted">' + esc(when(s.updated_at)) + '</span>' +
        '<button class="icon del" data-del="' + esc(s.id) + '" aria-label="删除会话">' + svg('trash') + '</button>' +
        '</div>';
    }).join('');
    var items = list.querySelectorAll('.sessitem');
    for (var i = 0; i < items.length; i++) {
      (function (el) {
        el.onclick = function (e) {
          if (e.target && e.target.closest && e.target.closest('[data-del]')) return;
          document.body.classList.remove('sess-open'); // 移动端抽屉选中后自动收起
          openSession(el.dataset.id);
        };
      })(items[i]);
    }
    var dels = list.querySelectorAll('[data-del]');
    for (var j = 0; j < dels.length; j++) {
      (function (btn) {
        btn.onclick = async function (e) {
          e.stopPropagation();
          if (!confirm('删除这个会话？聊天记录不可恢复。')) return;
          try {
            await api('sessions/' + btn.dataset.del, undefined, 'DELETE');
            if (S.cur && S.cur.id === btn.dataset.del) { closeWs(); S.cur = null; }
            await loadSessions();
            if (S.tab === 'chat' && !S.cur) {
              if (S.sessions.length) openSession(S.sessions[0].id);
              else { $('#msglist').innerHTML = ''; }
            }
            toast('会话已删除');
          } catch (err) { toast(err.message); }
        };
      })(dels[j]);
    }
  }

  async function openSession(id) {
    closeWs();
    S.cur = { id: id, ws: null, wsOk: false, busy: false, streamEl: null, toolCard: null, toolStartedAt: 0, thinkEl: null, thinkStart: 0, thinkOpen: true, statusEl: null };
    paintSessions();
    var list = $('#msglist');
    if (list) list.innerHTML = '';
    try {
      var r = await api('sessions/' + id + '/messages');
      var msgs = (r && r.messages) || [];
      for (var i = 0; i < msgs.length; i++) paintStored(msgs[i]);
      scrollBottom();
    } catch (e) { toast(e.message); }
    refreshTasks();
    refreshUsage();
    connectWs(id);
  }

  function refreshUsage() {
    if (!S.cur) return;
    api('sessions/' + S.cur.id + '/usage').then(function (r) {
      paintSessionUsage((r && r.usage) || null);
    }).catch(function () { /* 忽略 */ });
  }

  function paintSessionUsage(u) {
    var box = $('#sessUsage');
    if (!box) return;
    if (!u || (!u.prompt && !u.completion)) { box.innerHTML = ''; return; }
    var html = '<span class="chip usage num">' + svg('bolt') + '本会话 ↑' + fmtNum(u.prompt) + ' ↓' + fmtNum(u.completion) + ' tokens</span>';
    if (u.cached) html += '<span class="chip ok usage num">缓存命中 ' + fmtNum(u.cached) + '</span>';
    box.innerHTML = html;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function paintStored(m) {
    var list = $('#msglist');
    if (!list) return;
    if (m.role === 'user') addBubble('user', m.content);
    else if (m.role === 'assistant') {
      // 历史思考过程：折叠块可展开回看（持久化在 DO 的消息行里）
      if (m.reasoning) {
        var block = makeThinkBlock('思考过程', { done: true });
        block.body.textContent = m.reasoning;
        list.appendChild(block.el);
      }
      if (m.content) {
        var div = document.createElement('div');
        div.className = 'msg assistant entering';
        div.innerHTML = md(m.content); // 历史消息直接渲染 markdown
        list.appendChild(div);
      }
      if (m.tool_calls) {
        var calls = m.tool_calls;
        if (typeof calls === 'string') { try { calls = JSON.parse(calls); } catch (e) { calls = []; } }
        for (var i = 0; i < calls.length; i++) {
          addToolCard(calls[i] && calls[i].function && calls[i].function.name || '?', '', true, '历史调用');
        }
      }
    }
    // tool 消息的结果太长，历史里不重复渲染 —— 前面的工具卡片已示意
  }

  // ---------- WebSocket ----------

  function setWsState(text, cls) {
    var el = $('#wsState');
    if (!el) return;
    if (!text) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.textContent = text;
    el.className = 'chip' + (cls ? ' ' + cls : '');
  }

  function connectWs(id) {
    if (typeof WebSocket === 'undefined') { setWsState('REST 模式', ''); return; }
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws;
    try {
      ws = new WebSocket(proto + location.host + BASE + '/ws?session=' + encodeURIComponent(id));
    } catch (e) {
      setWsState('REST 模式', '');
      return;
    }
    S.cur.ws = ws;
    var alive = false;
    ws.onopen = function () { alive = true; S.cur.wsOk = true; setWsState('已连接', 'ok'); };
    ws.onclose = function () {
      if (S.cur && S.cur.ws === ws) {
        S.cur.wsOk = false;
        setWsState('实时通道断开，用输入框仍可对话（REST）', 'err');
      }
    };
    ws.onerror = function () { /* onclose 会跟着来 */ };
    ws.onmessage = function (ev) {
      var data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      handleEvent(data);
    };
    // 保活：浏览器侧定时 ping，服务端回 pong
    var timer = setInterval(function () {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
      else clearInterval(timer);
    }, 30000);
  }

  function closeWs() {
    if (S.cur && S.cur.ws) {
      try { S.cur.ws.close(); } catch (e) { /* 已经断了 */ }
      S.cur.ws = null;
      S.cur.wsOk = false;
    }
    setWsState('');
  }

  function handleEvent(e) {
    if (e.type === 'hello') return;
    if (e.type === 'pong') return;
    if (e.type === 'tasks') { paintTasks(e.tasks || []); return; }
    if (e.type === 'busy') { if (e.on) startStatus(); else endStatus(); setBusy(e.on); return; }
    if (e.type === 'reasoning') {
      // 推理模型的思考增量：显示为可折叠的「思考」块，不进历史
      if (e.text) appendThink(e.text);
      return;
    }
    if (e.type === 'delta') {
      endStatus();
      endThink(); // 思考结束、正文开始：把思考块定格收起
      if (!S.cur.streamEl) startStream();
      S.cur.streamEl.textContent += e.text;
      S.cur.streamRaw += e.text;
      scrollBottom();
      return;
    }
    if (e.type === 'tool_start') {
      endStatus();
      endThink();
      endStream();
      S.cur.toolStartedAt = Date.now();
      S.cur.toolCard = addToolCard(e.name, argsBrief(e.name, e.args), false, '执行中…');
      scrollBottom();
      return;
    }
    if (e.type === 'tool_end') {
      if (S.cur.toolCard) {
        S.cur.toolCard.className = 'toolcard' + (e.ok ? '' : ' err');
        var brief = S.cur.toolCard.querySelector('.brief');
        if (brief) {
          var text = e.brief || (e.ok ? '完成' : '失败');
          if (typeof e.ms === 'number') text += ' · ' + (e.ms / 1000).toFixed(1) + 's';
          brief.textContent = text;
        }
      }
      S.cur.toolCard = null;
      return;
    }
    if (e.type === 'notice') { endStatus(); addNotice(e.text); return; }
    if (e.type === 'error') { endStatus(); endThink(); endStream(); addError(e.message); scrollBottom(); return; }
    if (e.type === 'turn_done') {
      endStatus();
      endThink();
      endStream();
      paintSessionUsage(e.sessionUsage || null);
      refreshTasks();
      loadSessions();
      return;
    }
    if (e.type === 'files_changed') {
      if (S.tab === 'files') loadFiles();
      toast('工作区文件有更新：' + (e.paths || []).join('、'));
      return;
    }
  }

  // 工具开始时给卡片一个可读的参数摘要（比原始 JSON 好认）
  function argsBrief(name, argsJson) {
    try {
      var a = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson;
      if (!a || typeof a !== 'object') return '';
      if (a.path) return String(a.path);
      if (Array.isArray(a.paths)) return a.paths.join('、');
      if (a.query) return '“' + String(a.query).slice(0, 40) + '”';
      if (a.instruction) return String(a.instruction).slice(0, 40);
      return '';
    } catch (e) { return ''; }
  }

  // ---------- 思考过程与状态行 ----------

  function startStatus() {
    if (!S.cur) return;
    endStatus();
    var list = $('#msglist');
    if (!list) return;
    var div = document.createElement('div');
    div.className = 'statusrow';
    div.innerHTML = svg('bolt') + '<span>思考中…</span>';
    list.appendChild(div);
    S.cur.statusEl = div;
    scrollBottom();
  }

  function endStatus() {
    if (S.cur && S.cur.statusEl) { S.cur.statusEl.remove(); S.cur.statusEl = null; }
  }

  // 思考块工厂：流式思考与历史重绘共用。开合逻辑闭包在自己的元素上，
  // 不依赖 S.cur —— 否则回合结束后引用被清空，点击展开会失效。
  function makeThinkBlock(label, opts) {
    opts = opts || {};
    var div = document.createElement('div');
    div.className = 'think' + (opts.done ? ' done' : '');
    div.innerHTML =
      '<div class="thead" role="button">' + svg('clock') +
      '<span class="ttext">' + esc(label) + '</span><span class="ttoggle body-s">' + (opts.done ? '展开' : '收起') + '</span></div>' +
      '<div class="tbody"' + (opts.done ? ' style="display:none"' : '') + '></div>';
    var setOpen = function (open) {
      div.classList.toggle('open', open);
      div.querySelector('.tbody').style.display = open ? '' : 'none';
      div.querySelector('.ttoggle').textContent = open ? '收起' : '展开';
    };
    div.querySelector('.thead').onclick = function () {
      setOpen(!div.classList.contains('open'));
    };
    return { el: div, body: div.querySelector('.tbody'), setOpen: setOpen };
  }

  function startThink() {
    if (!S.cur) return;
    if (S.cur.thinkEl) return; // 已经在记这一段思考
    endStatus();
    var list = $('#msglist');
    if (!list) return;
    var block = makeThinkBlock('思考中');
    list.appendChild(block.el);
    S.cur.thinkEl = block;
    S.cur.thinkStart = Date.now();
    scrollBottom();
  }

  function appendThink(text) {
    if (!S.cur) return;
    if (!S.cur.thinkEl) startThink();
    S.cur.thinkEl.body.textContent += text;
    scrollBottom();
  }

  function endThink() {
    if (!S.cur || !S.cur.thinkEl) return;
    var block = S.cur.thinkEl;
    var secs = ((Date.now() - (S.cur.thinkStart || Date.now())) / 1000).toFixed(1);
    block.el.classList.add('done');
    var label = block.el.querySelector('.ttext');
    if (label) label.textContent = '思考 · 持续了 ' + secs + ' 秒';
    block.setOpen(false); // 默认收起，点击表头可展开回看
    S.cur.thinkEl = null;
  }

  function setBusy(on) {
    if (!S.cur) return;
    S.cur.busy = on;
    var btn = $('#sendBtn');
    if (btn) btn.innerHTML = svg(on ? 'stop' : 'send');
    var ta = $('#input');
    if (ta) ta.placeholder = on ? 'agent 正在干活…（点右侧按钮停止）' : '给 agent 派活…（Enter 发送，Shift+Enter 换行）';
  }

  function startStream() {
    if (!S.cur) return;
    endStream();
    var list = $('#msglist');
    if (!list) return;
    var div = document.createElement('div');
    div.className = 'msg assistant entering';
    var span = document.createElement('span');
    span.className = 'stream';
    div.appendChild(span);
    var caret = document.createElement('span');
    caret.className = 'caret';
    div.appendChild(caret);
    list.appendChild(div);
    S.cur.streamEl = span;
    S.cur.streamRaw = '';
    S.cur.streamDiv = div;
    scrollBottom();
  }

  function endStream() {
    if (!S.cur || !S.cur.streamEl) return;
    var div = S.cur.streamDiv;
    var raw = S.cur.streamRaw || '';
    var caret = div && div.querySelector('.caret');
    if (caret && caret.remove) caret.remove();
    if (!raw && div && div.remove) {
      div.remove(); // 空回答（比如只调了工具）不留空块
    } else if (div) {
      // 流式期间为了性能显示纯文本，结束时整体渲染成 markdown
      div.classList.remove('entering');
      div.innerHTML = md(raw);
    }
    S.cur.streamEl = null;
    S.cur.streamDiv = null;
    S.cur.streamRaw = '';
  }

  function addBubble(role, text) {
    var list = $('#msglist');
    if (!list) return null;
    var div = document.createElement('div');
    div.className = 'msg ' + role + ' entering';
    div.textContent = text;
    list.appendChild(div);
    return div;
  }

  function addToolCard(name, argsJson, done, brief, failed) {
    var list = $('#msglist');
    if (!list) return null;
    var div = document.createElement('div');
    div.className = 'toolcard' + (failed ? ' err' : '');
    div.innerHTML = svg('bolt') +
      '<span class="name">' + esc(name) + '</span>' +
      '<span class="brief" title="' + esc(argsJson || '') + '">' + esc(brief || '') + '</span>';
    list.appendChild(div);
    return div;
  }

  function addNotice(text) {
    var list = $('#msglist');
    if (!list) return;
    var div = document.createElement('div');
    div.className = 'notice';
    div.textContent = text;
    list.appendChild(div);
  }

  function addError(text) {
    var list = $('#msglist');
    if (!list) return;
    var div = document.createElement('div');
    div.className = 'msg error';
    div.textContent = text;
    list.appendChild(div);
  }

  function addMeta(text) {
    var list = $('#msglist');
    if (!list) return;
    var div = document.createElement('div');
    div.className = 'syschip';
    div.textContent = text;
    list.appendChild(div);
  }

  function scrollBottom() {
    var box = $('#msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function refreshTasks() {
    if (!S.cur) return;
    api('sessions/' + S.cur.id + '/tasks').then(function (r) {
      paintTasks((r && r.tasks) || []);
    }).catch(function () { /* 忽略 */ });
  }

  function paintTasks(tasks) {
    var box = $('#taskchips');
    if (!box) return;
    if (!tasks.length) { box.innerHTML = ''; return; }
    box.innerHTML = tasks.map(function (t) {
      return '<span class="chip pri">' + svg('clock') + esc(when(t.due_at) + ' · ' + String(t.instruction || '').slice(0, 24)) + '</span>';
    }).join('');
  }

  async function sendCurrent() {
    var ta = $('#input');
    if (!ta || !S.cur) return;
    var text = ta.value.trim();
    if (!text) return;
    if (S.cur.busy) {
      // busy 状态下按钮是停止
      if (S.cur.ws && S.cur.wsOk) S.cur.ws.send(JSON.stringify({ type: 'stop' }));
      else if (S.cur.id) { try { await api('sessions/' + S.cur.id + '/message', { text: '__stop__' }, 'POST'); } catch (e) { /* 无所谓 */ } }
      return;
    }
    ta.value = '';
    ta.style.height = 'auto';
    addBubble('user', text);
    startStatus(); // 等模型第一个字/第一次工具调用之前的「思考中」占位
    scrollBottom();
    if (S.cur.ws && S.cur.wsOk) {
      S.cur.ws.send(JSON.stringify({ type: 'user_message', text: text }));
      return;
    }
    // REST 兜底：一次拿全部事件再回放
    try {
      var r = await api('sessions/' + S.cur.id + '/message', { text: text });
      var events = (r && r.events) || [];
      for (var i = 0; i < events.length; i++) handleEvent(events[i]);
      if (r && r.ok === false && r.error) addError(r.error);
    } catch (e) {
      addError(e.message);
    }
  }

  // ---------- 文件视图 ----------

  async function renderFiles(pane) {
    pane.innerHTML =
      '<div class="head"><h2 class="headline-s">文件</h2><span class="spacer"></span>' +
      '<button class="btn tonal" id="uploadBtn">' + svg('upload') + '上传文本文件</button>' +
      '<input type="file" id="fileInput" style="display:none"></div>' +
      '<div class="filebar"><div class="field round"><input id="fileSearch" placeholder="全文检索：多个词用空格分开，全部命中"></div>' +
      '<button class="btn outlined" id="searchGo">' + svg('search') + '检索</button>' +
      '<button class="icon" id="refreshFiles" aria-label="刷新">' + svg('refresh') + '</button></div>' +
      '<div id="searchHits"></div>' +
      '<div class="list" id="filelist"><div class="empty">加载中…</div></div>';

    $('#refreshFiles').onclick = function () { loadFiles(); };
    $('#searchGo').onclick = function () { runSearch(); };
    $('#fileSearch').onkeydown = function (e) { if (e.key === 'Enter') runSearch(); };
    $('#uploadBtn').onclick = function () { $('#fileInput').click(); };
    $('#fileInput').onchange = async function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { toast('文件超过 2MB 上限'); return; }
      var path = prompt('保存为工作区路径：', f.name);
      if (!path) return;
      try {
        var text = await f.text();
        var res = await fetch(BASE + '/api/upload?path=' + encodeURIComponent(path), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: text,
          credentials: 'same-origin',
        });
        var data = null;
        try { data = await res.json(); } catch (e) { /* 忽略 */ }
        if (!res.ok || !data.ok) throw new Error((data && data.error) || '上传失败');
        toast('已上传 ' + path);
        loadFiles();
      } catch (e) { toast(e.message); }
    };
    await loadFiles();
  }

  async function loadFiles() {
    var box = $('#filelist');
    if (!box) return;
    try {
      var r = await api('files');
      S.files = (r && r.files) || [];
      if (!S.files.length) {
        box.innerHTML = '<div class="empty">工作区还是空的。上传一个文件，或者直接在会话里让 agent 写一个。</div>';
        return;
      }
      box.innerHTML = S.files.map(function (f) {
        return '<div class="item"><span class="ordinal">' + svg('doc') + '</span>' +
          '<div class="grow"><div class="ellipsis mono" style="font-size:13px">' + esc(f.path) + '</div>' +
          '<div class="body-s muted">' + esc(when((f.mtime || 0) * 1000)) + '</div></div>' +
          '<span class="filesize">' + esc(humanSize(f.size)) + '</span>' +
          '<div class="acts">' +
          '<button class="btn tonal small" data-open="' + esc(f.path) + '">打开</button>' +
          '<a class="btn outlined small" data-dl="' + esc(f.path) + '" href="' + BASE + '/api/download?path=' + encodeURIComponent(f.path) + '" download>下载</a>' +
          '<button class="icon" data-del="' + esc(f.path) + '" aria-label="删除">' + svg('trash') + '</button>' +
          '</div></div>';
      }).join('');
      bindFileActions(box);
    } catch (e) {
      box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }

  function bindFileActions(box) {
    var opens = box.querySelectorAll('[data-open]');
    for (var i = 0; i < opens.length; i++) {
      (function (btn) { btn.onclick = function () { previewFile(btn.dataset.open); }; })(opens[i]);
    }
    var dels = box.querySelectorAll('[data-del]');
    for (var j = 0; j < dels.length; j++) {
      (function (btn) {
        btn.onclick = async function () {
          if (!confirm('删除 ' + btn.dataset.del + ' ？不可恢复。')) return;
          try {
            await api('file?path=' + encodeURIComponent(btn.dataset.del), undefined, 'DELETE');
            toast('已删除');
            loadFiles();
          } catch (e) { toast(e.message); }
        };
      })(dels[j]);
    }
  }

  async function runSearch() {
    var q = $('#fileSearch') ? $('#fileSearch').value.trim() : '';
    var box = $('#searchHits');
    if (!q) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="empty">检索中…</div>';
    try {
      var r = await api('search?q=' + encodeURIComponent(q));
      var hits = (r && r.hits) || [];
      if (!hits.length) { box.innerHTML = '<div class="empty">没有命中。</div>'; return; }
      box.innerHTML = '<div class="list" style="margin-bottom:16px">' + hits.map(function (h) {
        return '<div class="item" style="display:block"><div class="hitpath">' + esc(h.path) + '</div>' +
          '<div class="body-m" style="margin-top:6px">' + esc(h.snippet || '') + '</div></div>';
      }).join('') + '</div>';
    } catch (e) {
      box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }

  async function previewFile(path) {
    var data = null;
    try {
      data = await api('file?path=' + encodeURIComponent(path));
    } catch (e) { toast(e.message); return; }
    var content = (data && data.content) || '';
    var dlg = document.createElement('dialog');
    dlg.innerHTML =
      '<h3 class="title-m mono">' + esc(path) + '</h3>' +
      '<div class="filepreview"><pre id="pvView"></pre><textarea id="pvEdit" style="display:none;width:100%;min-height:40vh;font-family:\'Roboto Mono\',ui-monospace,monospace;font-size:13px;padding:12px;border:1px solid var(--md-sys-color-outline);border-radius:12px;background:var(--md-sys-color-surface-container-highest);color:var(--md-sys-color-on-surface)"></textarea></div>' +
      (data && data.truncated ? '<p class="body-s muted">内容过长只显示了前一部分，完整编辑请让 agent 处理。</p>' : '') +
      '<div class="actions">' +
      '<button class="btn text" id="pvClose">关闭</button>' +
      '<a class="btn outlined small" href="' + BASE + '/api/download?path=' + encodeURIComponent(path) + '" download>' + svg('download') + '下载</a>' +
      '<button class="btn outlined" id="pvToggle">' + svg('edit') + '编辑</button>' +
      '</div>';
    document.body.appendChild(dlg);
    $('#pvView', dlg).textContent = content;
    var editing = false;
    $('#pvToggle', dlg).onclick = async function () {
      editing = !editing;
      $('#pvView', dlg).style.display = editing ? 'none' : '';
      $('#pvEdit', dlg).style.display = editing ? '' : 'none';
      if (editing) {
        $('#pvEdit', dlg).value = content;
        this.innerHTML = svg('doc') + '预览';
      } else {
        content = $('#pvEdit', dlg).value;
        $('#pvView', dlg).textContent = content;
        this.innerHTML = svg('edit') + '编辑';
        try {
          var r = await fetch(BASE + '/api/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path, content: content }),
            credentials: 'same-origin',
          });
          var out = null;
          try { out = await r.json(); } catch (e) { /* 忽略 */ }
          if (!r.ok || !out.ok) throw new Error((out && out.error) || '保存失败');
          toast('已保存');
          if (S.tab === 'files') loadFiles();
        } catch (e) { toast(e.message); }
      }
    };
    $('#pvClose', dlg).onclick = function () { dlg.close(); dlg.remove(); };
    dlg.addEventListener('close', function () { dlg.remove(); });
    dlg.showModal();
  }

  // ---------- 设置视图 ----------

  function numField(name, label, value, hint) {
    return '<div class="field"><label for="f_' + name + '">' + esc(label) + '</label>' +
      '<input id="f_' + name + '"" data-set="' + name + '" type="number" value="' + esc(value) + '">' +
      (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function textField(name, label, value, hint, type) {
    return '<div class="field"><label for="f_' + name + '">' + esc(label) + '</label>' +
      '<input id="f_' + name + '" data-set="' + name + '" type="' + (type || 'text') + '" value="' + esc(value) + '">' +
      (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function sw(name, label, desc, checked) {
    return '<label class="switch"><input type="checkbox" data-set="' + name + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="track"></span><span class="grow"><span class="label-l">' + esc(label) + '</span>' +
      (desc ? '<span class="body-s muted" style="display:block">' + esc(desc) + '</span>' : '') + '</span></label>';
  }

  function renderSettings(pane) {
    var s = S.settings || {};
    // 内嵌模式：模型来自所在网关的「模型链」，无需地址密钥；独立模式：手填网关三件套
    var gatewayCard = S.embedded
      ? '<div class="card"><h3 class="title-m">模型来源</h3>' +
        '<p class="body-m muted" style="margin:0 0 12px">本页 agent 内嵌在网关里，模型调用直接复用「提供商 / 模型链」的配置与故障转移，无需地址和密钥。' +
        '想增删模型，去控制台的模型链页。</p>' +
        '<div class="field"><label for="f_model">默认模型</label>' +
        '<select id="f_model" data-set="model">' +
        (function () {
          var cur = s.model || S.defaultModel || 'auto';
          var opts = ['<option value="auto"' + (cur === 'auto' ? ' selected' : '') + '>auto（跟随网关默认链）</option>'];
          for (var i = 0; i < S.models.length; i++) {
            var m = S.models[i];
            opts.push('<option value="' + esc(m.id) + '"' + (cur === m.id ? ' selected' : '') + '>' + esc(m.id) + (m.kind && m.kind !== 'chat' ? ' · ' + esc(m.kind) : '') + '</option>');
          }
          if (cur !== 'auto' && !S.models.some(function (x) { return x.id === cur; })) {
            opts.push('<option value="' + esc(cur) + '" selected>' + esc(cur) + '（别名已不存在）</option>');
          }
          return opts.join('');
        })() +
        '</select><div class="hint">故障转移永远生效：选中的模型失败会自动按链路顺序降级。</div></div>' +
        '</div>'
      : '<div class="card"><h3 class="title-m">网关</h3>' +
        textField('gatewayBaseUrl', '网关地址', s.gatewayBaseUrl || '', '例如 https://your-gateway.workers.dev，可以带 /v1 也可以不带。') +
        textField('gatewayKey', '网关密钥 ' + (s.hasKey ? '（已保存：' + esc(s.keyMask || '') + '，留掩码不改）' : '（必填）'), s.hasKey ? (s.keyMask || '') : (s.gatewayKey || ''), 'sk-gw-…，只在保存时明文可见。', 'password') +
        textField('model', '模型别名', s.model || 'auto', '网关调用链里的别名；auto/default 走默认链。') +
        '</div>';
    pane.innerHTML =
      '<div class="head"><h2 class="headline-s">设置</h2></div>' +
      '<p class="sub body-m">模型调用' + (S.embedded ? '由所在网关统一承载' : '经由你的 OpenAI 兼容网关') + '，改完即存即生效。</p>' +
      gatewayCard +
      '<div class="card"><h3 class="title-m">联网（可选）</h3>' +
      '<p class="body-m muted" style="margin:0 0 12px">配置后 agent 会多出 web_search / web_fetch 两个工具，任何会调工具的模型都能联网。</p>' +
      textField('webSearchUrl', '搜索端点 URL（Tavily 兼容，留空 = 关闭搜索）', s.webSearchUrl || '', 'Tavily 填 https://api.tavily.com/search；其他服务只要 POST {query} 返回 {results:[{title,url,content}]} 即可。') +
      textField('webSearchKey', '搜索 API Key' + (s.hasWebKey ? '（已保存：' + esc(s.webKeyMask || '') + '，留掩码不改）' : ''), s.hasWebKey ? (s.webKeyMask || '') : (s.webSearchKey || ''), 'Tavily 是 tvly- 开头。抓取（web_fetch）不依赖这里，走 Worker 原生抓取。', 'password') +
      sw('webFetchEnabled', '允许 web_fetch 抓取网页', '关掉后 agent 只能搜索不能打开具体网页。', s.webFetchEnabled !== false) +
      '</div>' +
      '<div class="card"><h3 class="title-m">行为</h3>' +
      numField('maxToolCalls', '单轮最多工具调用次数', s.maxToolCalls, '到上限后强制总结。免费版每次调用 50 个子请求的护栏。') +
      numField('maxHistoryChars', '上下文字符预算', s.maxHistoryChars, '超了就丢最旧几段对话（成组丢，不会拆散工具配对）。') +
      '<label class="switch"><input type="checkbox" data-set="scheduleEnabled"' + (s.scheduleEnabled !== false ? ' checked' : '') + '>' +
      '<span class="track"></span><span class="grow"><span class="label-l">允许定时任务</span>' +
      '<span class="body-s muted" style="display:block">关掉后 agent 的 schedule_task 会被拒绝。</span></span></label>' +
      '</div>' +
      '<div class="card"><h3 class="title-m">附加系统提示</h3>' +
      '<div class="field"><textarea id="f_systemPrompt" data-set="systemPrompt" placeholder="工作区说明、语气要求等。基础守则已内置，不用重复。">' + esc(s.systemPrompt || '') + '</textarea></div>' +
      '</div>' +
      '<div class="row"><button class="btn" id="saveSet">保存设置</button></div>';
    $('#saveSet').onclick = async function () {
      var payload = {};
      var els = pane.querySelectorAll('[data-set]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        payload[el.dataset.set] = el.type === 'checkbox' ? el.checked : el.value;
      }
      try {
        var r = await api('settings', { settings: payload });
        S.settings = r.settings;
        toast('设置已保存');
        renderSettings(pane);
      } catch (e) { toast(e.message); }
    };
  }

  // ---------- 启动 ----------

  async function boot() {
    try {
      var s = await api('session');
      S.authed = s.authed;
      S.hasPassword = s.hasPassword;
      if (S.authed) {
        var st = await api('state');
        S.settings = st.settings;
        S.defaults = st.defaults || {};
        S.sessions = st.sessions || [];
        S.embedded = Boolean(st.embedded);
        S.models = st.models || [];
        S.defaultModel = st.defaultModel || '';
      }
    } catch (e) { /* 未登录 */ }
    if (S.authed) render();
    else renderLogin();
  }

  initTheme();
  boot();
}
