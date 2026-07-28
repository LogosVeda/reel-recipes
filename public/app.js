/* Reel Recipes — main page logic (plain JS, no build step) */
(function () {
  'use strict';

  var form = document.getElementById('extract-form');
  var hero = document.getElementById('hero');
  var urlInput = document.getElementById('url');
  var pasteBtn = document.getElementById('paste-link');
  var servingsInput = document.getElementById('servings');
  var textInput = document.getElementById('recipe-text');
  var originalUrl = document.getElementById('original-url');
  var submitBtn = document.getElementById('submit');
  var errorBox = document.getElementById('error-box');
  var rescue = document.getElementById('rescue');
  var rescueTextBtn = document.getElementById('rescue-text');
  var rescuePhotosBtn = document.getElementById('rescue-photos');
  var panelText = document.getElementById('panel-text');
  var panelPhotos = document.getElementById('panel-photos');
  var pickImageBtn = document.getElementById('pick-image');
  var imageFile = document.getElementById('image-file');
  var imageChip = document.getElementById('image-chip');
  var imagePreview = document.getElementById('image-preview');
  var thumbSkeleton = document.getElementById('thumb-skeleton');
  var imageName = document.getElementById('image-name');
  var imageRetry = document.getElementById('image-retry');
  var imageClear = document.getElementById('image-clear');
  var progressWrap = document.getElementById('progress-wrap');
  var progressEl = document.getElementById('progress');
  var progressSecsEl = document.getElementById('progress-secs');

  // Fixed markup, never user input — the accent span colors the punctuation.
  var HERO_IDLE = 'What are we cooking<span class="qm">?</span>';
  var HERO_BUSY = 'Hang tight — we’re on it<span class="qm">.</span>';
  var HERO_ERROR = 'Let’s try another way<span class="qm">.</span>';

  function setHero(html) { hero.innerHTML = html; }

  // What the next submit sends. The link is the whole product; text/photos
  // are rescue paths that only appear after a link attempt fails.
  var mode = 'link';

  // Base64 (no data: prefix) of the screenshot(s) to submit.
  var pendingImage = null;
  // True while a file is chosen but not yet turned into submittable bytes —
  // submitting in this state must NOT silently fall back to the link.
  var imagePending = false;
  // Last picked files, kept so "Try again" can reprocess them.
  var lastFiles = null;

  // --- rescue options ----------------------------------------------------

  function openRescue() { rescue.hidden = false; }

  function setMode(next) {
    mode = next;
    var textOn = next === 'text';
    var photosOn = next === 'photos';
    panelText.hidden = !textOn;
    panelPhotos.hidden = !photosOn;
    rescueTextBtn.setAttribute('aria-expanded', textOn ? 'true' : 'false');
    rescuePhotosBtn.setAttribute('aria-expanded', photosOn ? 'true' : 'false');
    rescueTextBtn.classList.toggle('on', textOn);
    rescuePhotosBtn.classList.toggle('on', photosOn);
  }

  rescueTextBtn.addEventListener('click', function () {
    setMode(mode === 'text' ? 'link' : 'text');
    if (mode === 'text') textInput.focus();
  });

  rescuePhotosBtn.addEventListener('click', function () {
    setMode(mode === 'photos' ? 'link' : 'photos');
  });

  // --- helpers ---------------------------------------------------------

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    setHero(HERO_ERROR);
    if (errorBox.scrollIntoView) {
      errorBox.scrollIntoView({ block: 'nearest' });
    }
  }

  function clearError() {
    errorBox.hidden = true;
    if (!submitBtn.disabled) setHero(HERO_IDLE);
  }

  function humanSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Chip states: 'loading' (shimmer), 'ready' (thumbnail), 'failed' (retry).
  function setChip(state, dataUrl, label) {
    imageChip.hidden = false;
    imageChip.classList.toggle('failed', state === 'failed');
    thumbSkeleton.hidden = state !== 'loading';
    imageRetry.hidden = state !== 'failed';
    if (state === 'ready' && dataUrl) {
      imagePreview.src = dataUrl;
      imagePreview.hidden = false;
    } else {
      imagePreview.removeAttribute('src');
      imagePreview.hidden = true;
    }
    imageName.textContent = label;
  }

  function clearImage() {
    pendingImage = null;
    imagePending = false;
    lastFiles = null;
    imageFile.value = '';
    imageChip.hidden = true;
    imageChip.classList.remove('failed');
    imagePreview.removeAttribute('src');
    imagePreview.hidden = true;
    thumbSkeleton.hidden = true;
    imageRetry.hidden = true;
    imageName.textContent = '';
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error('read failed')); };
      fr.readAsDataURL(file);
    });
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        return loadViaImgTag(file);
      });
    }
    return loadViaImgTag(file);
  }

  function loadViaImgTag(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  // A data URL only counts as usable if it decoded to real pixels. iOS Safari
  // returns "data:," (or a near-empty image) when a canvas exceeds its limits.
  function usableDataUrl(dataUrl) {
    return typeof dataUrl === 'string' &&
      dataUrl.indexOf('data:image/') === 0 &&
      dataUrl.length > 3000;
  }

  /**
   * Stack screenshots vertically into one image so a recipe spanning several
   * screens arrives as a single picture the reader can follow top to bottom.
   * Sizes stay inside mobile Safari's canvas limits (max side ~4096px, and a
   * total-area ceiling) — exceeding them yields a silently blank canvas.
   */
  function stitch(bitmaps, scaleHint) {
    var MAX_SIDE = 4000;
    var MAX_AREA = 11000000;
    var TARGET_W = Math.round(1000 * scaleHint);

    var parts = bitmaps.map(function (b) {
      var w = b.width || b.naturalWidth;
      var h = b.height || b.naturalHeight;
      var s = Math.min(1, TARGET_W / w);
      return { b: b, w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
    });

    var width = parts.reduce(function (m, p) { return Math.max(m, p.w); }, 1);
    var height = parts.reduce(function (a, p) { return a + p.h; }, 0);

    // Shrink until every limit is satisfied.
    var squeeze = Math.min(
      1,
      MAX_SIDE / width,
      MAX_SIDE / height,
      Math.sqrt(MAX_AREA / (width * height))
    );

    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * squeeze));
    canvas.height = Math.max(1, Math.round(height * squeeze));
    var g = canvas.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);

    var y = 0;
    parts.forEach(function (p) {
      var w = Math.max(1, Math.round(p.w * squeeze));
      var h = Math.max(1, Math.round(p.h * squeeze));
      try { g.drawImage(p.b, 0, y, w, h); } catch (e) { /* skip a bad frame */ }
      y += h;
    });

    var out;
    try { out = canvas.toDataURL('image/jpeg', 0.85); } catch (e) { return null; }
    return usableDataUrl(out) ? out : null;
  }

  function processImages(files) {
    var MAX_COUNT = 6;
    var total = files.length;
    var list = Array.prototype.slice.call(files, 0, MAX_COUNT);
    if (list.length === 0) return;

    lastFiles = list;
    imagePending = true;
    pendingImage = null;
    setChip('loading', null, list.length === 1 ? 'Preparing your screenshot…' : 'Preparing ' + list.length + ' screenshots…');

    var totalBytes = list.reduce(function (a, f) { return a + (f.size || 0); }, 0);
    // Never truncate silently: say when only the first 6 are used.
    var label = list.length === 1
      ? ((list[0].name || 'Screenshot') + ' · ' + humanSize(list[0].size))
      : (total > MAX_COUNT
          ? 'First ' + MAX_COUNT + ' of ' + total + ' screenshots combined · ' + humanSize(totalBytes)
          : list.length + ' screenshots combined · ' + humanSize(totalBytes));

    Promise.all(list.map(loadBitmap))
      .then(function (bitmaps) {
        // Try full size, then progressively smaller — some phones only fail at
        // the larger sizes.
        var dataUrl = stitch(bitmaps, 1) || stitch(bitmaps, 0.6) || stitch(bitmaps, 0.35);
        if (dataUrl) return dataUrl;
        // Canvas is unusable on this device: send the original file untouched.
        if (list.length === 1) return readFileAsDataUrl(list[0]);
        throw new Error('combine failed');
      })
      .then(function (dataUrl) {
        if (!usableDataUrl(dataUrl)) throw new Error('empty image');
        var b64 = dataUrl.split(',')[1] || '';
        // ~8MB binary ceiling on the server (base64 is ~4/3 of binary size).
        if (b64.length > 11000000) {
          throw new Error('too large');
        }
        pendingImage = b64;
        imagePending = false;
        setChip('ready', dataUrl, label);
        clearError();
      })
      .catch(function (err) {
        pendingImage = null;
        imagePending = false;
        var msg = String((err && err.message) || '');
        if (msg === 'too large') {
          setChip('failed', null, 'Too large to send');
          showError('That screenshot is too big to send. Try fewer images, or screenshot just the recipe part.');
        } else if (msg === 'combine failed') {
          setChip('failed', null, "Couldn't combine these");
          showError("This phone couldn't merge multiple screenshots. Upload them one at a time — each becomes its own recipe.");
        } else {
          setChip('failed', null, "Couldn't read this image");
          showError("That image couldn't be read on this device. Try a PNG or JPEG screenshot (HEIC photos sometimes fail).");
        }
      });
  }

  // --- progress feedback ------------------------------------------------

  var progressTimers = [];
  var elapsedTimer = null;
  var progressStage = '';
  var startedAt = 0;

  // Stage copy goes into the aria-live region only when it changes; the
  // ticking seconds live in an aria-hidden span so screen readers aren't
  // re-read the line every second.
  function renderProgress() {
    if (!progressStage) return;
    if (progressEl.textContent !== progressStage) progressEl.textContent = progressStage;
    var secs = Math.round((Date.now() - startedAt) / 1000);
    progressSecsEl.textContent = secs >= 8 ? ' · ' + secs + ' s' : '';
  }

  function startProgress(kind) {
    stopProgress();
    startedAt = Date.now();
    progressWrap.hidden = false;
    // Hedged wording: the client can't see the server pipeline, so these are
    // timed guesses, not status facts.
    var steps = kind === 'image'
      ? [[0, 'Reading your screenshot…'], [8000, 'Still reading — long recipes take a moment…']]
      : kind === 'text'
        ? [[0, 'Reading the recipe…'], [8000, 'Almost there — tidying it up…']]
        : [
            [0, 'Opening the link…'],
            [5000, 'Looking for a written recipe…'],
            [12000, 'Might be a spoken one — listening to the video…'],
            [25000, 'Transcribing what we hear…'],
            [40000, 'Almost there — writing it up…'],
          ];
    steps.forEach(function (s) {
      progressTimers.push(setTimeout(function () {
        progressStage = s[1];
        renderProgress();
      }, s[0]));
    });
    elapsedTimer = setInterval(renderProgress, 1000);
  }

  function stopProgress() {
    progressTimers.forEach(clearTimeout);
    progressTimers = [];
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    progressStage = '';
    progressEl.textContent = '';
    progressSecsEl.textContent = '';
    progressWrap.hidden = true;
  }

  function setBusy(busy, kind) {
    if (busy) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Reading recipe…';
      setHero(HERO_BUSY);
      startProgress(kind);
    } else {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Get recipe';
      if (errorBox.hidden) setHero(HERO_IDLE);
      stopProgress();
    }
  }

  // --- UI wiring --------------------------------------------------------

  // In-field Paste: only shown (and given field room) where the Clipboard
  // API actually works.
  if (pasteBtn && navigator.clipboard && navigator.clipboard.readText) {
    pasteBtn.hidden = false;
    pasteBtn.parentNode.className += ' has-paste';
    pasteBtn.addEventListener('click', function () {
      navigator.clipboard.readText()
        .then(function (t) {
          t = (t || '').trim();
          if (t) {
            urlInput.value = t;
            clearError();
          }
          urlInput.focus();
        })
        .catch(function () {
          // Permission denied or empty clipboard — just focus the field.
          urlInput.focus();
        });
    });
  }

  urlInput.addEventListener('input', clearError);
  textInput.addEventListener('input', clearError);

  pickImageBtn.addEventListener('click', function () { imageFile.click(); });

  imageFile.addEventListener('change', function () {
    clearError();
    if (imageFile.files && imageFile.files.length > 0) {
      processImages(imageFile.files);
    } else if (!lastFiles) {
      clearImage();
    }
  });

  imageRetry.addEventListener('click', function () {
    clearError();
    if (lastFiles && lastFiles.length > 0) {
      processImages(lastFiles);
    } else {
      imageFile.click();
    }
  });

  imageClear.addEventListener('click', function () {
    clearImage();
    clearError();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearError();

    var url = urlInput.value.trim();
    var priorUrl = originalUrl.value.trim();
    var sourceUrl = url || priorUrl;

    var payload = {};
    var kind = mode;

    if (mode === 'photos') {
      if (imagePending) {
        showError('Still preparing your screenshot — try again in a second.');
        return;
      }
      if (!pendingImage) {
        showError(lastFiles
          ? "That screenshot couldn't be prepared. Tap Try again, or remove it and pick another."
          : 'Choose the screenshot(s) of the recipe first.');
        return;
      }
      kind = 'image';
      payload.image = pendingImage;
      if (sourceUrl) payload.url = sourceUrl;
    } else if (mode === 'text') {
      var text = textInput.value.trim();
      if (!text) {
        showError('Paste the recipe text first — quantities and all.');
        return;
      }
      payload.text = text;
      if (sourceUrl) payload.url = sourceUrl;
    } else {
      if (!url) {
        showError('Paste a reel or recipe link first.');
        return;
      }
      kind = 'link';
      payload.url = url;
    }

    var servings = parseInt(servingsInput.value, 10);
    var hasServings = !isNaN(servings) && servings > 0;
    if (hasServings) payload.servings = servings;

    setBusy(true, kind);

    // Hard client-side ceiling so the button can never spin forever.
    var controller = window.AbortController ? new AbortController() : null;
    var timedOut = false;
    var timeout = setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
    }, 180000);

    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
    if (controller) options.signal = controller.signal;

    fetch('/api/extract', options)
      .then(function (res) {
        // The server can return a non-JSON body (edge 5xx, HTML error page);
        // parse defensively so we show a status message, not "check your connection".
        return res.text().then(function (raw) {
          var body = null;
          try { body = JSON.parse(raw); } catch (e) { /* leave null */ }
          return { res: res, body: body };
        });
      })
      .then(function (result) {
        clearTimeout(timeout);
        var res = result.res;
        var body = result.body;

        if (res.ok && body && body.ok) {
          var dest = body.webUrl;
          if (hasServings && body.servings) {
            dest += (dest.indexOf('?') === -1 ? '?' : '&') + 'servings=' + servings;
          }
          window.location = dest;
          return;
        }

        setBusy(false);

        if (!body) {
          showError(res.status >= 500
            ? 'Server error (' + res.status + '). Please try again in a moment.'
            : 'Unexpected response (' + res.status + '). Please try again.');
          return;
        }

        showError(body.message || 'Something went wrong — try again in a moment.');

        // A failed link attempt unlocks the rescue paths.
        if (mode === 'link') {
          openRescue();
          if (body.code === 'fetch_blocked') {
            // The page text was fetched but never analyzed — hand it over.
            setMode('text');
            if (body.fetchedText && !textInput.value.trim()) {
              textInput.value = body.fetchedText;
            }
          } else if (body.code === 'no_recipe_found') {
            // The caption and audio are already checked automatically; what's
            // left is what only the user can see — comments, on-screen text.
            setMode('photos');
          }
          if (url) originalUrl.value = url;
        }
      })
      .catch(function () {
        clearTimeout(timeout);
        setBusy(false);
        if (mode === 'link') openRescue();
        showError(timedOut
          ? 'That took too long and was stopped. Reels with long videos can time out — try again, or send screenshots of the recipe below.'
          : 'Could not reach the server. Check your connection and try again.');
      });
  });
})();
