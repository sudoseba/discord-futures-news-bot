// Login page: render the enabled sign-in methods and handle password login.
const MESSAGES = {
  denied: 'You cancelled the Discord authorization.',
  invalid: 'Invalid login request — please try again.',
  state: 'Your login attempt expired. Please try again.',
  not_member: "That account isn't a member of the bot's Discord server.",
  oauth: 'Discord sign-in failed. Please try again.',
  disabled: 'Discord sign-in is turned off on this server.',
};

const errBox = document.getElementById('err');
function showErr(msg) { errBox.textContent = msg; errBox.classList.add('show'); }

const urlErr = new URLSearchParams(location.search).get('error');
if (urlErr) showErr(MESSAGES[urlErr] || 'Sign-in failed. Please try again.');

fetch('/api/me', { headers: { Accept: 'application/json' } })
  .then((r) => r.json())
  .then((me) => {
    const methods = me.authMethods || {};
    if (methods.discord) document.getElementById('discordBtn').style.display = '';
    if (methods.password) document.getElementById('pwForm').style.display = '';
    if (methods.discord && methods.password) document.getElementById('orDiv').style.display = '';
    if (methods.password && !methods.discord) {
      document.getElementById('subtitle').textContent = 'Sign in with your username and password.';
    }
    if (me.devAuth) {
      const foot = document.querySelector('.login-foot');
      const link = document.createElement('a');
      link.href = '/auth/dev';
      link.className = 'btn-ghost';
      link.style.cssText = 'display:inline-block;margin-top:14px';
      link.textContent = '▶ Preview locally (dev login)';
      foot.replaceChildren(link);
    }
  })
  .catch(() => {});

// Password form → POST /auth/local
const form = document.getElementById('pwForm');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('.pw-submit');
  btn.disabled = true;
  errBox.classList.remove('show');
  try {
    const res = await fetch('/auth/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('pwUser').value,
        password: document.getElementById('pwPass').value,
      }),
    });
    if (res.ok) { location.href = '/'; return; }
    const j = await res.json().catch(() => ({}));
    showErr(j.error || 'Sign-in failed.');
  } catch {
    showErr('Network error — please try again.');
  } finally {
    btn.disabled = false;
  }
});
