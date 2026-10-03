/**
 * Overlay Ink — shared constants and helpers.
 *
 * Loaded first by the content script (see manifest.json > content_scripts) and
 * by the popup. Everything hangs off a single namespaced global so that a
 * repeated injection of this file is always harmless.
 */
(function (scope) {
  'use strict';

  if (scope.__overlayInkCommon) return;

  const STORAGE = Object.freeze({
    settings: 'oiSettings',
    blocks: 'oiBlocks',
    // Written by 0.1.x, kept so older notes can be migrated into a block.
    legacyText: 'oiText'
  });

  const BLOCKS_VERSION = 2;

  const MODES = Object.freeze(['edit', 'view']);

  const DEFAULT_SETTINGS = Object.freeze({
    mode: 'edit',      // which mode a freshly opened overlay starts in
    color: '#ff2d55',  // ink colour
    fontSize: 44,      // px
    font: 'hand',      // one of FONTS[].id
    bgOpacity: 0,      // 0..100 — 0 keeps the overlay fully transparent
    textShadow: true   // subtle outline so ink stays readable on busy pages
  });

  const PRESET_COLORS = Object.freeze([
    '#ff2d55', // red
    '#ff9500', // orange
    '#ffd60a', // yellow
    '#34c759', // green
    '#00c7b7', // teal
    '#0a84ff', // blue
    '#a855f7', // violet
    '#ffffff'  // white
  ]);

  const FONT_FAMILY_NAME = 'Overlay Ink Hand';

  const FONTS = Object.freeze([
    { id: 'hand', label: 'Handwriting', stack: "'" + FONT_FAMILY_NAME + "', 'Patrick Hand', 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive" },
    { id: 'sans', label: 'Sans serif', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
    { id: 'serif', label: 'Serif', stack: "Georgia, 'Iowan Old Style', 'Times New Roman', Times, serif" },
    { id: 'mono', label: 'Monospace', stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace" }
  ]);

  const MIN_FONT_SIZE = 12;
  const MAX_FONT_SIZE = 240;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isHexColor(value) {
    return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
  }

  function expandHex(value) {
    const hex = value.trim().toLowerCase();
    if (hex.length !== 4) return hex;
    return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }

  function fontStack(id) {
    const font = FONTS.find(function (f) { return f.id === id; });
    return (font || FONTS[0]).stack;
  }

  /** Pages the browser lets extensions touch at all. */
  function isSupportedUrl(url) {
    return typeof url === 'string' && /^(https?|file|ftp):/i.test(url.trim());
  }

  /** Pages that actively block content scripts (Web Store + Chrome's own UI). */
  function isBlockedUrl(url) {
    return typeof url === 'string' && /^(https?:\/\/)?(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url.trim());
  }

  /** Coerce anything that came out of storage into a usable settings object. */
  function normaliseSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const fontSize = Number(s.fontSize);
    const bgOpacity = Number(s.bgOpacity);
    return {
      mode: MODES.indexOf(s.mode) !== -1 ? s.mode : DEFAULT_SETTINGS.mode,
      color: isHexColor(s.color) ? expandHex(s.color) : DEFAULT_SETTINGS.color,
      fontSize: Number.isFinite(fontSize) ? clamp(Math.round(fontSize), MIN_FONT_SIZE, MAX_FONT_SIZE) : DEFAULT_SETTINGS.fontSize,
      font: FONTS.some(function (f) { return f.id === s.font; }) ? s.font : DEFAULT_SETTINGS.font,
      bgOpacity: Number.isFinite(bgOpacity) ? clamp(Math.round(bgOpacity), 0, 100) : DEFAULT_SETTINGS.bgOpacity,
      textShadow: s.textShadow !== false
    };
  }

  function makeId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * A block is one piece of writing pinned somewhere on the page. `x` and `y`
   * are fractions of the viewport (0..1) so a note made in a big window still
   * lands somewhere sensible in a small one.
   */
  function normaliseBlock(raw, fallback) {
    const b = raw && typeof raw === 'object' ? raw : {};
    const base = fallback || {};
    const x = Number(b.x);
    const y = Number(b.y);
    const fontSize = Number(b.fontSize);
    return {
      id: typeof b.id === 'string' && b.id ? b.id : makeId(),
      x: Number.isFinite(x) ? clamp(x, 0, 1) : (Number.isFinite(base.x) ? base.x : 0.06),
      y: Number.isFinite(y) ? clamp(y, 0, 1) : (Number.isFinite(base.y) ? base.y : 0.2),
      text: typeof b.text === 'string' ? b.text : '',
      color: isHexColor(b.color) ? expandHex(b.color) : (base.color || DEFAULT_SETTINGS.color),
      fontSize: Number.isFinite(fontSize)
        ? clamp(Math.round(fontSize), MIN_FONT_SIZE, MAX_FONT_SIZE)
        : (base.fontSize || DEFAULT_SETTINGS.fontSize),
      font: FONTS.some(function (f) { return f.id === b.font; }) ? b.font : (base.font || DEFAULT_SETTINGS.font)
    };
  }

  /** Accepts the stored { version, blocks } wrapper, a bare array, or garbage. */
  function normaliseBlocks(raw, fallback) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.blocks) ? raw.blocks : []);
    return list
      .filter(function (b) { return b && typeof b === 'object'; })
      .map(function (b) { return normaliseBlock(b, fallback); })
      .filter(function (b) { return b.text.trim() !== ''; });
  }

  function blocksForStorage(blocks) {
    return {
      version: BLOCKS_VERSION,
      blocks: (blocks || []).map(function (b) {
        return { id: b.id, x: b.x, y: b.y, text: b.text, color: b.color, fontSize: b.fontSize, font: b.font };
      })
    };
  }

  scope.__overlayInkCommon = Object.freeze({
    STORAGE: STORAGE,
    BLOCKS_VERSION: BLOCKS_VERSION,
    MODES: MODES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    PRESET_COLORS: PRESET_COLORS,
    FONTS: FONTS,
    FONT_FAMILY_NAME: FONT_FAMILY_NAME,
    MIN_FONT_SIZE: MIN_FONT_SIZE,
    MAX_FONT_SIZE: MAX_FONT_SIZE,
    clamp: clamp,
    isHexColor: isHexColor,
    expandHex: expandHex,
    fontStack: fontStack,
    isSupportedUrl: isSupportedUrl,
    isBlockedUrl: isBlockedUrl,
    normaliseSettings: normaliseSettings,
    makeId: makeId,
    normaliseBlock: normaliseBlock,
    normaliseBlocks: normaliseBlocks,
    blocksForStorage: blocksForStorage
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
