/**
 * Headless smoke test for Overlay Ink.
 *
 *   npm install
 *   npm test
 *
 * Loads common.js + content/overlay.js into a jsdom page with a fake chrome API
 * and drives the overlay the way the toolbar button, the popup and the options
 * page would: toggle it, click the canvas to place text, type, colour, move,
 * delete, hide, re-inject.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const commonSource = readFileSync(join(root, 'common.js'), 'utf8');
const overlaySource = readFileSync(join(root, 'content/overlay.js'), 'utf8');
const popupSource = readFileSync(join(root, 'popup/popup.js'), 'utf8');
const popupHtml = readFileSync(join(root, 'popup/popup.html'), 'utf8');
const demoPopupShim = readFileSync(join(root, 'demo/demo-popup-shim.js'), 'utf8');
const doms = [];

let failures = 0;
let checks = 0;

function check(label, condition, extra) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ fake chrome -- */

function createFakeChrome(store) {
  const state = { runtimeListeners: [], popupListeners: [], storageListeners: [], sent: [] };

  function fireStorageChanges(area, changes) {
    state.storageListeners.forEach((fn) => fn(changes, area));
  }

  return {
    runtime: {
      id: 'smoke-test',
      lastError: undefined,
      getURL: (path) => `chrome-extension://smoke-test/${path}`,
      sendMessage: (message, callback) => {
        state.sent.push(message);
        state.popupListeners.slice().forEach((fn) => fn(message, { tab: { id: 7 } }));
        if (callback) callback(undefined);
      },
      onMessage: { addListener: (fn) => state.runtimeListeners.push(fn) }
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const out = {};
          if (typeof keys === 'string') out[keys] = store[keys];
          else if (Array.isArray(keys)) keys.forEach((k) => { out[k] = store[k]; });
          else Object.assign(out, store);
          if (callback) setTimeout(() => callback(out), 0);
        },
        set: (values, callback) => {
          const changes = {};
          Object.keys(values).forEach((key) => {
            changes[key] = { oldValue: store[key], newValue: values[key] };
            store[key] = values[key];
          });
          fireStorageChanges('local', changes);
          if (callback) setTimeout(() => callback(), 0);
        }
      },
      onChanged: { addListener: (fn) => state.storageListeners.push(fn) }
    },
    _state: state,
    _sendToContent: (message) => {
      let response;
      state.runtimeListeners.slice().forEach((fn) => fn(message, {}, (value) => { response = value; }));
      return response;
    }
  };
}

/* ------------------------------------------------------------------- setup -- */

/**
 * Run `source` inside the jsdom realm (so `window` etc. exist) and return the
 * value of its last statement — the same trick a <script> tag does.
 */
function injectScript(win, source) {
  const script = win.document.createElement('script');
  script.textContent = `window.__oiTestResult = (0, eval)(${JSON.stringify(source)});`;
  (win.document.body || win.document.documentElement).appendChild(script);
  script.remove();
  const result = win.__oiTestResult;
  delete win.__oiTestResult;
  return result;
}

function bootPage(store = {}, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><h1>demo page</h1></body></html>', {
    url: 'https://example.com/article',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const chrome = createFakeChrome(store);
  dom.window.chrome = chrome;
  injectScript(dom.window, commonSource);
  if (options.overlay !== false) injectScript(dom.window, overlaySource);
  doms.push(dom);
  return { dom, win: dom.window, chrome, store };
}


async function waitFor(predicate, label, timeout = 2500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + label);
    await sleep(10);
  }
}

/** A separate popup realm using the same APIs an installed action popup uses. */
async function bootPopup(page, options = {}) {
  const dom = new JSDOM(popupHtml, {
    url: 'chrome-extension://smoke-test/popup/popup.html',
    runScripts: 'dangerously', pretendToBeVisual: true
  });
  doms.push(dom);
  const win = dom.window;
  const sent = [];
  const listeners = [];
  let closed = false;
  let injections = 0;
  let openedOptions = 0;
  const nativeClose = win.close.bind(win);
  const chrome = {
    runtime: {
      id: 'smoke-test', lastError: undefined,
      onMessage: { addListener: (fn) => {
        listeners.push(fn); page.chrome._state.popupListeners.push(fn);
      } },
      openOptionsPage: (callback) => { openedOptions += 1; if (callback) callback(); }
    },
    storage: page.chrome.storage,
    tabs: {
      query: (query, callback) => setTimeout(() => callback(options.noTab ? [] : [
        { id: 7, url: options.url || 'https://example.com/article' }
      ]), 0),
      sendMessage: (id, message, callback) => {
        sent.push(message);
        const response = options.oldState
          ? { visible: false, mode: 'edit', blocks: 0 }
          : page.chrome._sendToContent(message);
        setTimeout(() => callback(response), options.responseDelay || 0);
      }
    },
    scripting: {
      executeScript: async () => {
        injections += 1;
        if (options.injectFail) throw new Error('Injection blocked');
        injectScript(page.win, commonSource);
        injectScript(page.win, overlaySource);
        return [];
      }
    }
  };
  win.chrome = chrome;
  win.close = () => { closed = true; };
  // The web-demo bridge must leave the real extension API untouched.
  injectScript(win, demoPopupShim);
  injectScript(win, commonSource);
  injectScript(win, popupSource);
  await waitFor(() => win.document.body.dataset.ready === 'true' || !win.document.getElementById('banner').hidden, 'popup boot');
  return {
    dom, win, chrome, sent, $: (id) => win.document.getElementById(id),
    isClosed: () => closed, injections: () => injections, optionsOpened: () => openedOptions,
    click(id) { this.$(id).click(); },
    change(id, value, type = 'change') {
      const control = this.$(id);
      if (typeof value === 'boolean') control.checked = value; else control.value = value;
      control.dispatchEvent(new win.Event(type, { bubbles: true }));
    },
    destroy() {
      page.chrome._state.popupListeners = page.chrome._state.popupListeners.filter((fn) => !listeners.includes(fn));
      win.dispatchEvent(new win.Event('pagehide'));
      nativeClose();
    }
  };
}

