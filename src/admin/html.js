export function renderAdminPage(siteTitle = "CF LLM Gateway") {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${siteTitle} · 管理面板</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Material+Symbols+Rounded" rel="stylesheet">
<style>
:root{
  --md-primary:#6750A4; --md-on-primary:#ffffff; --md-primary-container:#EADDFF; --md-on-primary-container:#21005D;
  --md-surface:#FFFBFE; --md-surface-variant:#E7E0EC; --md-on-surface:#1C1B1F; --md-on-surface-variant:#49454F;
  --md-outline:#79747E; --md-error:#B3261E; --md-error-container:#F9DEDC; --md-on-error-container:#410E0B;
  --md-success:#146C2E; --md-success-container:#C6F0D0;
  --md-elevation-1: 0 1px 3px rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.08);
  --md-elevation-2: 0 3px 6px rgba(0,0,0,.10), 0 2px 4px rgba(0,0,0,.08);
}
*{box-sizing:border-box;}
body{margin:0;font-family:'Roboto',system-ui,sans-serif;background:#F3EDF7;color:var(--md-on-surface);}
.material-symbols-rounded{font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24;vertical-align:middle;font-size:20px;}
.topbar{display:flex;align-items:center;gap:12px;padding:16px 24px;background:var(--md-surface);box-shadow:var(--md-elevation-1);position:sticky;top:0;z-index:10;}
.topbar h1{font-size:20px;font-weight:500;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.container{max-width:980px;margin:24px auto;padding:0 16px 64px;}
.card{background:var(--md-surface);border-radius:16px;padding:20px;margin-bottom:20px;box-shadow:var(--md-elevation-1);}
.card h2{font-size:16px;font-weight:500;margin:0 0 4px;display:flex;align-items:center;gap:8px;}
.card .desc{color:var(--md-on-surface-variant);font-size:13px;margin-bottom:16px;}
.btn{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:20px;padding:10px 20px;font-size:14px;font-weight:500;cursor:pointer;background:var(--md-primary);color:var(--md-on-primary);transition:box-shadow .2s;}
.btn:hover{box-shadow:var(--md-elevation-2);}
.btn.outlined{background:transparent;color:var(--md-primary);border:1px solid var(--md-outline);}
.btn.text{background:transparent;color:var(--md-primary);padding:8px 12px;}
.btn.danger{background:var(--md-error);color:#fff;}
.btn.sm{padding:6px 12px;font-size:13px;}
.btn:disabled{opacity:.5;cursor:not-allowed;}
input,select{width:100%;padding:12px 14px;border-radius:8px;border:1px solid var(--md-outline);background:var(--md-surface);color:var(--md-on-surface);font-size:14px;font-family:inherit;}
input:focus,select:focus{outline:2px solid var(--md-primary);border-color:var(--md-primary);}
label{display:block;font-size:12px;color:var(--md-on-surface-variant);margin-bottom:6px;margin-top:12px;}
.row{display:flex;gap:12px;flex-wrap:wrap;}
.row > div{flex:1;min-width:180px;}
.provider{border:1px solid var(--md-surface-variant);border-radius:12px;padding:16px;margin-bottom:12px;}
.provider-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:8px;}
.provider-head .name{font-weight:500;flex:1;}
.badge{font-size:11px;padding:2px 8px;border-radius:8px;background:var(--md-primary-container);color:var(--md-on-primary-container);}
.badge.off{background:var(--md-surface-variant);color:var(--md-on-surface-variant);}
.model-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #eee;font-size:13px;flex-wrap:wrap;row-gap:6px;}
.model-row .mid{flex:1;font-family:monospace;min-width:120px;word-break:break-all;}
.chip{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--md-surface-variant);color:var(--md-on-surface-variant);margin-right:2px;}
.chip.on{background:var(--md-success-container);color:var(--md-success);}
.switch{position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0;}
.switch input{opacity:0;width:0;height:0;}
.slider{position:absolute;cursor:pointer;inset:0;background:var(--md-surface-variant);border-radius:20px;transition:.2s;}
.slider:before{content:"";position:absolute;height:14px;width:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;}
input:checked + .slider{background:var(--md-primary);}
input:checked + .slider:before{transform:translateX(16px);}
.toast{position:fixed;top:20px;right:20px;left:auto;bottom:auto;background:#333;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;z-index:300;box-shadow:var(--md-elevation-2);max-width:320px;opacity:0;transform:translateX(32px);transition:opacity .25s cubic-bezier(0.05,0.7,0.1,1.0),transform .25s cubic-bezier(0.05,0.7,0.1,1.0);pointer-events:none;}
.toast.show{opacity:1;transform:translateX(0);}
.key-list-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #eee;font-size:13px;flex-wrap:wrap;row-gap:6px;}
.key-list-item .kname{flex:1;}
.mono{font-family:monospace;background:var(--md-surface-variant);padding:2px 6px;border-radius:6px;}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;}
.login-card{width:100%;max-width:340px;text-align:center;}
.login-card .material-symbols-rounded{font-size:40px;color:var(--md-primary);}
#login{transition:opacity .2s ease;}
#app{display:none;transition:opacity .2s ease;}
#login.fade-out,#app.fade-out{opacity:0;}
#login.fade-in,#app.fade-in{opacity:0;}
.order-btns{display:flex;flex-direction:column;gap:2px;}
.order-btns button{background:none;border:none;cursor:pointer;color:var(--md-on-surface-variant);padding:0;line-height:1;}
.hint{font-size:12px;color:var(--md-on-surface-variant);margin-top:6px;}
code.small{font-size:12px;}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200;padding:16px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,visibility .2s ease;}
.modal-overlay.show{opacity:1;visibility:visible;pointer-events:auto;}
.modal-dialog{background:var(--md-surface);border-radius:28px;padding:24px;width:min(440px,100%);box-shadow:var(--md-elevation-2);transform:scale(.92) translateY(8px);transition:transform .2s cubic-bezier(0.05,0.7,0.1,1.0);}
.modal-overlay.show .modal-dialog{transform:scale(1) translateY(0);}
.modal-icon{width:48px;height:48px;border-radius:50%;background:var(--md-primary-container);display:flex;align-items:center;justify-content:center;margin-bottom:16px;}
.modal-icon .material-symbols-rounded{color:var(--md-on-primary-container);font-size:24px;}
.modal-title{font-size:20px;line-height:28px;font-weight:400;margin:0 0 8px;color:var(--md-on-surface);}
.modal-desc{font-size:14px;line-height:20px;color:var(--md-on-surface-variant);margin:0 0 20px;}
.modal-key-box{background:var(--md-surface-variant);border-radius:12px;padding:14px 16px;margin-bottom:24px;}
.modal-key-box code{word-break:break-all;font-size:13px;line-height:1.5;color:var(--md-on-surface);}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;}

