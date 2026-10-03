/**
 * Overlay Ink — the overlay itself (content script).
 *
 * Injected into every http(s) page by the manifest, and re-injected on demand
 * by the popup when the page predates the install. The file is
 * written so that running it twice is always safe:
 *
 *   • first run  → installs the API on the page, creates no DOM
 *   • later runs → return the current state and change nothing
 *
 * The overlay is a canvas: click anywhere and a caret appears exactly there, so
 * writing is placed where you put it instead of flowing from the top of the
 * page. Every piece of writing is a "block" — its own little text box with its
 * own colour, size and font, movable by dragging its grip. Nothing is drawn
 * except the glyphs and per-note handles. All controls live in the action popup,
 * leaving the whole page available for writing.
 *
 * Public API on the page (used by the demo and tests):
 *   window.__overlayInkToggle()   → toggle, returns the new state
 *   window.__overlayInkState()    → { visible, mode, blocks, settings, selected }
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

  const { STORAGE, DEFAULT_SETTINGS } = C;
  const LOG = '[Overlay Ink]';
  const EDGE_MARGIN = 12;  // keep a caret reachable at the viewport edges

  /* --------------------------------------------------------------- state -- */

  // Defaults for new writing. Global: shared by every tab through storage.
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let blocks = [];          // { id, x, y, text, color, fontSize, font, el?, ink? }
  let selectedId = null;    // kept when focus moves into the extension popup
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
    const signature = JSON.stringify(state);
    if (lastNotified === signature) return;
    lastNotified = signature;
    sendMessage(Object.assign({ type: 'oi:state' }, state));
  }

  function currentState() {
    const visible = Boolean(instance && instance.isVisible());
    const block = visible && settings.mode === 'edit' ? findBlock(selectedId) : null;
    return {
      visible: visible,
      mode: settings.mode,
      blocks: blocks.length,
      settings: Object.assign({}, settings),
      selected: block ? { id: block.id, color: block.color, fontSize: block.fontSize, font: block.font } : null,
      controlsVersion: 3
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
    notifyState();
  }

  /** Style the selected note, or the defaults when the popup chooses new notes. */
  function setInk(patch, targetId) {
    const id = targetId === undefined ? selectedId : targetId;
    const block = id ? findBlock(id) : null;
    // A stale popup must never turn a deleted note's style change into defaults.
    if (id && !block) return;
    if (!block) {
      const next = C.normaliseSettings(Object.assign({}, settings, patch));
      updateSettings({ color: next.color, fontSize: next.fontSize, font: next.font }, { immediate: true });
      return;
    }
    const next = C.normaliseBlock(Object.assign({}, block, patch), settings);
    block.color = next.color;
    block.fontSize = next.fontSize;
    block.font = next.font;
    if (instance) instance.applySettings();
    persistBlocks({ immediate: true });
    notifyState();
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
      notifyState();
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
        notifyState();
        return;
      }
      readStorage('local', STORAGE.legacyText).then(function (legacy) {
        if (blocksDirty || revision !== blocksRevision) return;
        if (typeof legacy !== 'string' || !legacy.trim()) return;
        blocks = [C.normaliseBlock({ text: legacy, x: 0.06, y: 0.16 }, null)];
        if (instance) instance.renderBlocks();
        persistBlocks({ immediate: true });
        writeStorage('local', { [STORAGE.legacyText]: '' });
        notifyState();
      });
    });
  }

  function clearEverything() {
    blocksDirty = true;
    blocksRevision += 1;
    blocks = [];
    selectedId = null;
    if (instance) instance.renderBlocks();
    persistBlocks({ immediate: true });
    writeStorage('local', { [STORAGE.legacyText]: '' });
    notifyState();
  }

  /* ------------------------------------------------------------- picture -- */

  const ICONS = {
    close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    grip: '<circle cx="5.5" cy="5" r="1.15"/><circle cx="10.5" cy="5" r="1.15"/><circle cx="5.5" cy="8" r="1.15"/><circle cx="10.5" cy="8" r="1.15"/><circle cx="5.5" cy="11" r="1.15"/><circle cx="10.5" cy="11" r="1.15"/>'
  };

  function icon(name) {
    const filled = name === 'grip';
    return '<svg viewBox="0 0 16 16" fill="' + (filled ? 'currentColor' : 'none') + '" ' +
      (filled ? '' : 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ') +
      'aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  const CSS_TEXT = [
    ':host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }',
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

    /* layers: optional background → transparent click surface → text blocks */
    '.scrim { position: absolute; inset: 0; background: var(--oi-bg, transparent); pointer-events: none; z-index: 0; }',
    '.canvas { position: absolute; inset: 0; pointer-events: none; z-index: 1; }',
    '.wrap[data-mode="edit"] .canvas { pointer-events: auto; cursor: text; }',
    '.blocks { position: absolute; inset: 0; pointer-events: none; z-index: 2; }',

    /* one piece of writing */
    '.blk { position: absolute; max-width: 100vw; pointer-events: auto; }',
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
    '.blk[data-at-top="true"] .tools { top: 100%; margin-top: 4px; }',
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

    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const canvas = document.createElement('div');
    canvas.className = 'canvas';
    const blockLayer = document.createElement('div');
    blockLayer.className = 'blocks';
    wrap.appendChild(scrim);
    wrap.appendChild(canvas);
    wrap.appendChild(blockLayer);
    shadow.appendChild(wrap);

    let visible = false;
    let lastAppliedMode = null;

    /* --------------------------------------------------------- geometry -- */

    function placeElement(block) {
      if (!block.el) return;
      const { w, h } = viewport();
      const left = Math.round(C.clamp(block.x * w, 0, Math.max(0, w - EDGE_MARGIN)));
      const top = Math.round(C.clamp(block.y * h, 0, Math.max(0, h - EDGE_MARGIN)));
      block.el.style.left = left + 'px';
      block.el.style.top = top + 'px';
      block.el.style.maxWidth = Math.max(16, w - left - 4) + 'px';
      block.el.dataset.atTop = String(top < 24);
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
      ink.setAttribute('contenteditable', settings.mode === 'edit' ? 'true' : 'false');
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
      });

      ink.addEventListener('pointerdown', function () {
        selectBlock(block.id);
      });

      ink.addEventListener('input', function () {
        block.text = blockText(ink);
        persistBlocks();
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

      // Keep a nonempty note selected when focus moves to Brave's popup.
      // Selecting another note, New notes, Esc, View or Off deselects it.
      ink.addEventListener('focusout', function () {
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
      if (!findBlock(selectedId)) selectedId = null;
      blockLayer.textContent = '';
      blocks.forEach(function (block) {
        const el = buildBlockElement(block);
        placeElement(block);
        blockLayer.appendChild(el);
      });
      notifyState();
    }

    function startDrag(block, event) {
      if (settings.mode !== 'edit' || event.button !== 0) return;
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
        persistBlocks({ immediate: true });
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
      if (selectedId === id) deselect();
    }

    function activeInk() {
      try {
        return shadow.activeElement;
      } catch (err) {
        return null;
      }
    }

    /** Tidy a blurred note; keep it selected for the popup unless it is empty. */
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
      notifyState();
    }

    function selectBlock(id) {
      if (selectedId === id) {
        notifyState();
        return;
      }
      blocks.forEach(function (block) {
        if (block.el) block.el.dataset.selected = String(block.id === id);
      });
      selectedId = id;
      notifyState();
    }

    function deselect() {
      const id = selectedId;
      try { if (activeInk()) activeInk().blur(); } catch (err) { /* ignore */ }
      if (id) finishBlock(id);
      selectedId = null;
      blocks.forEach(function (block) {
        if (block.el) block.el.dataset.selected = 'false';
      });
      notifyState();
    }

    function refocusBlock() {
      if (settings.mode !== 'edit' || !visible) return;
      if (!selectedId) return;
      focusBlock(selectedId, true);
    }

    /** Return from the popup without forcing the caret to the end of the note. */
    function resumeEditing() {
      if (settings.mode !== 'edit' || !visible || !selectedId) return;
      focusBlock(selectedId, false);
    }

    /* ------------------------------------------------------- style sync -- */

    function applyStyle() {
      wrap.style.setProperty('--oi-bg', 'rgba(16, 18, 27, ' + (settings.bgOpacity / 100).toFixed(2) + ')');
      blocks.forEach(applyBlockStyle);
    }

    function syncMode() {
      wrap.dataset.mode = settings.mode;
      blocks.forEach(function (block) {
        if (block.ink) block.ink.setAttribute('contenteditable', settings.mode === 'edit' ? 'true' : 'false');
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
        deselect();
      } else if (visible) {
        refocusBlock();
      }
    }

    /* -------------------------------------------------------- visibility -- */

    function attach() {
      if (!visible) return;
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
      if (settings.mode === 'edit') {
        const active = document.activeElement;
        if (active && active !== host && typeof active.blur === 'function') {
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

    /* ------------------------------------------------------------ events -- */

    // Click anywhere on the empty canvas → a caret appears right there.
    canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || settings.mode !== 'edit') return;
      event.preventDefault();
      const block = addBlock(event.clientX / viewport().w, event.clientY / viewport().h);
      focusBlock(block.id);
    });

    /* Typing with nothing selected starts a note where it is comfortable. */
    window.addEventListener('keydown', function (event) {
      if (!visible || settings.mode !== 'edit' || selectedId) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (typeof event.key !== 'string' || event.key.length !== 1) return;
      if (isInsideOverlay(event)) return;
      event.preventDefault();
      const block = addBlock(0.06, 0.12);
      focusBlock(block.id);
      insertTextAtCaret(block.ink, event.key);
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
      deselect: deselect,
      resumeEditing: resumeEditing,
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
        case 'oi:set-ink':
          setInk(message.ink || {}, message.blockId);
          sendResponse(currentState());
          break;
        case 'oi:resume-edit':
          if (instance) instance.resumeEditing();
          sendResponse(currentState());
          break;
        case 'oi:deselect':
          if (instance) instance.deselect();
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
      if (area !== 'local') return;
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
      notifyState();
    });
  } catch (err) {
    /* ignore */
  }

  // Native popup dismissal or returning to this tab restores the selected
  // note's caret. Nothing is focused or created in View mode or while Off.
  window.addEventListener('focus', function () {
    if (instance) instance.resumeEditing();
  });

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
