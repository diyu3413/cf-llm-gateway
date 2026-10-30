// Material Design 3 样式表。
// 颜色/形状/高度/状态层/动效等设计令牌全部在 ./tokens.js（与 cf-llm-gateway 共用的
// 单一事实源，两处拷贝保持一致）；基础组件样式（按钮/输入/卡片/对话框/导航等）
// 也与网关同源。本文件只额外定义本项目的视图：会话双栏、消息流、工具卡片、
// 文件列表、编辑器对话框。
//
// 断点（移动端以 375px 为基准设计）：
//   <=840px  会话列表收进模态抽屉，顶栏出现汉堡按钮
//   <=600px  列表项纵向堆叠、按钮整行、对话框贴边

import { MD3_TOKENS_CSS } from './tokens.js';

export const UI_CSS = MD3_TOKENS_CSS + `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:Roboto,"Roboto Flex","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;
  background:var(--md-sys-color-surface);
  color:var(--md-sys-color-on-surface);
  font-size:14px;line-height:1.5;
  -webkit-font-smoothing:antialiased;
  -webkit-tap-highlight-color:transparent;
  overflow-wrap:anywhere;
  transition:background-color var(--dur-m) var(--ease-std),color var(--dur-m) var(--ease-std);
}
body.nav-open{overflow:hidden}
:focus-visible{outline:3px solid var(--md-sys-color-primary);outline-offset:2px;border-radius:var(--md-shape-xs)}
svg.i{width:22px;height:22px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto}
svg.i.sm{width:18px;height:18px;stroke-width:2}

/* ---------- 动效关键帧 ---------- */
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes dlgIn{from{opacity:0;transform:translateY(28px) scale(.94)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes popIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}
}

/* ---------- 排版 M3 type scale ---------- */
.display-s{font-size:36px;line-height:44px;font-weight:400;letter-spacing:0}
.headline-s{font-size:24px;line-height:32px;font-weight:400;margin:0}
.title-l{font-size:22px;line-height:28px;font-weight:400;margin:0}
.title-m{font-size:16px;line-height:24px;font-weight:500;letter-spacing:.15px;margin:0}
.title-s{font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px;margin:0}
.body-m{font-size:14px;line-height:20px;letter-spacing:.25px}
.body-s{font-size:12px;line-height:16px;letter-spacing:.4px}
.label-l{font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px}
.label-s{font-size:11px;line-height:16px;font-weight:500;letter-spacing:.5px}
.muted{color:var(--md-sys-color-on-surface-variant)}
.mono{font-family:"Roboto Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.num{font-variant-numeric:tabular-nums}

/* ---------- 顶栏 ---------- */
.topbar{
  position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:8px;
  height:64px;padding:0 12px;
  background:var(--md-sys-color-surface-container);
  color:var(--md-sys-color-on-surface);
  transition:background-color var(--dur-m) var(--ease-std),box-shadow var(--dur-m) var(--ease-std);
}
.topbar .brand{display:flex;align-items:center;gap:8px;font-size:20px;line-height:28px;min-width:0}
.topbar .brand b{font-weight:500;white-space:nowrap}
.topbar .brand .mark{color:var(--md-sys-color-primary);display:flex}
.topbar .spacer{flex:1;min-width:8px}
.menubtn{display:none}

/* ---------- 骨架 ---------- */
.shell{display:flex;min-height:calc(100vh - 64px)}
.scrim{
  position:fixed;inset:0;z-index:35;background:var(--md-sys-color-scrim);
  opacity:0;visibility:hidden;
  transition:opacity var(--dur-m) var(--ease-std),visibility var(--dur-m) var(--ease-std);
}
.rail{
  width:88px;flex:0 0 88px;padding:12px 0;display:flex;flex-direction:column;gap:4px;align-items:center;
  background:var(--md-sys-color-surface);
}
.drawerhead{display:none}
.navitem{
  width:72px;border:0;background:none;color:var(--md-sys-color-on-surface-variant);
  display:flex;flex-direction:column;align-items:center;gap:4px;padding:0;cursor:pointer;font:inherit;
  position:relative;
}
.navitem .pill{
  width:56px;height:32px;border-radius:var(--md-shape-l);display:grid;place-items:center;
  transition:background-color var(--dur-m) var(--ease-std),color var(--dur-m) var(--ease-std);
  position:relative;overflow:hidden;
}
.navitem .pill::after{
  content:"";position:absolute;inset:0;background:currentColor;opacity:0;
  transition:opacity var(--dur-s) var(--ease-std);
}
.navitem:hover .pill::after{opacity:var(--md-state-hover)}
.navitem:active .pill::after{opacity:var(--md-state-press)}
.navitem[aria-selected=true] .pill{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}
.navitem[aria-selected=true]{color:var(--md-sys-color-on-surface)}
.navitem .rl{font-size:12px;font-weight:500;line-height:16px;white-space:nowrap}
.railfoot{
  margin-top:auto;padding-top:10px;width:72px;display:flex;flex-direction:column;align-items:center;
  border-top:1px solid var(--md-sys-color-outline-variant);
}
.railfoot .rl{font-size:10.5px;letter-spacing:0}
.themestate{font-size:10px;line-height:14px;color:var(--md-sys-color-on-surface-variant);white-space:nowrap}

main{flex:1;min-width:0;padding:8px 24px 96px}
.wrap{max-width:1080px;margin:0 auto}
#pane.enter{animation:fadeUp var(--dur-m) var(--ease-emph-out) both}
.head{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:16px 0 4px}
.head h2{margin:0}
.head .spacer{flex:1}
.sub{margin:0 0 20px;color:var(--md-sys-color-on-surface-variant)}

/* ---------- 卡片 ---------- */
.card{
  background:var(--md-sys-color-surface-container-low);
  border-radius:var(--md-shape-l);padding:20px;margin-bottom:16px;
  transition:background-color var(--dur-m) var(--ease-std),box-shadow var(--dur-m) var(--ease-std);
}
.card.outlined{background:var(--md-sys-color-surface);border:1px solid var(--md-sys-color-outline-variant)}
.card.elev{background:var(--md-sys-color-surface-container-lowest);box-shadow:var(--md-elev-1)}
.card.elev:hover{box-shadow:var(--md-elev-2)}
.card h3{margin:0 0 4px}
.grid{display:grid;gap:16px}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.grid.three{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.stat{
  background:var(--md-sys-color-surface-container);border-radius:var(--md-shape-l);padding:16px 20px;
  animation:popIn var(--dur-m) var(--ease-emph-out) both;
  transition:background-color var(--dur-m) var(--ease-std);
}
.stat .n{font-size:30px;line-height:38px;font-weight:400;color:var(--md-sys-color-primary);font-variant-numeric:tabular-nums}

/* ---------- 按钮 ---------- */
button.btn{
  font:inherit;font-weight:500;letter-spacing:.1px;cursor:pointer;border:0;
  min-height:40px;padding:0 24px;border-radius:var(--md-shape-full);display:inline-flex;align-items:center;justify-content:center;gap:8px;
  background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary);
  position:relative;overflow:hidden;
  transition:box-shadow var(--dur-m) var(--ease-std),transform 90ms var(--ease-std),background-color var(--dur-m) var(--ease-std);
}
button.btn::after,button.icon::after,a.btn::after{
  content:"";position:absolute;inset:0;background:currentColor;opacity:0;pointer-events:none;
  transition:opacity var(--dur-s) var(--ease-std);
}
button.btn:hover::after,button.icon:hover::after{opacity:var(--md-state-hover)}
button.btn:active::after,button.icon:active::after{opacity:var(--md-state-press)}
button.btn:hover{box-shadow:var(--md-elev-1)}
button.btn:active{transform:scale(.97)}
button.btn:disabled{opacity:.38;cursor:not-allowed;box-shadow:none;transform:none}
button.btn:disabled::after{opacity:0}
button.btn.tonal{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}
button.btn.outlined{background:transparent;color:var(--md-sys-color-primary);border:1px solid var(--md-sys-color-outline)}
button.btn.text{background:transparent;color:var(--md-sys-color-primary);padding:0 12px}
button.btn.danger{background:var(--md-sys-color-error-container);color:var(--md-sys-color-on-error-container)}
button.btn.small{min-height:32px;height:32px;padding:0 16px;font-size:13px;border-radius:var(--md-shape-full)}
button.btn.icononly{padding:0;width:40px;min-width:40px}
a.btn{
  font:inherit;font-weight:500;text-decoration:none;min-height:40px;padding:0 24px;border-radius:var(--md-shape-full);
  display:inline-flex;align-items:center;justify-content:center;gap:8px;position:relative;overflow:hidden;
  background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary);
}
button.icon{
  border:0;background:transparent;color:var(--md-sys-color-on-surface-variant);cursor:pointer;
  width:40px;height:40px;min-width:40px;border-radius:var(--md-shape-full);display:grid;place-items:center;
  position:relative;overflow:hidden;
  transition:background-color var(--dur-m) var(--ease-std),transform 90ms var(--ease-std),color var(--dur-m) var(--ease-std);
}
button.icon:active{transform:scale(.92)}
button.icon:disabled{opacity:.38;cursor:not-allowed}
button.icon:disabled::after{opacity:0}
button.icon.spinning svg{animation:spin 900ms linear infinite;transform-origin:50% 50%}

/* ---------- 输入 ---------- */
.field{position:relative;margin:0 0 20px}
.field>label{
  display:block;font-size:12px;line-height:16px;font-weight:500;letter-spacing:.4px;
  color:var(--md-sys-color-on-surface-variant);margin-bottom:6px;
}
.field input,.field select,.field textarea{
  width:100%;font:inherit;color:var(--md-sys-color-on-surface);
  background:var(--md-sys-color-surface-container-highest);
  border:0;border-bottom:1px solid var(--md-sys-color-on-surface-variant);
  border-radius:var(--md-shape-xs) var(--md-shape-xs) 0 0;padding:12px 16px;min-height:48px;
  transition:border-color var(--dur-s) var(--ease-std),background-color var(--dur-m) var(--ease-std);
}
.field textarea{min-height:96px;resize:vertical;font-family:"Roboto Mono",ui-monospace,monospace;font-size:13px}
.field input:focus,.field select:focus,.field textarea:focus{
  outline:none;border-bottom:2px solid var(--md-sys-color-primary);padding-bottom:11px;
}
.hint{font-size:12px;line-height:16px;color:var(--md-sys-color-on-surface-variant);margin-top:4px}
/* 全圆角输入框：圆弧半径与 40px 高的按钮保持一致（药丸形） */
.field.round input{
  border:1px solid var(--md-sys-color-outline);
  border-radius:var(--md-shape-full);
  background:var(--md-sys-color-surface-container-highest);
  padding:12px 20px;
}
.field.round input:focus{
  border:2px solid var(--md-sys-color-primary);
  border-radius:var(--md-shape-full);
  padding:11px 19px;
}

/* ---------- 开关 ---------- */
.switch{display:flex;align-items:center;gap:12px;padding:8px 0;cursor:pointer}
.switch input{position:absolute;opacity:0;width:0;height:0}
.switch .track{
  width:52px;height:32px;border-radius:var(--md-shape-l);flex:0 0 52px;position:relative;
  background:var(--md-sys-color-surface-container-highest);
  border:2px solid var(--md-sys-color-outline);
  transition:background-color var(--dur-m) var(--ease-emph),border-color var(--dur-m) var(--ease-emph);
}
.switch .track::after{
  content:"";position:absolute;top:6px;left:6px;width:16px;height:16px;border-radius:50%;
  background:var(--md-sys-color-outline);
  transition:transform var(--dur-m) var(--ease-emph),width var(--dur-m) var(--ease-emph),height var(--dur-m) var(--ease-emph),top var(--dur-m) var(--ease-emph),left var(--dur-m) var(--ease-emph),background-color var(--dur-m) var(--ease-emph);
}
.switch input:checked+.track{background:var(--md-sys-color-primary);border-color:var(--md-sys-color-primary)}
.switch input:checked+.track::after{transform:translateX(20px);width:24px;height:24px;top:2px;left:2px;background:var(--md-sys-color-on-primary)}
.switch input:focus-visible+.track{outline:3px solid var(--md-sys-color-primary);outline-offset:2px}

/* ---------- Chip ---------- */
.chip{
  display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:var(--md-shape-s);
  border:1px solid var(--md-sys-color-outline-variant);color:var(--md-sys-color-on-surface-variant);
  font-size:13px;font-weight:500;background:transparent;cursor:default;
  white-space:nowrap;flex:0 0 auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;
  transition:background-color var(--dur-m) var(--ease-std),color var(--dur-m) var(--ease-std);
}
.chip.on{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container);border-color:transparent}
.chip.pri{background:var(--md-sys-color-primary-container);color:var(--md-sys-color-on-primary-container);border-color:transparent}
.chip.err{background:var(--md-sys-color-error-container);color:var(--md-sys-color-on-error-container);border-color:transparent}
.chip.ok{background:var(--md-sys-color-success-container);color:var(--md-sys-color-on-success-container);border-color:transparent}
.chip.sel{cursor:pointer}
.chips{display:flex;gap:8px;flex-wrap:wrap;min-width:0}

/* ---------- 列表 ---------- */
.list{display:flex;flex-direction:column;gap:8px}
.item{
  background:var(--md-sys-color-surface-container);border-radius:var(--md-shape-m);padding:14px 16px;
  display:flex;gap:12px;align-items:center;flex-wrap:wrap;
  animation:fadeUp var(--dur-m) var(--ease-emph-out) both;
  transition:background-color var(--dur-m) var(--ease-std);
}
.list>.item:nth-child(1){animation-delay:0ms}
.list>.item:nth-child(2){animation-delay:35ms}
.list>.item:nth-child(3){animation-delay:70ms}
.list>.item:nth-child(4){animation-delay:105ms}
.list>.item:nth-child(5){animation-delay:140ms}
.list>.item:nth-child(6){animation-delay:175ms}
.list>.item:nth-child(7){animation-delay:210ms}
.list>.item:nth-child(n+8){animation-delay:240ms}
.item .grow{flex:1 1 240px;min-width:0}
.item .acts{display:flex;gap:4px;align-items:center;margin-left:auto;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
.item .ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ordinal{
  width:32px;height:32px;flex:0 0 32px;border-radius:var(--md-shape-s);display:grid;place-items:center;
  background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary);font-weight:500;font-size:13px;
}
.ordinal.off{background:var(--md-sys-color-surface-container-highest);color:var(--md-sys-color-on-surface-variant)}
.empty{
  border:1px dashed var(--md-sys-color-outline-variant);border-radius:var(--md-shape-l);padding:32px 20px;text-align:center;
  color:var(--md-sys-color-on-surface-variant);animation:fadeIn var(--dur-m) var(--ease-std) both;
}

/* ---------- 表格 ---------- */
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:var(--md-shape-m);background:var(--md-sys-color-surface-container)}
table.md{width:100%;border-collapse:collapse;font-size:13px;min-width:420px}
table.md th{
  text-align:left;font-weight:500;font-size:12px;letter-spacing:.4px;white-space:nowrap;
  color:var(--md-sys-color-on-surface-variant);padding:12px 14px;
  border-bottom:1px solid var(--md-sys-color-outline-variant);
}
table.md td{padding:12px 14px;border-bottom:1px solid var(--md-sys-color-outline-variant);white-space:nowrap}
table.md tbody tr:last-child td{border-bottom:0}
table.md th.r,table.md td.r{text-align:right;font-variant-numeric:tabular-nums}
table.md tfoot td{font-weight:500;border-top:1px solid var(--md-sys-color-outline);border-bottom:0}

/* ---------- 对话框 ---------- */
dialog{
  border:0;border-radius:var(--md-shape-xl);padding:24px;max-width:min(560px,calc(100vw - 32px));width:100%;
  max-height:calc(100vh - 48px);overflow:auto;
  background:var(--md-sys-color-surface-container-high);color:var(--md-sys-color-on-surface);
  box-shadow:var(--md-elev-3);
}
dialog[open]{animation:dlgIn var(--dur-l) var(--ease-emph-out) both}
dialog::backdrop{background:var(--md-sys-color-scrim);animation:fadeIn var(--dur-m) var(--ease-std) both}
dialog h3{margin:0 0 8px}
dialog .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px;flex-wrap:wrap}
.scroll{max-height:46vh;overflow:auto;margin:8px -4px;padding:0 4px}

/* ---------- 提示条 ---------- */
/* 之前用 translateY(120%) 藏，元素本身有 padding，算下来底部还会露出十几像素的色块。
   现在改成 opacity + visibility 双保险，并且内容为空时直接不参与布局。 */
#snack{
  position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));
  transform:translate(-50%,16px);
  opacity:0;visibility:hidden;pointer-events:none;
  background:var(--md-sys-color-inverse-surface);color:var(--md-sys-color-inverse-on-surface);
  padding:14px 16px;border-radius:var(--md-shape-s);box-shadow:var(--md-elev-3);z-index:99;
  max-width:min(560px,calc(100vw - 32px));
  transition:opacity var(--dur-m) var(--ease-std),transform var(--dur-m) var(--ease-emph-out),visibility var(--dur-m) var(--ease-std);
}
#snack.on{opacity:1;visibility:visible;transform:translate(-50%,0)}
#snack:empty{display:none}
.banner{
  background:var(--md-sys-color-error-container);color:var(--md-sys-color-on-error-container);
  border-radius:var(--md-shape-m);padding:14px 16px;margin-bottom:16px;
  animation:fadeUp var(--dur-m) var(--ease-emph-out) both;
}
.banner.info{background:var(--md-sys-color-tertiary-container);color:var(--md-sys-color-on-tertiary-container)}

/* ---------- 登录 ---------- */
.login{min-height:100vh;display:grid;place-items:center;padding:24px}
.login .card{
  width:min(400px,100%);text-align:center;background:var(--md-sys-color-surface-container-low);
  animation:fadeUp var(--dur-l) var(--ease-emph-out) both;
}
.login .logo{margin-bottom:8px;display:flex;justify-content:center;color:var(--md-sys-color-primary)}
.login .logo svg{width:40px;height:40px}
.login .field{text-align:left}

/* ---------- 代码块 ---------- */
pre.code{
  background:var(--md-sys-color-surface-container-highest);border-radius:var(--md-shape-m);padding:14px 16px;
  overflow:auto;font-size:12.5px;line-height:1.6;margin:0;
  font-family:"Roboto Mono",ui-monospace,monospace;
}
.keyout{
  background:var(--md-sys-color-primary-container);color:var(--md-sys-color-on-primary-container);
  border-radius:var(--md-shape-m);padding:14px 16px;word-break:break-all;font-family:"Roboto Mono",ui-monospace,monospace;font-size:13px;
}

/* ---------- <=840px：侧栏变模态抽屉 ---------- */
@media(max-width:840px){
  .menubtn{display:grid}
  body.nav-open .scrim{opacity:1;visibility:visible}
  .rail{
    position:fixed;left:0;top:0;bottom:0;z-index:40;
    width:min(300px,84vw);flex-basis:auto;
    padding:12px;gap:2px;align-items:stretch;
    background:var(--md-sys-color-surface-container-low);
    border-radius:0 var(--md-shape-l) var(--md-shape-l) 0;box-shadow:var(--md-elev-3);
    overflow-y:auto;overscroll-behavior:contain;
    transform:translateX(-104%);
    transition:transform var(--dur-l) var(--ease-emph);
  }
  body.nav-open .rail{transform:none}
  .drawerhead{
    display:flex;align-items:center;gap:8px;padding:4px 4px 12px 12px;
    color:var(--md-sys-color-on-surface-variant);
  }
  .drawerhead .t{flex:1;font-size:14px;font-weight:500;letter-spacing:.5px}
  .navitem{
    flex-direction:row;width:100%;height:56px;min-height:56px;border-radius:var(--md-shape-xl);
    padding:0 16px;gap:12px;justify-content:flex-start;
    transition:background-color var(--dur-m) var(--ease-std),color var(--dur-m) var(--ease-std);
  }
  .navitem::after{
    content:"";position:absolute;inset:0;border-radius:var(--md-shape-xl);background:currentColor;opacity:0;
    transition:opacity var(--dur-s) var(--ease-std);pointer-events:none;
  }
  .navitem:hover::after{opacity:var(--md-state-hover)}
  .navitem:active::after{opacity:var(--md-state-press)}
  .navitem .pill{width:auto;height:auto;background:none!important;border-radius:0}
  .navitem .pill::after{display:none}
  .navitem[aria-selected=true]{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}
  .navitem .rl{font-size:14px;line-height:20px}
  .railfoot{width:100%;margin-top:auto;padding-top:8px;align-items:stretch}
  .railfoot .navitem{justify-content:flex-start}
  .railfoot .rl{font-size:14px}
  .themestate{font-size:12px;margin-left:auto}
  main{padding:8px 16px 96px}
}

/* ---------- <=600px：紧凑布局，基准 375px ---------- */
@media(max-width:600px){
  main{padding:4px 12px 88px}
  .topbar{padding:0 4px;gap:2px;height:60px}
  .topbar .brand{font-size:17px;gap:6px}
  .topbar .brand .long{display:none}
  .card{padding:16px}
  .head{flex-direction:column;align-items:stretch;gap:10px;margin:12px 0 4px}
  .head .spacer{display:none}
  .head>.btn{width:100%}
  .headline-s{font-size:22px;line-height:28px}
  .sub{margin-bottom:16px}
  /* 列表项：正文整行，操作按钮另起一行靠右，避免互相挤压把文字压成竖排 */
  .item{align-items:flex-start;padding:14px;gap:10px}
  .item .grow{flex:1 1 100%}
  .item .acts{
    width:100%;margin-left:0;justify-content:flex-end;
    padding-top:10px;border-top:1px solid var(--md-sys-color-outline-variant);
  }
  .item .acts .btn.small{flex:0 0 auto}
  .chip{height:28px;font-size:12px;padding:0 10px}
  .chips{gap:6px}
  .stat{padding:14px 16px}
  .stat .n{font-size:26px;line-height:34px}
  button.btn{padding:0 18px}
  button.btn.small{padding:0 14px}
  dialog{
    border-radius:var(--md-shape-xl);padding:20px 16px;
    max-width:calc(100vw - 24px);max-height:calc(100vh - 32px);
  }
  dialog .actions{margin-top:20px}
  dialog .actions .btn{flex:1 1 auto}
  .scroll{max-height:52vh}
  .login{padding:16px}
  .login .card{padding:24px 20px}
  pre.code{font-size:12px;padding:12px}
  .field{margin-bottom:16px}
  #snack{left:12px;right:12px;transform:translateY(16px);max-width:none}
  #snack.on{transform:translateY(0)}
  table.md .hide-sm{display:none}
  table.md th,table.md td{padding:10px}
}
@media(max-width:400px){
  .logouttext{display:none}
  button.btn.logout{width:40px;min-width:40px;padding:0}
}


/* ---------- 会话视图：双栏 ---------- */
.chatwrap{display:flex;min-height:calc(100vh - 64px);height:calc(100vh - 64px)}
.sesscol{
  width:272px;flex:0 0 272px;display:flex;flex-direction:column;min-height:0;
  border-right:1px solid var(--md-sys-color-outline-variant);background:var(--md-sys-color-surface-container-low);
}
.sesscol .sesshead{display:flex;align-items:center;gap:8px;padding:12px 12px 8px}
.sesscol .sesshead .t{flex:1;font-size:13px;font-weight:500;letter-spacing:.3px;color:var(--md-sys-color-on-surface-variant)}
.sesslist{flex:1;overflow-y:auto;padding:0 8px 12px;display:flex;flex-direction:column;gap:4px}
.sessitem{
  border:0;background:none;font:inherit;text-align:left;cursor:pointer;color:var(--md-sys-color-on-surface);
  display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:var(--md-shape-m);position:relative;overflow:hidden;
  transition:background-color var(--dur-s) var(--ease-std);
}
.sessitem::after{content:"";position:absolute;inset:0;background:currentColor;opacity:0;transition:opacity var(--dur-s) var(--ease-std);pointer-events:none}
.sessitem:hover::after{opacity:var(--md-state-hover)}
.sessitem .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.sessitem .del{visibility:hidden}
.sessitem:hover .del,.sessitem[aria-current=true] .del{visibility:visible}
.sessitem[aria-current=true]{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}
.sessempty{padding:24px 16px;color:var(--md-sys-color-on-surface-variant);font-size:13px;text-align:center}

.chatcol{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}
.msgs{flex:1;overflow-y:auto;padding:20px 24px 12px;scroll-behavior:smooth}
.msgs .inner{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.msg{min-width:0}
.msg.user{
  align-self:flex-end;max-width:78%;
  background:var(--md-sys-color-primary-container);color:var(--md-sys-color-on-primary-container);
  padding:12px 16px;border-radius:var(--md-shape-l);white-space:pre-wrap;overflow-wrap:anywhere;
}
.msg.assistant{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}
.msg.assistant .meta{font-size:11px;color:var(--md-sys-color-on-surface-variant);margin-top:4px}
.toolcard{
  border:1px solid var(--md-sys-color-outline-variant);border-radius:var(--md-shape-m);
  background:var(--md-sys-color-surface-container-low);
  display:flex;align-items:center;gap:10px;padding:10px 14px;font-size:13px;max-width:640px;
}
.toolcard .name{font-weight:500;font-family:"Roboto Mono",ui-monospace,monospace;font-size:12px;color:var(--md-sys-color-on-surface-variant)}
.toolcard .brief{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toolcard svg.i{width:16px;height:16px}
.toolcard.err{background:var(--md-sys-color-error-container);color:var(--md-sys-color-on-error-container);border-color:transparent}
.notice{font-size:12px;color:var(--md-sys-color-on-surface-variant);text-align:center}
.msg.error{background:var(--md-sys-color-error-container);color:var(--md-sys-color-on-error-container);border-radius:var(--md-shape-m);padding:12px 16px;font-size:13px}
.caret{
  display:inline-block;width:9px;height:15px;vertical-align:-2px;background:var(--md-sys-color-primary);
  border-radius:2px;animation:blink 900ms steps(1) infinite;margin-left:2px;
}
@keyframes blink{50%{opacity:0}}
.msg.entering{animation:fadeUp var(--dur-m) var(--ease-emph-out) both}
.syschip{
  align-self:center;font-size:11.5px;color:var(--md-sys-color-on-surface-variant);
  background:var(--md-sys-color-surface-container);border-radius:var(--md-shape-full);padding:4px 12px;
}

/* ---------- 输入区 ---------- */
.composer{padding:8px 24px calc(16px + env(safe-area-inset-bottom,0px))}
.composer .inner{max-width:820px;margin:0 auto;display:flex;gap:8px;align-items:flex-end}
.composer textarea{
  flex:1;font:inherit;color:var(--md-sys-color-on-surface);resize:none;
  background:var(--md-sys-color-surface-container-high);
  border:1px solid transparent;border-radius:var(--md-shape-l);
  padding:12px 16px;min-height:48px;max-height:180px;line-height:1.5;
  transition:border-color var(--dur-s) var(--ease-std),background-color var(--dur-m) var(--ease-std);
}
.composer textarea:focus{outline:none;border-color:var(--md-sys-color-primary)}
.composer .send{width:48px;height:48px;min-width:48px;border-radius:var(--md-shape-l)}
.composer .hintbar{max-width:820px;margin:6px auto 0;font-size:11px;color:var(--md-sys-color-on-surface-variant);display:flex;gap:8px;align-items:center}
.taskchips{display:flex;gap:6px;flex-wrap:wrap;max-width:820px;margin:0 auto 6px}

/* ---------- 文件视图 ---------- */
.filebar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.filebar .field{margin:0;flex:1;min-width:220px}
.filesize{font-size:12px;color:var(--md-sys-color-on-surface-variant);font-variant-numeric:tabular-nums;white-space:nowrap}
.filepreview{max-height:56vh;overflow:auto;margin:8px -4px;padding:0 4px}
.filepreview pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:1.6}
.hitpath{font-size:12px;font-family:"Roboto Mono",ui-monospace,monospace;color:var(--md-sys-color-on-surface-variant)}

/* ---------- <=840px：会话列表变模态抽屉 ---------- */
@media(max-width:840px){
  .chatwrap{height:auto;min-height:calc(100vh - 64px)}
  .sesscol{
    position:fixed;left:0;top:0;bottom:0;z-index:40;width:min(300px,84vw);flex-basis:auto;
    border-right:0;border-radius:0 var(--md-shape-l) var(--md-shape-l) 0;box-shadow:var(--md-elev-3);
    transform:translateX(-104%);transition:transform var(--dur-l) var(--ease-emph);
    overscroll-behavior:contain;
  }
  body.sess-open .sesscol{transform:none}
  body.sess-open{overflow:hidden}
  .msgs{padding:16px 14px 8px}
  .composer{padding:8px 14px 12px}
  .msg.user{max-width:88%}
}

/* ---------- <=600px ---------- */
@media(max-width:600px){
  .msgs{padding:12px 10px 6px}
  .composer{padding:6px 10px 10px}
  .composer .send{width:44px;height:44px;min-width:44px}
  .toolcard{max-width:100%}
  .filebar .field{min-width:0;flex-basis:100%}
}

/* ---------- 思考过程 / 状态行 / 会话用量 ---------- */
.statusrow{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--md-sys-color-on-surface-variant)}
.statusrow svg.i{width:14px;height:14px;animation:spin 1.2s linear infinite}
.think{border-left:3px solid var(--md-sys-color-outline-variant);padding:2px 0 2px 12px;max-width:680px}
.think .thead{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:12px;font-weight:500;color:var(--md-sys-color-on-surface-variant);padding:2px 0}
.think .thead svg.i{width:13px;height:13px}
.think .tbody{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:1.65;color:var(--md-sys-color-on-surface-variant);margin-top:6px}
.think.done .tbody{display:none}
.think.done.open .tbody{display:block}
.think .ttoggle{margin-left:auto}
.chip.usage{height:24px;font-size:11.5px;padding:0 10px;gap:4px}
.chip.usage svg.i{width:12px;height:12px}
/* 下载链接按钮（<a> 版 small） */
a.btn.small{min-height:32px;height:32px;padding:0 14px;font-size:13px;text-decoration:none;justify-content:center}

/* ---------- 移动端会话列表入口 ---------- */
/* 桌面端会话列常驻，按钮隐藏；≤840px 会话列变抽屉，顶栏出现打开按钮 */
.topbar .sessbtn{display:none}
@media(max-width:840px){
  .topbar .sessbtn{display:grid}
}

/* ---------- assistant 消息内的 markdown ---------- */
.msg.assistant h1,.msg.assistant h2,.msg.assistant h3,.msg.assistant h4{margin:14px 0 6px;line-height:1.35}
.msg.assistant h1{font-size:20px}
.msg.assistant h2{font-size:18px}
.msg.assistant h3{font-size:16px}
.msg.assistant h4{font-size:14.5px}
.msg.assistant p{margin:6px 0}
.msg.assistant ul,.msg.assistant ol{margin:6px 0;padding-left:22px}
.msg.assistant li{margin:3px 0}
.msg.assistant blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--md-sys-color-outline-variant);color:var(--md-sys-color-on-surface-variant);background:var(--md-sys-color-surface-container);border-radius:var(--md-shape-s)}
.msg.assistant blockquote p{margin:2px 0}
.msg.assistant code.mdcode-i{background:var(--md-sys-color-surface-container-highest);border-radius:4px;padding:1px 6px;font-family:"Roboto Mono",ui-monospace,monospace;font-size:12.5px}
.msg.assistant pre.mdcode{margin:10px 0;position:relative}
.msg.assistant .mdlang{display:block;font-size:10.5px;letter-spacing:.5px;color:var(--md-sys-color-on-surface-variant);margin-bottom:4px;text-transform:uppercase}
.msg.assistant a{color:var(--md-sys-color-primary);text-decoration:underline;text-underline-offset:2px}
.msg.assistant hr{border:0;border-top:1px solid var(--md-sys-color-outline-variant);margin:12px 0}

/* ---------- 会话视图独占视口 ---------- */
/* 页面级滚动会在聊天内容下方拖出大片空白：聊天态锁死 body 滚动，
   让 .msgs 自己滚；切到文件/设置页自动恢复普通文档流。 */
body.view-chat{overflow:hidden}
main.chatmode{padding:0;height:calc(100vh - 64px);overflow:hidden}
main.chatmode #pane{height:100%}
.chatwrap{height:100%;min-height:0}
@media(max-width:600px){
  main.chatmode{height:calc(100vh - 60px)}
}
`;