/* ==== 移动端适配（以 320px 宽度为基准） ==== */
@media (max-width: 480px){
  .container{padding:0 12px 48px;margin:16px auto;}
  .card{padding:14px;border-radius:14px;margin-bottom:14px;}
  .card h2{font-size:15px;}
  .topbar{padding:10px 14px;gap:8px;}
  .topbar h1{font-size:16px;}
  .btn{padding:9px 16px;font-size:13px;}
  .btn.sm{padding:6px 10px;font-size:12px;}
  .row{gap:8px;}
  .row > div{min-width:100%;}
  label{font-size:11px;}
  input,select{padding:10px 12px;font-size:13px;}
  .provider{padding:12px;}
  .provider-head .name{font-size:14px;flex-basis:100%;order:-1;}
  .key-list-item{font-size:12px;}
  .key-list-item .kname{font-size:12px;flex-basis:100%;order:1;}
  .modal-overlay{padding:12px;}
  .modal-dialog{padding:18px;border-radius:20px;}
  .modal-title{font-size:17px;line-height:24px;}
  .modal-desc{font-size:13px;}
  .modal-key-box{padding:12px;}
  .modal-actions{flex-direction:column-reverse;gap:8px;}
  .modal-actions .btn{width:100%;justify-content:center;}
  /* toast 在窄屏下改为贴顶横幅样式，避免固定 max-width 导致溢出屏幕 */
  .toast{left:12px;right:12px;top:12px;max-width:none;width:auto;transform:translateY(-16px);}
  .toast.show{transform:translateY(0);}
}
</style>
</head>
<body>

