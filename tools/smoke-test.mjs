/**
 * Headless smoke test for Overlay Ink.
 *
 *   npm install
 *   npm test
 *
 * Loads common.js + content/overlay.js into a jsdom page with a fake chrome
 * API and drives the overlay the way the popup and the toolbar button would:
 * toggle it, switch modes, type, hide, re-inject.
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

  const chrome = {
    runtime: {
      id: 'smoke-test',
      lastError: undefined,
      getURL: (path) => `chrome-extension://smoke-test/${path}`,
      sendMessage: (message, callback) => {
        state.sent.push(message);
        if (callback) callback(undefined);
      },
      onMessage: {
        addListener: (fn) => state.runtimeListeners.push(fn)
      }
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
      onChanged: {
        addListener: (fn) => state.storageListeners.push(fn)
      }
    },
    _state: state,
    _sendToContent: (message) => {
      const fromContent = state.runtimeListeners;
      let response;
      fromContent.slice().forEach((fn) => fn(message, {}, (value) => { response = value; }));
      return response;
    }
  };

  return chrome;
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

function bootPage() {
  const dom = new JSDOM('<!doctype html><html><body><h1>demo page</h1></body></html>', {
    url: 'https://example.com/article',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const store = {};
  const chrome = createFakeChrome(store);
  dom.window.chrome = chrome;
  injectScript(dom.window, commonSource);
  injectScript(dom.window, overlaySource);
  return { dom, win: dom.window, chrome, store };
}

/* -------------------------------------------------------------------- run -- */

section('common.js — settings normalisation');
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
  const { win, chrome, store } = bootPage();

  const afterToggle = win.__overlayInkToggle();
  const host = win.document.querySelector('overlay-ink');
  check('toggle reports visible', afterToggle.visible === true, afterToggle);
  check('host element is on the page', !!host);
  check('shadow root is open', !!(host && host.shadowRoot));
  check('state message reached the worker', chrome._state.sent.some((m) => m.type === 'oi:state' && m.visible));

  const shadow = host.shadowRoot;
  const wrap = shadow.querySelector('.wrap');
  const note = shadow.querySelector('.note');
  check('bar rendered', !!shadow.querySelector('.bar'));
  check('8 preset swatches + custom', shadow.querySelectorAll('.swatch').length === 9);
  check('starts in the stored mode', wrap.dataset.mode === 'edit');
  check('edit button is pressed', shadow.querySelector('.segbtn[data-mode="edit"]').getAttribute('aria-pressed') === 'true');
  check('note is a textarea', note.tagName === 'TEXTAREA');

  check('toggle reports hidden again', win.__overlayInkToggle().visible === false);
  check('host removed from the page', win.document.querySelector('overlay-ink') === null);
  check('note survived in storage', store.oiText === '' && 'oiText' in store);
}

section('typing, persistence and re-opening');
{
  const { win, store } = bootPage();
  win.__overlayInkToggle();
  const shadow = win.document.querySelector('overlay-ink').shadowRoot;
  const note = shadow.querySelector('.note');

  note.value = 'Remember: buy milk';
  note.dispatchEvent(new win.Event('input', { bubbles: true }));

  check('text kept in memory', win.__overlayInkState().visible === true);
  await sleep(500); // the save is debounced
  check('text stored globally', store.oiText === 'Remember: buy milk', store.oiText);

  win.__overlayInkToggle();               // hide
  win.__overlayInkToggle();               // show again
  const reopened = win.document.querySelector('overlay-ink').shadowRoot.querySelector('.note');
  check('text restored on re-open', reopened.value === 'Remember: buy milk', reopened.value);
}

