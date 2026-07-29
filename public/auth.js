/* Reel Recipes — login/signup page logic (plain JS, no build step) */
(function () {
  'use strict';

  var form = document.getElementById('auth-form');
  var hero = document.getElementById('hero');
  var sub = document.getElementById('sub');
  var emailInput = document.getElementById('email');
  var passwordInput = document.getElementById('password');
  var submitBtn = document.getElementById('submit');
  var errorBox = document.getElementById('error-box');
  var switchText = document.getElementById('switch-text');
  var switchBtn = document.getElementById('switch-btn');

  // 'login' or 'signup'. Start on whichever the URL asks for (?mode=signup).
  var mode = /(?:^|[?&])mode=signup/.test(location.search) ? 'signup' : 'login';

  // Where to go after success: ?next= (same-origin path only), else home.
  function nextDest() {
    var m = /[?&]next=([^&]+)/.exec(location.search);
    if (!m) return '/';
    var dest = decodeURIComponent(m[1]);
    // Only allow same-origin absolute paths — never an off-site redirect.
    return dest.charAt(0) === '/' && dest.charAt(1) !== '/' ? dest : '/';
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function clearError() { errorBox.hidden = true; }

  function render() {
    if (mode === 'signup') {
      hero.innerHTML = 'Create your account<span class="qm">.</span>';
      sub.textContent = 'One account keeps your recipes private — on the web and from the iPhone Shortcut.';
      submitBtn.textContent = 'Create account';
      passwordInput.setAttribute('autocomplete', 'new-password');
      switchText.textContent = 'Already have an account?';
      switchBtn.textContent = 'Sign in';
    } else {
      hero.innerHTML = 'Welcome back<span class="qm">.</span>';
      sub.textContent = 'Sign in to save recipes privately to your account — on the web and from the iPhone Shortcut.';
      submitBtn.textContent = 'Sign in';
      passwordInput.setAttribute('autocomplete', 'current-password');
      switchText.textContent = 'New here?';
      switchBtn.textContent = 'Create an account';
    }
    clearError();
  }

  switchBtn.addEventListener('click', function () {
    mode = mode === 'signup' ? 'login' : 'signup';
    render();
    emailInput.focus();
  });

  emailInput.addEventListener('input', clearError);
  passwordInput.addEventListener('input', clearError);

  // If already signed in, skip straight to the destination.
  fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
    .then(function (res) { if (res.ok) window.location = nextDest(); })
    .catch(function () { /* not signed in — stay on the form */ });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearError();

    var email = emailInput.value.trim();
    var password = passwordInput.value;
    if (!email) { showError('Enter your email address.'); return; }
    if (!password) { showError('Enter your password.'); return; }
    if (mode === 'signup' && password.length < 8) {
      showError('Use a password with at least 8 characters.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' +
      (mode === 'signup' ? 'Creating…' : 'Signing in…');

    fetch('/api/auth/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    })
      .then(function (res) {
        return res.text().then(function (raw) {
          var body = null;
          try { body = JSON.parse(raw); } catch (e) { /* leave null */ }
          return { res: res, body: body };
        });
      })
      .then(function (result) {
        if (result.res.ok && result.body && result.body.ok) {
          window.location = nextDest();
          return;
        }
        submitBtn.disabled = false;
        render();
        showError((result.body && result.body.message) ||
          'Something went wrong. Please try again.');
      })
      .catch(function () {
        submitBtn.disabled = false;
        render();
        showError('Could not reach the server. Check your connection and try again.');
      });
  });

  render();
})();