<div id="login" class="login-wrap">
  <div class="card login-card">
    <span class="material-symbols-rounded">lock</span>
    <h2 style="margin-top:8px">${siteTitle} 管理登录</h2>
    <input id="pwd" type="password" placeholder="管理员密码" style="margin-top:12px" />
    <div style="margin-top:16px"><button class="btn" style="width:100%" onclick="doLogin()">登录</button></div>
    <div id="loginErr" style="color:var(--md-error);font-size:13px;margin-top:8px"></div>
  </div>
</div>

<div id="app">
  <div class="topbar">
    <span class="material-symbols-rounded" style="color:var(--md-primary)">hub</span>
    <h1>${siteTitle} · 管理面板</h1>
    <button class="btn text" onclick="logout()"><span class="material-symbols-rounded">logout</span>退出</button>
  </div>

  <div class="container">

    <div class="card">
      <h2><span class="material-symbols-rounded">dns</span>服务商 / 模型</h2>
      <div class="desc">按顺序调用：外部请求不指定模型（或选择 auto）时，将从上到下依次尝试每个服务商的默认模型，第一个调用成功即返回。</div>
      <div id="providerList"></div>
      <button class="btn outlined sm" onclick="openAddProvider()"><span class="material-symbols-rounded">add</span>添加服务商</button>
    </div>

    <div class="card">
      <h2><span class="material-symbols-rounded">tune</span>全局设置</h2>
      <label>默认模型（可覆盖自动故障转移，填 auto 表示按顺序自动选择）</label>
      <input id="s_defaultModel" placeholder="auto 或 deepseek/deepseek-chat" />
      <div style="margin-top:16px"><button class="btn" onclick="saveSettings()">保存设置</button></div>
    </div>

    <div class="card">
      <h2><span class="material-symbols-rounded">vpn_key</span>对外 API Key</h2>
      <div class="desc">用于部署到 Claude Code / AstrBot 等外部项目。密钥仅在创建时完整显示一次，请立即保存。</div>
      <button class="btn" onclick="openNameModal()"><span class="material-symbols-rounded">add</span>生成新密钥</button>
      <div id="keyList"></div>
    </div>

    <div class="card">
      <h2><span class="material-symbols-rounded">integration_instructions</span>接入方式</h2>

      <label style="margin-top:0">OpenAI 兼容（AstrBot / 大多数第三方客户端）</label>
      <div class="desc" style="margin-bottom:6px">Base URL 填下面地址，API Key 使用上方生成的密钥：</div>
      <code class="mono small" id="apiBaseOpenAI"></code>

      <label>Anthropic 兼容（Claude Code 等原生 Anthropic 协议客户端）</label>
      <div class="desc" style="margin-bottom:6px">设置环境变量 <code class="mono small">ANTHROPIC_BASE_URL</code> 为下面地址（客户端会自动请求
        <code class="mono small">/v1/messages</code>），<code class="mono small">ANTHROPIC_AUTH_TOKEN</code>
        / <code class="mono small">ANTHROPIC_API_KEY</code> 使用上方生成的密钥：</div>
      <code class="mono small" id="apiBaseAnthropic"></code>
      <div class="hint">示例（终端里临时设置后运行 Claude Code）：</div>
      <code class="mono small" id="anthropicExample" style="display:block;white-space:pre-wrap;margin-top:4px"></code>
    </div>

  </div>
</div>

<div id="keyNameModalOverlay" class="modal-overlay" onclick="if(event.target===this) closeNameModal()">
  <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="keyNameModalTitle">
    <div class="modal-icon"><span class="material-symbols-rounded">edit_note</span></div>
    <h3 class="modal-title" id="keyNameModalTitle">为新密钥添加备注</h3>
    <p class="modal-desc">备注用于区分不同用途的密钥（例如部署的项目名），必须填写。</p>
    <input id="k_name" placeholder="例如 my-astrbot" onkeydown="if(event.key==='Enter') confirmCreateKey()" />
    <div id="k_name_error" style="color:var(--md-error);font-size:12px;margin-top:6px;display:none">请输入密钥备注</div>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn text" onclick="closeNameModal()">取消</button>
      <button class="btn" onclick="confirmCreateKey()">下一步</button>
    </div>
  </div>
