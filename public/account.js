/* Reel Recipes — account page logic (plain JS, no build step) */
(function () {
  'use strict';

  var emailEl = document.getElementById('email');
  var tokenEl = document.getElementById('token');
  var copyBtn = document.getElementById('copy');
  var logoutBtn = document.getElementById('logout');

  var token = '';

  // Load the signed-in user; bounce to login when the session is gone.
  fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) { window.location = '/login?next=%2Faccount'; return null; }
      return res.json();
    })
    .then(function (body) {
      if (!body || !body.ok) return;
      emailEl.textContent = body.user.email;
      token = body.user.apiToken;
      tokenEl.textContent = token;
    })
    .catch(function () {
      emailEl.textContent = 'Could not load your account.';
    });

  copyBtn.addEventListener('click', function () {
    if (!token) return;
    var done = function () {
      copyBtn.textContent = 'Copied';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(token).then(done).catch(selectFallback);
    } else {
      selectFallback();
    }
  });

  // No Clipboard API (older iOS/Safari): select the token so a long-press copy works.
  function selectFallback() {
    var range = document.createRange();
    range.selectNodeContents(tokenEl);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/auth/logout', { method: 'POST' })
      .then(function () { window.location = '/login'; })
      .catch(function () { window.location = '/login'; });
  });
})();