/** Test helpers: reach into the overlay the way a user's pointer does. */
function overlay(win) {
  const host = win.document.querySelector('overlay-ink');
  const shadow = host && host.shadowRoot;
  return {
    host,
    shadow,
    canvas: shadow && shadow.querySelector('.canvas'),
    blocks: () => Array.from(shadow.querySelectorAll('.blk')),
    inks: () => Array.from(shadow.querySelectorAll('.ink')),
    /** Click the canvas at a point — creates a placed text block. */
    clickAt(x, y) {
      const event = new win.MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      shadow.querySelector('.canvas').dispatchEvent(event);
      return this.blocks()[this.blocks().length - 1];
    },
    click(selector) {
      const el = typeof selector === 'string' ? shadow.querySelector(selector) : selector;
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, composed: true }));
      return el;
    },
    type(text, ink) {
      const target = ink || shadow.activeElement || shadow.querySelector('.ink');
      target.textContent = text;
      target.dispatchEvent(new win.Event('input', { bubbles: true }));
      return target;
    },
    /** Move focus away, the way clicking elsewhere on the page does. */
    finish(ink) {
      try { ink.blur(); } catch (err) { /* ignore */ }
      ink.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    }
  };
}

/* -------------------------------------------------------------------- run -- */

section('common.js — settings and blocks');
{
  const g = {};
  new Function('globalThis', commonSource)(g);
  const C = g.__overlayInkCommon;

  check('exposes a frozen namespace', Object.isFrozen(C));
  check('falls back to defaults', C.normaliseSettings(undefined).color === '#ff2d55');
  check('clamps font size', C.normaliseSettings({ fontSize: 9999 }).fontSize === C.MAX_FONT_SIZE);
  check('clamps background', C.normaliseSettings({ bgOpacity: -20 }).bgOpacity === 0);
  check('expands 3-digit hex', C.normaliseSettings({ color: '#f0a' }).color === '#ff00aa');
  check('rejects junk colours', C.normaliseSettings({ color: 'red' }).color === '#ff2d55');
  check('rejects unknown fonts', C.normaliseSettings({ font: 'papyrus' }).font === 'hand');
  check('blocked pages detected', C.isBlockedUrl('https://chromewebstore.google.com/detail/x') === true);
  check('normal pages allowed', C.isSupportedUrl('https://example.com') && !C.isBlockedUrl('https://example.com'));
  check('font stack is permissive', C.fontStack('sans').includes('sans-serif'));

  const block = C.normaliseBlock({ x: 2, y: -1, text: 'hi', color: 'nope' }, null);
  check('block position clamped', block.x === 1 && block.y === 0, block);
  check('block colour falls back', block.color === '#ff2d55');
  check('blocks accept the stored wrapper', C.normaliseBlocks({ version: 2, blocks: [{ text: 'a' }] }).length === 1);
  check('empty blocks are dropped', C.normaliseBlocks({ blocks: [{ text: '   ' }, { text: 'x' }] }).length === 1);
  check('blocks survive a round trip',
    C.normaliseBlocks(C.blocksForStorage([C.normaliseBlock({ text: 'keep me' })])).length === 1);
}

section('content script — first run installs without touching the DOM');
{
  const { win } = bootPage();
  check('api exposed', typeof win.__overlayInkToggle === 'function');
  check('nothing rendered yet', win.document.querySelector('overlay-ink') === null);
  check('reports hidden', win.__overlayInkState().visible === false);
}

section('canvas on / off state — controls stay outside the page');
{
  const { win, chrome } = bootPage();
  const state = win.__overlayInkToggle();
  const ui = overlay(win);

  check('toggle reports visible', state.visible === true, state);
  check('host element is on the page', !!ui.host);
  check('shadow root is open', !!ui.shadow);
  check('state message reached the worker', chrome._state.sent.some((m) => m.type === 'oi:state' && m.visible));
  check('no on-page bar or hint is rendered', !ui.shadow.querySelector('.bar, .topwrap, .hint, [role="toolbar"]'));
  check('no permanent on-page controls', ui.shadow.querySelectorAll('button, input, select').length === 0);
  check('the entire click surface is rendered', !!ui.canvas);
  check('popup receives settings in the state', state.settings.color === '#ff2d55');
  check('popup receives its controls version', state.controlsVersion === 3);
  check('starts in the stored mode', ui.shadow.querySelector('.wrap').dataset.mode === 'edit');
  check('the canvas only catches clicks in edit mode',
    ui.shadow.querySelector('style').textContent.includes('.wrap[data-mode="edit"] .canvas { pointer-events: auto'));

  check('toggle reports hidden again', win.__overlayInkToggle().visible === false);
  check('host removed from the page', win.document.querySelector('overlay-ink') === null);
}