</div>

<div id="keyModalOverlay" class="modal-overlay" onclick="if(event.target===this) closeKeyModal()">
  <div class="modal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="keyModalTitle">
    <div class="modal-icon"><span class="material-symbols-rounded">vpn_key</span></div>
    <h3 class="modal-title" id="keyModalTitle">新密钥已生成</h3>
    <p class="modal-desc">请立即复制保存，出于安全考虑，此密钥仅在此刻显示，关闭后将无法再次查看完整内容。</p>
    <div class="modal-key-box"><code class="mono" id="modalKeyValue"></code></div>
    <div class="modal-actions">
      <button class="btn text" onclick="closeKeyModal()">关闭</button>
      <button class="btn" onclick="copyKeyValue()"><span class="material-symbols-rounded">content_copy</span>复制</button>
    </div>
  </div>
</div>

<div id="addProviderModalOverlay" class="modal-overlay" onclick="if(event.target===this) closeAddProvider()">
  <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="addProviderModalTitle" style="width:min(480px,100%)">
    <div class="modal-icon"><span class="material-symbols-rounded">add_circle</span></div>
    <h3 class="modal-title" id="addProviderModalTitle">新增服务商</h3>
    <div class="row">
      <div>
        <label style="margin-top:0">预设模板</label>
        <select id="np_preset" onchange="onPresetChange()"></select>
      </div>
      <div>
        <label style="margin-top:0">显示名称</label>
        <input id="np_name" placeholder="例如 DeepSeek" />
      </div>
    </div>
    <label>Base URL（OpenAI 兼容接口根地址）</label>
    <input id="np_baseUrl" placeholder="https://api.deepseek.com/v1" />
    <label>API Key</label>
    <input id="np_apiKey" placeholder="sk-..." />
    <div class="hint">保存后可点击「搜索模型」自动拉取该服务商下可用的模型列表。</div>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn text" onclick="closeAddProvider()">取消</button>
      <button class="btn" onclick="saveNewProvider()">保存</button>
    </div>
  </div>
</div>

<div id="confirmModalOverlay" class="modal-overlay" onclick="if(event.target===this) closeConfirmModal()">
  <div class="modal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmModalTitle">
    <div class="modal-icon" style="background:var(--md-error-container)"><span class="material-symbols-rounded" style="color:var(--md-on-error-container)">warning</span></div>
    <h3 class="modal-title" id="confirmModalTitle">确认删除</h3>
    <p class="modal-desc" id="confirmModalDesc"></p>
    <div class="modal-actions">
      <button class="btn text" onclick="closeConfirmModal()">取消</button>
      <button class="btn danger" id="confirmModalConfirmBtn" onclick="handleConfirmModalConfirm()">删除</button>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const ORIGIN = location.origin;
document.getElementById('apiBaseOpenAI').textContent = ORIGIN + '/v1';
document.getElementById('apiBaseAnthropic').textContent = ORIGIN;
document.getElementById('anthropicExample').textContent =
  'export ANTHROPIC_BASE_URL="' + ORIGIN + '"\\n' +
  'export ANTHROPIC_AUTH_TOKEN="你生成的sk-cfg-...密钥"\\n' +
  'claude';
let STATE = null;
let PRESETS = [];

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}

async function api(path, opts={}){
  const resp = await fetch(path, { ...opts, headers: { 'Content-Type':'application/json', ...(opts.headers||{}) } });
  if (resp.status === 401){ showLogin(); throw new Error('unauthorized'); }
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok) throw new Error(data.error?.message || ('HTTP '+resp.status));
  return data;
}

