// Material Design 3 设计令牌（单一事实源）。
//
// 本文件是 cf-llm-gateway 与 cf-agent-web 两个项目共用的设计语言，两处各存一份
// 完全相同的拷贝（有意不引 npm 包，维持零依赖），改动时务必两边同步。
//
// 组成：
//  - 颜色：M3 teal 基线方案（种子 #006874），亮暗两套全量角色映射到 --md-sys-color-*
//  - 形状：M3 shape scale（xs 4 / s 8 / m 12 / l 16 / xl 28 / full）
//  - 高度：M3 elevation level 1-3 的盒阴影
//  - 状态层：hover / pressed 的不透明度（MD3 spec：hover 8%，pressed 12%）
//  - 动效：M3 motion 的 emphasized / standard 曲线与三档时长

export const MD3_TOKENS_CSS = `
:root{
  --md-sys-color-primary:#006874;
  --md-sys-color-on-primary:#ffffff;
  --md-sys-color-primary-container:#9eeffd;
  --md-sys-color-on-primary-container:#001f24;
  --md-sys-color-secondary:#4a6267;
  --md-sys-color-on-secondary:#ffffff;
  --md-sys-color-secondary-container:#cde7ec;
  --md-sys-color-on-secondary-container:#051f23;
  --md-sys-color-tertiary:#525e7d;
  --md-sys-color-on-tertiary:#ffffff;
  --md-sys-color-tertiary-container:#dae2ff;
  --md-sys-color-on-tertiary-container:#0e1b37;
  --md-sys-color-error:#ba1a1a;
  --md-sys-color-on-error:#ffffff;
  --md-sys-color-error-container:#ffdad6;
  --md-sys-color-on-error-container:#410002;
  --md-sys-color-surface:#f5fafb;
  --md-sys-color-on-surface:#171d1e;
  --md-sys-color-surface-variant:#dbe4e6;
  --md-sys-color-on-surface-variant:#3f484a;
  --md-sys-color-surface-container-lowest:#ffffff;
  --md-sys-color-surface-container-low:#eff5f6;
  --md-sys-color-surface-container:#e9eff0;
  --md-sys-color-surface-container-high:#e3e9ea;
  --md-sys-color-surface-container-highest:#dee3e5;
  --md-sys-color-outline:#6f797a;
  --md-sys-color-outline-variant:#bfc8ca;
  --md-sys-color-inverse-surface:#2b3133;
  --md-sys-color-inverse-on-surface:#ecf2f3;
  --md-sys-color-scrim:rgba(0,0,0,.4);
  --md-sys-color-success:#2c6a43;
  --md-sys-color-on-success-container:#00210f;
  --md-sys-color-success-container:#b0f1c2;
  /* M3 shape scale */
  --md-shape-xs:4px;
  --md-shape-s:8px;
  --md-shape-m:12px;
  --md-shape-l:16px;
  --md-shape-xl:28px;
  --md-shape-full:999px;
  /* M3 elevation */
  --md-elev-1:0 1px 2px rgba(0,0,0,.30),0 1px 3px 1px rgba(0,0,0,.15);
  --md-elev-2:0 1px 2px rgba(0,0,0,.30),0 2px 6px 2px rgba(0,0,0,.15);
  --md-elev-3:0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.30);
  /* M3 state layer */
  --md-state-hover:.08;
  --md-state-press:.12;
  /* M3 motion：emphasized 用于进出场，standard 用于状态变化 */
  --ease-emph:cubic-bezier(.2,0,0,1);
  --ease-emph-out:cubic-bezier(.05,.7,.1,1);
  --ease-std:cubic-bezier(.2,0,0,1);
  --dur-s:150ms;
  --dur-m:250ms;
  --dur-l:400ms;
  color-scheme:light;
}
[data-theme=dark]{
  --md-sys-color-primary:#82d3e0;
  --md-sys-color-on-primary:#00363d;
  --md-sys-color-primary-container:#004f58;
  --md-sys-color-on-primary-container:#9eeffd;
  --md-sys-color-secondary:#b1cbd0;
  --md-sys-color-on-secondary:#1c3438;
  --md-sys-color-secondary-container:#334b4f;
  --md-sys-color-on-secondary-container:#cde7ec;
  --md-sys-color-tertiary:#bac6ea;
  --md-sys-color-on-tertiary:#24304d;
  --md-sys-color-tertiary-container:#3b4664;
  --md-sys-color-on-tertiary-container:#dae2ff;
  --md-sys-color-error:#ffb4ab;
  --md-sys-color-on-error:#690005;
  --md-sys-color-error-container:#93000a;
  --md-sys-color-on-error-container:#ffdad6;
  --md-sys-color-surface:#0e1415;
  --md-sys-color-on-surface:#dee3e5;
  --md-sys-color-surface-variant:#3f484a;
  --md-sys-color-on-surface-variant:#bfc8ca;
  --md-sys-color-surface-container-lowest:#090f10;
  --md-sys-color-surface-container-low:#171d1e;
  --md-sys-color-surface-container:#1b2122;
  --md-sys-color-surface-container-high:#262b2c;
  --md-sys-color-surface-container-highest:#303637;
  --md-sys-color-outline:#899294;
  --md-sys-color-outline-variant:#3f484a;
  --md-sys-color-inverse-surface:#dee3e5;
  --md-sys-color-inverse-on-surface:#2b3133;
  --md-sys-color-success:#94d5a8;
  --md-sys-color-success-container:#0c4d2b;
  --md-sys-color-on-success-container:#b0f1c2;
  color-scheme:dark;
}
`;
