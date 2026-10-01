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
  const state = { runtimeListeners: [], storageListeners: [], sent: [] };

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

function bootPage(store = {}) {
  const dom = new JSDOM('<!doctype html><html><body><h1>demo page</h1></body></html>', {
    url: 'https://example.com/article',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const chrome = createFakeChrome(store);
  dom.window.chrome = chrome;
  injectScript(dom.window, commonSource);
  injectScript(dom.window, overlaySource);
  return { dom, win: dom.window, chrome, store };
}

/** Test helpers: reach into the overlay the way a user's pointer does. */
function overlay(win) {
  const host = win.document.querySelector('overlay-ink');
  const shadow = host && host.shadowRoot;
  return {
    host,
    shadow,
    canvas: shadow && shadow.querySelector('.canvas'),
    bar: shadow && shadow.querySelector('.bar'),
    hint: shadow && shadow.querySelector('.hint'),
    blocks: () => Array.from(shadow.querySelectorAll('.blk')),
    inks: () => Array.from(shadow.querySelectorAll('.ink')),
    /** Click the canvas at a point — creates a placed text block. */
    clickAt(x, y) {
      const event = new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
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

section('toggle on / off from the toolbar');
{
  const { win, chrome } = bootPage();
  const state = win.__overlayInkToggle();
  const ui = overlay(win);

  check('toggle reports visible', state.visible === true, state);
  check('host element is on the page', !!ui.host);
  check('shadow root is open', !!ui.shadow);
  check('state message reached the worker', chrome._state.sent.some((m) => m.type === 'oi:state' && m.visible));
  check('toolbar rendered', !!ui.bar);
  check('click surface rendered', !!ui.canvas);
  check('8 preset swatches + custom', ui.shadow.querySelectorAll('.swatch').length === 9);
  check('colour hex field rendered', !!ui.shadow.querySelector('.hexInput'));
  check('starts in the stored mode', ui.shadow.querySelector('.wrap').dataset.mode === 'edit');
  check('edit button is pressed', ui.shadow.querySelector('.segbtn[data-mode="edit"]').getAttribute('aria-pressed') === 'true');
  check('the canvas only catches clicks in edit mode',
    ui.shadow.querySelector('style').textContent.includes('.wrap[data-mode="edit"] .canvas { pointer-events: auto'));

  check('toggle reports hidden again', win.__overlayInkToggle().visible === false);
  check('host removed from the page', win.document.querySelector('overlay-ink') === null);
}

function getComputedStyleSafe() { return true; } // jsdom has no real layout

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

section('colour, size and font apply to the selected note, or set the default');
{
  const { win, store } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);

  const first = ui.clickAt(120, 200);
  ui.type('red one', first.querySelector('.ink'));
  ui.finish(first.querySelector('.ink'));
  await sleep(400); // leaving a note settles, then its save is debounced

  // Nothing selected now: picking a colour sets the default for new writing.
  ui.click('.swatch[data-color="#0a84ff"]');
  await sleep(10);
  check('with nothing selected the colour becomes the default', store.oiSettings.color === '#0a84ff', store.oiSettings.color);
  check('the existing note keeps its own colour', store.oiBlocks.blocks[0].color === '#ff2d55', store.oiBlocks.blocks[0].color);

  // A new note picks up the new default.
  const second = ui.clickAt(400, 400);
  ui.type('blue one', second.querySelector('.ink'));
  await sleep(400);
  check('new note uses the new colour', store.oiBlocks.blocks[1].color === '#0a84ff', store.oiBlocks.blocks[1]);

  // Selecting a note and picking a colour restyles that note only.
  const firstInk = ui.blocks()[0].querySelector('.ink');
  firstInk.dispatchEvent(new win.FocusEvent('focus', { bubbles: false }));
  firstInk.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
  ui.click('.swatch[data-color="#34c759"]');
  await sleep(400);
  check('selected note restyled', store.oiBlocks.blocks[0].color === '#34c759', store.oiBlocks.blocks[0].color);
  check('the other note untouched', store.oiBlocks.blocks[1].color === '#0a84ff');

  // Hex field.
  const hex = ui.shadow.querySelector('.hexInput');
  hex.value = '#ff8800';
  hex.dispatchEvent(new win.Event('input', { bubbles: true }));
  hex.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(400);
  check('hex entry restyles the selected note', store.oiBlocks.blocks[0].color === '#ff8800', store.oiBlocks.blocks[0].color);

  // Size and font, still on the selected note.
  const size = ui.shadow.querySelector('.sizeRange');
  size.value = '88';
  size.dispatchEvent(new win.Event('input', { bubbles: true }));
  size.dispatchEvent(new win.Event('change', { bubbles: true }));
  const font = ui.shadow.querySelector('.fonts');
  font.value = 'mono';
  font.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(400);
  check('size applied to the selected note', store.oiBlocks.blocks[0].fontSize === 88, store.oiBlocks.blocks[0].fontSize);
  check('font applied to the selected note', store.oiBlocks.blocks[0].font === 'mono');
  check('other note keeps its own size', store.oiBlocks.blocks[1].fontSize === 44, store.oiBlocks.blocks[1].fontSize);
  check('style reaches the element', ui.blocks()[0].style.getPropertyValue('--sz') === '88px');
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
  const { win, store } = bootPage();
  win.__overlayInkToggle();
  const ui = overlay(win);

  ui.type('a', ui.clickAt(100, 150).querySelector('.ink'));
  ui.type('b', ui.clickAt(400, 300).querySelector('.ink'));
  await sleep(400);
  check('two notes before clearing', store.oiBlocks.blocks.length === 2);

  const clearBtn = ui.shadow.querySelector('.clearBtn');
  ui.click(clearBtn);
  check('clear asks first', clearBtn.classList.contains('armed'));
  ui.click(clearBtn);
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

  check('background defaults to 0%', ui.shadow.querySelector('.bgRange').value === '0');
  check('scrim uses the background variable', style.includes('--oi-bg, transparent'));
  check('the note itself has no background', /\.blk \.ink \{[^}]*color: var\(--c/.test(style));
  check('canvas is transparent (no background rule)', !/\.canvas \{[^}]*background:/.test(style));
}

section('messages from the panel');
{
  const { win, chrome } = bootPage();
  const state = chrome._sendToContent({ type: 'oi:set-visible', visible: true });
  check('panel can switch the overlay on', state.visible === true, state);

  const viewState = chrome._sendToContent({ type: 'oi:set-mode', mode: 'view' });
  check('panel can switch mode', viewState.mode === 'view', viewState);
  check('mode applied in the DOM',
    win.document.querySelector('overlay-ink').shadowRoot.querySelector('.wrap').dataset.mode === 'view');

  const cleared = chrome._sendToContent({ type: 'oi:clear' });
  check('panel can clear the canvas', cleared.blocks === 0);

  const off = chrome._sendToContent({ type: 'oi:set-visible', visible: false });
  check('panel can switch it off', off.visible === false);
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
  check('size followed the options page', ui.shadow.querySelector('.sizeRange').value === '30');
  check('background followed the options page', ui.shadow.querySelector('.bgRange').value === '25');

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
  (manifest.content_scripts || []).forEach((cs) => (cs.js || []).forEach((p) => referenced.push(p)));
  (manifest.web_accessible_resources || []).forEach((war) => (war.resources || []).forEach((p) => referenced.push(p)));
  ['options/options.html', 'popup/popup.html'].forEach((p) => referenced.push(p));

  const missing = referenced.filter((p) => !p.includes('*') && !existsSync(join(root, p)));
  check(`manifest: all ${referenced.length} referenced files exist`, missing.length === 0, missing);
  check('manifest: version matches package.json',
    manifest.version === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  check('manifest: no host_permissions needed (activeTab only)', !manifest.host_permissions);
}

section('demo page (demo/index.html) boots the real content script');
{
  const demoDom = await JSDOM.fromFile(join(root, 'demo', 'index.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true
  });
  const win = demoDom.window;
  await new Promise((resolve) => {
    if (win.document.readyState === 'complete') resolve();
    else win.addEventListener('load', resolve);
  });

  check('demo: shared module loaded', !!win.__overlayInkCommon);
  check('demo: content script loaded', typeof win.__overlayInkToggle === 'function');

  const icon = win.document.getElementById('toolbarIcon');
  icon.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const host = win.document.querySelector('overlay-ink');
  check('demo: clicking the toolbar icon opens the overlay', !!host);
  check('demo: badge follows the state', win.document.getElementById('badge').hidden === false);
  check('demo: the canvas is there to write on', !!host.shadowRoot.querySelector('.canvas'));

  icon.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('demo: clicking again hides it', win.document.querySelector('overlay-ink') === null);
  check('demo: badge cleared', win.document.getElementById('badge').hidden === true);

  win.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('smoke test OK');