function crossFade(hideId, showId, showDisplay){
  const hideEl = document.getElementById(hideId);
  const showEl = document.getElementById(showId);
  const reveal = () => {
    showEl.style.display = showDisplay;
    showEl.classList.add('fade-in');
    // 强制触发一次重排，确保浏览器先应用 opacity:0 的初始状态，
    // 再在下一帧移除该类以触发过渡动画，否则过渡会被直接跳过。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      showEl.classList.remove('fade-in');
    }));
  };
  const isHiddenAlready = getComputedStyle(hideEl).display === 'none';
  if (isHiddenAlready) {
    reveal();
    return;
  }
  hideEl.classList.add('fade-out');
  setTimeout(() => {
    hideEl.style.display = 'none';
    hideEl.classList.remove('fade-out');
    reveal();
  }, 200);
}
function showLogin(){
  crossFade('app', 'login', 'flex');
}
function showApp(){
  crossFade('login', 'app', 'block');
}

async function doLogin(){
  const pwd = document.getElementById('pwd').value;
  try{
    await api('/admin/api/login', { method:'POST', body: JSON.stringify({ password: pwd }) });
    document.getElementById('loginErr').textContent='';
    showApp();
    await loadAll();
  }catch(e){
    document.getElementById('loginErr').textContent = '密码错误';
  }
}
async function logout(){
  await api('/admin/api/logout', { method:'POST' });
  showLogin();
}

async function loadAll(){
  const [state, presets] = await Promise.all([ api('/admin/api/state'), api('/admin/api/presets') ]);
  STATE = state; PRESETS = presets.presets;
  renderPresetSelect();
  renderProviders();
  document.getElementById('s_defaultModel').value = state.settings.defaultModel || 'auto';
  renderKeys();
}

function renderPresetSelect(){
  const sel = document.getElementById('np_preset');
  sel.innerHTML = PRESETS.map(p=>'<option value="'+p.id+'">'+p.name+'</option>').join('');
  onPresetChange();
}
function onPresetChange(){
  const id = document.getElementById('np_preset').value;
  const p = PRESETS.find(x=>x.id===id);
  if(!p) return;
  const nameInput = document.getElementById('np_name');
  const baseUrlInput = document.getElementById('np_baseUrl');
  const currentName = nameInput.value.trim();
  // 只有当名称为空，或者还等于"之前某个预设的默认名称"时才自动跟随切换；
  // 如果用户已经手动改成了自己的名字，则不覆盖，避免打断用户输入。
  const isUntouched = currentName === '' || PRESETS.some(preset => preset.name === currentName);
  if (isUntouched) {
    nameInput.value = p.id === 'custom' ? '' : p.name;
  }
  baseUrlInput.value = p.baseUrl || '';
}

function capChips(caps={}){
  const map = { vision:'视觉', audio:'音频', video:'视频', tools:'工具调用' };
  return Object.keys(map).map(k=>'<span class="chip '+(caps[k]?'on':'')+'">'+map[k]+'</span>').join('');
}

function renderProviders(){
  const el = document.getElementById('providerList');
  const providers = [...STATE.providers].sort((a,b)=>a.order-b.order);
  if(providers.length===0){ el.innerHTML='<div class="desc">暂无服务商，点击下方按钮添加。</div>'; return; }
  el.innerHTML = providers.map((p, idx)=>{
    const models = (p.models||[]);
    return '<div class="provider">'
      +'<div class="provider-head">'
        +'<div class="order-btns">'
          +'<button onclick="moveProvider(\\''+p.id+'\\',-1)" '+(idx===0?'disabled':'')+'><span class="material-symbols-rounded">arrow_drop_up</span></button>'
          +'<button onclick="moveProvider(\\''+p.id+'\\',1)" '+(idx===providers.length-1?'disabled':'')+'><span class="material-symbols-rounded">arrow_drop_down</span></button>'
        +'</div>'
        +'<span class="name">'+(idx+1)+'. '+p.name+'</span>'
        +'<span class="badge '+(p.enabled===false?'off':'')+'">'+(p.enabled===false?'已停用':'启用中')+'</span>'
        +'<label class="switch"><input type="checkbox" '+(p.enabled!==false?'checked':'')+' onchange="toggleProvider(\\''+p.id+'\\', this.checked)"><span class="slider"></span></label>'
        +'<button class="btn text sm" onclick="searchModels(\\''+p.id+'\\')"><span class="material-symbols-rounded">search</span>搜索模型</button>'
        +'<button class="btn text sm" onclick="deleteProvider(\\''+p.id+'\\')" style="color:var(--md-error)"><span class="material-symbols-rounded">delete</span></button>'
      +'</div>'
      +'<div class="hint">'+p.baseUrl+'</div>'
      +'<div id="models_'+p.id+'">'
        + (models.length? models.map(m=>
            '<div class="model-row">'
              +'<input type="radio" name="def_'+p.id+'" '+(p.defaultModelId===m.id?'checked':'')+' onchange="setDefaultModel(\\''+p.id+'\\',\\''+m.id+'\\')" title="设为该服务商默认调用模型" />'
              +'<span class="mid">'+m.id+'</span>'
              + capChips(m.capabilities)
              +'<label class="switch"><input type="checkbox" '+(m.enabled!==false?'checked':'')+' onchange="toggleModel(\\''+p.id+'\\',\\''+m.id+'\\',this.checked)"><span class="slider"></span></label>'
            +'</div>'
          ).join('')
          : '<div class="hint">尚未导入模型，点击"搜索模型"从上游拉取。</div>')
      +'</div>'
    +'</div>';
  }).join('');
}

