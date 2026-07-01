export function createMessageBox(messageEl) {
  return {
    show(text, type = 'info') {
      if (!messageEl) return;
      messageEl.textContent = text;
      messageEl.className = `message-box ${type} show`;
    },
    hide() {
      if (!messageEl) return;
      messageEl.className = 'message-box';
    },
  };
}

export function setButtonLoading(
  buttonEl,
  isLoading,
  {
    loadingHtml = '<div class="loading"></div> 验证中...',
    idleHtml = '<span>登录验证</span>',
  } = {}
) {
  if (!buttonEl) return;
  buttonEl.disabled = Boolean(isLoading);
  buttonEl.innerHTML = isLoading ? loadingHtml : idleHtml;
}
