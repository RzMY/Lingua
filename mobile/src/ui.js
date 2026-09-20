// Native dialogs share the web application's palette, typography and control sizes.
export const nativeStyles = `
.native-dialog{box-sizing:border-box;color:var(--ink,#1b1f16);background:var(--sheet,#f7f7f1);border:1px solid var(--line,rgba(28,32,22,.09));border-radius:24px;padding:24px;width:calc(100% - 32px);max-width:420px;max-height:calc(100dvh - max(16px,env(safe-area-inset-top)) - max(16px,env(safe-area-inset-bottom)));overflow:auto;overscroll-behavior:contain;font:400 15px/1.5 var(--font-ui,system-ui);box-shadow:0 24px 80px #0003}
.native-dialog::backdrop{background:rgba(12,18,8,.42);backdrop-filter:blur(5px)}
.native-dialog[hidden]{display:none}
.native-dialog:focus-visible{outline:none}
.native-head{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.native-head h2{flex:1;margin:0;font-size:20px;font-weight:700;letter-spacing:-.4px}
.native-dialog button{font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.native-close{display:grid;place-items:center;width:36px;height:36px;flex:none;padding:0;border:0;border-radius:50%;background:var(--card,#e8eddf);color:var(--ink-2,#40463a);font-size:24px!important;line-height:1}
.native-field{display:block;margin:0 0 20px}
.native-field>span{display:block;margin-bottom:8px;color:var(--ink-2,#40463a);font-size:14px;font-weight:600}
.native-field input,.native-field select{display:block;box-sizing:border-box;width:100%;min-height:48px;padding:12px 14px;border:1px solid var(--line-2,#ccd1c4);border-radius:14px;background:var(--bg-soft,#eef0e6);color:var(--ink,#1b1f16);font:inherit}
.native-field input{font-size:16px}
.native-field select{appearance:none;-webkit-appearance:none;padding-right:40px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%236c7364' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center}
.native-dialog :focus-visible{outline:2px solid var(--ring,#4f9b35);outline-offset:3px}
.native-status{margin:16px 0;color:var(--ink-2,#40463a);overflow-wrap:anywhere}
.native-status:empty{display:none}
.native-actions{display:flex;gap:10px;margin-top:24px}
.native-button{display:flex;align-items:center;justify-content:center;flex:1;min-height:46px;padding:11px 16px;border:1px solid var(--line-2,#ccd1c4);border-radius:14px;background:var(--card,#e8eddf);color:var(--ink,#1b1f16);font-weight:600!important}
.native-button-primary{background:var(--cta,#b6f18f);color:var(--cta-ink,#1d3311);border-color:transparent}
.native-button:active,.native-close:active{opacity:.75}
.native-dialog button:disabled{opacity:.5;cursor:default}
.native-tools{margin-top:24px;padding-top:8px;border-top:1px solid var(--line,#dde0d6)}
.native-tool{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;min-height:48px;padding:10px 0;border:0;background:none;color:var(--ink-2,#40463a);text-align:left}
.native-tool::after{content:'›';font-size:22px;color:var(--ink-3,#6c7364)}
.native-update{text-align:center;padding:28px 24px 24px}
.native-update h2{font-size:21px;letter-spacing:-.4px;margin:16px 0 0}
.native-update .native-status{margin:12px 0 0}
.native-update-mark{display:grid;place-items:center;width:64px;height:64px;border-radius:22px;background:var(--accent-soft,#d7e6c4);color:var(--accent,#4f7a37);margin:0 auto}
.native-update-mark svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
html.native-app{overscroll-behavior:none}
html.native-activity-pip .topbar,html.native-activity-pip .bottom-nav{display:none}
@media(max-height:480px){.native-dialog{padding:18px}.native-head{margin-bottom:16px}.native-update-mark{width:44px;height:44px;border-radius:16px}.native-actions{margin-top:18px}}
`;