function findProvider(id){ return STATE.providers.find(p=>p.id===id); }

async function toggleProvider(id, enabled){
  await api('/admin/api/providers/'+id, { method:'PUT', body: JSON.stringify({ enabled }) });
  findProvider(id).enabled = enabled;
  renderProviders();
}
async function toggleModel(pid, mid, enabled){
  const p = findProvider(pid);
  const m = p.models.find(x=>x.id===mid);
  m.enabled = enabled;
  await api('/admin/api/providers/'+pid, { method:'PUT', body: JSON.stringify({ models: p.models }) });
}
async function setDefaultModel(pid, mid){
  await api('/admin/api/providers/'+pid, { method:'PUT', body: JSON.stringify({ defaultModelId: mid }) });
  findProvider(pid).defaultModelId = mid;
  renderProviders();
  toast('已设置默认模型');
}
async function moveProvider(id, dir){
  const providers = [...STATE.providers].sort((a,b)=>a.order-b.order);
  const idx = providers.findIndex(p=>p.id===id);
  const swapIdx = idx+dir;
  if(swapIdx<0 || swapIdx>=providers.length) return;
  [providers[idx].order, providers[swapIdx].order] = [providers[swapIdx].order, providers[idx].order];
  await api('/admin/api/providers/reorder', { method:'POST', body: JSON.stringify({ order: providers.map(p=>({id:p.id, order:p.order})) }) });
  STATE.providers = providers;
  renderProviders();
}
let confirmModalCallback = null;
function openConfirmModal(title, desc, onConfirm){
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalDesc').textContent = desc;
  confirmModalCallback = onConfirm;
  document.getElementById('confirmModalOverlay').classList.add('show');
}
function closeConfirmModal(){
  document.getElementById('confirmModalOverlay').classList.remove('show');
  confirmModalCallback = null;
}
async function handleConfirmModalConfirm(){
  const cb = confirmModalCallback;
  closeConfirmModal();
  if (cb) await cb();
}

async function deleteProvider(id){
  const p = findProvider(id);
  openConfirmModal(
    '删除该服务商？',
    '将同时移除 "'+(p?p.name:'该服务商')+'" 下已导入的所有模型，此操作无法撤回。',
    async () => {
      await api('/admin/api/providers/'+id, { method:'DELETE' });
      STATE.providers = STATE.providers.filter(x=>x.id!==id);
      renderProviders();
      toast('删除成功');
    }
  );
}
async function searchModels(id){
  toast('正在搜索模型...');
  try{
    const res = await api('/admin/api/providers/'+id+'/search-models', { method:'POST' });
    findProvider(id).models = res.models;
    renderProviders();
    toast('已导入 '+res.models.length+' 个模型，请选择需要启用的版本');
  }catch(e){ toast('搜索失败: '+e.message); }
}

