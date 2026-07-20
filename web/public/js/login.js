// Show a friendly message for ?error=… on the login page.
const MESSAGES = {
  denied: 'You cancelled the Discord authorization.',
  invalid: 'Invalid login request — please try again.',
  state: 'Your login attempt expired. Please try again.',
  not_member: "That account isn't a member of the bot's Discord server.",
  oauth: 'Discord sign-in failed. Please try again.',
};
const err = new URLSearchParams(location.search).get('error');
if (err) {
  const box = document.getElementById('err');
  box.textContent = MESSAGES[err] || 'Sign-in failed. Please try again.';
  box.classList.add('show');
}

// When DEV_AUTH is enabled, offer a local-preview entry (no Discord needed).
fetch('/api/me', { headers: { Accept: 'application/json' } })
  .then((r) => r.json())
  .then((me) => {
    if (!me.devAuth) return;
    const foot = document.querySelector('.login-foot');
    const link = document.createElement('a');
    link.href = '/auth/dev';
    link.className = 'btn-ghost';
    link.style.cssText = 'display:inline-block;margin-top:14px';
    link.textContent = '▶ Preview locally (dev login)';
    foot.replaceChildren(link);
  })
  .catch(() => {});
