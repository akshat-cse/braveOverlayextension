/**
 * Overlay Ink — the standard toolbar action popup.
 *
 * All page controls live here. Closing it never hides the canvas. Style changes
 * are sent immediately to the content script (not debounced in this ephemeral
 * window), so even clicking outside right after a change cannot lose it.
 */
(function () {
  'use strict';

  const C = window.__overlayInkCommon;
  const $ = function (id) { return document.getElementById(id); };
  const el = {
    onOff: $('onOff'), onOffLabel: $('onOffLabel'), onOffHint: $('onOffHint'),
    controls: $('controls'), banner: $('banner'), modeSeg: $('modeSeg'),
    styleTarget: $('styleTarget'), newNotes: $('newNotes'), swatches: $('swatches'),
    hex: $('hexColor'), size: $('size'), sizeVal: $('sizeVal'), font: $('font'),
    bg: $('bg'), bgVal: $('bgVal'), shadow: $('shadow'), clear: $('clear'),
    reset: $('reset'), done: $('done'), close: $('close'), options: $('options'),
    usageHint: $('usageHint')
  };

  let settings = Object.assign({}, C.DEFAULT_SETTINGS);
  let page = { visible: false, mode: settings.mode, blocks: 0, selected: null };
  let tab = null;
  let ready = false;
  let disposed = false;
  window.addEventListener('pagehide', function () { disposed = true; });
  let unavailable = '';
  let commandRevision = 0;
  let toggling = false;
  let clearArmed = false;
  let clearTimer = null;
  let colorInput;
  let customSwatch;
  const inFlight = new Set();

  function readSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(C.STORAGE.settings, function (result) {
          void chrome.runtime.lastError;
          resolve(C.normaliseSettings(result && result[C.STORAGE.settings]));
        });
      } catch (err) { resolve(Object.assign({}, C.DEFAULT_SETTINGS)); }
    });
  }

  function queryActiveTab() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          void chrome.runtime.lastError;
          resolve((tabs && tabs[0]) || null);
        });
      } catch (err) { resolve(null); }
    });
  }

  function sendToTab(message) {
    return new Promise(function (resolve) {
      if (!tab || typeof tab.id !== 'number') return resolve(null);
      try {
        chrome.tabs.sendMessage(tab.id, message, function (response) {
          resolve(chrome.runtime.lastError ? null : (response || null));
        });
      } catch (err) { resolve(null); }
    });
  }

  async function injectOverlay() {
    try {
      if (!tab || typeof tab.id !== 'number') return false;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: ['common.js', 'content/overlay.js']
      });
      return true;
    } catch (err) { return false; }
  }

  function showBanner(text) {
    el.banner.textContent = text;
    el.banner.hidden = false;
  }

  function adopt(state) {
    page = state;
    settings = C.normaliseSettings(state.settings || settings);
    settings.mode = state.mode === 'view' ? 'view' : 'edit';
    render();
  }

  /** Dispatch now, not after a timer or after the previous command's callback. */
  function request(message) {
    if (!ready) return Promise.resolve(null);
    const revision = ++commandRevision;
    const pending = sendToTab(message);
    inFlight.add(pending);
    return pending.then(function (state) {
      inFlight.delete(pending);
      if (disposed || !window.document || revision !== commandRevision) return state;
      if (state) {
        el.banner.hidden = true;
        adopt(state);
      } else {
        showBanner('The page did not answer. Reload it, then reopen this popup.');
      }
      return state;
    });
  }

  function inkStyle() { return page.selected || settings; }

  function setInk(patch) {
    const blockId = page.selected ? page.selected.id : null;
    if (page.selected) page.selected = Object.assign({}, page.selected, patch);
    else settings = C.normaliseSettings(Object.assign({}, settings, patch));
    render();
    return request({ type: 'oi:set-ink', ink: patch, blockId: blockId });
  }

  function setSettings(patch) {
    settings = C.normaliseSettings(Object.assign({}, settings, patch));
    render();
    return request({ type: 'oi:set-settings', settings: patch });
  }

  function parseHex(value) {
    const text = value.trim();
    const hex = text.startsWith('#') ? text : '#' + text;
    return C.isHexColor(hex) ? C.expandHex(hex) : null;
  }

  function buildControls() {
    C.PRESET_COLORS.forEach(function (color) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'swatch'; btn.dataset.color = color;
      btn.style.setProperty('--c', color);
      btn.title = color; btn.setAttribute('aria-label', 'Ink colour ' + color);
      btn.setAttribute('aria-pressed', 'false');
      el.swatches.appendChild(btn);
    });
    customSwatch = document.createElement('label');
    customSwatch.className = 'swatch custom'; customSwatch.title = 'Choose any colour';
    colorInput = document.createElement('input');
    colorInput.type = 'color'; colorInput.setAttribute('aria-label', 'Custom ink colour');
    customSwatch.appendChild(colorInput); el.swatches.appendChild(customSwatch);
    C.FONTS.forEach(function (font) {
      const opt = document.createElement('option');
      opt.value = font.id; opt.textContent = font.label; el.font.appendChild(opt);
    });
  }

  function render() {
    if (disposed || !window.document) return;
    const ink = inkStyle();
    const focused = document.activeElement;
    el.onOff.checked = Boolean(page.visible);
    el.onOff.disabled = !ready || toggling;
    el.controls.disabled = !ready;

    if (unavailable) {
      el.onOffLabel.textContent = unavailable;
      el.onOffHint.textContent = 'Try a normal website, or reload this page';
    } else if (!ready) {
      el.onOffLabel.textContent = 'Connecting to this page…';
    } else {
      el.onOffLabel.textContent = page.visible ? 'Overlay is on' : 'Overlay is off';
      el.onOffHint.textContent = !page.visible ? 'Turn it on, then close this popup' :
        settings.mode === 'edit' ? 'Edit · click anywhere on the page to write' :
        'View · the page works normally';
    }

    el.modeSeg.querySelectorAll('button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.mode));
    });
    el.styleTarget.textContent = page.selected ? 'Editing selected note' : 'Style for new notes';
    el.newNotes.hidden = !page.selected;
    el.swatches.querySelectorAll('[data-color]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.color === ink.color));
    });
    customSwatch.dataset.active = String(C.PRESET_COLORS.indexOf(ink.color) === -1);
    colorInput.value = ink.color;
    if (focused !== el.hex) {
      el.hex.value = ink.color;
      el.hex.setAttribute('aria-invalid', 'false');
    }
    if (focused !== el.size) el.size.value = String(ink.fontSize);
    el.sizeVal.textContent = (focused === el.size ? el.size.value : ink.fontSize) + 'px';
    if (focused !== el.font) el.font.value = ink.font;
    if (focused !== el.bg) el.bg.value = String(settings.bgOpacity);
    el.bgVal.textContent = (focused === el.bg ? el.bg.value : settings.bgOpacity) + '%';
    el.shadow.checked = settings.textShadow;
    el.clear.disabled = !ready || (!page.blocks && !clearArmed);
    el.done.textContent = !page.visible ? 'Close popup' :
      settings.mode === 'edit' ? 'Done · write on page' : 'Done · back to page';
    el.usageHint.textContent = page.selected
      ? 'Styles change the selected note. “New notes instead” sets defaults. Close the popup to keep writing.'
      : 'Close the popup, then click anywhere to write. Reopen the icon for controls or View mode.';
  }

  function disarmClear() {
    clearTimeout(clearTimer); clearArmed = false;
    el.clear.classList.remove('armed'); el.clear.textContent = 'Clear all notes';
    render();
  }

  async function closePopup() {
    await Promise.all(Array.from(inFlight));
    if (disposed || !window.document) return;
    if (ready && page.visible && settings.mode === 'edit') {
      await request({ type: 'oi:resume-edit' });
    }
    if (!disposed && window.document) window.close();
  }

  function wire() {
    el.onOff.addEventListener('change', async function () {
      const wanted = el.onOff.checked;
      toggling = true; render();
      await request({ type: 'oi:set-visible', visible: wanted });
      toggling = false; render();
    });
    el.modeSeg.addEventListener('click', function (event) {
      const btn = event.target.closest('button[data-mode]');
      if (!btn || !ready) return;
      settings.mode = btn.dataset.mode;
      page.mode = settings.mode;
      if (settings.mode === 'view') page.selected = null;
      render();
      request({ type: 'oi:set-mode', mode: settings.mode });
    });
    el.newNotes.addEventListener('click', function () {
      page.selected = null; render();
      request({ type: 'oi:deselect' });
    });
    el.swatches.addEventListener('click', function (event) {
      const btn = event.target.closest('[data-color]');
      if (btn && ready) setInk({ color: btn.dataset.color });
    });
    colorInput.addEventListener('input', function () { setInk({ color: colorInput.value }); });
    colorInput.addEventListener('change', function () { setInk({ color: colorInput.value }); });
    function commitHex() {
      const color = parseHex(el.hex.value);
      el.hex.setAttribute('aria-invalid', String(!color));
      if (color) setInk({ color: color });
    }
    el.hex.addEventListener('input', commitHex);
    el.hex.addEventListener('change', commitHex);
    el.hex.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commitHex(); el.hex.blur(); render(); }
    });
    el.size.addEventListener('input', function () { setInk({ fontSize: Number(el.size.value) }); });
    el.size.addEventListener('change', function () { setInk({ fontSize: Number(el.size.value) }); });
    el.font.addEventListener('change', function () { setInk({ font: el.font.value }); });
    el.bg.addEventListener('input', function () { setSettings({ bgOpacity: Number(el.bg.value) }); });
    el.bg.addEventListener('change', function () { setSettings({ bgOpacity: Number(el.bg.value) }); });
    el.shadow.addEventListener('change', function () { setSettings({ textShadow: el.shadow.checked }); });
    el.clear.addEventListener('click', function () {
      if (!clearArmed) {
        clearArmed = true; el.clear.classList.add('armed');
        el.clear.textContent = 'Erase every note?';
        clearTimer = setTimeout(disarmClear, 3000);
        return;
      }
      disarmClear(); request({ type: 'oi:clear' });
    });
    el.reset.addEventListener('click', function () {
      settings = Object.assign({}, C.DEFAULT_SETTINGS);
      page.mode = settings.mode;
      render(); request({ type: 'oi:set-settings', settings: settings });
    });
    el.done.addEventListener('click', closePopup);
    el.close.addEventListener('click', closePopup);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.preventDefault(); closePopup();
    });
    el.options.addEventListener('click', function () {
      try {
        chrome.runtime.openOptionsPage(function () {
          if (chrome.runtime.lastError) showBanner('Open Overlay Ink’s options from brave://extensions.');
          else closePopup();
        });
      } catch (err) { showBanner('Open Overlay Ink’s options from brave://extensions.'); }
    });
  }

  async function init() {
    buildControls(); wire(); render();
    const initial = await Promise.all([readSettings(), queryActiveTab()]);
    if (disposed || !window.document) return;
    settings = initial[0]; tab = initial[1];
    const url = tab && typeof tab.url === 'string' ? tab.url : '';
    if (!tab || (url && (!C.isSupportedUrl(url) || C.isBlockedUrl(url)))) {
      unavailable = 'Not available here';
      showBanner('Browser pages, the Web Store and PDF viewers cannot host the overlay. Open a normal website.');
      render(); return;
    }
    let state = await sendToTab({ type: 'oi:get-state' });
    if (!state && await injectOverlay()) state = await sendToTab({ type: 'oi:get-state' });
    if (disposed || !window.document) return;
    if (!state) {
      unavailable = 'Not available here';
      showBanner('This page blocks extensions. Try a normal website, or reload the page.');
      render(); return;
    }
    if (state.controlsVersion !== 3) {
      unavailable = 'Page needs a reload';
      showBanner('Overlay Ink was updated. Reload this page once to use the new popup controls.');
      render(); return;
    }
    ready = true; adopt(state);
    document.body.dataset.ready = 'true';
    chrome.runtime.onMessage.addListener(function (message, sender) {
      if (!message || message.type !== 'oi:state' || !sender.tab || sender.tab.id !== tab.id) return;
      if (!inFlight.size) adopt(message);
    });
  }

  init().catch(function (err) {
    console.warn('[Overlay Ink] popup failed to initialise', err);
    unavailable = 'Could not connect';
    showBanner('Reload the page and reopen Overlay Ink to try again.'); render();
  });
})();
