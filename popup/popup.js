/**
 * Overlay Ink — popup.
 *
 * A small control panel for the tab you are looking at:
 *   • on/off for this tab (talks to the content script)
 *   • the sticky options (mode, colour, size, font, background) that every
 *     overlay picks up, stored in chrome.storage.local
 */
(function () {
  'use strict';

  const C = window.__overlayInkCommon;
  const $ = function (id) { return document.getElementById(id); };

  const el = {
    onOff: $('onOff'),
    onOffLabel: $('onOffLabel'),
    onOffHint: $('onOffHint'),
    banner: $('banner'),
    modeSeg: $('modeSeg'),
    swatches: $('swatches'),
    size: $('size'),
    sizeVal: $('sizeVal'),
    font: $('font'),
    bg: $('bg'),
    bgVal: $('bgVal'),
    shadow: $('shadow'),
    clear: $('clear'),
    reset: $('reset'),
    shortcuts: $('shortcuts'),
    shortcutNote: $('shortcutNote')
  };

  let settings = Object.assign({}, C.DEFAULT_SETTINGS);
  let tab = null;
  let supported = true;
  let visible = false;
  let saveTimer = null;
  let clearArmed = false;
  let clearTimer = null;
  let colorInput = null;
  let customSwatch = null;

  /* ------------------------------------------------------------- storage -- */

  function readSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(C.STORAGE.settings, function (result) {
          void chrome.runtime.lastError;
          resolve(C.normaliseSettings(result && result[C.STORAGE.settings]));
        });
      } catch (err) {
        resolve(Object.assign({}, C.DEFAULT_SETTINGS));
      }
    });
  }

  function writeSettings(immediate) {
    clearTimeout(saveTimer);
    const commit = function () {
      try {
        chrome.storage.local.set({ [C.STORAGE.settings]: settings }, function () {
          void chrome.runtime.lastError;
        });
      } catch (err) { /* ignore */ }
    };
    if (immediate) commit();
    else saveTimer = setTimeout(commit, 250);
  }

  /* ---------------------------------------------------------- tab comms --- */

  /**
   * The page the panel is about. This file is loaded either as a real action
   * popup or as a free-standing panel window, so ask for the active tab of the
   * last focused *normal* window rather than "the current window".
   */
  function queryActiveTab() {
    return new Promise(function (resolve) {
      const byWindow = function (windowId) {
        const query = windowId === undefined
          ? { active: true, currentWindow: true }
          : { active: true, windowId: windowId };
        try {
          chrome.tabs.query(query, function (tabs) {
            void chrome.runtime.lastError;
            resolve((tabs && tabs[0]) || null);
          });
        } catch (err) {
          resolve(null);
        }
      };

      try {
        chrome.windows.getLastFocused({ windowTypes: ['normal'] }, function (win) {
          if (chrome.runtime.lastError || !win || typeof win.id !== 'number') byWindow(undefined);
          else byWindow(win.id);
        });
      } catch (err) {
        byWindow(undefined);
      }
    });
  }

  function sendToTab(message) {
    return new Promise(function (resolve) {
      if (!tab || typeof tab.id !== 'number') return resolve(null);
      try {
        chrome.tabs.sendMessage(tab.id, message, function (response) {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response || null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function injectOverlay() {
    if (!tab || typeof tab.id !== 'number') return Promise.resolve(false);
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['common.js', 'content/overlay.js']
    }).then(function () { return true; }).catch(function () { return false; });
  }

  /* ------------------------------------------------------------- render --- */

  function buildControls() {
    C.PRESET_COLORS.forEach(function (color) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.dataset.color = color;
      btn.style.setProperty('--c', color);
      btn.title = color;
      btn.setAttribute('aria-pressed', 'false');
      el.swatches.appendChild(btn);
    });

    customSwatch = document.createElement('label');
    customSwatch.className = 'swatch custom';
    customSwatch.title = 'Custom colour';
    colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.setAttribute('aria-label', 'Custom ink colour');
    customSwatch.appendChild(colorInput);
    el.swatches.appendChild(customSwatch);

    C.FONTS.forEach(function (font) {
      const opt = document.createElement('option');
      opt.value = font.id;
      opt.textContent = font.label;
      el.font.appendChild(opt);
    });
  }

  function renderSettings() {
    el.size.value = String(settings.fontSize);
    el.sizeVal.textContent = settings.fontSize + 'px';
    el.bg.value = String(settings.bgOpacity);
    el.bgVal.textContent = settings.bgOpacity + '%';
    el.font.value = settings.font;
    el.shadow.checked = settings.textShadow;

    el.modeSeg.querySelectorAll('button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.mode));
    });
    el.swatches.querySelectorAll('.swatch[data-color]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.color === settings.color));
    });
    customSwatch.dataset.active = String(C.PRESET_COLORS.indexOf(settings.color) === -1);
    customSwatch.style.setProperty('--c', settings.color);
    colorInput.value = settings.color;
  }

  function renderState() {
    el.onOff.checked = visible;
    el.onOff.disabled = !supported;

    if (!supported) {
      el.onOffLabel.textContent = 'Not available here';
      el.onOffHint.textContent = 'Browser pages, the Web Store and PDF viewers block extensions';
      return;
    }
    if (visible) {
      el.onOffLabel.textContent = 'Overlay is on for this tab';
      el.onOffHint.textContent = settings.mode === 'edit'
        ? 'Edit mode — the page waits while you write'
        : 'View mode — the page works normally';
    } else {
      el.onOffLabel.textContent = 'Overlay is off';
      el.onOffHint.textContent = 'Turn it on to write on this page';
    }
  }

  function showBanner(text) {
    el.banner.textContent = text;
    el.banner.hidden = false;
  }

  /* -------------------------------------------------------------- wiring -- */

  function wire() {
    el.onOff.addEventListener('change', async function () {
      const wanted = el.onOff.checked;
      el.onOff.disabled = true;
      const response = await sendToTab({ type: 'oi:set-visible', visible: wanted });
      if (response) {
        visible = Boolean(response.visible);
        if (response.mode) settings.mode = response.mode;
        renderSettings();
      } else {
        showBanner('The page did not answer. Reload it and try again.');
      }
      el.onOff.disabled = !supported;
      renderState();
    });

    el.modeSeg.addEventListener('click', function (event) {
      const btn = event.target.closest('button[data-mode]');
      if (!btn) return;
      settings.mode = btn.dataset.mode;
      writeSettings(true);
      renderSettings();
      renderState();
      sendToTab({ type: 'oi:set-mode', mode: settings.mode });
    });

    el.swatches.addEventListener('click', function (event) {
      const btn = event.target.closest('.swatch[data-color]');
      if (!btn) return;
      settings.color = btn.dataset.color;
      writeSettings(true);
      renderSettings();
    });

    colorInput.addEventListener('input', function () {
      settings.color = C.isHexColor(colorInput.value) ? C.expandHex(colorInput.value) : settings.color;
      renderSettings();
      writeSettings(false);
    });
    colorInput.addEventListener('change', function () {
      settings.color = C.isHexColor(colorInput.value) ? C.expandHex(colorInput.value) : settings.color;
      writeSettings(true);
      renderSettings();
    });

    el.size.addEventListener('input', function () {
      settings.fontSize = C.clamp(Number(el.size.value), C.MIN_FONT_SIZE, C.MAX_FONT_SIZE);
      el.sizeVal.textContent = settings.fontSize + 'px';
      writeSettings(false);
    });
    el.size.addEventListener('change', function () {
      writeSettings(true);
    });

    el.bg.addEventListener('input', function () {
      settings.bgOpacity = C.clamp(Number(el.bg.value), 0, 100);
      el.bgVal.textContent = settings.bgOpacity + '%';
      writeSettings(false);
    });
    el.bg.addEventListener('change', function () {
      writeSettings(true);
    });

    el.font.addEventListener('change', function () {
      settings.font = el.font.value;
      writeSettings(true);
    });

    el.shadow.addEventListener('change', function () {
      settings.textShadow = el.shadow.checked;
      writeSettings(true);
    });

    el.clear.addEventListener('click', function () {
      if (!clearArmed) {
        clearArmed = true;
        el.clear.classList.add('armed');
        el.clear.textContent = 'Click again to erase';
        clearTimeout(clearTimer);
        clearTimer = setTimeout(function () {
          clearArmed = false;
          el.clear.classList.remove('armed');
          el.clear.textContent = 'Clear note text';
        }, 3000);
        return;
      }
      clearTimeout(clearTimer);
      clearArmed = false;
      el.clear.classList.remove('armed');
      el.clear.textContent = 'Clear note text';
      try {
        chrome.storage.local.set({ [C.STORAGE.text]: '' }, function () { void chrome.runtime.lastError; });
      } catch (err) { /* ignore */ }
      sendToTab({ type: 'oi:clear' });
    });

    el.reset.addEventListener('click', function () {
      settings = Object.assign({}, C.DEFAULT_SETTINGS);
      writeSettings(true);
      renderSettings();
      renderState();
      sendToTab({ type: 'oi:set-settings', settings: settings });
    });

    el.shortcuts.addEventListener('click', function () {
      try {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }, function () {
          if (chrome.runtime.lastError) el.shortcutNote.hidden = false;
        });
      } catch (err) {
        el.shortcutNote.hidden = false;
      }
    });
  }

  /* ---------------------------------------------------------------- boot -- */

  async function init() {
    buildControls();
    settings = await readSettings();
    renderSettings();
    wire();
    renderState();

    tab = await queryActiveTab();
    const url = tab && typeof tab.url === 'string' ? tab.url : '';

    if (url && (!C.isSupportedUrl(url) || C.isBlockedUrl(url))) {
      supported = false;
      showBanner('This page cannot host the overlay. Open a normal website (http/https) and try again.');
      renderState();
      return;
    }

    // Without the "tabs" permission the URL is unknown on purpose — the page
    // itself will tell us whether the overlay can run there.
    let state = await sendToTab({ type: 'oi:get-state' });
    if (!state) {
      // Page loaded before the extension did — install the content script now.
      const injected = await injectOverlay();
      if (!injected) {
        supported = false;
        showBanner('This page blocks extensions (PDF viewers and the Web Store do). Try a normal website.');
        renderState();
        return;
      }
      state = await sendToTab({ type: 'oi:get-state' });
    }
    if (state) {
      visible = Boolean(state.visible);
      if (state.mode) settings.mode = state.mode;
      renderSettings();
    }
    renderState();
    followPage();
  }

  /** Keep the panel in step with what happens inside the page. */
  function followPage() {
    setInterval(async function () {
      if (document.hidden) return;
      const state = await sendToTab({ type: 'oi:get-state' });
      if (!state) return;
      if (state.visible === visible && state.mode === settings.mode) return;
      visible = Boolean(state.visible);
      settings.mode = state.mode || settings.mode;
      renderSettings();
      renderState();
    }, 1200);
  }

  init().catch(function (err) {
    console.warn('[Overlay Ink] popup failed to initialise', err);
  });
})();
