/**
 * Overlay Ink — options page.
 *
 * Edits the same `oiSettings` blob the popup and the content script use, so a
 * change here reaches any open overlay immediately (chrome.storage.onChanged).
 */
(function () {
  'use strict';

  const C = window.__overlayInkCommon;
  const $ = function (id) { return document.getElementById(id); };

  const el = {
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
  let saveTimer = null;
  let clearArmed = false;
  let clearTimer = null;
  let colorInput = null;
  let customSwatch = null;

  function save(immediate) {
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

  function build() {
    C.PRESET_COLORS.forEach(function (color) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.dataset.color = color;
      btn.style.setProperty('--c', color);
      btn.title = color;
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

  function render() {
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

  function wire() {
    el.modeSeg.addEventListener('click', function (event) {
      const btn = event.target.closest('button[data-mode]');
      if (!btn) return;
      settings.mode = btn.dataset.mode;
      save(true);
      render();
    });

    el.swatches.addEventListener('click', function (event) {
      const btn = event.target.closest('.swatch[data-color]');
      if (!btn) return;
      settings.color = btn.dataset.color;
      save(true);
      render();
    });

    colorInput.addEventListener('input', function () {
      if (C.isHexColor(colorInput.value)) settings.color = C.expandHex(colorInput.value);
      render();
      save(false);
    });
    colorInput.addEventListener('change', function () {
      if (C.isHexColor(colorInput.value)) settings.color = C.expandHex(colorInput.value);
      save(true);
      render();
    });

    el.size.addEventListener('input', function () {
      settings.fontSize = C.clamp(Number(el.size.value), C.MIN_FONT_SIZE, C.MAX_FONT_SIZE);
      el.sizeVal.textContent = settings.fontSize + 'px';
      save(false);
    });
    el.size.addEventListener('change', function () { save(true); });

    el.bg.addEventListener('input', function () {
      settings.bgOpacity = C.clamp(Number(el.bg.value), 0, 100);
      el.bgVal.textContent = settings.bgOpacity + '%';
      save(false);
    });
    el.bg.addEventListener('change', function () { save(true); });

    el.font.addEventListener('change', function () {
      settings.font = el.font.value;
      save(true);
    });

    el.shadow.addEventListener('change', function () {
      settings.textShadow = el.shadow.checked;
      save(true);
    });

    el.clear.addEventListener('click', function () {
      if (!clearArmed) {
        clearArmed = true;
        el.clear.classList.add('armed');
        el.clear.textContent = 'Click again to erase every note';
        clearTimeout(clearTimer);
        clearTimer = setTimeout(function () {
          clearArmed = false;
          el.clear.classList.remove('armed');
          el.clear.textContent = 'Clear all notes on every page';
        }, 4000);
        return;
      }
      clearTimeout(clearTimer);
      clearArmed = false;
      el.clear.classList.remove('armed');
      el.clear.textContent = 'Clear all notes on every page';
      try {
        chrome.storage.local.set({ [C.STORAGE.blocks]: { version: C.BLOCKS_VERSION, blocks: [] }, [C.STORAGE.legacyText]: '' }, function () { void chrome.runtime.lastError; });
      } catch (err) { /* ignore */ }
    });

    el.reset.addEventListener('click', function () {
      settings = Object.assign({}, C.DEFAULT_SETTINGS);
      save(true);
      render();
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

  function init() {
    build();
    try {
      chrome.storage.local.get(C.STORAGE.settings, function (result) {
        void chrome.runtime.lastError;
        settings = C.normaliseSettings(result && result[C.STORAGE.settings]);
        render();
      });
    } catch (err) {
      render();
    }
    render();
    wire();
  }

  init();
})();
