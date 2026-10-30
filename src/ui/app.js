// 后台前端。写成一个函数，构建时用 Function.prototype.toString() 内联进 HTML，
// 这样这里可以正常用模板字符串，不需要满屏转义。
//
// 图标全部是手写的 24x24 描边 SVG（不是 emoji，也不引外部图标字体）：
// emoji 在不同系统里渲染差异极大，而外部字体要多花一次请求。

export function uiApp() {
  var S = {
    authed: false, hasPassword: true, kvBound: true,
    presets: [], config: null, keys: [], cooldown: [], stats: null, usage: null, disguise: null,
  };
  var TAB = 'overview';
  var discovered = { providerId: null, list: [], picked: {} };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var root = $('#root');

  // ---------- 图标 ----------

  var ICONS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M18 6l-.9-3.4M18 6l-3.4-.9"/>',
    logout: '<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M16 8l4 4-4 4M20 12H9"/>',
    moon: '<path d="M20 13.5A8.5 8.5 0 1 1 10.5 4a7 7 0 0 0 9.5 9.5Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    overview: '<rect x="3.5" y="3.5" width="7" height="8" rx="2"/><rect x="13.5" y="3.5" width="7" height="5" rx="2"/><rect x="13.5" y="11.5" width="7" height="9" rx="2"/><rect x="3.5" y="14.5" width="7" height="6" rx="2"/>',
    hub: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="4" r="2"/><circle cx="19" cy="17" r="2"/><circle cx="5" cy="17" r="2"/><path d="M12 9V6M14.6 13.7l2.6 1.6M9.4 13.7l-2.6 1.6"/>',
    layers: '<path d="M12 2.5 2.5 7 12 11.5 21.5 7 12 2.5Z"/><path d="M2.5 12 12 16.5 21.5 12"/><path d="M2.5 17 12 21.5 21.5 17"/>',
    key: '<circle cx="7.5" cy="12" r="3.5"/><path d="M11 12h9.5M17.5 12v3M20.5 12v2.5"/>',
    chart: '<path d="M3 20.5h18"/><path d="M6.5 20.5V12M12 20.5V4.5M17.5 20.5v-5.5"/>',
    tune: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.6"/><circle cx="8" cy="17" r="2.6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z"/>',
    up: '<path d="M12 19.5V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 4.5V19M18 13l-6 6-6-6"/>',
    edit: '<path d="M4 20h4L19 9a2.12 2.12 0 0 0-3-3L5 17v3Z"/><path d="M14.5 6.5l3 3"/>',
    trash: '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
    copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path d="M5.5 15h-.5A1.5 1.5 0 0 1 3.5 13.5v-9A1.5 1.5 0 0 1 5 3h9a1.5 1.5 0 0 1 1.5 1.5V5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6 21 21"/>',
    bolt: '<path d="M13 2.5 5.5 13.5H11l-1 8 7.5-11H12l1-8Z"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.95 6.75 19.7l1-5.85L3.5 9.7l5.9-.9L12 3.5Z"/>',
    mark: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.2v3.4M12 18.4v3.4M2.2 12h3.4M18.4 12h3.4"/><path d="M5.1 5.1l2.4 2.4M16.5 16.5l2.4 2.4M18.9 5.1l-2.4 2.4M7.5 16.5l-2.4 2.4"/>',
    bot: '<rect x="4.5" y="8.5" width="15" height="11" rx="3"/><path d="M12 8.5V4.5M8.5 4.5h7"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/><path d="M9.5 17h5"/>',
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

  function fmt(n) {
    var v = Number(n) || 0;
    return v.toLocaleString('en-US');
  }

  function when(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
  }

  function toast(msg, ms) {
    var el = $('#snack');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.classList.remove('on');
      // 收起动画放完再清空文本，避免 :empty 立刻把元素抽掉导致动画被打断
      setTimeout(function () { if (!el.classList.contains('on')) el.textContent = ''; }, 300);
    }, ms || 3200);
  }

  async function api(path, body) {
    var res = await fetch('/admin/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401 && path !== 'login') { S.authed = false; render(); throw new Error('会话已过期，请重新登录。'); }
    if (!res.ok) throw new Error((data && data.error && data.error.message) || ('请求失败 ' + res.status));
    return data;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制'); } catch (e2) { toast('复制失败，请手动选中'); }
      ta.remove();
    }
  }

  // ---------- 启动 ----------

  async function boot() {
    try {
      var s = await api('session');
      S.authed = s.authed; S.hasPassword = s.hasPassword;
      if (S.authed) await loadState();
    } catch (e) { /* 未登录 */ }
    render();
  }

  async function loadState() {
    var data = await api('state');
    S.kvBound = data.kvBound;
    S.agent = Boolean(data.agent); // 合并部署才有：左侧 rail 显示 Agent 入口
    S.presets = data.presets;
    S.config = data.config;
    S.keys = data.keys;
    S.cooldown = data.cooldown;
    S.stats = data.stats;
    S.usage = data.usage;
    S.disguise = data.disguise;
    S.defaults = data.defaults;
  }

  async function refresh() { await loadState(); render(); }

  // ---------- 渲染 ----------

  function render() {
    if (!S.authed) { closeNav(); renderLogin(); return; }
    closeNav();
    root.innerHTML = shell();
    bindShell();
    renderTab();
  }

  function renderLogin() {
    root.innerHTML =
      '<div class="login"><div class="card elev">' +
      '<div class="logo">' + svg('mark') + '</div>' +
      '<h1 class="headline-s">LLM Gateway</h1>' +
      '<p class="body-m muted" style="margin:8px 0 24px">用环境变量 admin_password 里设置的密码登录。</p>' +
      (S.hasPassword ? '' : '<div class="banner">还没有设置 admin_password。请到 Cloudflare 控制台的变量与机密里添加纯文本变量 admin_password，然后重新部署。</div>') +
      '<div class="field round"><label for="pw">管理员密码</label><input id="pw" type="password" autocomplete="current-password"></div>' +
      '<button class="btn" id="loginBtn" style="width:100%">登录</button>' +
      '</div></div>';
    var go = async function () {
      var btn = $('#loginBtn'); btn.disabled = true;
      try {
        await api('login', { password: $('#pw').value });
        S.authed = true;
        await loadState();
        render();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    $('#loginBtn').onclick = go;
    $('#pw').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    $('#pw').focus();
  }

  var TABS = [
    { id: 'overview', icon: 'overview', label: '概览' },
    { id: 'providers', icon: 'hub', label: '提供商' },
    { id: 'models', icon: 'layers', label: '模型链' },
    { id: 'keys', icon: 'key', label: '密钥' },
    { id: 'usage', icon: 'chart', label: '用量' },
    { id: 'settings', icon: 'tune', label: '设置' },
    { id: 'edge', icon: 'globe', label: '优选 IP' },
  ];

  function isDark() { return document.documentElement.dataset.theme === 'dark'; }

  function themeItem() {
    var dark = isDark();
    return '<button class="navitem" id="themeBtn" type="button" title="夜间模式切换">' +
      '<span class="pill">' + svg(dark ? 'sun' : 'moon') + '</span>' +
      '<span class="rl">夜间模式切换</span>' +
      '<span class="themestate">' + (dark ? '深色' : '浅色') + '</span></button>';
  }

  function shell() {
    var nav = TABS.map(function (t) {
      return '<button class="navitem" type="button" data-tab="' + t.id + '" aria-selected="' + (TAB === t.id) + '">' +
        '<span class="pill">' + svg(t.icon) + '</span><span class="rl">' + t.label + '</span></button>';
    }).join('');
    // 内嵌 Agent：只有合并部署（绑定了 DO/D1/R2）才出现这个入口；
    // Pages 纯网关产物里 state.agent 为 false，自动隐藏。
    if (S.agent) {
      nav += '<button class="navitem" type="button" data-href="/agent" title="文件工作区 Agent">' +
        '<span class="pill">' + svg('bot') + '</span><span class="rl">Agent</span></button>';
    }

    return '' +
      '<header class="topbar">' +
      '<button class="icon menubtn" id="menuBtn" type="button" aria-label="打开菜单" aria-expanded="false">' + svg('menu') + '</button>' +
      '<span class="brand"><span class="mark">' + svg('mark') + '</span><b>LLM Gateway</b>' +
      '<span class="long body-s muted">OpenAI 兼容聚合网关</span></span>' +
      '<span class="spacer"></span>' +
      '<button class="icon" id="reloadBtn" type="button" title="刷新" aria-label="刷新">' + svg('refresh') + '</button>' +
      '<button class="btn tonal small logout" id="logoutBtn" type="button" aria-label="退出控制台">' +
      svg('logout', 'sm') + '<span class="logouttext">退出</span></button>' +
      '</header>' +
      '<div class="scrim" id="scrim"></div>' +
      '<div class="shell">' +
      '<nav class="rail" id="rail" aria-label="功能导航">' +
      '<div class="drawerhead"><span class="t">导航</span>' +
      '<button class="icon" id="navClose" type="button" aria-label="关闭菜单">' + svg('close') + '</button></div>' +
      nav +
      '<div class="railfoot">' + themeItem() + '</div>' +
      '</nav>' +
      '<main><div class="wrap" id="pane"></div></main></div>';
  }

  function openNav() {
    document.body.classList.add('nav-open');
    var b = $('#menuBtn'); if (b) b.setAttribute('aria-expanded', 'true');
    var first = $('#rail .navitem'); if (first) first.focus();
  }
  function closeNav() {
    document.body.classList.remove('nav-open');
    var b = $('#menuBtn'); if (b) b.setAttribute('aria-expanded', 'false');
  }
  function toggleNav() {
    if (document.body.classList.contains('nav-open')) closeNav(); else openNav();
  }

  function applyTheme(next) {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('gw-theme', next); } catch (e) {}
    var foot = $('.railfoot');
    if (foot) { foot.innerHTML = themeItem(); bindTheme(); }
  }

  function bindTheme() {
    var t = $('#themeBtn');
    if (t) t.onclick = function () { applyTheme(isDark() ? 'light' : 'dark'); };
  }

  function bindShell() {
    root.querySelectorAll('.navitem[data-tab]').forEach(function (b) {
      b.onclick = function () { TAB = b.dataset.tab; render(); };
    });
    root.querySelectorAll('.navitem[data-href]').forEach(function (b) {
      b.onclick = function () { location.href = b.dataset.href; };
    });
    bindTheme();
    $('#menuBtn').onclick = toggleNav;
    $('#navClose').onclick = closeNav;
    $('#scrim').onclick = closeNav;
    $('#reloadBtn').onclick = async function () {
      var b = this;
      b.classList.add('spinning'); b.disabled = true;
      try { await refresh(); toast('已刷新'); }
      catch (e) { toast(e.message); b.classList.remove('spinning'); b.disabled = false; }
    };
    $('#logoutBtn').onclick = async function () {
      await api('logout', {});
      S.authed = false; render();
    };
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) closeNav();
  });

  function renderTab() {
    var pane = $('#pane');
    if (TAB === 'overview') viewOverview(pane);
    else if (TAB === 'providers') viewProviders(pane);
    else if (TAB === 'models') viewModels(pane);
    else if (TAB === 'keys') viewKeys(pane);
    else if (TAB === 'usage') viewUsage(pane);
    else if (TAB === 'settings') viewSettings(pane);
    else if (TAB === 'edge') viewEdge(pane);
    // 重放一次进场动画：切页时内容淡入上移，不然内容是"啪"地换掉的
    pane.classList.remove('enter');
    void pane.offsetWidth;
    pane.classList.add('enter');
  }

  function warnings() {
    var out = '';
    if (!S.kvBound) out += '<div class="banner"><b>没有检测到 KV 绑定。</b> 现在改的任何配置都不会保存，重新部署就没了。请到 Worker/Pages 设置里新建 KV 命名空间绑定，变量名填 <span class="mono">KV</span>。</div>';
    if (S.config && !S.config.models.length) out += '<div class="banner info">还没有模型。先去「提供商」加一个上游，搜索模型后加入调用链。</div>';
    else if (S.keys && !S.keys.length) out += '<div class="banner info">还没有网关密钥。到「密钥」页创建一个，才能从外部调用。</div>';
    return out;
  }

  // ---------- 概览 ----------

  function viewOverview(pane) {
    var base = location.origin;
    var models = S.config.models;
    var dm = models.filter(function (m) { return m.id === S.config.defaultModel; })[0];
    pane.innerHTML =
      warnings() +
      '<div class="head"><h2 class="headline-s">概览</h2></div>' +
      '<p class="sub body-m">把下面这个地址填进 Claude Code、AstrBot、Cherry Studio 等客户端的 OpenAI Base URL。</p>' +
      '<div class="card elev">' +
      '<div class="title-s muted">接口地址</div>' +
      '<div class="row" style="margin:8px 0 16px"><code class="keyout" style="flex:1 1 200px">' + esc(base) + '/v1</code>' +
      '<button class="btn tonal small" data-copy="' + esc(base) + '/v1">' + svg('copy', 'sm') + '复制</button></div>' +
      '<div class="title-s muted">OpenAI 协议 · chat</div>' +
      '<div class="row" style="margin:8px 0 12px"><code class="mono body-s" style="flex:1 1 200px;word-break:break-all">' + esc(base) + '/v1/chat/completions</code>' +
      '<button class="btn text small" data-copy="' + esc(base) + '/v1/chat/completions">复制</button></div>' +
      '<div class="title-s muted">Anthropic 协议 · messages（给 Claude Code 用）</div>' +
      '<div class="row" style="margin:8px 0 0"><code class="mono body-s" style="flex:1 1 200px;word-break:break-all">' + esc(base) + '/v1/messages</code>' +
      '<button class="btn text small" data-copy="' + esc(base) + '">复制根地址</button></div>' +
      '</div>' +
      '<div class="grid three" style="margin-bottom:16px">' +
      stat('提供商', S.config.providers.length) +
      stat('调用链模型', models.filter(function (m) { return m.enabled !== false; }).length + ' / ' + models.length) +
      stat('可用密钥', S.keys.filter(function (k) { return k.enabled; }).length) +
      '</div>' +
      '<div class="card">' +
      '<h3 class="title-m">默认模型</h3>' +
      '<p class="body-m muted">客户端没指定模型、或指定了网关里不存在的模型时，从这个模型开始往下试。</p>' +
      (dm ? '<div class="chips"><span class="chip pri">' + esc(dm.alias) + '</span><span class="chip">上游 ' + esc(dm.model) + '</span></div>'
          : '<div class="chips"><span class="chip err">未设置</span></div>') +
      '</div>' +
      (S.cooldown.length ? '<div class="card"><h3 class="title-m">冷却中的模型</h3><p class="body-m muted">这些模型最近调用失败，冷却期内会被直接跳过，不发请求。</p><div class="chips">' +
        S.cooldown.map(function (c) {
          var m = models.filter(function (x) { return x.id === c.modelId; })[0];
          return '<span class="chip err">' + esc(m ? m.alias : c.modelId) + ' · ' + c.status + ' · ' + c.secondsLeft + 's</span>';
        }).join('') + '</div><div style="margin-top:12px"><button class="btn outlined small" id="clearCd">立即解除冷却</button></div></div>' : '') +
      '<div class="card outlined"><h3 class="title-m">接入示例</h3>' +
      '<pre class="code">curl ' + esc(base) + '/v1/chat/completions \\\n' +
      '  -H "Authorization: Bearer $GW_KEY" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"model":"' + esc(dm ? dm.alias : 'auto') + '","messages":[{"role":"user","content":"hi"}]}\'</pre>' +
      '<p class="body-s muted" style="margin-top:12px"><b>AstrBot</b>：提供商类型选 OpenAI，API Base 填 <span class="mono">' + esc(base) + '/v1</span>，' +
      '模型名照抄「模型链」页里的别名 —— 网关的 /v1/models 会把这些别名列出来，选不到模型多半是 base_url 少写了 /v1。<br>' +
      '<b>Claude Code</b>：它说的是 Anthropic 协议，所以要设 <span class="mono">ANTHROPIC_BASE_URL=' + esc(base) + '</span> 和 ' +
      '<span class="mono">ANTHROPIC_AUTH_TOKEN=你的网关密钥</span>，网关会自动在两种协议之间翻译。</p></div>' +
      '<div class="card"><h3 class="title-m">本 isolate 运行统计</h3>' +
      '<p class="body-s muted">只存在内存里，不写 KV。Cloudflare 回收实例后归零，属正常现象。按密钥累计的长期用量在「用量」页。</p>' +
      '<div class="chips"><span class="chip">请求 ' + S.stats.requests + '</span><span class="chip ok">成功 ' + S.stats.success + '</span><span class="chip err">全链失败 ' + S.stats.failed + '</span></div></div>';

    pane.querySelectorAll('[data-copy]').forEach(function (b) { b.onclick = function () { copy(b.dataset.copy); }; });
    var cc = $('#clearCd');
    if (cc) cc.onclick = async function () { await api('cooldown/clear', {}); await refresh(); toast('冷却已解除'); };
  }

  function stat(label, n) {
    return '<div class="stat"><div class="n">' + esc(String(n)) + '</div><div class="body-s muted">' + esc(label) + '</div></div>';
  }

  // ---------- 提供商 ----------

  function viewProviders(pane) {
    var list = S.config.providers.map(function (p) {
      var count = S.config.models.filter(function (m) { return m.providerId === p.id; }).length;
      return '<div class="item">' +
        '<div class="grow"><div class="title-s">' + esc(p.name) + (p.enabled === false ? ' <span class="chip">已停用</span>' : '') + '</div>' +
        '<div class="body-s muted ellipsis mono">' + esc(p.baseUrl) + '</div>' +
        '<div class="chips" style="margin-top:8px"><span class="chip">' + esc(p.keyMask || '无 key') + '</span>' +
        '<span class="chip">鉴权 ' + esc(p.authStyle) + '</span><span class="chip">' + count + ' 个模型已入链</span></div></div>' +
        '<div class="acts">' +
        '<button class="btn tonal small" data-test="' + p.id + '">测试</button>' +
        '<button class="btn small" data-discover="' + p.id + '">' + svg('search', 'sm') + '搜索模型</button>' +
        '<button class="icon" data-edit="' + p.id + '" title="编辑" aria-label="编辑">' + svg('edit') + '</button>' +
        '<button class="icon" data-del="' + p.id + '" title="删除" aria-label="删除">' + svg('trash') + '</button>' +
        '</div></div>';
    }).join('');

    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">提供商</h2><span class="spacer"></span>' +
      '<button class="btn" id="addProv">' + svg('plus', 'sm') + '添加提供商</button></div>' +
      '<p class="sub body-m">填入各家的 API Key。所有 key 存在 KV 里，面板只显示掩码，不会回传明文。</p>' +
      (S.config.providers.length ? '<div class="list">' + list + '</div>'
        : '<div class="empty">还没有提供商。点上面的按钮添加一个，比如 DeepSeek 或 NVIDIA NIM。</div>');

    $('#addProv').onclick = function () { providerDialog(null); };
    pane.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { providerDialog(S.config.providers.filter(function (p) { return p.id === b.dataset.edit; })[0]); };
    });
    pane.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('删除这个提供商？它名下已加入调用链的模型会一并删除。')) return;
        await api('providers/delete', { id: b.dataset.del });
        await refresh(); toast('已删除');
      };
    });
    pane.querySelectorAll('[data-test]').forEach(function (b) {
      b.onclick = async function () {
        b.disabled = true; b.textContent = '测试中';
        try { var r = await api('providers/test', { id: b.dataset.test }); toast((r.ok ? '成功：' : '失败：') + r.message + ' (' + r.ms + 'ms)', 5000); }
        catch (e) { toast(e.message); }
        b.disabled = false; b.textContent = '测试';
      };
    });
    pane.querySelectorAll('[data-discover]').forEach(function (b) {
      b.onclick = function () { discoverDialog(b.dataset.discover); };
    });
  }

  function providerDialog(existing) {
    var p = existing || { type: 'deepseek', authStyle: 'bearer', enabled: true };
    var opts = S.presets.map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === p.type ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    }).join('');
    var dlg = mkDialog(
      (existing ? '编辑提供商' : '添加提供商'),
      '<div class="field"><label for="pType">预设</label><select id="pType">' + opts + '</select><div class="hint" id="pNote"></div></div>' +
      '<div class="field"><label for="pName">显示名称</label><input id="pName" value="' + esc(p.name || '') + '"></div>' +
      '<div class="field"><label for="pUrl">Base URL（OpenAI 兼容端点，末尾不要带 /chat/completions）</label><input id="pUrl" class="mono" value="' + esc(p.baseUrl || '') + '"></div>' +
      '<div class="field"><label for="pKey">API Key' + (existing ? '（留空表示不修改）' : '') + '</label><input id="pKey" type="password" autocomplete="off" placeholder="' + esc(existing && existing.keyMask ? existing.keyMask : '') + '"></div>' +
      '<div class="field"><label for="pAuth">鉴权方式</label><select id="pAuth">' +
      ['bearer', 'api-key', 'x-api-key', 'custom'].map(function (a) {
        return '<option value="' + a + '"' + (a === p.authStyle ? ' selected' : '') + '>' + (a === 'bearer' ? 'Authorization: Bearer（多数厂商）' : a === 'custom' ? '自定义请求头' : a + ' 请求头') + '</option>';
      }).join('') + '</select></div>' +
      '<div id="customAuth" style="display:none"><div class="field"><label for="pHeadName">请求头名</label><input id="pHeadName" value="' + esc(p.authHeaderName || '') + '"></div>' +
      '<div class="field"><label for="pHeadPrefix">值前缀（可空）</label><input id="pHeadPrefix" value="' + esc(p.authHeaderPrefix || '') + '"></div></div>' +
      '<label class="switch"><input type="checkbox" id="pEnabled"' + (p.enabled !== false ? ' checked' : '') + '><span class="track"></span><span class="label-l">启用</span></label>',
      '保存'
    );

    var typeSel = $('#pType', dlg), urlIn = $('#pUrl', dlg), nameIn = $('#pName', dlg), authSel = $('#pAuth', dlg);
    function syncPreset(force) {
      var preset = S.presets.filter(function (x) { return x.id === typeSel.value; })[0];
      if (!preset) return;
      $('#pNote', dlg).textContent = preset.note || '';
      if (force || !urlIn.value) urlIn.value = preset.baseUrl || '';
      if (force || !nameIn.value) nameIn.value = preset.name;
      if (force) authSel.value = preset.authStyle || 'bearer';
      $('#customAuth', dlg).style.display = authSel.value === 'custom' ? 'block' : 'none';
    }
    typeSel.onchange = function () { syncPreset(true); };
    authSel.onchange = function () { $('#customAuth', dlg).style.display = authSel.value === 'custom' ? 'block' : 'none'; };
    syncPreset(false);

    $('#dlgOk', dlg).onclick = async function () {
      var payload = {
        id: existing ? existing.id : undefined,
        type: typeSel.value,
        name: nameIn.value.trim(),
        baseUrl: urlIn.value.trim(),
        apiKey: $('#pKey', dlg).value.trim(),
        authStyle: authSel.value,
        authHeaderName: $('#pHeadName', dlg).value.trim(),
        authHeaderPrefix: $('#pHeadPrefix', dlg).value.trim(),
        enabled: $('#pEnabled', dlg).checked,
      };
      try {
        await api('providers/save', { provider: payload });
        dlg.close(); dlg.remove();
        await refresh(); toast('已保存');
      } catch (e) { toast(e.message); }
    };
  }

  async function discoverDialog(providerId) {
    var prov = S.config.providers.filter(function (p) { return p.id === providerId; })[0];
    var dlg = mkDialog('搜索 ' + esc(prov.name) + ' 的模型',
      '<p class="body-m muted">正在用这把 key 请求上游的 /models…</p><div id="dList"></div>', '添加所选');
    $('#dlgOk', dlg).disabled = true;

    var r;
    try { r = await api('providers/discover', { id: providerId }); }
    catch (e) { $('#dList', dlg).innerHTML = '<div class="banner">' + esc(e.message) + '</div>'; return; }
    if (!r.ok) {
      $('#dList', dlg).innerHTML = '<div class="banner">' + esc(r.message) + '</div>' +
        '<p class="body-s muted">也可以直接手工填模型名：把上游模型 ID 写进下面的输入框。</p>' +
        '<div class="field"><label for="manual">手工添加（逗号分隔）</label><input id="manual" class="mono" placeholder="deepseek-chat, deepseek-reasoner"></div>';
      $('#dlgOk', dlg).disabled = false;
      $('#dlgOk', dlg).onclick = async function () {
        var ids = ($('#manual', dlg).value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (!ids.length) return toast('先填至少一个模型名');
        await api('models/add', { providerId: providerId, models: ids.map(function (id) { return { id: id }; }) });
        dlg.close(); dlg.remove(); await refresh(); toast('已添加 ' + ids.length + ' 个');
      };
      return;
    }

    discovered = { providerId: providerId, list: r.models, picked: {} };
    $('#dlgOk', dlg).disabled = false;
    $('#dList', dlg).innerHTML =
      '<div class="field" style="margin-bottom:12px"><label for="filter">筛选（共 ' + r.count + ' 个）</label><input id="filter" placeholder="输入关键字，比如 flash / pro / vl"></div>' +
      '<div class="row" style="margin-bottom:8px"><button class="btn text small" id="selAll">全选当前</button><button class="btn text small" id="selNone">清空</button>' +
      '<span class="spacer" style="flex:1"></span><span class="body-s muted" id="cnt">已选 0</span></div>' +
      '<div class="scroll" id="mlist"></div>' +
      // 拉取成功也保留手工入口：上游 /models 不全、私有部署改名、或只想加某一个时用得上
      '<p class="body-s muted" style="margin:12px 0 0">列表里没有的模型，直接手工填上游模型 ID（逗号分隔），确认时会一并加入。</p>' +
      '<div class="field"><label for="manual">手工添加（逗号分隔，可与上方勾选并用）</label><input id="manual" class="mono" placeholder="比如 gpt-5-chat, my-private-model"></div>';

    function paint() {
      var q = ($('#filter', dlg).value || '').toLowerCase();
      var rows = discovered.list.filter(function (m) { return !q || m.id.toLowerCase().indexOf(q) >= 0; });
      $('#mlist', dlg).innerHTML = rows.length ? rows.map(function (m) {
        var caps = [];
        if (m.caps.vision) caps.push('视觉');
        if (m.caps.audio) caps.push('音频');
        if (m.caps.video) caps.push('视频');
        if (m.caps.tools) caps.push('工具');
        if (m.caps.reasoning) caps.push('推理');
        return '<label class="item" style="cursor:pointer">' +
          '<input type="checkbox" data-mid="' + esc(m.id) + '"' + (discovered.picked[m.id] ? ' checked' : '') + (m.added ? ' disabled' : '') + '>' +
          '<div class="grow"><div class="title-s mono ellipsis">' + esc(m.id) + '</div>' +
          '<div class="chips" style="margin-top:6px"><span class="chip">' + esc(m.kind) + '</span>' +
          caps.map(function (c) { return '<span class="chip on">' + c + '</span>'; }).join('') +
          (m.added ? '<span class="chip pri">已在链中</span>' : '') + '</div></div></label>';
      }).join('') : '<div class="empty">没有匹配的模型</div>';

      $('#mlist', dlg).querySelectorAll('input[data-mid]').forEach(function (cb) {
        cb.onchange = function () {
          if (cb.checked) discovered.picked[cb.dataset.mid] = true; else delete discovered.picked[cb.dataset.mid];
          $('#cnt', dlg).textContent = '已选 ' + Object.keys(discovered.picked).length;
        };
      });
    }
    $('#filter', dlg).oninput = paint;
    $('#selAll', dlg).onclick = function () {
      var q = ($('#filter', dlg).value || '').toLowerCase();
      discovered.list.forEach(function (m) { if (!m.added && (!q || m.id.toLowerCase().indexOf(q) >= 0)) discovered.picked[m.id] = true; });
      paint(); $('#cnt', dlg).textContent = '已选 ' + Object.keys(discovered.picked).length;
    };
    $('#selNone', dlg).onclick = function () { discovered.picked = {}; paint(); $('#cnt', dlg).textContent = '已选 0'; };
    paint();

    $('#dlgOk', dlg).onclick = async function () {
      var picked = Object.keys(discovered.picked);
      var manual = ($('#manual', dlg).value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      // 手工填的和勾选的合并去重（同一上游模型 ID 重复添加服务端本来就会跳过）
      var ids = picked.concat(manual.filter(function (id) { return picked.indexOf(id) < 0; }));
      if (!ids.length) return toast('先勾选或手工填至少一个模型');
      var payload = ids.map(function (id) {
        var m = discovered.list.filter(function (x) { return x.id === id; })[0];
        return m ? { id: id, kind: m.kind, caps: m.caps } : { id: id };
      });
      try {
        var res = await api('models/add', { providerId: providerId, models: payload });
        dlg.close(); dlg.remove();
        await refresh(); toast('已加入调用链 ' + res.added + ' 个模型');
      } catch (e) { toast(e.message); }
    };
  }

  // ---------- 模型链 ----------

  function viewModels(pane) {
    var models = S.config.models;
    var rows = models.map(function (m, i) {
      var p = S.config.providers.filter(function (x) { return x.id === m.providerId; })[0];
      var caps = [];
      if (m.caps) {
        if (m.caps.vision) caps.push('视觉');
        if (m.caps.audio) caps.push('音频');
        if (m.caps.video) caps.push('视频');
        if (m.caps.tools) caps.push('工具调用');
        if (m.caps.reasoning) caps.push('推理');
      }
      var isDefault = S.config.defaultModel === m.id;
      return '<div class="item">' +
        '<div class="ordinal' + (m.enabled === false ? ' off' : '') + '">' + (i + 1) + '</div>' +
        '<div class="grow"><div class="title-s ellipsis">' + esc(m.alias) + (isDefault ? ' <span class="chip pri">默认</span>' : '') + '</div>' +
        '<div class="body-s muted ellipsis mono">' + esc(p ? p.name : '提供商已删除') + ' · ' + esc(m.model) + '</div>' +
        '<div class="chips" style="margin-top:8px"><span class="chip">' + esc(m.kind || 'chat') + '</span>' +
        (caps.length ? caps.map(function (c) { return '<span class="chip on">' + c + '</span>'; }).join('') : '<span class="chip">纯文本</span>') +
        '</div></div>' +
        '<div class="acts">' +
        '<button class="icon" data-up="' + m.id + '"' + (i === 0 ? ' disabled' : '') + ' title="上移" aria-label="上移">' + svg('up') + '</button>' +
        '<button class="icon" data-down="' + m.id + '"' + (i === models.length - 1 ? ' disabled' : '') + ' title="下移" aria-label="下移">' + svg('down') + '</button>' +
        '<button class="btn tonal small" data-test="' + m.id + '">测试</button>' +
        '<button class="btn text small" data-default="' + m.id + '"' + (isDefault ? ' disabled' : '') + '>设为默认</button>' +
        '<button class="icon" data-edit="' + m.id + '" title="编辑" aria-label="编辑">' + svg('edit') + '</button>' +
        '<button class="icon" data-del="' + m.id + '" title="移除" aria-label="移除">' + svg('trash') + '</button>' +
        '</div></div>';
    }).join('');

    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">模型调用链</h2></div>' +
      '<p class="sub body-m">从上往下依次尝试：第 1 个能正常返回就用它，之后不再往后试。全部失败返回 403。序号 1 就是最优先。</p>' +
      (models.length ? '<div class="list">' + rows + '</div>' : '<div class="empty">调用链是空的。先到「提供商」搜索并添加模型。</div>');

    pane.querySelectorAll('[data-up],[data-down]').forEach(function (b) {
      b.onclick = async function () {
        var id = b.dataset.up || b.dataset.down;
        var ids = models.map(function (m) { return m.id; });
        var i = ids.indexOf(id);
        var j = b.dataset.up ? i - 1 : i + 1;
        if (j < 0 || j >= ids.length) return;
        ids[i] = ids[j]; ids[j] = id;
        await api('models/reorder', { ids: ids });
        await refresh();
      };
    });
    pane.querySelectorAll('[data-default]').forEach(function (b) {
      b.onclick = async function () { await api('models/default', { id: b.dataset.default }); await refresh(); toast('已设为默认模型'); };
    });
    pane.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('把这个模型移出调用链？')) return;
        await api('models/delete', { id: b.dataset.del }); await refresh(); toast('已移除');
      };
    });
    pane.querySelectorAll('[data-test]').forEach(function (b) {
      b.onclick = async function () {
        b.disabled = true; b.textContent = '…';
        try { var r = await api('models/test', { id: b.dataset.test }); toast((r.ok ? '成功：' : '失败 ' + r.status + '：') + r.message + ' (' + r.ms + 'ms)', 6000); }
        catch (e) { toast(e.message); }
        b.disabled = false; b.textContent = '测试';
      };
    });
    pane.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { modelDialog(models.filter(function (m) { return m.id === b.dataset.edit; })[0]); };
    });
  }

  function modelDialog(m) {
    var capRows = [
      ['text', '文本'], ['vision', '视觉 / 图片'], ['audio', '音频'], ['video', '视频'],
      ['tools', '工具调用 function calling'], ['json', 'JSON 输出'], ['reasoning', '推理 / 思维链'],
    ].map(function (c) {
      return '<label class="switch"><input type="checkbox" data-cap="' + c[0] + '"' + (m.caps && m.caps[c[0]] ? ' checked' : '') + '><span class="track"></span><span class="label-l">' + c[1] + '</span></label>';
    }).join('');

    var dlg = mkDialog('编辑模型',
      '<div class="field"><label for="mAlias">对外别名（客户端里填的模型名）</label><input id="mAlias" class="mono" value="' + esc(m.alias) + '"></div>' +
      '<div class="field"><label for="mUp">上游模型 ID</label><input id="mUp" class="mono" value="' + esc(m.model) + '"></div>' +
      '<div class="field"><label for="mKind">类型</label><select id="mKind">' +
      ['chat', 'embedding', 'image', 'audio', 'video', 'rerank'].map(function (k) {
        return '<option value="' + k + '"' + (k === (m.kind || 'chat') ? ' selected' : '') + '>' + k + '</option>';
      }).join('') + '</select><div class="hint">embedding 类型只参与 /v1/embeddings，不进 chat 调用链。</div></div>' +
      '<div class="title-s" style="margin:16px 0 4px">能力标注</div>' +
      '<p class="body-s muted" style="margin:0 0 8px">上游的 /models 基本不返回模态信息，这里的初始值是按模型名猜的，不准就手工改。</p>' + capRows +
      '<div class="field" style="margin-top:16px"><label for="mDrop">转发时删掉的参数（逗号分隔）</label><input id="mDrop" class="mono" value="' + esc((m.dropParams || []).join(', ')) + '" placeholder="frequency_penalty, presence_penalty"><div class="hint">某些上游会因为不认识的参数直接 400，把它们填这里。</div></div>' +
      '<label class="switch"><input type="checkbox" id="mEnabled"' + (m.enabled !== false ? ' checked' : '') + '><span class="track"></span><span class="label-l">在调用链中启用</span></label>',
      '保存');

    $('#dlgOk', dlg).onclick = async function () {
      var caps = {};
      dlg.querySelectorAll('[data-cap]').forEach(function (cb) { caps[cb.dataset.cap] = cb.checked; });
      try {
        await api('models/save', {
          model: {
            id: m.id,
            alias: $('#mAlias', dlg).value.trim(),
            model: $('#mUp', dlg).value.trim(),
            kind: $('#mKind', dlg).value,
            caps: caps,
            enabled: $('#mEnabled', dlg).checked,
            dropParams: ($('#mDrop', dlg).value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          },
        });
        dlg.close(); dlg.remove(); await refresh(); toast('已保存');
      } catch (e) { toast(e.message); }
    };
  }

  // ---------- 密钥 ----------

  function viewKeys(pane) {
    var rows = S.keys.map(function (k) {
      return '<div class="item">' +
        '<div class="grow"><div class="title-s">' + esc(k.name) + (k.enabled ? '' : ' <span class="chip">已停用</span>') + '</div>' +
        '<div class="body-s muted mono ellipsis">' + esc(k.prefix) + '…' + esc(k.tail) + '</div>' +
        '<div class="body-s muted">创建于 ' + when(k.createdAt) + '</div></div>' +
        '<div class="acts">' +
        '<button class="btn text small" data-toggle="' + k.id + '" data-en="' + (k.enabled ? '0' : '1') + '">' + (k.enabled ? '停用' : '启用') + '</button>' +
        '<button class="icon" data-del="' + k.id + '" title="删除" aria-label="删除">' + svg('trash') + '</button>' +
        '</div></div>';
    }).join('');

    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">网关密钥</h2><span class="spacer"></span><button class="btn" id="newKey">' + svg('plus', 'sm') + '创建密钥</button></div>' +
      '<p class="sub body-m">这是外部客户端用来调网关的 key。KV 里只存 SHA-256，明文只在创建那一刻显示一次，关掉就再也看不到了。</p>' +
      '<div id="freshKey"></div>' +
      (S.keys.length ? '<div class="list">' + rows + '</div>' : '<div class="empty">还没有密钥。创建一个，然后填进客户端的 API Key 栏。</div>');

    $('#newKey').onclick = function () {
      var dlg = mkDialog('创建网关密钥', '<div class="field"><label for="kName">密钥备注（必填）</label><input id="kName" placeholder="例如：AstrBot、笔记本"></div>' +
        '<p class="body-s muted">备注会显示在密钥列表和用量页里，用来区分是哪个客户端在调。创建后明文只显示一次，请立刻复制保存。</p>', '下一步');
      $('#dlgOk', dlg).onclick = async function () {
        var name = $('#kName', dlg).value.trim();
        if (!name) { toast('请输入密钥备注'); $('#kName', dlg).focus(); return; }
        try {
          var r = await api('keys/create', { name: name });
          dlg.close(); dlg.remove();
          await refresh();
          showFreshKey(r.key);
        } catch (e) { toast(e.message); }
      };
    };
    pane.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.onclick = async function () { await api('keys/toggle', { id: b.dataset.toggle, enabled: b.dataset.en === '1' }); await refresh(); };
    });
    pane.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('删除这把密钥？正在用它的客户端会立刻 401。')) return;
        await api('keys/delete', { id: b.dataset.del }); await refresh(); toast('已删除');
      };
    });
  }

  function showFreshKey(key) {
    var box = $('#freshKey');
    box.innerHTML = '<div class="card elev"><h3 class="title-m">新密钥（只显示这一次）</h3>' +
      '<p class="body-m muted">刷新页面后就查不到了，现在复制走。</p>' +
      '<div class="keyout" id="kv">' + esc(key) + '</div>' +
      '<div class="row" style="margin-top:12px"><button class="btn" id="kCopy">' + svg('copy', 'sm') + '复制密钥</button>' +
      '<button class="btn text" id="kHide">我已保存，隐藏</button></div></div>';
    $('#kCopy').onclick = function () { copy(key); };
    $('#kHide').onclick = function () { box.innerHTML = ''; };
  }

  // ---------- 用量 ----------

  function viewUsage(pane) {
    var u = S.usage || { keys: [], totals: {}, persisted: false };
    var t = u.totals || {};
    var rows = (u.keys || []).map(function (k) {
      return '<tr>' +
        '<td><div class="title-s">' + esc(k.name || '未命名') + (k.exists ? '' : ' <span class="chip">已删除</span>') + '</div>' +
        '<div class="body-s muted mono">' + esc(k.prefix || '') + '…' + esc(k.tail || '') + '</div></td>' +
        '<td class="r">' + fmt(k.calls) + '</td>' +
        '<td class="r">' + fmt(k.prompt) + '</td>' +
        '<td class="r">' + fmt(k.completion) + '</td>' +
        '<td class="r">' + fmt(k.total) + '</td>' +
        '<td class="body-s muted hide-sm">' + when(k.lastAt) + '</td>' +
        '<td><button class="btn text small" data-detail="' + esc(k.id) + '">明细</button></td>' +
        '</tr>';
    }).join('');

    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">用量</h2><span class="spacer"></span>' +
      '<button class="btn outlined" id="resetUsage">重置统计</button></div>' +
      '<p class="sub body-m">按网关密钥累计的调用次数与 token 数。上游返回 usage 字段时用真实值；没返回的（多数流式接口默认不带）用和 ' +
      '<span class="mono">/v1/messages/count_tokens</span> 同一套算法估算，估算过的条数单列出来。</p>' +
      '<div class="grid three" style="margin-bottom:16px">' +
      stat('总调用次数', fmt(t.calls)) +
      stat('输入 tokens', fmt(t.prompt)) +
      stat('输出 tokens', fmt(t.completion)) +
      '</div>' +
      (u.keys && u.keys.length
        ? '<div class="card" style="padding:0;overflow:hidden"><div class="tablewrap"><table class="md">' +
          '<thead><tr><th>密钥</th><th class="r">调用次数</th><th class="r">输入</th><th class="r">输出</th><th class="r">合计</th><th class="hide-sm">最近使用</th><th></th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
          '<tfoot><tr><td>合计</td><td class="r">' + fmt(t.calls) + '</td><td class="r">' + fmt(t.prompt) + '</td>' +
          '<td class="r">' + fmt(t.completion) + '</td><td class="r">' + fmt(t.total) + '</td><td class="hide-sm"></td><td></td></tr></tfoot>' +
          '</table></div></div>'
        : '<div class="empty">还没有任何调用记录。用网关密钥打一次 /v1/chat/completions 就会出现在这里。</div>') +
      '<div class="card outlined"><h3 class="title-m">这些数字是怎么来的</h3>' +
      '<p class="body-m muted">计数在内存里累加，每隔一段时间批量写一次 KV（默认 ' + esc(String(u.flushSeconds || 300)) + ' 秒，' +
      '最坏情况一天不到 300 次写，免费版每天 1000 次写额度用不满）。' +
      (u.persisted ? '当前<b>已开启</b>持久化，重新部署或实例回收后数据仍在。' : '当前<b>未开启</b>持久化（或没绑 KV），实例回收后归零。') +
      '</p><div class="chips"><span class="chip">估算条数 ' + fmt(t.estimatedCalls) + '</span>' +
      '<span class="chip">待写入 ' + fmt(u.pending) + '</span>' +
      '<span class="chip">上次落盘 ' + when(u.updatedAt) + '</span></div></div>';

    pane.querySelectorAll('[data-detail]').forEach(function (b) {
      b.onclick = function () {
        var k = (u.keys || []).filter(function (x) { return x.id === b.dataset.detail; })[0];
        if (!k) return;
        var models = (k.byModel || []).map(function (m) {
          return '<tr><td class="mono">' + esc(m.name) + '</td><td class="r">' + fmt(m.calls) + '</td><td class="r">' + fmt(m.tokens) + '</td></tr>';
        }).join('');
        var eps = (k.byEndpoint || []).map(function (e) {
          return '<span class="chip">' + esc(e.name) + ' · ' + fmt(e.calls) + '</span>';
        }).join('');
        mkDialog('明细 · ' + esc(k.name || '未命名'),
          '<div class="chips" style="margin-bottom:16px">' + (eps || '<span class="chip">无</span>') + '</div>' +
          (models
            ? '<div class="tablewrap"><table class="md" style="min-width:340px"><thead><tr><th>模型</th><th class="r">次数</th><th class="r">tokens</th></tr></thead><tbody>' + models + '</tbody></table></div>'
            : '<div class="empty">还没有按模型的细分数据。</div>'),
          '关闭');
      };
    });

    $('#resetUsage').onclick = async function () {
      if (!confirm('清空所有密钥的用量统计？这个动作不可撤销。')) return;
      try { await api('usage/reset', {}); await refresh(); toast('用量已清空'); }
      catch (e) { toast(e.message); }
    };
  }

  // ---------- 设置 ----------

  function viewSettings(pane) {
    var s = S.config.settings;
    var dg = S.disguise || {};
    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">设置</h2></div>' +
      '<p class="sub body-m">默认值已经按 Cloudflare 免费额度调过，一般不用动。</p>' +
      '<div class="card"><h3 class="title-m">调用链行为</h3>' +
      sw('strictModelRouting', '严格模型路由', '开启后：客户端点名的模型失败就直接报错，不再往下降级。关闭则继续按顺序尝试。', s.strictModelRouting) +
      sw('rewriteModelName', '回写模型名', '把响应里的 model 字段改回客户端请求的名字。AstrBot 之类会校验模型名的客户端建议开着。', s.rewriteModelName) +
      numField('maxAttempts', '单次请求最多尝试模型数', s.maxAttempts, '免费版每次调用最多 50 个外部子请求，留足余量。') +
      numField('headerTimeoutMs', '等待上游响应头超时（毫秒）', s.headerTimeoutMs, '只管到响应头为止；流式回答开始后不再计时，不会被掐断。') +
      numField('cooldownSeconds', '失败冷却（秒）', s.cooldownSeconds, '某个模型失败后，这段时间内直接跳过，连请求都不发 —— 省的就是这些。填 0 关闭。') +
      sw('peekStreamErrors', '识破藏在流里的错误', '有的上游返回 200，错误却在 SSE 第一个事件里。开启后先看一眼首块，是错误就无感转到下一个模型。', s.peekStreamErrors) +
      '</div>' +
      '<div class="card"><h3 class="title-m">请求改写</h3>' +
      sw('mapDeveloperRole', 'developer 角色映射成 system', '新版 OpenAI SDK 会把 system 发成 developer，除 OpenAI 外几乎没有兼容接口认它（MiniMax 直接 400）。', s.mapDeveloperRole) +
      '</div>' +
      '<div class="card"><h3 class="title-m">接口</h3>' +
      sw('allowAnonymousModels', '/v1/models 允许匿名访问', '有些客户端会在填 key 之前先拉一次模型列表。除非遇到问题，否则保持关闭。', s.allowAnonymousModels) +
      sw('exposeProviderInList', '模型列表里显示提供商', '在 owned_by 字段里写上提供商名字。', s.exposeProviderInList) +
      numField('keyRpmLimit', '单密钥每分钟请求上限（0 = 不限制）', s.keyRpmLimit, '内存滑动窗口限速，isolate 重启即清零。给 agent 这类自动循环的客户端设个上限，防止失控打爆上游。') +
      '</div>' +
      '<div class="card"><h3 class="title-m">用量统计</h3>' +
      sw('trackUsage', '记录每把密钥的调用次数与 tokens', '关掉后「用量」页不再增加新数据，转发路径上也省掉一次响应体扫描。', s.trackUsage) +
      numField('usageFlushSeconds', '统计落盘间隔（秒）', s.usageFlushSeconds, '越大越省 KV 写额度，越小面板数字越新。最小 30 秒。') +
      '</div>' +
      '<div class="row"><button class="btn" id="saveSet">保存设置</button></div>' +
      '<div class="card outlined" style="margin-top:24px"><h3 class="title-m">首页伪装</h3>' +
      '<p class="body-m muted">用环境变量 <span class="mono">url</span> 控制，改完要重新部署才生效 —— 它是部署级变量，不走 KV，所以这里只能看不能改。' +
      '设置后访问根路径 <span class="mono">/</span> 会直接吐出目标站点的首页，看不出这是个网关；控制台仍在 <span class="mono">/admin</span>。' +
      '不设就默认伪装成 <span class="mono">www.bing.com</span>；填 <span class="mono">off</span> 则显示网关自带的落地页。</p>' +
      '<div class="chips">' +
      (dg.enabled
        ? '<span class="chip ok">已开启</span><span class="chip mono">' + esc(dg.target || '') + '</span>'
        : '<span class="chip">已关闭，显示自带落地页</span>') +
      '</div></div>' +
      '<div class="card outlined"><h3 class="title-m">备份</h3>' +
      '<p class="body-m muted">导出内容包含上游 API Key 明文，请当密码文件保管。</p>' +
      '<div class="row"><button class="btn tonal" id="expBtn">导出配置</button><button class="btn outlined" id="impBtn">导入配置</button></div></div>';

    $('#saveSet').onclick = async function () {
      var payload = {};
      pane.querySelectorAll('[data-set]').forEach(function (el) {
        payload[el.dataset.set] = el.type === 'checkbox' ? el.checked : Number(el.value);
      });
      try { await api('settings/save', { settings: payload }); await refresh(); toast('设置已保存'); }
      catch (e) { toast(e.message); }
    };
    $('#expBtn').onclick = async function () {
      var r = await api('export');
      var blob = new Blob([JSON.stringify(r.config, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'llm-gateway-config.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    };
    $('#impBtn').onclick = function () {
      var dlg = mkDialog('导入配置', '<div class="field"><label for="impText">粘贴导出的 JSON</label><textarea id="impText" style="min-height:200px"></textarea></div><p class="body-s muted">导入会整体覆盖现有的提供商、模型和设置。网关密钥不受影响。</p>', '覆盖导入');
      $('#dlgOk', dlg).onclick = async function () {
        try {
          var cfg = JSON.parse($('#impText', dlg).value);
          var r = await api('import', { config: cfg });
          dlg.close(); dlg.remove(); await refresh();
          toast('已导入 ' + r.providers + ' 个提供商 / ' + r.models + ' 个模型');
        } catch (e) { toast('导入失败：' + e.message); }
      };
    };
  }

  function sw(key, label, hint, val) {
    return '<label class="switch"><input type="checkbox" data-set="' + key + '"' + (val ? ' checked' : '') + '><span class="track"></span>' +
      '<span><span class="label-l">' + esc(label) + '</span><br><span class="body-s muted">' + esc(hint) + '</span></span></label>';
  }
  function numField(key, label, val, hint) {
    return '<div class="field" style="margin-top:12px"><label>' + esc(label) + '</label><input type="number" data-set="' + key + '" value="' + esc(String(val)) + '"><div class="hint">' + esc(hint) + '</div></div>';
  }

  // ---------- 优选 IP ----------

  function viewEdge(pane) {
    pane.innerHTML =
      '<div class="head"><h2 class="headline-s">Cloudflare 优选 IP</h2></div>' +
      '<p class="sub body-m">先说清楚原理，免得白折腾：入口走哪个边缘节点是由 anycast 路由决定的，Worker 自己改不了。' +
      '能优化的只有你本机到 Cloudflare 的这一段，办法是把域名解析指向延迟更低的 CF IP。' +
      '而网关到 NVIDIA / OpenAI 这一段，本来就跑在 Cloudflare 骨干网上，不需要也没法优选。</p>' +
      '<div class="card elev"><h3 class="title-m">当前接入节点</h3>' +
      '<p class="body-m muted">探测走 <span class="mono">/cdn-cgi/trace</span>，这个路径由 Cloudflare 边缘直接响应，不会触发 Worker，不消耗你的每日请求额度。</p>' +
      '<div id="traceOut" class="chips"><span class="chip">探测中…</span></div>' +
      '<div class="row" style="margin-top:16px"><button class="btn" id="pingBtn">测 10 次延迟</button>' +
      '<button class="btn text" id="traceBtn">重新探测</button></div>' +
      '<div id="pingOut" style="margin-top:12px"></div></div>' +
      '<div class="card"><h3 class="title-m">hosts 生成器</h3>' +
      '<p class="body-m muted">用 <span class="mono">CloudflareSpeedTest</span> 之类的工具在本机测出低延迟 IP 后，粘进来生成 hosts 行。' +
      '注意：hosts 只对自定义域名有效，<span class="mono">*.pages.dev</span> 和 <span class="mono">*.workers.dev</span> 因为要走 Cloudflare 的 SNI 校验，改 hosts 通常没用。</p>' +
      '<div class="field"><label for="hDomain">你的自定义域名</label><input id="hDomain" class="mono" value="' + esc(location.hostname) + '"></div>' +
      '<div class="field"><label for="hIps">优选 IP（每行一个）</label><textarea id="hIps" placeholder="104.16.0.1&#10;172.64.0.1"></textarea></div>' +
      '<div class="row"><button class="btn tonal" id="genHosts">生成</button></div>' +
      '<pre class="code" id="hostsOut" style="margin-top:12px;display:none"></pre></div>' +
      '<div class="card outlined"><h3 class="title-m">怎么测</h3>' +
      '<p class="body-m">Cloudflare 官方 IP 段：<span class="mono">https://www.cloudflare.com/ips-v4</span>（v6 把 v4 换成 v6）。' +
      '本机跑 CloudflareSpeedTest 拿到延迟最低的几个 IP，写进 hosts 或者代理软件的分流规则里。' +
      '如果用的是 <span class="mono">*.pages.dev</span>，想优选就得先绑一个自己的域名。</p></div>';

    async function trace() {
      var out = $('#traceOut');
      out.innerHTML = '<span class="chip">探测中…</span>';
      try {
        var t0 = performance.now();
        var res = await fetch('/cdn-cgi/trace?_=' + Date.now(), { cache: 'no-store' });
        var ms = Math.round(performance.now() - t0);
        var txt = await res.text();
        var kv = {};
        txt.split('\n').forEach(function (line) {
          var i = line.indexOf('=');
          if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
        });
        out.innerHTML = '<span class="chip pri">机房 ' + esc(kv.colo || '未知') + '</span>' +
          '<span class="chip">你的出口 IP ' + esc(kv.ip || '?') + '</span>' +
          '<span class="chip">地区 ' + esc(kv.loc || '?') + '</span>' +
          '<span class="chip">' + ms + 'ms</span>' +
          '<span class="chip">' + esc(kv.http || '') + '</span>';
      } catch (e) {
        out.innerHTML = '<span class="chip err">探测失败：' + esc(e.message) + '</span>';
      }
    }

    $('#traceBtn').onclick = trace;
    $('#pingBtn').onclick = async function () {
      var btn = this; btn.disabled = true;
      var times = [];
      for (var i = 0; i < 10; i++) {
        var t0 = performance.now();
        try { await fetch('/cdn-cgi/trace?_=' + Math.random(), { cache: 'no-store' }); times.push(performance.now() - t0); }
        catch (e) { /* 忽略单次失败 */ }
      }
      btn.disabled = false;
      if (!times.length) { $('#pingOut').innerHTML = '<div class="banner">全部失败。</div>'; return; }
      times.sort(function (a, b) { return a - b; });
      var min = Math.round(times[0]);
      var med = Math.round(times[Math.floor(times.length / 2)]);
      var max = Math.round(times[times.length - 1]);
      $('#pingOut').innerHTML = '<div class="chips"><span class="chip ok">最快 ' + min + 'ms</span>' +
        '<span class="chip pri">中位 ' + med + 'ms</span><span class="chip">最慢 ' + max + 'ms</span>' +
        '<span class="chip">样本 ' + times.length + '</span></div>' +
        '<p class="body-s muted" style="margin-top:8px">中位数低于 120ms 基本没有优化空间；高于 250ms 或者波动很大，换 IP 通常能明显改善。</p>';
    };
    $('#genHosts').onclick = function () {
      var domain = ($('#hDomain').value || '').trim();
      var ips = ($('#hIps').value || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!domain || !ips.length) return toast('域名和 IP 都要填');
      var out = $('#hostsOut');
      out.style.display = 'block';
      out.textContent = '# LLM Gateway 优选 IP\n' + ips.map(function (ip) { return ip + '\t' + domain; }).join('\n') +
        '\n\n# Windows: C:\\Windows\\System32\\drivers\\etc\\hosts\n# macOS / Linux: /etc/hosts\n# 只保留一行生效，多行会由系统自行选择。';
    };
    trace();
  }

  // ---------- 对话框 ----------

  function mkDialog(title, inner, okLabel) {
    var dlg = document.createElement('dialog');
    var onlyClose = okLabel === '关闭';
    dlg.innerHTML = '<h3 class="title-l">' + title + '</h3><div class="dlgBody">' + inner + '</div>' +
      '<div class="actions">' +
      (onlyClose ? '' : '<button class="btn text" id="dlgCancel">取消</button>') +
      '<button class="btn" id="dlgOk">' + esc(okLabel || '确定') + '</button></div>';
    document.body.appendChild(dlg);
    dlg.showModal();
    if (onlyClose) $('#dlgOk', dlg).onclick = function () { dlg.close(); dlg.remove(); };
    else $('#dlgCancel', dlg).onclick = function () { dlg.close(); dlg.remove(); };
    dlg.addEventListener('close', function () { setTimeout(function () { dlg.remove(); }, 0); });
    return dlg;
  }

  try {
    var saved = localStorage.getItem('gw-theme');
    if (saved) document.documentElement.dataset.theme = saved;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
  } catch (e) {}

  boot();
}
