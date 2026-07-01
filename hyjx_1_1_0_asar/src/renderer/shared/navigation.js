export function navigateToTeacherDashboard(fallbackHref) {
  try {
    if (window?.api?.navigateTo) {
      window.api.navigateTo('teacher:home');
      return;
    }
  } catch (_) {
    // ignore
  }

  try {
    if (window?.electronAPI?.navigateToHome) {
      window.electronAPI.navigateToHome();
      return;
    }
  } catch (_) {
    // ignore
  }

  if (fallbackHref) {
    window.location.href = fallbackHref;
  }
}