section('click anywhere on the canvas and write there');
{
  const { win, store } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);

  check('nothing on the canvas yet', ui.blocks().length === 0);

  const first = ui.clickAt(220, 300);
  check('a block appears where you clicked', ui.blocks().length === 1);
  check('block is placed at the click point', first.style.left === '220px' && first.style.top === '300px',
    { left: first.style.left, top: first.style.top });
  check('the new block has the caret', ui.shadow.activeElement === first.querySelector('.ink'));

  ui.type('first note', first.querySelector('.ink'));
  await sleep(400);
  const saved = store.oiBlocks;
  check('blocks are stored as the canvas', saved && saved.version === 2 && saved.blocks.length === 1, saved);
  check('text stored per block', saved.blocks[0].text === 'first note', saved.blocks[0]);
  check('position stored as a fraction', Math.abs(saved.blocks[0].x - 220 / win.innerWidth) < 0.001, saved.blocks[0]);

  // A second note somewhere completely different — not below the first.
  win.document.querySelector('overlay-ink').shadowRoot
    .querySelector('.ink').dispatchEvent(new win.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  const second = ui.clickAt(640, 520);
  check('second block placed independently', ui.blocks().length === 2);
  check('second block is where you clicked', second.style.left === '640px' && second.style.top === '520px');
  ui.type('second note', second.querySelector('.ink'));
  await sleep(400);
  check('both notes kept', store.oiBlocks.blocks.length === 2 && store.oiBlocks.blocks[1].text === 'second note');

  const reloaded = bootPage(store);
  reloaded.win.__overlayInkToggle();
  await sleep(30); // storage reads answer on the next tick
  const ui2 = overlay(reloaded.win);
  check('notes come back after a reload', ui2.blocks().length === 2);
  check('with their text', ui2.inks().map((i) => i.textContent).join('|') === 'first note|second note');
}

section('typing with nothing selected starts a note');
{
  const { win } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);

  const event = new win.KeyboardEvent('keydown', { key: 'H', bubbles: true, cancelable: true });
  win.dispatchEvent(event);
  check('a block was created by the keystroke', ui.blocks().length === 1);
  check('the typed letter landed in it', ui.inks()[0].textContent === 'H', ui.inks()[0].textContent);
  check('the event was consumed', event.defaultPrevented === true);
}

section('popup style messages target a selected note or the defaults');
{
  const { win, store, chrome } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);
  const first = ui.clickAt(120, 200);
  ui.type('red one', first.querySelector('.ink'));
  ui.finish(first.querySelector('.ink'));
  await sleep(400);
  check('a note stays selected when focus moves away to the popup', win.__overlayInkState().selected.id === first.dataset.id);
  chrome._sendToContent({ type: 'oi:deselect' });
  chrome._sendToContent({ type: 'oi:set-ink', ink: { color: '#0a84ff' }, blockId: null });
  check('with nothing selected the colour becomes the default', store.oiSettings.color === '#0a84ff');
  check('the existing note keeps its own colour', store.oiBlocks.blocks[0].color === '#ff2d55');

  const second = ui.clickAt(400, 400);
  ui.type('blue one', second.querySelector('.ink'));
  await sleep(400);
  check('new note uses the new colour', store.oiBlocks.blocks[1].color === '#0a84ff');

  const firstInk = first.querySelector('.ink');
  firstInk.focus();
  ui.finish(firstInk);
  chrome._sendToContent({ type: 'oi:set-ink', ink: { color: '#34c759' }, blockId: first.dataset.id });
  check('selected note restyled from the popup', store.oiBlocks.blocks[0].color === '#34c759');
  check('the other note untouched', store.oiBlocks.blocks[1].color === '#0a84ff');
  chrome._sendToContent({ type: 'oi:set-ink', ink: { color: '#ff8800', fontSize: 88, font: 'mono' }, blockId: first.dataset.id });
  check('custom colour applied to the selected note', store.oiBlocks.blocks[0].color === '#ff8800');
  check('size applied to the selected note', store.oiBlocks.blocks[0].fontSize === 88);
  check('font applied to the selected note', store.oiBlocks.blocks[0].font === 'mono');
  check('other note keeps its own size', store.oiBlocks.blocks[1].fontSize === 44);
  check('style reaches the element', first.style.getPropertyValue('--sz') === '88px');
  const previous = JSON.stringify(store.oiSettings);
  chrome._sendToContent({ type: 'oi:set-ink', ink: { color: '#ffffff' }, blockId: 'deleted-note' });
  check('a stale note target cannot accidentally change defaults', JSON.stringify(store.oiSettings) === previous);
}

section('no toolbar margin: writing can start at the very top of the page');
{
  const { win } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);
  const note = ui.clickAt(70, 1);
  check('caret lands at y=1 without a reserved bar area', note.style.top === '1px');
  check('near-top move/delete handles are placed below the note', note.dataset.atTop === 'true');
}

section('moving and deleting a note');
{
  const { win, store } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);

  const el = ui.clickAt(200, 200);
  ui.type('drag me', el.querySelector('.ink'));
  ui.finish(el.querySelector('.ink'));
  await sleep(400);

  // jsdom has no layout engine: report the rectangle a browser would, so the
  // drag maths can be checked the way it actually behaves on a page.
  el.getBoundingClientRect = () => ({
    left: parseFloat(el.style.left) || 0,
    top: parseFloat(el.style.top) || 0,
    width: 120, height: 40, right: 0, bottom: 0, x: 0, y: 0
  });

  const grip = el.querySelector('.grip');
  grip.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200, clientY: 200, button: 0, pointerId: 1 }));
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 500, clientY: 380, pointerId: 1 }));
  win.dispatchEvent(new win.MouseEvent('pointerup', { clientX: 500, clientY: 380, pointerId: 1 }));
  await sleep(400);

  check('the note moved on screen', el.style.left === '500px' && el.style.top === '380px', { left: el.style.left, top: el.style.top });
  check('the move was saved', Math.abs(store.oiBlocks.blocks[0].x - 500 / win.innerWidth) < 0.001, store.oiBlocks.blocks[0]);

  ui.click(el.querySelector('.del'));
  await sleep(400);
  check('delete removes it from the canvas', ui.blocks().length === 0);
  check('delete is saved', store.oiBlocks.blocks.length === 0, store.oiBlocks);
}

