/**
 * Overlay Ink — the overlay itself (content script).
 *
 * Injected into every http(s) page by the manifest, and re-injected on demand
 * by the background worker when the page predates the install. The file is
 * written so that running it twice is always safe:
 *
 *   • first run  → installs the API on the page, creates no DOM
 *   • later runs → return the current state and change nothing
 *
 * The overlay is only built the first time somebody actually shows it, so pages
 * you never use it on pay nothing but this small file.
 *
 * Public API on the page (used by the background worker):
 *   window.__overlayInkToggle()   → toggle, returns the new state
 *   window.__overlayInkState()    → { visible, mode }
 * The popup talks to it with chrome.tabs.sendMessage instead (see below).
 */
(function () {
  'use strict';

  const C = typeof globalThis !== 'undefined' ? globalThis.__overlayInkCommon : null;

  /* ------------------------------------------------------------ re-entry -- */

  if (typeof window.__overlayInkToggle === 'function') {
    return Object.assign({ ok: true, alreadyLoaded: true }, window.__overlayInkState());
  }

  if (!C) {
    return { ok: false, reason: 'shared-module-missing' };
  }

  const { STORAGE, DEFAULT_SETTINGS, PRESET_COLORS, MIN_FONT_SIZE, MAX_FONT_SIZE } = C;
  const LOG = '[Overlay Ink]';

  /* --------------------------------------------------------------- state -- */

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let noteText = '';
  let noteTextLoaded = false;
  let noteDirtyByUser = false;
  let lastWrittenText = null;
  let instance = null;
  let lastNotified = null;
  let textSaveTimer = null;
  let settingsSaveTimer = null;
  // Storage reads resolve asynchronously, so a read that started before the
  // user (or another tab / the popup) changed something must never win.
  // Every change bumps these counters; the initial loads only apply their
  // result when nothing moved in the meantime.
  let settingsRevision = 0;
  let textRevision = 0;
  // True between "the user changed something" and "that change reached
  // storage", so the echo of our own write cannot bounce back over it.
  let settingsPendingWrite = false;

  /* ------------------------------------------------------------- helpers -- */

  function sendMessage(message) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(message, function () { void chrome.runtime.lastError; });
    } catch (err) {
      /* Extension was reloaded while the page stayed open — nothing to do. */
    }
  }

  function readStorage(area, key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage[area].get(key, function (result) {
          void chrome.runtime.lastError;
          resolve(result ? result[key] : undefined);
        });
      } catch (err) {
        resolve(undefined);
      }
    });
  }

  function writeStorage(area, values, done) {
    try {
      chrome.storage[area].set(values, function () {
        void chrome.runtime.lastError;
        if (done) done();
      });
    } catch (err) {
      if (done) done();
    }
  }

  function timeout(fn, ms) {
    return setTimeout(fn, ms);
  }

  function notifyState() {
    const state = currentState();
    if (lastNotified && lastNotified.visible === state.visible && lastNotified.mode === state.mode) return;
    lastNotified = state;
    sendMessage({ type: 'oi:state', visible: state.visible, mode: state.mode });
  }

  function currentState() {
    return {
      visible: Boolean(instance && instance.isVisible()),
      mode: settings.mode
    };
  }

  /** Write the current settings immediately. */
  function writeSettings() {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    writeStorage('local', { [STORAGE.settings]: settings }, function () {
      settingsPendingWrite = false;
    });
  }

  /** Write them a moment later — used while a slider is being dragged. */
  function persistSettings() {
    settingsPendingWrite = true;
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = timeout(writeSettings, 250);
  }

  /** Merge a patch into the live settings and reflect it everywhere. */
  function updateSettings(patch, options) {
    const immediate = options && options.immediate;
    settings = C.normaliseSettings(Object.assign({}, settings, patch));
    settingsRevision += 1;
    settingsPendingWrite = true;
    if (instance) instance.applySettings();
    if (immediate) writeSettings();
    else persistSettings();
  }

  function setMode(mode) {
    if (C.MODES.indexOf(mode) === -1 || mode === settings.mode) return;
    updateSettings({ mode: mode }, { immediate: true });
    notifyState();
  }

  function setText(value, force) {
    textRevision += 1;
    noteText = String(value == null ? '' : value);
    if (instance && (force || !instance.isEditing())) instance.setText(noteText);
  }

  function persistTextNow() {
    clearTimeout(textSaveTimer);
    textSaveTimer = null;
    lastWrittenText = noteText;
    writeStorage('local', { [STORAGE.text]: noteText });
  }

  function persistTextLater() {
    clearTimeout(textSaveTimer);
    textSaveTimer = timeout(persistTextNow, 400);
  }

  function loadSettings() {
    const revision = settingsRevision;
    readStorage('local', STORAGE.settings).then(function (raw) {
      if (revision !== settingsRevision) return; // something newer already landed
      settings = C.normaliseSettings(raw);
      if (instance) instance.applySettings();
    });
  }

  function loadText() {
    if (noteTextLoaded) return;
    noteTextLoaded = true;
    const revision = textRevision;
    readStorage('local', STORAGE.text).then(function (value) {
      if (noteDirtyByUser || revision !== textRevision) return; // the user got there first
      setText(typeof value === 'string' ? value : '', true);
    });
  }

  /* ------------------------------------------------------------- picture -- */

  const ICONS = {
    pencil: '<path d="M11.4 2.6l2 2-8 8-2.7.7.7-2.7 8-8z"/><path d="M9.9 4.1l2 2"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>',
    trash: '<path d="M3 4.6h10M6.3 4.6V3.1h3.4v1.5M4.7 4.6l.6 8.3h5.4l.6-8.3"/>',
    close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    outline: '<path d="M2.6 13.3L8 3l5.4 10.3M4.7 10h6.6"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  const BAR_HTML =
    '<div class="topwrap">' +
      '<div class="bar" role="toolbar" aria-label="Overlay Ink">' +
        '<div class="seg" role="group" aria-label="Mode">' +
          '<button type="button" class="segbtn" data-mode="edit" title="Edit — the page pauses while you write">' +
            icon('pencil') + '<span>Edit</span></button>' +
          '<button type="button" class="segbtn" data-mode="view" title="View — the note stays, the page works normally">' +
            icon('eye') + '<span>View</span></button>' +
        '</div>' +
        '<span class="sep"></span>' +
        '<div class="swatches" role="group" aria-label="Ink colour"></div>' +
        '<span class="sep"></span>' +
        '<label class="field" title="Text size">' +
          '<span class="lbl">Size</span>' +
          '<input class="range sizeRange" type="range" min="' + MIN_FONT_SIZE + '" max="' + MAX_FONT_SIZE + '" step="1" aria-label="Text size">' +
          '<b class="val sizeVal">44px</b>' +
        '</label>' +
        '<label class="field" title="Font">' +
          '<select class="fonts" aria-label="Font"></select>' +
        '</label>' +
        '<label class="field" title="Note background — 0% keeps the overlay fully transparent">' +
          '<span class="lbl">BG</span>' +
          '<input class="range bgRange" type="range" min="0" max="100" step="1" aria-label="Background opacity">' +
          '<b class="val bgVal">0%</b>' +
        '</label>' +
        '<button type="button" class="iconbtn shadowBtn" data-act="shadow" title="Text outline — keeps the ink readable on busy pages">' +
          icon('outline') + '</button>' +
        '<span class="sep"></span>' +
        '<button type="button" class="txtbtn clearBtn" data-act="clear" title="Erase the note text">' +
          icon('trash') + '<span class="txt">Clear</span></button>' +
        '<button type="button" class="iconbtn closeBtn" data-act="hide" title="Hide the overlay (Alt+Shift+H)">' +
          icon('close') + '</button>' +
      '</div>' +
      '<div class="hint">Type to write &nbsp;·&nbsp; <b>Esc</b> switches to View &nbsp;·&nbsp; <b>Alt+Shift+H</b> hides</div>' +
    '</div>';

  const CSS_TEXT = [
    ':host { all: initial; }',
    '*, *::before, *::after { box-sizing: border-box; }',

    '.wrap {',
    // `fixed`, not `absolute`: absolute would anchor to the document origin and
    // leave the overlay behind as soon as the page is scrolled.
    '  position: fixed; inset: 0;',
    "  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;",
    '  font-size: 12.5px; line-height: 1.4; color: #f4f4f5;',
    '  text-align: left; direction: ltr; letter-spacing: normal; word-spacing: normal;',
    '  text-transform: none; white-space: normal; pointer-events: none;',
    '  -webkit-font-smoothing: antialiased;',
    '}',

    /* the transparent note surface */
    '.scrim { position: absolute; inset: 0; background: var(--oi-bg, transparent); pointer-events: none; }',
    '.note {',
    '  position: absolute; inset: 0; width: 100%; height: 100%;',
    '  margin: 0; padding: 8vh 5vw 12vh; border: 0; outline: 0; resize: none;',
    '  background: transparent; color: var(--oi-ink, #ff2d55);',
    '  font-family: var(--oi-font, cursive); font-size: var(--oi-size, 44px);',
    '  font-weight: 400; font-style: normal; line-height: 1.3; letter-spacing: 0.005em;',
    '  text-shadow: var(--oi-shadow, none); caret-color: currentColor;',
    '  white-space: pre-wrap; overflow-wrap: break-word; tab-size: 4;',
    // `overscroll-behavior` is left at its default on purpose: once the note
    // itself cannot scroll any further, the wheel keeps scrolling the page.
    '  overflow: auto; scrollbar-width: thin;',
    '  pointer-events: none; z-index: 1;',
    '}',
    '.wrap[data-mode="edit"] .note { pointer-events: auto; cursor: text; }',
    '.note::placeholder { color: rgba(255,255,255,.42); }',
    '.wrap[data-mode="view"] .note::placeholder { color: transparent; }',

    /* toolbar */
    '.topwrap {',
    '  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);',
    '  display: flex; flex-direction: column; align-items: center; gap: 8px;',
    '  width: max-content; max-width: min(96vw, 1120px); pointer-events: none; z-index: 3;',
    '}',
    '.bar {',
    '  pointer-events: auto;',
    '  display: flex; flex-wrap: wrap; align-items: center; gap: 7px;',
    '  padding: 7px 9px; border-radius: 14px;',
    '  background: rgba(17, 19, 26, .87);',
    '  border: 1px solid rgba(255, 255, 255, .13);',
    '  box-shadow: 0 14px 38px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(255, 255, 255, .07);',
    '  -webkit-backdrop-filter: blur(14px) saturate(160%); backdrop-filter: blur(14px) saturate(160%);',
    '  animation: oi-in .18s ease-out; transition: opacity .18s ease;',
    '}',
    '.wrap[data-mode="view"] .bar { opacity: .6; }',
    '.wrap[data-mode="view"] .bar:hover, .wrap[data-mode="view"] .bar:focus-within { opacity: 1; }',
    '@keyframes oi-in { from { opacity: 0; transform: translateY(-6px) scale(.985); } to { opacity: 1; transform: none; } }',
    '@media (prefers-reduced-motion: reduce) { .bar { animation: none; } }',

    '.seg { display: flex; gap: 3px; padding: 3px; border-radius: 10px; background: rgba(255, 255, 255, .07); }',
    '.segbtn {',
    '  display: inline-flex; align-items: center; gap: 5px;',
    '  padding: 6px 11px; border: 0; border-radius: 8px; cursor: pointer;',
    '  background: transparent; color: #d4d4d8; font: inherit; font-weight: 600;',
    '  transition: background .14s ease, color .14s ease;',
    '}',
    '.segbtn:hover { background: rgba(255, 255, 255, .1); color: #fff; }',
    '.segbtn[aria-pressed="true"] { background: #7c3aed; color: #fff; box-shadow: 0 2px 10px rgba(124, 58, 237, .45); }',
    '.segbtn svg { width: 14px; height: 14px; display: block; }',

    '.sep { width: 1px; align-self: stretch; min-height: 20px; background: rgba(255, 255, 255, .14); }',

    '.swatches { display: flex; align-items: center; gap: 5px; }',
    '.swatch {',
    '  width: 18px; height: 18px; padding: 0; border-radius: 50%; cursor: pointer;',
    '  border: 1px solid rgba(255, 255, 255, .38); background: var(--c, #fff);',
    '  transition: transform .12s ease, box-shadow .12s ease;',
    '}',
    '.swatch:hover { transform: scale(1.16); }',
    '.swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px rgba(17, 19, 26, .95), 0 0 0 3.5px var(--c, #fff); }',
    '.custom {',
    '  position: relative; overflow: hidden; border-style: dashed; border-color: rgba(255, 255, 255, .5);',
    '  background: conic-gradient(from 0deg, #ff2d55, #ff9500, #ffd60a, #34c759, #00c7b7, #0a84ff, #a855f7, #ff2d55);',
    '}',
    '.custom[data-active="true"] { border-style: solid; box-shadow: 0 0 0 2px rgba(17, 19, 26, .95), 0 0 0 3.5px #a1a1aa; }',
    '.custom input { position: absolute; inset: -8px; width: 220%; height: 220%; opacity: 0; border: 0; padding: 0; cursor: pointer; }',

    '.field { display: inline-flex; align-items: center; gap: 6px; color: #d4d4d8; font-weight: 600; }',
    '.field .lbl { opacity: .7; }',
    '.field .val { min-width: 34px; text-align: right; color: #a1a1aa; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }',
    'input[type="range"] { width: 104px; height: 18px; accent-color: #a78bfa; cursor: pointer; background: transparent; }',
    'select.fonts {',
    '  appearance: none; padding: 5px 8px; border-radius: 8px; cursor: pointer;',
    '  border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06);',
    '  color: #e4e4e7; font: inherit; font-weight: 600;',
    '}',
    'select.fonts option { background: #171923; color: #e4e4e7; }',

    '.iconbtn, .txtbtn {',
    '  display: inline-flex; align-items: center; gap: 6px;',
    '  padding: 6px 9px; border-radius: 9px; cursor: pointer; font: inherit; font-weight: 600;',
    '  border: 1px solid rgba(255, 255, 255, .13); background: rgba(255, 255, 255, .05); color: #d4d4d8;',
    '  transition: background .14s ease, color .14s ease, border-color .14s ease;',
    '}',
    '.iconbtn:hover, .txtbtn:hover { background: rgba(255, 255, 255, .13); color: #fff; }',
    '.iconbtn svg, .txtbtn svg { width: 14px; height: 14px; display: block; }',
    '.iconbtn[aria-pressed="false"] { opacity: .5; }',
    '.closeBtn:hover { background: rgba(239, 68, 68, .9); border-color: rgba(239, 68, 68, .9); color: #fff; }',
    '.clearBtn.armed { background: rgba(239, 68, 68, .92); border-color: rgba(239, 68, 68, .92); color: #fff; }',

    '.hint {',
    '  padding: 5px 12px; border-radius: 999px; font-weight: 600; color: #e4e4e7;',
    '  background: rgba(17, 19, 26, .78); border: 1px solid rgba(255, 255, 255, .1);',
    '  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);',
    '  max-width: 92vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
    '  opacity: 1; transition: opacity .45s ease;',
    '}',
    '.hint[data-faded="true"] { opacity: 0; }',
    '.hint b { color: #c4b5fd; font-weight: 700; }',
    '.wrap[data-mode="view"] .hint { display: none; }'
  ].join('\n');

  /* -------------------------------------------------------------- overlay -- */

  function createOverlay() {
    const host = document.createElement('overlay-ink');
    const shadow = host.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = fontFaceCss() + '\n' + CSS_TEXT;
    shadow.appendChild(styleEl);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.dataset.mode = settings.mode;
    wrap.innerHTML = BAR_HTML;

    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    wrap.insertBefore(scrim, wrap.firstChild);

    const note = document.createElement('textarea');
    note.className = 'note';
    note.setAttribute('spellcheck', 'false');
    note.setAttribute('autocapitalize', 'off');
    note.setAttribute('autocorrect', 'off');
    note.setAttribute('autocomplete', 'off');
    note.setAttribute('wrap', 'soft');
    note.setAttribute('aria-label', 'Overlay note');
    note.dataset.gramm = 'false';
    note.dataset.enableGrammarly = 'false';
    note.placeholder = 'Start typing — your note appears here';
    scrim.after(note);
    shadow.appendChild(wrap);

    /* element handles */
    const bar = wrap.querySelector('.bar');
    const segButtons = wrap.querySelectorAll('.segbtn');
    const swatchWrap = wrap.querySelector('.swatches');
    const sizeRange = wrap.querySelector('.sizeRange');
    const sizeVal = wrap.querySelector('.sizeVal');
    const bgRange = wrap.querySelector('.bgRange');
    const bgVal = wrap.querySelector('.bgVal');
    const fontSelect = wrap.querySelector('.fonts');
    const shadowBtn = wrap.querySelector('.shadowBtn');
    const clearBtn = wrap.querySelector('.clearBtn');
    const hint = wrap.querySelector('.hint');

    /* colour swatches */
    const customSwatch = document.createElement('label');
    customSwatch.className = 'swatch custom';
    customSwatch.title = 'Custom colour';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.setAttribute('aria-label', 'Custom ink colour');
    customSwatch.appendChild(colorInput);

    PRESET_COLORS.forEach(function (color) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.dataset.color = color;
      btn.style.setProperty('--c', color);
      btn.title = color;
      btn.setAttribute('aria-pressed', 'false');
      swatchWrap.appendChild(btn);
    });
    swatchWrap.appendChild(customSwatch);

    /* font options */
    C.FONTS.forEach(function (font) {
      const opt = document.createElement('option');
      opt.value = font.id;
      opt.textContent = font.label;
      fontSelect.appendChild(opt);
    });

    let visible = false;
    let lastAppliedMode = null;
    let clearArmed = false;
    let clearTimer = null;
    let hintTimer = null;
    let hintShownOnce = false;

    /* ------------------------------------------------------- style sync -- */

    function applyStyle() {
      wrap.style.setProperty('--oi-ink', settings.color);
      wrap.style.setProperty('--oi-size', settings.fontSize + 'px');
      wrap.style.setProperty('--oi-font', C.fontStack(settings.font));
      wrap.style.setProperty('--oi-bg', 'rgba(16, 18, 27, ' + (settings.bgOpacity / 100).toFixed(2) + ')');
      wrap.style.setProperty('--oi-shadow', settings.textShadow
        ? '0 1px 2px rgba(0,0,0,.62), 0 0 14px rgba(0,0,0,.42)'
        : 'none');

      sizeRange.value = String(settings.fontSize);
      sizeVal.textContent = settings.fontSize + 'px';
      bgRange.value = String(settings.bgOpacity);
      bgVal.textContent = settings.bgOpacity + '%';
      fontSelect.value = settings.font;
      shadowBtn.setAttribute('aria-pressed', String(settings.textShadow));
      colorInput.value = settings.color;

      const isCustom = PRESET_COLORS.indexOf(settings.color) === -1;
      customSwatch.dataset.active = String(isCustom);
      customSwatch.style.setProperty('--c', settings.color);
      swatchWrap.querySelectorAll('.swatch[data-color]').forEach(function (btn) {
        btn.setAttribute('aria-pressed', String(btn.dataset.color === settings.color));
      });
    }

    function syncMode() {
      wrap.dataset.mode = settings.mode;
      segButtons.forEach(function (btn) {
        btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.mode));
      });
    }

    function applySettings() {
      applyStyle();
      if (settings.mode !== lastAppliedMode) {
        lastAppliedMode = settings.mode;
        refreshMode();
      } else {
        syncMode();
      }
    }

    /** Focus rules that depend on the mode; only runs when the mode changes. */
    function refreshMode() {
      syncMode();
      note.placeholder = settings.mode === 'edit' ? 'Start typing — your note appears here' : '';
      if (settings.mode === 'view') {
        try { note.blur(); } catch (err) { /* ignore */ }
      } else if (visible) {
        focusNote();
      }
    }

    /* -------------------------------------------------------- visibility -- */

    function focusNote() {
      try {
        note.focus({ preventScroll: true });
      } catch (err) {
        note.focus();
      }
    }

    function setTextValue(value) {
      if (note.value === value) return;
      note.value = value;
    }

    function showHint() {
      if (hintShownOnce) return;
      hintShownOnce = true;
      hint.dataset.faded = 'false';
      clearTimeout(hintTimer);
      hintTimer = setTimeout(dismissHint, 9000);
    }

    function dismissHint() {
      clearTimeout(hintTimer);
      hint.dataset.faded = 'true';
    }

    function attach() {
      const parent = document.fullscreenElement && !isReplacedElement(document.fullscreenElement)
        ? document.fullscreenElement
        : (document.documentElement || document.body);
      if (parent && host.parentNode !== parent) parent.appendChild(host);
    }

    function show() {
      if (visible) {
        if (settings.mode === 'edit') focusNote();
        return;
      }
      visible = true;
      attach();
      loadText();
      setTextValue(noteText);
      lastAppliedMode = settings.mode;
      applyStyle();
      syncMode();
      note.placeholder = settings.mode === 'edit' ? 'Start typing — your note appears here' : '';
      showHint();

      if (settings.mode === 'edit') {
        const active = document.activeElement;
        if (active && active !== host && active !== note && typeof active.blur === 'function') {
          try { active.blur(); } catch (err) { /* ignore */ }
        }
        focusNote();
      }
      notifyState();
    }

    function hide() {
      if (!visible) return;
      visible = false;
      persistTextNow();
      dismissHint();
      try { note.blur(); } catch (err) { /* ignore */ }
      if (host.parentNode) host.parentNode.removeChild(host);
      notifyState();
    }

    function toggle() {
      if (visible) hide();
      else show();
      return isVisible();
    }

    function isVisible() {
      return visible;
    }

    /* ----------------------------------------------------------- actions -- */

    function disarmClear() {
      clearTimeout(clearTimer);
      clearArmed = false;
      clearBtn.classList.remove('armed');
      clearBtn.querySelector('.txt').textContent = 'Clear';
    }

    function handleClear() {
      if (!clearArmed) {
        clearArmed = true;
        clearBtn.classList.add('armed');
        clearBtn.querySelector('.txt').textContent = 'Sure?';
        clearTimeout(clearTimer);
        clearTimer = setTimeout(disarmClear, 3000);
        return;
      }
      disarmClear();
      noteDirtyByUser = true;
      noteText = '';
      textRevision += 1;
      note.value = '';
      persistTextNow();
      focusNote();
    }

    function refocusNote() {
      if (settings.mode === 'edit' && visible) focusNote();
    }

    /* ------------------------------------------------------------ events -- */

    bar.addEventListener('click', function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const seg = target.closest('.segbtn');
      if (seg) {
        setMode(seg.dataset.mode);
        dismissHint();
        refocusNote();
        return;
      }

      const swatch = target.closest('.swatch[data-color]');
      if (swatch) {
        updateSettings({ color: swatch.dataset.color }, { immediate: true });
        refocusNote();
        return;
      }

      const action = target.closest('[data-act]');
      if (!action) return;
      const act = action.dataset.act;
      if (act === 'hide') {
        hide();
      } else if (act === 'shadow') {
        updateSettings({ textShadow: !settings.textShadow }, { immediate: true });
        refocusNote();
      } else if (act === 'clear') {
        handleClear();
      }
    });

    // Buttons and swatches steal focus: hand it back to the note so typing
    // keeps working. `change` covers the native controls (font, colour picker).
    bar.addEventListener('pointerup', function (event) {
      const target = event.target;
      if (target instanceof Element && target.closest('button, .swatch[data-color]')) refocusNote();
    });
    bar.addEventListener('change', function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target === fontSelect) updateSettings({ font: fontSelect.value }, { immediate: true });
      refocusNote();
    });

    sizeRange.addEventListener('input', function () {
      sizeVal.textContent = sizeRange.value + 'px';
      updateSettings({ fontSize: Number(sizeRange.value) });
    });
    bgRange.addEventListener('input', function () {
      bgVal.textContent = bgRange.value + '%';
      updateSettings({ bgOpacity: Number(bgRange.value) });
    });
    colorInput.addEventListener('input', function () {
      updateSettings({ color: colorInput.value });
    });
    colorInput.addEventListener('change', function () {
      updateSettings({ color: colorInput.value }, { immediate: true });
      refocusNote();
    });

    note.addEventListener('input', function () {
      noteDirtyByUser = true;
      noteText = note.value;
      textRevision += 1;
      persistTextLater();
      dismissHint();
    });

    note.addEventListener('keydown', function (event) {
      if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        insertAtCaret(note, '    ');
        dismissHint();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissHint();
        if (settings.mode === 'edit') setMode('view');
        else {
          try { note.blur(); } catch (err) { /* ignore */ }
        }
      }
    });

    /* If the page enters fullscreen, keep the overlay attached to whatever is
       really on screen. */
    document.addEventListener('fullscreenchange', attach, true);

    return {
      show: show,
      hide: hide,
      toggle: toggle,
      isVisible: isVisible,
      isEditing: function () { return document.activeElement === host || shadow.activeElement === note; },
      setText: setTextValue,
      applySettings: applySettings,
      refreshMode: refreshMode,
      destroy: function () {
        document.removeEventListener('fullscreenchange', attach, true);
        if (host.parentNode) host.parentNode.removeChild(host);
        visible = false;
      }
    };
  }

  function isReplacedElement(el) {
    return el.matches && el.matches('video, img, canvas, iframe, embed, object, audio');
  }

  function fontFaceCss() {
    let url = '';
    try {
      url = chrome.runtime.getURL('fonts/PatrickHand-Regular.woff2');
    } catch (err) {
      url = '';
    }
    if (!url) return '';
    return "@font-face { font-family: '" + C.FONT_FAMILY_NAME + "'; font-style: normal; font-weight: 400; " +
      "font-display: swap; src: url('" + url + "') format('woff2'); }\n";
  }

  function insertAtCaret(el, text) {
    try {
      if (document.execCommand && document.execCommand('insertText', false, text)) return;
    } catch (err) {
      /* fall through to setRangeText */
    }
    const start = el.selectionStart == null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd == null ? start : el.selectionEnd;
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ------------------------------------------------------ instance maker -- */

  function ensureInstance() {
    if (!instance) instance = createOverlay();
    return instance;
  }

  function showOverlay() {
    ensureInstance().show();
    return currentState();
  }

  function hideOverlay() {
    if (instance) instance.hide();
    return currentState();
  }

  function toggleOverlay() {
    ensureInstance().toggle();
    return currentState();
  }

  /* -------------------------------------------------------- tab messages -- */

  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || typeof message.type !== 'string') return;
      switch (message.type) {
        case 'oi:get-state':
          sendResponse(currentState());
          break;
        case 'oi:toggle':
          sendResponse(toggleOverlay());
          break;
        case 'oi:set-visible':
          sendResponse(message.visible ? showOverlay() : hideOverlay());
          break;
        case 'oi:set-mode':
          setMode(message.mode);
          sendResponse(currentState());
          break;
        case 'oi:clear':
          noteDirtyByUser = true;
          setText('', true);
          persistTextNow();
          sendResponse(currentState());
          break;
        case 'oi:set-settings':
          updateSettings(message.settings || {}, { immediate: true });
          sendResponse(currentState());
          break;
        default:
          break;
      }
    });
  } catch (err) {
    console.warn(LOG, 'could not register message listener', err);
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (changes[STORAGE.settings] && !settingsPendingWrite) {
        settingsRevision += 1;
        settings = C.normaliseSettings(changes[STORAGE.settings].newValue);
        if (instance) instance.applySettings();
      }
      if (changes[STORAGE.text]) {
        const next = String(changes[STORAGE.text].newValue || '');
        // Ignore the echo of our own save, follow anything another tab or the
        // popup wrote.
        if (next === noteText || next === lastWrittenText) return;
        noteTextLoaded = true;
        setText(next, true);
      }
    });
  } catch (err) {
    /* ignore */
  }

  /* Alt+Shift+H hides the overlay from anywhere on the page. */
  window.addEventListener('keydown', function (event) {
    if (!event.altKey || !event.shiftKey) return;
    if (String(event.key).toLowerCase() !== 'h') return;
    if (!instance || !instance.isVisible()) return;
    event.preventDefault();
    event.stopPropagation();
    hideOverlay();
  }, true);

  window.addEventListener('pagehide', function () {
    if (textSaveTimer) persistTextNow();
    if (settingsSaveTimer) writeSettings();
  });

  /* ----------------------------------------------------------- public API -- */

  window.__overlayInkToggle = function () {
    return toggleOverlay();
  };
  window.__overlayInkState = function () {
    return currentState();
  };

  loadSettings();

  return Object.assign({ ok: true, installed: true }, currentState());
})();