function openAddProvider(){ document.getElementById('addProviderModalOverlay').classList.add('show'); }
function closeAddProvider(){ document.getElementById('addProviderModalOverlay').classList.remove('show'); }
async function saveNewProvider(){
  const preset = document.getElementById('np_preset').value;
  const name = document.getElementById('np_name').value.trim();
  const baseUrl = document.getElementById('np_baseUrl').value.trim();
  const apiKey = document.getElementById('np_apiKey').value.trim();
  if(!name || !baseUrl || !apiKey){ toast('请填写完整信息'); return; }
  const res = await api('/admin/api/providers', { method:'POST', body: JSON.stringify({ preset, name, baseUrl, apiKey }) });
  STATE.providers.push(res.provider);
  closeAddProvider();
  document.getElementById('np_name').value=''; document.getElementById('np_baseUrl').value=''; document.getElementById('np_apiKey').value='';
  renderProviders();
  toast('导入成功');
}

async function saveSettings(){
  const defaultModel = document.getElementById('s_defaultModel').value.trim() || 'auto';
  await api('/admin/api/settings', { method:'PUT', body: JSON.stringify({ defaultModel }) });
  toast('设置已保存');
}

let currentGeneratedKey = '';

function openNameModal(){
  const input = document.getElementById('k_name');
  input.value = '';
  document.getElementById('k_name_error').style.display = 'none';
  document.getElementById('keyNameModalOverlay').classList.add('show');
  setTimeout(() => input.focus(), 50);
}
function closeNameModal(){
  document.getElementById('keyNameModalOverlay').classList.remove('show');
}
function renderKeys(){
  const el = document.getElementById('keyList');
  const keys = STATE.apikeys || [];
  el.innerHTML = keys.map(k=>
    '<div class="key-list-item">'
      +'<span class="mono">'+k.prefix+'...</span>'
      +'<span class="kname">'+(k.name||'未命名')+' · 创建于 '+new Date(k.createdAt).toLocaleString()+(k.lastUsedAt? ' · 最近使用 '+new Date(k.lastUsedAt).toLocaleString() : '')+'</span>'
      +'<button class="btn text sm" style="color:var(--md-error)" onclick="confirmRevokeKey(\\''+k.id+'\\')"><span class="material-symbols-rounded">delete</span>撤销</button>'
    +'</div>'
  ).join(''); // 列表为空时不显示任何占位文字
}
function confirmRevokeKey(id){
  const key = (STATE.apikeys || []).find(k => k.id === id);
  const label = key ? (key.name || '未命名') : '该密钥';
  openConfirmModal(
    '删除该密钥？',
    '撤销后 "'+label+'" 将立即失效，使用该密钥的项目会立刻断开，此操作无法撤回。',
    async () => {
      await api('/admin/api/apikeys/'+id, { method:'DELETE' });
      STATE.apikeys = STATE.apikeys.filter(k=>k.id!==id);
      renderKeys();
      toast('删除成功');
    }
  );
}
async function confirmCreateKey(){
  const input = document.getElementById('k_name');
  const name = input.value.trim();
  const errorEl = document.getElementById('k_name_error');
  if (!name) {
    errorEl.style.display = 'block';
    input.focus();
    return;
  }
  errorEl.style.display = 'none';
  const res = await api('/admin/api/apikeys', { method:'POST', body: JSON.stringify({ name }) });
  STATE.apikeys.push(res.meta);
  renderKeys();
  closeNameModal();
  openKeyModal(res.key);
}
function openKeyModal(key){
  currentGeneratedKey = key;
  document.getElementById('modalKeyValue').textContent = key;
  document.getElementById('keyModalOverlay').classList.add('show');
}
function closeKeyModal(){
  document.getElementById('keyModalOverlay').classList.remove('show');
  currentGeneratedKey = '';
}
async function copyKeyValue(){
  try{
    await navigator.clipboard.writeText(currentGeneratedKey);
    toast('已复制到剪贴板');
  }catch(e){
    toast('复制失败，请长按/选中后手动复制');
  }
}

document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){ closeKeyModal(); closeNameModal(); closeConfirmModal(); closeAddProvider(); }
});

// 尝试自动恢复已登录状态
(async ()=>{
  try{ await api('/admin/api/state'); showApp(); await loadAll(); }
  catch(e){ showLogin(); }
})();
</script>
</body>
</html>`;
}