section('picking options from the in-page toolbar');
{
  const { win, store } = bootPage();
  win.__overlayInkToggle();
  const shadow = win.document.querySelector('overlay-ink').shadowRoot;
  const wrap = shadow.querySelector('.wrap');
  const win2 = win;

  function click(selector) {
    const el = shadow.querySelector(selector);
    el.dispatchEvent(new win2.MouseEvent('click', { bubbles: true, composed: true }));
  }

  click('[data-mode="view"]');
  check('view mode applied', wrap.dataset.mode === 'view');
  check('view mode persisted', store.oiSettings.mode === 'view');

  click('.swatch[data-color="#0a84ff"]');
  check('colour applied', store.oiSettings.color === '#0a84ff');
  check('swatch marked selected', shadow.querySelector('[data-color="#0a84ff"]').getAttribute('aria-pressed') === 'true');

  const size = shadow.querySelector('.sizeRange');
  size.value = '72';
  size.dispatchEvent(new win.Event('input', { bubbles: true }));
  check('size readout follows the slider', shadow.querySelector('.sizeVal').textContent === '72px');
  await sleep(400); // saved on a short debounce
  check('size persisted', store.oiSettings.fontSize === 72, store.oiSettings.fontSize);
  check('earlier choices not lost', store.oiSettings.color === '#0a84ff', store.oiSettings);

  const font = shadow.querySelector('.fonts');
  font.value = 'mono';
  font.dispatchEvent(new win.Event('change', { bubbles: true }));
  check('font persisted', store.oiSettings.font === 'mono');

  click('.shadowBtn');
  check('text outline toggles', store.oiSettings.textShadow === false);

  // Clear needs two clicks, like a "sure?" confirmation.
  click('.clearBtn');
  check('clear asks first', shadow.querySelector('.clearBtn').classList.contains('armed'));
  click('.clearBtn');
  check('second click clears the note', store.oiText === '');

  await sleep(350);
}

section('messages from the popup');
{
  const { win, chrome } = bootPage();
  const state = chrome._sendToContent({ type: 'oi:set-visible', visible: true });
  check('popup can switch the overlay on', state.visible === true, state);
  check('host exists after popup toggle', !!win.document.querySelector('overlay-ink'));

  const viewState = chrome._sendToContent({ type: 'oi:set-mode', mode: 'view' });
  check('popup can switch mode', viewState.mode === 'view', viewState);
  check('mode applied in the DOM',
    win.document.querySelector('overlay-ink').shadowRoot.querySelector('.wrap').dataset.mode === 'view');

  const off = chrome._sendToContent({ type: 'oi:set-visible', visible: false });
  check('popup can switch it off', off.visible === false);
  check('host removed', win.document.querySelector('overlay-ink') === null);
}

section('escape leaves edit mode; alt+shift+h hides');
{
  const { win } = bootPage();
  win.__overlayInkToggle();
  const shadow = win.document.querySelector('overlay-ink').shadowRoot;
  const note = shadow.querySelector('.note');

  const esc = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  note.dispatchEvent(esc);
  check('escape switched to view', shadow.querySelector('.wrap').dataset.mode === 'view');

  const hide = new win.KeyboardEvent('keydown', { key: 'H', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
  win.dispatchEvent(hide);
  check('alt+shift+h hid the overlay', win.document.querySelector('overlay-ink') === null);
}

section('re-injecting the content script is harmless');
{
  const { win } = bootPage();
  win.__overlayInkToggle();
  const result = injectScript(win, overlaySource);
  check('second run reports already loaded', result && result.alreadyLoaded === true, result);
  check('still exactly one overlay', win.document.querySelectorAll('overlay-ink').length === 1);
  check('still visible', win.__overlayInkState().visible === true);
}

section('storage changes from the options page reach an open overlay');
{
  const { win, store } = bootPage();
  win.__overlayInkToggle();
  const shadow = win.document.querySelector('overlay-ink').shadowRoot;

  // the same call the options page makes
  win.chrome.storage.local.set({
    oiSettings: { mode: 'view', color: '#34c759', fontSize: 30, font: 'serif', bgOpacity: 25, textShadow: false }
  });
  await sleep(10);

  check('mode followed the options page', shadow.querySelector('.wrap').dataset.mode === 'view');
  check('size followed the options page', shadow.querySelector('.sizeRange').value === '30');
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
  check('demo: clicking the toolbar icon opens the overlay', !!win.document.querySelector('overlay-ink'));
  check('demo: badge follows the state', win.document.getElementById('badge').hidden === false);

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