section('an empty note disappears when you click away');
{
  const { win, store } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);

  const el = ui.clickAt(300, 300);
  check('empty note exists while it has the caret', ui.blocks().length === 1);
  ui.finish(el.querySelector('.ink'));
  await sleep(400);
  check('it is dropped once you leave it', ui.blocks().length === 0);

  const kept = ui.clickAt(300, 300);
  ui.type('not empty', kept.querySelector('.ink'));
  ui.finish(kept.querySelector('.ink'));
  await sleep(400);
  check('a note with text stays', ui.blocks().length === 1 && store.oiBlocks.blocks.length === 1);
}

section('clear wipes the canvas, colour survives');
{
  const { win, store, chrome } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);

  ui.type('a', ui.clickAt(100, 150).querySelector('.ink'));
  ui.type('b', ui.clickAt(400, 300).querySelector('.ink'));
  await sleep(400);
  check('two notes before clearing', store.oiBlocks.blocks.length === 2);

  chrome._sendToContent({ type: 'oi:clear' });
  await sleep(400);
  check('canvas emptied', ui.blocks().length === 0);
  check('storage emptied', store.oiBlocks.blocks.length === 0, store.oiBlocks);
}

section('the overlay stays transparent');
{
  const { win } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);
  const style = ui.shadow.querySelector('style').textContent;

  check('background defaults to 0%', win.__overlayInkState().settings.bgOpacity === 0);
  check('scrim uses the background variable', style.includes('--oi-bg, transparent'));
  check('the note itself has no background', /\.blk \.ink \{[^}]*color: var\(--c/.test(style));
  check('canvas is transparent (no background rule)', !/\.canvas \{[^}]*background:/.test(style));
}

section('messages from the popup');
{
  const { win, chrome } = bootPage();
  const state = chrome._sendToContent({ type: 'oi:set-visible', visible: true });
  check('popup can switch the overlay on', state.visible === true, state);

  const viewState = chrome._sendToContent({ type: 'oi:set-mode', mode: 'view' });
  check('popup can switch mode', viewState.mode === 'view', viewState);
  check('mode applied in the DOM',
    win.document.querySelector('overlay-ink').shadowRoot.querySelector('.wrap').dataset.mode === 'view');

  const cleared = chrome._sendToContent({ type: 'oi:clear' });
  check('popup can clear the canvas', cleared.blocks === 0);

  const off = chrome._sendToContent({ type: 'oi:set-visible', visible: false });
  check('popup can switch it off', off.visible === false);
  check('host removed', win.document.querySelector('overlay-ink') === null);
}

section('escape leaves edit mode; alt+shift+h hides');
{
  const { win } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);
  const el = ui.clickAt(200, 250);
  ui.type('note', el.querySelector('.ink'));

  const escInBlock = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  el.querySelector('.ink').dispatchEvent(escInBlock);
  await sleep(20);
  check('escape inside a note deselects it', ui.shadow.querySelectorAll('.blk[data-selected="true"]').length === 0);
  check('still in edit mode after the first escape', ui.shadow.querySelector('.wrap').dataset.mode === 'edit');

  const escOnPage = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  win.dispatchEvent(escOnPage);
  check('a second escape switches to view', ui.shadow.querySelector('.wrap').dataset.mode === 'view');

  const hide = new win.KeyboardEvent('keydown', { key: 'H', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
  win.dispatchEvent(hide);
  check('alt+shift+h hid the overlay', win.document.querySelector('overlay-ink') === null);
}

section('returning focus from popup controls restores only an Edit-mode caret');
{
  const { win, chrome } = bootPage();
  chrome._sendToContent({ type: 'oi:set-visible', visible: true });
  const ui = overlay(win);
  const ink = ui.clickAt(200, 200).querySelector('.ink');
  ui.type('resume writing', ink); ui.finish(ink); await sleep(20);
  win.dispatchEvent(new win.Event('focus'));
  check('returning to the page refocuses the selected Edit note', ui.shadow.activeElement === ink);
  chrome._sendToContent({ type: 'oi:set-mode', mode: 'view' });
  win.dispatchEvent(new win.Event('focus'));
  check('returning to View never grabs the page’s keyboard focus', ui.shadow.activeElement !== ink && win.__overlayInkState().selected === null);
}

section('an Off canvas cannot reappear on a fullscreen change');
{
  const { win, chrome } = bootPage();
  chrome._sendToContent({ type: 'oi:set-visible', visible: true });
  chrome._sendToContent({ type: 'oi:set-visible', visible: false });
  win.document.dispatchEvent(new win.Event('fullscreenchange'));
  check('fullscreen never reattaches a hidden canvas', win.document.querySelector('overlay-ink') === null);
}

section('notes from 0.1 are not lost');
{
  const { win, store } = bootPage({ oiText: 'written with the old version' });
  win.__overlayInkToggle();
  await sleep(30);
  const ui = overlay(win);
  check('the old note became a block', ui.blocks().length === 1);
  check('with its text intact', ui.inks()[0].textContent === 'written with the old version');
  check('and was written back as a block', store.oiBlocks.blocks[0].text === 'written with the old version', store.oiBlocks);
  check('the old key was cleared', store.oiText === '');
}

section('re-injecting the content script is harmless');
{
  const { win } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);
  ui.type('keep', ui.clickAt(100, 120).querySelector('.ink'));
  const result = injectScript(win, overlaySource);
  check('second run reports already loaded', result && result.alreadyLoaded === true, result);
  check('still exactly one overlay', win.document.querySelectorAll('overlay-ink').length === 1);
  check('the canvas is untouched', ui.shadow.querySelectorAll('.blk').length === 1);
}

