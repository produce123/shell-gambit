/**
 * Shell Gambit — 入口
 *
 * 整个游戏是纯静态的 ES Module 前端：没有打包步骤、没有第三方运行时依赖，
 * 直接把仓库传到 GitHub Pages 就能玩。
 */

import { init } from './ui/app.js';

try {
  init();
} catch (err) {
  console.error('初始化失败', err);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div style="position:fixed;inset:0;display:grid;place-items:center;padding:24px;
      background:#0a0c0f;color:#e9eef4;font-family:system-ui;text-align:center;z-index:999">
      <div>
        <h2 style="margin:0 0 8px">游戏启动失败</h2>
        <p style="color:#9aa7b5;font-size:13px">${String(err && err.message ? err.message : err)}</p>
        <p style="color:#6b7683;font-size:12px">请使用较新的 Chrome / Edge / Safari / Firefox 打开本页。</p>
      </div>
    </div>`
  );
}