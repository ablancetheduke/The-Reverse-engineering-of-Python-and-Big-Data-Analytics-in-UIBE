// ========== C 方案 - 静默更新状态栏 ==========
// 在每个页面初始化时调用 mountUpdateBanner(),会:
//   1. 在右上角/底栏插入一条小提示(可关闭),不抢焦点
//   2. 监听主进程 push 过来的更新状态
//   3. 下载中:显示"正在后台下载 v1.0.8... 45%"
//   4. 下载完成:显示"新版本 v1.0.8 已就绪 [立即更新] [稍后]"
//   5. 用户在 app 内点"立即更新"→ 调 main 打开安装包

const STYLE_ID = 'huiyuan-update-banner-styles';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
  .huiyuan-update-banner {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 9999;
    background: #1f2a44;
    color: #fff;
    padding: 8px 14px;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    font-size: 12px;
    line-height: 1.4;
    max-width: 360px;
    display: flex;
    align-items: center;
    gap: 10px;
    user-select: none;
    transition: opacity .25s, transform .25s;
  }
  .huiyuan-update-banner.is-hidden {
    opacity: 0;
    transform: translateY(10px);
    pointer-events: none;
  }
  .huiyuan-update-banner .hub-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #5cd29d;
    box-shadow: 0 0 6px #5cd29d;
    flex-shrink: 0;
  }
  .huiyuan-update-banner.is-downloading .hub-dot {
    background: #f0a04b;
    box-shadow: 0 0 6px #f0a04b;
    animation: hub-pulse 1.2s ease-in-out infinite;
  }
  @keyframes hub-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .huiyuan-update-banner .hub-text {
    flex: 1;
    word-break: break-all;
  }
  .huiyuan-update-banner .hub-btn {
    background: #2f8af0;
    color: #fff;
    border: 0;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
    flex-shrink: 0;
  }
  .huiyuan-update-banner .hub-btn:hover { background: #4a9bf5; }
  .huiyuan-update-banner .hub-btn.hub-btn-ghost {
    background: transparent;
    color: #aab5cc;
  }
  .huiyuan-update-banner .hub-btn.hub-btn-ghost:hover { color: #fff; }
  `;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

let bannerEl = null;
let currentPhase = 'idle';
let currentData = null;

function buildBanner() {
  if (bannerEl) return bannerEl;
  injectStyles();
  bannerEl = document.createElement('div');
  bannerEl.className = 'huiyuan-update-banner is-hidden';
  bannerEl.innerHTML = `
    <span class="hub-dot"></span>
    <span class="hub-text"></span>
    <button class="hub-btn hub-btn-ghost" data-act="skip">稍后</button>
    <button class="hub-btn" data-act="apply" style="display:none;">立即更新</button>
  `;
  document.body.appendChild(bannerEl);

  bannerEl.querySelector('[data-act="skip"]').addEventListener('click', async () => {
    try { await window.api.appSkipUpdate(); } catch (_) {}
    hideBanner();
  });
  bannerEl.querySelector('[data-act="apply"]').addEventListener('click', async () => {
    try {
      const r = await window.api.appApplyUpdate();
      if (r && r.ok) {
        bannerEl.querySelector('.hub-text').textContent = '已打开安装包,请按提示完成安装';
        bannerEl.querySelector('[data-act="apply"]').style.display = 'none';
        bannerEl.querySelector('[data-act="skip"]').style.display = 'none';
        setTimeout(hideBanner, 5000);
      }
    } catch (_) {}
  });

  return bannerEl;
}

function showBanner(html, opts = {}) {
  const el = buildBanner();
  el.classList.remove('is-hidden');
  el.classList.toggle('is-downloading', !!opts.downloading);
  el.querySelector('.hub-text').innerHTML = html;
  el.querySelector('[data-act="apply"]').style.display = opts.showApply ? '' : 'none';
  el.querySelector('[data-act="skip"]').style.display = opts.showSkip ? '' : 'none';
}

function hideBanner() {
  if (bannerEl) bannerEl.classList.add('is-hidden');
}

function handleStatus(payload) {
  if (!payload) return;
  currentPhase = payload.phase;
  currentData = payload;

  switch (payload.phase) {
    case 'checking':
      // 检测中不提示,避免一闪而过
      break;
    case 'downloading':
      showBanner(
        `正在后台下载新版本 v${payload.version}${payload.percent != null ? ` (${payload.percent}%)` : ''}`,
        { downloading: true, showApply: false, showSkip: true }
      );
      break;
    case 'ready':
      showBanner(
        `新版本 v${payload.version} 已就绪,点击立即更新`,
        { showApply: true, showSkip: true }
      );
      break;
    case 'upToDate':
      hideBanner();
      break;
    case 'error':
      // 静默:不打扰用户,只写日志
      console.warn('[update]', payload.error);
      break;
    case 'idle':
    default:
      hideBanner();
  }
}

export function mountUpdateBanner() {
  if (!window.api || typeof window.api.onUpdateStatus !== 'function') return;
  buildBanner();

  // 订阅主进程推送
  window.api.onUpdateStatus(handleStatus);

  // 启动时主动拉一次"是否已有 pending"
  if (typeof window.api.appGetUpdateStatus === 'function') {
    window.api.appGetUpdateStatus()
      .then((s) => {
        if (s && s.hasUpdate) {
          showBanner(
            `新版本 v${s.version} 已就绪,点击立即更新`,
            { showApply: true, showSkip: true }
          );
        }
      })
      .catch(() => {});

    // 启动时清理已经更新过的 stale 状态
    if (typeof window.api.appClearStaleUpdate === 'function') {
      window.api.appClearStaleUpdate().catch(() => {});
    }
  }
}

// 兼容 CommonJS 导出(主进程侧)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mountUpdateBanner };
}