section('storage changes from the options page reach an open overlay');
{
  const { win } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);

  win.chrome.storage.local.set({
    oiSettings: { mode: 'view', color: '#34c759', fontSize: 30, font: 'serif', bgOpacity: 25, textShadow: false }
  });
  await sleep(10);
  check('mode followed the options page', ui.shadow.querySelector('.wrap').dataset.mode === 'view');
  check('size followed the options page', win.__overlayInkState().settings.fontSize === 30);
  check('background followed the options page', ui.shadow.querySelector('.wrap').style.getPropertyValue('--oi-bg').includes('0.25'));

  win.chrome.storage.local.set({
    oiBlocks: { version: 2, blocks: [{ id: 'x1', x: 0.1, y: 0.1, text: 'typed in another tab', color: '#ffffff', fontSize: 20, font: 'sans' }] }
  });
  await sleep(10);
  check('notes from another tab appear', ui.blocks().length === 1);
  check('with their text', ui.inks()[0].textContent === 'typed in another tab');
}

section('manifest.json points at files that exist');
{
  const { existsSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const referenced = [];

  Object.values(manifest.icons || {}).forEach((p) => referenced.push(p));
  Object.values((manifest.action && manifest.action.default_icon) || {}).forEach((p) => referenced.push(p));
  if (manifest.background) referenced.push(manifest.background.service_worker);
  if (manifest.options_ui) referenced.push(manifest.options_ui.page);
  if (manifest.action.default_popup) referenced.push(manifest.action.default_popup);
  (manifest.content_scripts || []).forEach((cs) => (cs.js || []).forEach((p) => referenced.push(p)));
  (manifest.web_accessible_resources || []).forEach((war) => (war.resources || []).forEach((p) => referenced.push(p)));
  ['options/options.html', 'popup/popup.html'].forEach((p) => referenced.push(p));

  const missing = referenced.filter((p) => !p.includes('*') && !existsSync(join(root, p)));
  check(`manifest: all ${referenced.length} referenced files exist`, missing.length === 0, missing);
  check('manifest: version matches package.json',
    manifest.version === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  check('manifest: no additional host_permissions declared', !manifest.host_permissions);
  check('manifest: toolbar action uses a native popup', manifest.action.default_popup === 'popup/popup.html');
  check('manifest: the action shortcut opens popup controls', manifest.commands._execute_action.description.includes('popup'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  check('manifest: lockfile version matches too', lock.version === manifest.version && lock.packages[''].version === manifest.version);
}


section('native popup — opening is not On; all controls are here');
{
  const page = bootPage();
  const popup = await bootPopup(page);
  check('opening the popup does not turn the overlay on', !page.win.__overlayInkState().visible && !page.win.document.querySelector('overlay-ink'));
  check('initialisation never sends a toggle command', !popup.sent.some((m) => m.type === 'oi:toggle' || m.type === 'oi:set-visible'));
  check('the action popup is ready and On/Off is enabled', !popup.$('onOff').disabled && popup.$('controls').disabled === false);
  check('On/Off reflects the tab state', popup.$('onOff').checked === false);
  check('eight presets and the custom picker are inside the popup', popup.$('swatches').querySelectorAll('.swatch').length === 9);
  check('typed hex colour is inside the popup', !!popup.$('hexColor'));
  check('the demo bridge is inert in an installed extension popup', popup.win.chrome === popup.chrome);
  popup.$('swatches').querySelector('[data-color="#0a84ff"]').click();
  await sleep(20);
  check('preset colour is saved immediately as a new-note default', page.store.oiSettings.color === '#0a84ff');
  const custom = popup.$('swatches').querySelector('input[type="color"]');
  custom.value = '#123456'; custom.dispatchEvent(new popup.win.Event('input', { bubbles: true }));
  await sleep(20);
  check('custom colour picker is saved immediately', page.store.oiSettings.color === '#123456');
  const hex = popup.$('hexColor');
  hex.focus(); hex.value = 'abc'; hex.dispatchEvent(new popup.win.Event('input', { bubbles: true }));
  await sleep(20);
  check('typed hex supports short codes without a leading hash', page.store.oiSettings.color === '#aabbcc');
  hex.value = 'invalid'; hex.dispatchEvent(new popup.win.Event('input', { bubbles: true }));
  await sleep(10);
  check('invalid hex never changes the ink', page.store.oiSettings.color === '#aabbcc' && hex.getAttribute('aria-invalid') === 'true');
  hex.value = '#f0a'; hex.dispatchEvent(new popup.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(20);
  check('Enter commits and normalises the hex colour', page.store.oiSettings.color === '#ff00aa' && hex.value === '#ff00aa');
  popup.change('size', '72', 'input');
  popup.change('font', 'mono');
  popup.change('bg', '18', 'input');
  popup.change('shadow', false);
  await sleep(20);
  check('size and font are editable from the popup', page.store.oiSettings.fontSize === 72 && page.store.oiSettings.font === 'mono');
  check('background and outline are editable from the popup', page.store.oiSettings.bgOpacity === 18 && page.store.oiSettings.textShadow === false);
  popup.click('reset'); await sleep(20);
  check('reset restores defaults without enabling the overlay', page.store.oiSettings.bgOpacity === 0 && page.store.oiSettings.fontSize === 44 && !page.win.__overlayInkState().visible);

  check('the popup content is version-labelled for updates', popup.win.document.querySelector('.foot').textContent.includes('v' + JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version));
  popup.change('onOff', true); await sleep(20);
  check('On explicitly enables the canvas', page.win.__overlayInkState().visible && popup.$('onOff').checked);
  check('the page contains no floating toolbar after On', !overlay(page.win).shadow.querySelector('.bar, .hint, .topwrap'));
  const ui = overlay(page.win);
  const writing = ui.clickAt(250, 20).querySelector('.ink');
  ui.type('hello from the clear canvas', writing);
  ui.finish(writing); await sleep(20);
  popup.click('done'); await sleep(20);
  check('Done closes the popup', popup.isClosed());
  check('closing the popup does not turn the overlay off', page.win.__overlayInkState().visible);
  check('closing the popup restores the selected note’s caret', ui.shadow.activeElement === writing);
  ui.type('hello from the clear canvas — still typing');
  check('the user can keep typing with the popup closed', writing.textContent.endsWith('still typing'));
  popup.destroy();
  const reopened = await bootPopup(page);
  check('reopening the icon keeps the overlay on', page.win.__overlayInkState().visible && reopened.$('onOff').checked);
  reopened.click('close'); await sleep(10);
  check('the close icon also closes only the popup', reopened.isClosed() && page.win.__overlayInkState().visible);
  reopened.destroy();
}

section('native popup — selection survives focus, restyling, defaults and clear');
{
  const page = bootPage();
  page.chrome._sendToContent({ type: 'oi:set-visible', visible: true });
  const ui = overlay(page.win);
  const first = ui.clickAt(100, 140);
  ui.type('first note', first.querySelector('.ink'));
  const second = ui.clickAt(500, 400);
  ui.type('second note', second.querySelector('.ink'));
  first.querySelector('.ink').focus(); ui.finish(first.querySelector('.ink'));
  await sleep(400);
  const popup = await bootPopup(page);
  check('the popup identifies the selected note even after blur', popup.$('styleTarget').textContent === 'Editing selected note' && !popup.$('newNotes').hidden);
  popup.change('hexColor', '#112233', 'input');
  popup.change('size', '90', 'input'); popup.change('font', 'serif');
  await sleep(20);
  check('popup colour, size and font restyle the selected note', page.store.oiBlocks.blocks[0].color === '#112233' && page.store.oiBlocks.blocks[0].fontSize === 90 && page.store.oiBlocks.blocks[0].font === 'serif');
  check('restyling leaves the other note and defaults untouched', page.store.oiBlocks.blocks[1].color === '#ff2d55' && page.win.__overlayInkState().settings.color === '#ff2d55');
  popup.click('reset'); await sleep(20);
  check('Reset defaults never resets a note’s own style', page.store.oiBlocks.blocks[0].color === '#112233' && page.store.oiBlocks.blocks[0].fontSize === 90);
  popup.click('newNotes');
  // This is deliberately immediate: the next change must target defaults,
  // even before New notes' response comes back from the content script.
  popup.$('swatches').querySelector('[data-color="#34c759"]').click();
  await sleep(20);
  check('New notes deselects the page note', page.win.__overlayInkState().selected === null && popup.$('newNotes').hidden);
  check('New notes changes defaults, not the former selection', page.store.oiSettings.color === '#34c759' && page.store.oiBlocks.blocks[0].color === '#112233');
  check('popup makes the default target explicit', popup.$('styleTarget').textContent === 'Style for new notes');

  const view = popup.$('modeSeg').querySelector('[data-mode="view"]');
  view.click(); await sleep(20);
  check('View is set from the popup', page.win.__overlayInkState().mode === 'view');
  check('View makes all existing notes read-only', ui.inks().every((ink) => ink.getAttribute('contenteditable') === 'false'));
  check('View removes the selected-note state', page.win.__overlayInkState().selected === null);
  const css = ui.shadow.querySelector('style').textContent;
  check('View makes note blocks click-through and hides their handles', css.includes('.wrap[data-mode="view"] .blk { pointer-events: none; }') && css.includes('.wrap[data-mode="view"] .tools { display: none; }'));
  check('there is no clickable control bar in View', !ui.shadow.querySelector('[role="toolbar"], input, select'));
  popup.$('modeSeg').querySelector('[data-mode="edit"]').click(); await sleep(20);
  check('Edit makes the notes editable again', ui.inks().every((ink) => ink.getAttribute('contenteditable') === 'true'));
  popup.click('clear');
  check('clear asks for confirmation in the popup', popup.$('clear').classList.contains('armed') && page.store.oiBlocks.blocks.length === 2);
  popup.click('clear'); await sleep(20);
  check('confirmed clear empties the canvas and legacy storage', ui.blocks().length === 0 && page.store.oiBlocks.blocks.length === 0 && page.store.oiText === '');
  check('clear keeps the new-note colour', page.store.oiSettings.color === '#34c759');
  popup.change('onOff', false); await sleep(20);
  check('Off hides the canvas from the popup', !page.win.__overlayInkState().visible && page.win.document.querySelector('overlay-ink') === null);
  popup.destroy();
}

section('popup — safe close, cross-tab changes and restricted pages');
{
  const page = bootPage();
  const popup = await bootPopup(page, { responseDelay: 10 });
  popup.change('size', '55', 'input');
  popup.change('size', '80', 'input');
  popup.destroy();
  await sleep(30);
  check('closing immediately after a control change cannot lose the latest value', page.store.oiSettings.fontSize === 80);
  const reopened = await bootPopup(page);
  check('the next popup reads the saved value', reopened.$('size').value === '80');
  page.chrome.storage.local.set({ oiSettings: { mode: 'view', color: '#ffd60a', fontSize: 25, font: 'sans', bgOpacity: 12, textShadow: false } });
  await sleep(20);
  check('external settings changes reach an already-open popup', reopened.$('size').value === '25' && reopened.$('bg').value === '12' && reopened.$('modeSeg').querySelector('[data-mode="view"]').getAttribute('aria-pressed') === 'true');
  reopened.win.document.dispatchEvent(new reopened.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(20);
  check('Escape closes the popup without changing the mode or visibility', reopened.isClosed() && page.win.__overlayInkState().mode === 'view' && !page.win.__overlayInkState().visible);
  reopened.destroy();
  const optionsPopup = await bootPopup(page);
  optionsPopup.click('options'); await sleep(20);
  check('Options uses the browser options API', optionsPopup.optionsOpened() === 1 && optionsPopup.isClosed());
  optionsPopup.destroy();
}
{
  for (const url of ['brave://settings', 'https://chromewebstore.google.com/detail/x']) {
    const page = bootPage();
    const popup = await bootPopup(page, { url });
    check('restricted popup disables On/Off: ' + url, popup.$('onOff').disabled && !popup.$('banner').hidden);
    check('restricted page is never injected', popup.injections() === 0);
    popup.destroy();
  }
  const page = bootPage({}, { overlay: false });
  const popup = await bootPopup(page);
  check('popup injects the overlay into a tab that predates installation', popup.injections() === 1 && !popup.$('onOff').disabled);
  check('injection alone never enables the canvas', !page.win.__overlayInkState().visible);
  popup.destroy();
  const blockedPage = bootPage({}, { overlay: false });
  const blocked = await bootPopup(blockedPage, { injectFail: true });
  check('injection failure is shown instead of a nonworking switch', blocked.$('onOff').disabled && !blocked.$('banner').hidden);
  blocked.destroy();
  const stale = await bootPopup(bootPage(), { oldState: true });
  check('an older content script asks for a reload instead of leaving an old bar behind', stale.$('onOff').disabled && stale.$('banner').textContent.includes('Reload'));
  stale.destroy();
}

section('background — badge only; the action no longer toggles directly');
{
  const events = {};
  const badge = {};
  const menus = [];
  let openedOptions = 0;
  const chrome = {
    action: {
      setBadgeText: (value) => Object.assign(badge, value),
      setBadgeBackgroundColor: (value) => { badge.color = value.color; },
      setBadgeTextColor: () => {}, setTitle: (value) => { badge.title = value.title; }
      // No action.onClicked: a default_popup action must never depend on it.
    },
    runtime: {
      onMessage: { addListener: (fn) => { events.message = fn; } },
      onInstalled: { addListener: (fn) => { events.install = fn; } },
      onStartup: { addListener: (fn) => { events.startup = fn; } },
      openOptionsPage: (callback) => { openedOptions += 1; callback(); }
    },
    tabs: { onUpdated: { addListener: (fn) => { events.updated = fn; } } },
    contextMenus: {
      removeAll: (callback) => { menus.length = 0; callback(); },
      create: (menu) => menus.push(menu),
      onClicked: { addListener: (fn) => { events.menu = fn; } }
    }
  };
  new Function('chrome', readFileSync(join(root, 'background.js'), 'utf8'))(chrome);
  events.message({ type: 'oi:state', visible: true, mode: 'edit' }, { tab: { id: 7 } });
  check('EDIT badge follows the canvas state', badge.text === 'EDIT' && badge.color === '#7c3aed');
  check('action tooltip offers controls, not click-to-hide', badge.title.includes('controls') && !badge.title.includes('hide'));
  events.message({ type: 'oi:state', visible: true, mode: 'view' }, { tab: { id: 7 } });
  check('VIEW badge follows the canvas state', badge.text === 'VIEW' && badge.color === '#0f9d58');
  events.updated(7, { status: 'loading' });
  check('navigation clears the badge', badge.text === '');
  events.install({ reason: 'update' });
  check('old quick-panel / toggle menus are replaced with Options only', menus.length === 1 && menus[0].id === 'oi-options');
  events.menu({ menuItemId: 'oi-options' });
  check('Options context menu works', openedOptions === 1);
}

section('demo — the real popup and canvas work together');
{
  const demoDom = await JSDOM.fromFile(join(root, 'demo', 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true
  });
  doms.push(demoDom);
  const win = demoDom.window;
  await new Promise((resolve) => {
    if (win.document.readyState === 'complete') resolve(); else win.addEventListener('load', resolve);
  });
  const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
  check('demo visibly identifies the current popup canvas build',
    win.document.querySelector('.kicker').textContent.includes(`v${version}`) &&
    win.document.querySelector('.kicker').textContent.includes('popup') &&
    win.document.querySelector('.footer').textContent.includes(`v${version}`));
  const assets = Array.from(win.document.querySelectorAll('script[src], link[rel="stylesheet"], img[src]'));
  check('demo asset URLs bypass older cached builds', assets.every((asset) => new URL(asset.src || asset.href).searchParams.get('v') === version));
  check('demo loads the real content script', typeof win.__overlayInkToggle === 'function');

  const icon = win.document.getElementById('toolbarIcon');
  const container = win.document.getElementById('demoPopup');
  const badge = win.document.getElementById('badge');
  async function openDemoPopup() {
    icon.click();
    await waitFor(() => container.querySelector('iframe')?.contentDocument?.body?.dataset.ready === 'true', 'demo popup', 5000);
    const frame = container.querySelector('iframe');
    return { frame, win: frame.contentWindow, $: (id) => frame.contentDocument.getElementById(id) };
  }
  const popup = await openDemoPopup();
  check('toolbar icon opens a dropdown, not the canvas itself', !container.hidden && !win.document.querySelector('overlay-ink'));
  check('the demo reuses the installed popup HTML', new URL(popup.frame.src).pathname.endsWith('/popup/popup.html'));
  check('the popup frame is versioned too', new URL(popup.frame.src).searchParams.get('v') === version);
  check('the same full colour picker and hex control are loaded', !!popup.$('swatches').querySelector('input[type="color"]') && !!popup.$('hexColor'));
  const popupAssets = Array.from(popup.frame.contentDocument.querySelectorAll('script[src], link[rel="stylesheet"], img[src]'));
  check('popup assets bypass older cached builds', popupAssets.every((asset) => new URL(asset.src || asset.href).searchParams.get('v') === version));
  popup.$('onOff').checked = true;
  popup.$('onOff').dispatchEvent(new popup.win.Event('change', { bubbles: true }));
  await sleep(20);
  check('On in the demo popup enables the real canvas', win.__overlayInkState().visible && !!win.document.querySelector('overlay-ink'));
  check('demo badge follows On', badge.hidden === false && badge.textContent === 'EDIT');
  popup.$('done').click(); await sleep(20);
  check('Done removes the popup but leaves the overlay on', container.hidden && win.__overlayInkState().visible);
  const ui = overlay(win);
  check('the demo has no on-page control bar or hint', !ui.shadow.querySelector('.bar, .hint, .topwrap'));
  const note = ui.clickAt(480, 300);
  ui.type('a freely placed demo note', note.querySelector('.ink'));
  await sleep(400);
  check('after closing the popup, click-anywhere writing works', note.style.left === '480px' && note.style.top === '300px' && note.querySelector('.ink').textContent === 'a freely placed demo note');

  const editing = await openDemoPopup();
  check('reopening the popup does not hide notes', win.__overlayInkState().visible && ui.blocks().length === 1);
  check('the real popup sees the page’s selected note', editing.$('styleTarget').textContent === 'Editing selected note');
  editing.$('hexColor').focus(); editing.$('hexColor').value = '#0a84ff';
  editing.$('hexColor').dispatchEvent(new editing.win.Event('input', { bubbles: true }));
  await sleep(20);
  check('demo popup colour changes reach that note', note.style.getPropertyValue('--c') === '#0a84ff');
  editing.$('done').click(); await sleep(20);
  check('demo Done restores the selected note’s caret after using popup fields', container.hidden && ui.shadow.activeElement === note.querySelector('.ink'));
  const viewing = await openDemoPopup();
  viewing.$('modeSeg').querySelector('[data-mode="view"]').click(); await sleep(20);
  check('demo popup View changes the real canvas', ui.shadow.querySelector('.wrap').dataset.mode === 'view');
  check('demo badge follows View', badge.textContent === 'VIEW');
  viewing.$('close').click(); await sleep(20);
  check('closing View controls leaves view-only notes visible', container.hidden && win.__overlayInkState().visible && note.querySelector('.ink').getAttribute('contenteditable') === 'false');
  win.document.getElementById('sampleAction').click();
  check('the demo’s ordinary page button works in View', win.document.getElementById('sampleAction').textContent.includes('clicked 1 time'));

  const off = await openDemoPopup();
  off.$('onOff').checked = false; off.$('onOff').dispatchEvent(new off.win.Event('change', { bubbles: true }));
  await sleep(20);
  check('Off is controlled from the demo popup', !win.__overlayInkState().visible && !win.document.querySelector('overlay-ink'));
  check('Off clears the badge but remembers the note', badge.hidden && win.__overlayInkState().blocks === 1);
  icon.click();
  check('clicking the toolbar again closes only the popup', container.hidden && !win.__overlayInkState().visible);

  const resumed = await openDemoPopup();
  resumed.$('onOff').checked = true; resumed.$('onOff').dispatchEvent(new resumed.win.Event('change', { bubbles: true }));
  await sleep(20);
  resumed.$('modeSeg').querySelector('[data-mode="edit"]').click(); await sleep(20);
  const resumedUi = overlay(win);
  const nextNote = resumedUi.clickAt(150, 210);
  check('outside click dismisses the demo popup and places a note at the same point', container.hidden && nextNote.style.left === '150px' && nextNote.style.top === '210px');
  check('outside dismissal never toggles Off', win.__overlayInkState().visible);
  resumedUi.type('the popup stays out of the way', nextNote.querySelector('.ink'));
  const modeBefore = win.__overlayInkState().mode;
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'O', altKey: true, shiftKey: true, cancelable: true }));
  await waitFor(() => container.querySelector('iframe')?.contentDocument?.body?.dataset.ready === 'true', 'shortcut popup', 5000);
  check('Alt+Shift+O opens controls instead of hiding the overlay', !container.hidden && win.__overlayInkState().visible);
  const shortcutWindow = container.querySelector('iframe').contentWindow;
  shortcutWindow.document.dispatchEvent(new shortcutWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(20);
  check('Escape inside the popup closes only the controls', container.hidden && win.__overlayInkState().mode === modeBefore && win.__overlayInkState().visible);
}

doms.forEach((dom) => dom.window.close());
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('smoke test OK');
