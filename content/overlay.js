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
 * The overlay is a canvas: click anywhere and a caret appears exactly there, so
 * writing is placed where you put it instead of flowing from the top of the
 * page. Every piece of writing is a "block" — its own little text box with its
 * own colour, size and font, movable by dragging its grip. Nothing is drawn
 * except the glyphs (and the small toolbar), so the page stays fully visible.
 *
 * Public API on the page (used by the background worker):
 *   window.__overlayInkToggle()   → toggle, returns the new state
 *   window.__overlayInkState()    → { visible, mode, blocks }
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
  const EDGE_MARGIN = 24;  // keep blocks this far from the right/bottom edge
  const TOP_MARGIN = 66;   // and below the toolbar when placed programmatically

  /* --------------------------------------------------------------- state -- */

  // Defaults for new writing. Global: shared by every tab through storage.
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let blocks = [];          // { id, x, y, text, color, fontSize, font, el?, ink? }
  let selectedId = null;    // the block the toolbar acts on
  let instance = null;
  let lastNotified = null;

  let blocksLoaded = false;
  let blocksDirty = false;
  let lastWrittenBlocks = null;
  let blocksSaveTimer = null;
  let settingsSaveTimer = null;

  // Storage reads resolve asynchronously, so a read that started before the
  // user (or another tab / the popup) changed something must never win.
  let settingsRevision = 0;
  let blocksRevision = 0;
  // True between "the user changed something" and "that change reached
  // storage", so the echo of our own write cannot bounce back over it.
  let settingsPendingWrite = false;
  let blocksPendingWrite = false;

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

  function viewport() {
    return {
      w: Math.max(320, window.innerWidth || 1024),
      h: Math.max(240, window.innerHeight || 768)
    };
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
      mode: settings.mode,
      blocks: blocks.length
    };
  }

  function findBlock(id) {
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].id === id) return blocks[i];
    }
    return null;
  }

  /* ------------------------------------------------------ settings (new) -- */

  function writeSettings() {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    writeStorage('local', { [STORAGE.settings]: settings }, function () {
      settingsPendingWrite = false;
    });
  }

  function persistSettings() {
    settingsPendingWrite = true;
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = timeout(writeSettings, 250);
  }

  /** Merge a patch into the defaults for new writing. */
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

  /* --------------------------------------------------------- blocks (io) -- */

  function writeBlocks() {
    clearTimeout(blocksSaveTimer);
    blocksSaveTimer = null;
    const payload = C.blocksForStorage(blocks);
    lastWrittenBlocks = payload;
    writeStorage('local', { [STORAGE.blocks]: payload }, function () {
      blocksPendingWrite = false;
    });
  }

  function persistBlocks(options) {
    blocksDirty = true;
    blocksPendingWrite = true;
    clearTimeout(blocksSaveTimer);
    if (options && options.immediate) writeBlocks();
    else blocksSaveTimer = timeout(writeBlocks, 300);
  }

  function loadSettings() {
    const revision = settingsRevision;
    readStorage('local', STORAGE.settings).then(function (raw) {
      if (revision !== settingsRevision) return; // something newer already landed
      settings = C.normaliseSettings(raw);
      if (instance) instance.applySettings();
    });
  }

  /**
   * Load the canvas. Until 0.2 the note was a single blob of text; if that is
   * all we find, it becomes one block so nothing is lost on upgrade.
   */
  function loadBlocks() {
    if (blocksLoaded) return;
    blocksLoaded = true;
    const revision = blocksRevision;
    readStorage('local', STORAGE.blocks).then(function (raw) {
      if (blocksDirty || revision !== blocksRevision) return; // the user got there first
      const stored = C.normaliseBlocks(raw, null);
      if (stored.length) {
        blocks = stored;
        if (instance) instance.renderBlocks();
        return;
      }
      readStorage('local', STORAGE.legacyText).then(function (legacy) {
        if (blocksDirty || revision !== blocksRevision) return;
        if (typeof legacy !== 'string' || !legacy.trim()) return;
        blocks = [C.normaliseBlock({ text: legacy, x: 0.06, y: 0.16 }, null)];
        if (instance) instance.renderBlocks();
        persistBlocks({ immediate: true });
        writeStorage('local', { [STORAGE.legacyText]: '' });
      });
    });
  }

  function clearEverything() {
    blocksDirty = true;
    blocksRevision += 1;
    blocks = [];
    selectedId = null;
    if (instance) {
      instance.renderBlocks();
      instance.syncToolbar();
    }
    persistBlocks({ immediate: true });
    writeStorage('local', { [STORAGE.legacyText]: '' });
  }

  /* ------------------------------------------------------------- picture -- */

  const ICONS = {
    pencil: '<path d="M11.4 2.6l2 2-8 8-2.7.7.7-2.7 8-8z"/><path d="M9.9 4.1l2 2"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>',
    trash: '<path d="M3 4.6h10M6.3 4.6V3.1h3.4v1.5M4.7 4.6l.6 8.3h5.4l.6-8.3"/>',
    close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    outline: '<path d="M2.6 13.3L8 3l5.4 10.3M4.7 10h6.6"/>',
    grip: '<circle cx="5.5" cy="5" r="1.15"/><circle cx="10.5" cy="5" r="1.15"/><circle cx="5.5" cy="8" r="1.15"/><circle cx="10.5" cy="8" r="1.15"/><circle cx="5.5" cy="11" r="1.15"/><circle cx="10.5" cy="11" r="1.15"/>'
  };

  function icon(name) {
    const filled = name === 'grip';
    return '<svg viewBox="0 0 16 16" fill="' + (filled ? 'currentColor' : 'none') + '" ' +
      (filled ? '' : 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ') +
      'aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  const BAR_HTML =
    '<div class="topwrap">' +
      '<div class="bar" role="toolbar" aria-label="Overlay Ink">' +
        '<div class="seg" role="group" aria-label="Mode">' +
          '<button type="button" class="segbtn" data-mode="edit" title="Edit — the page pauses while you write">' +
            icon('pencil') + '<span>Edit</span></button>' +
          '<button type="button" class="segbtn" data-mode="view" title="View — the text stays, the page works normally">' +
            icon('eye') + '<span>View</span></button>' +
        '</div>' +
        '<span class="sep"></span>' +
        '<div class="swatches" role="group" aria-label="Ink colour"></div>' +
        '<input class="hexInput" type="text" spellcheck="false" maxlength="7" aria-label="Ink colour hex code" title="Type a hex colour, e.g. #ff8800">' +
        '<span class="sep"></span>' +
        '<label class="field" title="Text size">' +
          '<span class="lbl">Size</span>' +
          '<input class="range sizeRange" type="range" min="' + MIN_FONT_SIZE + '" max="' + MAX_FONT_SIZE + '" step="1" aria-label="Text size">' +
          '<b class="val sizeVal">44px</b>' +
        '</label>' +
        '<label class="field" title="Font">' +
          '<select class="fonts" aria-label="Font"></select>' +
        '</label>' +
        '<label class="field" title="Panel behind the whole overlay — 0% keeps it fully transparent">' +
          '<span class="lbl">BG</span>' +
          '<input class="range bgRange" type="range" min="0" max="100" step="1" aria-label="Background opacity">' +
          '<b class="val bgVal">0%</b>' +
        '</label>' +
        '<button type="button" class="iconbtn shadowBtn" data-act="shadow" title="Text outline — keeps the ink readable on busy pages">' +
          icon('outline') + '</button>' +
        '<span class="sep"></span>' +
        '<button type="button" class="txtbtn clearBtn" data-act="clear" title="Erase everything on the canvas">' +
          icon('trash') + '<span class="txt">Clear</span></button>' +
        '<button type="button" class="iconbtn closeBtn" data-act="hide" title="Hide the overlay (Alt+Shift+H)">' +
          icon('close') + '</button>' +
      '</div>' +
      '<div class="hint">Click anywhere and type &nbsp;·&nbsp; drag <b>⠿</b> to move a note &nbsp;·&nbsp; <b>Esc</b> switches to View</div>' +
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

    /* layers: background panel → click surface → text blocks → toolbar */
    '.scrim { position: absolute; inset: 0; background: var(--oi-bg, transparent); pointer-events: none; z-index: 0; }',
    '.canvas { position: absolute; inset: 0; pointer-events: none; z-index: 1; }',
    '.wrap[data-mode="edit"] .canvas { pointer-events: auto; cursor: text; }',
    '.blocks { position: absolute; inset: 0; pointer-events: none; z-index: 2; }',

    /* one piece of writing */
    '.blk { position: absolute; max-width: 96vw; pointer-events: auto; }',
    '.wrap[data-mode="view"] .blk { pointer-events: none; }',
    '.blk .ink {',
    '  display: block; min-width: 16px; min-height: 1.34em; outline: 0;',
    '  color: var(--c, #ff2d55); font-family: var(--ff, cursive); font-size: var(--sz, 44px);',
    '  font-weight: 400; font-style: normal; line-height: 1.34; letter-spacing: 0.005em;',
    '  text-shadow: var(--sh, none); caret-color: var(--c, #ff2d55);',
    '  white-space: pre-wrap; overflow-wrap: break-word; tab-size: 4;',
    '  max-height: 78vh; overflow: auto; scrollbar-width: thin;',
    '}',
    '.blk[data-selected="true"] .ink { outline: 1px dashed rgba(255, 255, 255, .4); outline-offset: 5px; border-radius: 2px; }',
    '.wrap[data-mode="view"] .blk[data-selected="true"] .ink { outline: 0; }',

    /* move + delete handles */
    '.tools {',
    '  position: absolute; top: -21px; left: -3px; display: flex; gap: 3px;',
    '  opacity: 0; pointer-events: none; transition: opacity .12s ease; z-index: 3;',
    '}',
    '.blk:hover .tools, .blk[data-selected="true"] .tools, .blk:focus-within .tools { opacity: 1; pointer-events: auto; }',
    '.wrap[data-mode="view"] .tools { display: none; }',
    '.tools button {',
    '  width: 19px; height: 19px; padding: 0; display: grid; place-items: center;',
    '  border: 0; border-radius: 5px; cursor: pointer; color: #d4d4d8;',
    '  background: rgba(17, 19, 26, .92); box-shadow: 0 2px 8px rgba(0, 0, 0, .45);',
    '}',
    '.tools button:hover { background: #7c3aed; color: #fff; }',
    '.tools .grip { cursor: grab; }',
    '.tools .grip:active { cursor: grabbing; }',
    '.tools .del:hover { background: #dc2626; }',
    '.tools svg { width: 11px; height: 11px; display: block; }',
    '.blk.dragging { opacity: .85; }',

    /* toolbar */
    '.topwrap {',
    '  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);',
    '  display: flex; flex-direction: column; align-items: center; gap: 8px;',
    '  width: max-content; max-width: min(96vw, 1180px); pointer-events: none; z-index: 4;',
    '}',
    '.bar {',
    '  pointer-events: auto;',
    '  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 7px;',
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
    '.hexInput {',
    '  width: 76px; padding: 5px 7px; border-radius: 8px; text-align: center;',
    '  border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06);',
    '  color: #e4e4e7; font: 600 11px/1.3 ui-monospace, Menlo, Consolas, monospace;',
    '  text-transform: lowercase;',
    '}',
    '.hexInput:focus { outline: 1px solid #a78bfa; }',

    '.field { display: inline-flex; align-items: center; gap: 6px; color: #d4d4d8; font-weight: 600; }',
    '.field .lbl { opacity: .7; }',
    '.field .val { min-width: 34px; text-align: right; color: #a1a1aa; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }',
    'input[type="range"] { width: 96px; height: 18px; accent-color: #a78bfa; cursor: pointer; background: transparent; }',
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
    const canvas = document.createElement('div');
    canvas.className = 'canvas';
    const blockLayer = document.createElement('div');
    blockLayer.className = 'blocks';
    wrap.insertBefore(canvas, wrap.firstChild);
    wrap.insertBefore(scrim, canvas);
    wrap.insertBefore(blockLayer, wrap.querySelector('.topwrap'));
    shadow.appendChild(wrap);

    /* element handles */
    const bar = wrap.querySelector('.bar');
    const segButtons = wrap.querySelectorAll('.segbtn');
    const swatchWrap = wrap.querySelector('.swatches');
    const hexInput = wrap.querySelector('.hexInput');
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

    /* --------------------------------------------------------- geometry -- */

    function placeElement(block) {
      if (!block.el) return;
      const { w, h } = viewport();
      const maxLeft = Math.max(0, w - EDGE_MARGIN * 2);
      const maxTop = Math.max(0, h - EDGE_MARGIN * 3);
      block.el.style.left = Math.round(C.clamp(block.x * w, 0, maxLeft)) + 'px';
      block.el.style.top = Math.round(C.clamp(block.y * h, 0, maxTop)) + 'px';
    }

    function layoutBlocks() {
      blocks.forEach(placeElement);
    }

    /* ---------------------------------------------------------- blocks -- */

    function blockText(ink) {
      let out = '';
      const walk = function (node) {
        const children = node.childNodes;
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          if (child.nodeType === 3) {          // text
            out += child.nodeValue;
            continue;
          }
          if (child.nodeType !== 1) continue;  // elements only
          const tag = child.nodeName.toLowerCase();
          if (tag === 'br') {
            out += '\n';
            continue;
          }
          const isBlockLevel = /^(div|p|li|h[1-6]|blockquote|pre|section|article|ul|ol|table|tr)$/.test(tag);
          if (isBlockLevel && out && out.charAt(out.length - 1) !== '\n') out += '\n';
          walk(child);
          if (isBlockLevel && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        }
      };
      walk(ink);
      return out.replace(/\u00a0/g, ' ').replace(/\u200b/g, '').replace(/\n+$/, '');
    }

    function normaliseInk(ink) {
      const text = blockText(ink);
      if (ink.textContent !== text) ink.textContent = text;
    }

    function selection() {
      try {
        if (shadow.getSelection) return shadow.getSelection();
      } catch (err) { /* not supported */ }
      try { return document.getSelection(); } catch (err) { return null; }
    }

    function placeCaretAtEnd(el) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = selection();
        if (!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (err) { /* ignore */ }
    }

    function insertTextAtCaret(el, text) {
      el.focus();
      try {
        if (document.execCommand && document.execCommand('insertText', false, text)) return;
      } catch (err) { /* fall through */ }
      el.textContent = blockText(el) + text;
      placeCaretAtEnd(el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function buildBlockElement(block) {
      const el = document.createElement('div');
      el.className = 'blk';
      el.dataset.id = block.id;

      const ink = document.createElement('div');
      ink.className = 'ink';
      ink.setAttribute('contenteditable', 'true');
      ink.setAttribute('spellcheck', 'false');
      ink.setAttribute('autocapitalize', 'off');
      ink.setAttribute('autocorrect', 'off');
      ink.setAttribute('aria-label', 'Overlay note');
      ink.dataset.gramm = 'false';
      ink.dataset.enableGrammarly = 'false';
      ink.textContent = block.text;

      const tools = document.createElement('div');
      tools.className = 'tools';
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'grip';
      grip.title = 'Drag to move this note';
      grip.innerHTML = icon('grip');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.title = 'Delete this note';
      del.innerHTML = icon('close');
      tools.appendChild(grip);
      tools.appendChild(del);

      el.appendChild(tools);
      el.appendChild(ink);
      block.el = el;
      block.ink = ink;

      applyBlockStyle(block);
      el.dataset.selected = String(block.id === selectedId);

      /* --- typing --- */
      ink.addEventListener('focus', function () {
        selectBlock(block.id);
        dismissHint();
      });

      ink.addEventListener('pointerdown', function () {
        selectBlock(block.id);
      });

      ink.addEventListener('input', function () {
        block.text = blockText(ink);
        persistBlocks();
        dismissHint();
      });

      ink.addEventListener('keydown', function (event) {
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault();
          insertTextAtCaret(ink, '    ');
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();   // one Esc deselects, a second one switches to View
          blurBlock(block.id);
          return;
        }
        if ((event.ctrlKey || event.metaKey) && /^[biu]$/i.test(event.key)) {
          event.preventDefault();   // plain text only, no bold/italic/underline
        }
      });

      ink.addEventListener('paste', function (event) {
        event.preventDefault();
        const data = event.clipboardData || window.clipboardData;
        const text = data ? data.getData('text/plain') : '';
        if (text) {
          block.text = text;
          insertTextAtCaret(ink, text);
        }
      });

      ink.addEventListener('drop', function (event) {
        const data = event.dataTransfer;
        if (!data) return;
        const text = data.getData('text/plain');
        if (!text) return;
        event.preventDefault();
        insertTextAtCaret(ink, text);
      });

      // Focus moved away: tidy the markup, drop the block if it was left empty
      // and stop the toolbar from pointing at it — unless focus only went to
      // our own toolbar, where keeping the selection is the whole point.
      ink.addEventListener('focusout', function (event) {
        const related = event.relatedTarget;
        if (related && related instanceof Element && bar.contains(related)) return;
        timeout(function () { finishBlock(block.id); }, 0);
      });

      /* --- move + delete --- */
      grip.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        startDrag(block, event);
      });

      del.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        event.stopPropagation();
      });
      del.addEventListener('click', function (event) {
        event.preventDefault();
        removeBlock(block.id);
      });

      return el;
    }

    function applyBlockStyle(block) {
      if (!block.el) return;
      block.el.style.setProperty('--c', block.color);
      block.el.style.setProperty('--sz', block.fontSize + 'px');
      block.el.style.setProperty('--ff', C.fontStack(block.font));
      block.el.style.setProperty('--sh', settings.textShadow
        ? '0 1px 2px rgba(0,0,0,.62), 0 0 14px rgba(0,0,0,.42)'
        : 'none');
    }

    function paintBlocks() {
      blockLayer.textContent = '';
      blocks.forEach(function (block) {
        const el = buildBlockElement(block);
        placeElement(block);
        blockLayer.appendChild(el);
      });
    }

    function startDrag(block, event) {
      const el = block.el;
      const rect = el.getBoundingClientRect();
      const { w, h } = viewport();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const target = event.currentTarget;

      selectBlock(block.id);
      el.classList.add('dragging');

      const move = function (moveEvent) {
        const left = C.clamp(moveEvent.clientX - offsetX, 0, Math.max(0, w - EDGE_MARGIN));
        const top = C.clamp(moveEvent.clientY - offsetY, 0, Math.max(0, h - EDGE_MARGIN * 2));
        block.x = C.clamp(left / w, 0, 1);
        block.y = C.clamp(top / h, 0, 1);
        placeElement(block);
      };
      const finish = function () {
        el.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        persistBlocks();
        try { if (target && target.releasePointerCapture && event.pointerId != null) target.releasePointerCapture(event.pointerId); } catch (err) { /* ignore */ }
        refocusBlock();
      };

      try { if (target && target.setPointerCapture && event.pointerId != null) target.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    }

    /* -------------------------------------------------------------- api -- */

    function addBlock(x, y) {
      const block = C.normaliseBlock({
        x: x,
        y: y,
        text: '',
        color: settings.color,
        fontSize: settings.fontSize,
        font: settings.font
      }, null);
      blocks.push(block);
      if (blockLayer) {
        const el = buildBlockElement(block);
        placeElement(block);
        blockLayer.appendChild(el);
      }
      selectBlock(block.id);
      persistBlocks();
      return block;
    }

    function focusBlock(id, atEnd) {
      const block = findBlock(id);
      if (!block || !block.ink) return;
      try {
        block.ink.focus({ preventScroll: true });
      } catch (err) {
        block.ink.focus();
      }
      if (atEnd) placeCaretAtEnd(block.ink);
    }

    function blurBlock(id) {
      const block = findBlock(id);
      if (block && block.ink && activeInk() === block.ink) {
        try { block.ink.blur(); } catch (err) { /* ignore */ }
      }
      finishBlock(id);
    }

    function activeInk() {
      try {
        return shadow.activeElement;
      } catch (err) {
        return null;
      }
    }

    /** Called when a block loses focus: tidy it, drop it if empty, deselect. */
    function finishBlock(id) {
      const block = findBlock(id);
      if (!block || !block.ink) return;
      const ink = block.ink;
      // Focus came back before this ran: the user is still writing, leave it be.
      if (activeInk() === ink) return;

      normaliseInk(ink);
      block.text = blockText(ink);
      if (!block.text.trim()) {
        removeBlock(id, { silent: true });
        return;
      }
      persistBlocks();
      if (selectedId === id) {
        selectedId = null;
        block.el.dataset.selected = 'false';
        syncToolbar();
      }
    }

    function removeBlock(id, options) {
      const index = blocks.findIndex(function (b) { return b.id === id; });
      if (index === -1) return;
      const block = blocks[index];
      if (block.el && block.el.parentNode) block.el.parentNode.removeChild(block.el);
      blocks.splice(index, 1);
      if (selectedId === id) selectedId = null;
      if (!(options && options.silent)) persistBlocks({ immediate: true });
      else persistBlocks();
      syncToolbar();
    }

    function selectBlock(id) {
      if (selectedId === id) {
        syncToolbar();
        return;
      }
      blocks.forEach(function (block) {
        if (block.el) block.el.dataset.selected = String(block.id === id);
      });
      selectedId = id;
      syncToolbar();
      notifyState();
    }

    function deselect() {
      selectedId = null;
      blocks.forEach(function (block) {
        if (block.el) block.el.dataset.selected = 'false';
      });
      syncToolbar();
    }

    function refocusBlock() {
      if (settings.mode !== 'edit' || !visible) return;
      if (!selectedId) return;
      focusBlock(selectedId, true);
    }

    function selectedBlock() {
      return selectedId ? findBlock(selectedId) : null;
    }

    /* ------------------------------------------------------- style sync -- */

    function currentInk() {
      const block = selectedBlock();
      if (block) return { color: block.color, fontSize: block.fontSize, font: block.font };
      return { color: settings.color, fontSize: settings.fontSize, font: settings.font };
    }

    function applyStyle() {
      wrap.style.setProperty('--oi-bg', 'rgba(16, 18, 27, ' + (settings.bgOpacity / 100).toFixed(2) + ')');
      bgRange.value = String(settings.bgOpacity);
      bgVal.textContent = settings.bgOpacity + '%';
      shadowBtn.setAttribute('aria-pressed', String(settings.textShadow));
      blocks.forEach(applyBlockStyle);
      syncToolbar();
    }

    /** The toolbar always shows what the next keystroke (or the selected
        block) will look like. */
    function syncToolbar() {
      const ink = currentInk();
      const focused = activeInk();

      if (focused !== hexInput && document.activeElement !== hexInput) hexInput.value = ink.color;
      hexInput.dataset.valid = 'true';
      if (focused !== sizeRange && document.activeElement !== sizeRange) sizeRange.value = String(ink.fontSize);
      sizeVal.textContent = ink.fontSize + 'px';
      if (focused !== fontSelect && document.activeElement !== fontSelect) fontSelect.value = ink.font;
      if (focused !== bgRange && document.activeElement !== bgRange) bgRange.value = String(settings.bgOpacity);
      bgVal.textContent = settings.bgOpacity + '%';

      shadowBtn.setAttribute('aria-pressed', String(settings.textShadow));
      colorInput.value = ink.color;
      const isCustom = PRESET_COLORS.indexOf(ink.color) === -1;
      customSwatch.dataset.active = String(isCustom);
      customSwatch.style.setProperty('--c', ink.color);
      swatchWrap.querySelectorAll('.swatch[data-color]').forEach(function (btn) {
        btn.setAttribute('aria-pressed', String(btn.dataset.color === ink.color));
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
      if (settings.mode === 'view') {
        blocks.forEach(function (block) {
          if (block.el) block.el.dataset.selected = 'false';
        });
        try { if (activeInk()) activeInk().blur(); } catch (err) { /* ignore */ }
      } else if (visible) {
        refocusBlock();
      }
    }

    /* -------------------------------------------------------- visibility -- */

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

    function renderBlocks() {
      paintBlocks();
      layoutBlocks();
    }

    function show() {
      if (visible) {
        if (settings.mode === 'edit') refocusBlock();
        return;
      }
      visible = true;
      attach();
      loadBlocks();
      paintBlocks();
      layoutBlocks();
      lastAppliedMode = settings.mode;
      applyStyle();
      syncMode();
      showHint();
      if (settings.mode === 'edit') {
        const active = document.activeElement;
        if (active && active !== host && typeof active.blur === 'function' && !isEditableElement(active)) {
          try { active.blur(); } catch (err) { /* ignore */ }
        }
        refocusBlock();
      }
      notifyState();
    }

    function hide() {
      if (!visible) return;
      visible = false;
      blocks.forEach(function (block) {
        if (block.ink) {
          normaliseInk(block.ink);
          block.text = blockText(block.ink);
        }
      });
      blocks = blocks.filter(function (block) { return block.text.trim() !== ''; });
      if (blocksDirty || lastWrittenBlocks) persistBlocks({ immediate: true });
      selectedId = null;
      dismissHint();
      try { if (activeInk()) activeInk().blur(); } catch (err) { /* ignore */ }
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
      clearEverything();
    }

    /**
     * Colour / size / font changes land on the block being edited; with nothing
     * selected they become the defaults for the next thing you write.
     */
    function setInk(patch, options) {
      const immediate = options && options.immediate;
      const block = selectedBlock();
      if (block) {
        const next = C.normaliseBlock(Object.assign({}, block, patch), settings);
        block.color = next.color;
        block.fontSize = next.fontSize;
        block.font = next.font;
        applyBlockStyle(block);
        persistBlocks(immediate ? { immediate: true } : undefined);
        syncToolbar();
        notifyState();
        return;
      }
      updateSettings(patch, options);
    }

    /* ------------------------------------------------------------ events -- */

    // Click anywhere on the empty canvas → a caret appears right there.
    canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || settings.mode !== 'edit') return;
      event.preventDefault();
      const block = addBlock(event.clientX / viewport().w, event.clientY / viewport().h);
      focusBlock(block.id);
    });

    // Keep focus where it is for buttons and swatches; sliders, the select and
    // the hex field need their default behaviour.
    bar.addEventListener('pointerdown', function (event) {
      const target = event.target;
      if (target instanceof Element && target.closest('input, select')) return;
      event.preventDefault();
    });

    bar.addEventListener('click', function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const seg = target.closest('.segbtn');
      if (seg) {
        setMode(seg.dataset.mode);
        dismissHint();
        refocusBlock();
        return;
      }

      const swatch = target.closest('.swatch[data-color]');
      if (swatch) {
        setInk({ color: swatch.dataset.color }, { immediate: true });
        return;
      }

      const action = target.closest('[data-act]');
      if (!action) return;
      const act = action.dataset.act;
      if (act === 'hide') {
        hide();
      } else if (act === 'shadow') {
        updateSettings({ textShadow: !settings.textShadow }, { immediate: true });
      } else if (act === 'clear') {
        handleClear();
      }
    });

    bar.addEventListener('change', function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target === fontSelect) setInk({ font: fontSelect.value }, { immediate: true });
      if (target === sizeRange) setInk({ fontSize: Number(sizeRange.value) }, { immediate: true });
      if (target === bgRange) updateSettings({ bgOpacity: Number(bgRange.value) }, { immediate: true });
      if (target === colorInput) setInk({ color: colorInput.value }, { immediate: true });
      refocusBlock();
    });

    sizeRange.addEventListener('input', function () {
      sizeVal.textContent = sizeRange.value + 'px';
      setInk({ fontSize: Number(sizeRange.value) });
    });
    bgRange.addEventListener('input', function () {
      bgVal.textContent = bgRange.value + '%';
      updateSettings({ bgOpacity: Number(bgRange.value) });
    });
    colorInput.addEventListener('input', function () {
      setInk({ color: colorInput.value });
    });

    hexInput.addEventListener('input', function () {
      const value = hexInput.value.trim();
      hexInput.dataset.valid = String(C.isHexColor(value));
      if (C.isHexColor(value)) setInk({ color: C.expandHex(value) });
    });
    hexInput.addEventListener('change', function () {
      const value = hexInput.value.trim();
      const colour = C.isHexColor(value) ? C.expandHex(value) : (value ? '#' + value.replace(/^#/, '') : '');
      if (C.isHexColor(colour)) setInk({ color: C.expandHex(colour) }, { immediate: true });
      syncToolbar();
      refocusBlock();
    });
    hexInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        hexInput.blur();
      }
    });

    /* Typing with nothing selected starts a note where it is comfortable. */
    window.addEventListener('keydown', function (event) {
      if (!visible || settings.mode !== 'edit' || selectedId) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (typeof event.key !== 'string' || event.key.length !== 1) return;
      if (isInsideOverlay(event)) return;
      event.preventDefault();
      const { w, h } = viewport();
      const block = addBlock(0.06, Math.min(0.6, (TOP_MARGIN + 40) / h));
      focusBlock(block.id);
      insertTextAtCaret(block.ink, event.key);
      void w;
    }, true);

    /* Shortcuts that do not depend on where the focus is. */
    window.addEventListener('keydown', function (event) {
      if (!visible) return;
      if (event.key === 'Escape' && settings.mode === 'edit' && !selectedId) {
        event.preventDefault();
        setMode('view');
      }
    }, true);

    window.addEventListener('resize', layoutBlocks);
    document.addEventListener('fullscreenchange', attach, true);

    return {
      show: show,
      hide: hide,
      toggle: toggle,
      isVisible: isVisible,
      applySettings: applySettings,
      refreshMode: refreshMode,
      renderBlocks: renderBlocks,
      syncToolbar: syncToolbar,
      destroy: function () {
        window.removeEventListener('resize', layoutBlocks);
        document.removeEventListener('fullscreenchange', attach, true);
        if (host.parentNode) host.parentNode.removeChild(host);
        visible = false;
      }
    };
  }

  function isReplacedElement(el) {
    return el.matches && el.matches('video, img, canvas, iframe, embed, object, audio');
  }

  function isEditableElement(el) {
    return Boolean(el && el.matches && el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  }

  /** True when a DOM event happened inside our own overlay. */
  function isInsideOverlay(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (!path) return false;
    for (let i = 0; i < path.length; i += 1) {
      const node = path[i];
      if (node && node.tagName && String(node.tagName).toLowerCase() === 'overlay-ink') return true;
    }
    return false;
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
          clearEverything();
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
      if (changes[STORAGE.blocks] && !blocksPendingWrite) {
        blocksRevision += 1;
        blocks = C.normaliseBlocks(changes[STORAGE.blocks].newValue, null);
        if (instance) instance.renderBlocks();
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
    if (blocksSaveTimer) writeBlocks();
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
  loadBlocks();

  return Object.assign({ ok: true, installed: true }, currentState());
})();
