/**
 * Connect the real action popup to the web demo when it is inside its iframe.
 * In an installed extension this file is a no-op: it never replaces Brave's
 * APIs, nor can an arbitrary web page supply an extension API bridge.
 */
(function () {
  'use strict';
  if (!/^(https?:|file:)$/.test(window.location.protocol)) return;
  if (window.parent === window || new URL(window.location.href).searchParams.get('demo') !== '1') return;
  try {
    if (window.parent.location.origin !== window.location.origin) return;
    const browser = window.parent.__overlayInkDemoBrowser;
    if (!browser) return;
    const api = browser.createPopupApi();
    window.chrome = api.chrome;
    window.__overlayInkDemoDispose = api.dispose;
    window.close = function () {
      api.dispose();
      window.parent.dispatchEvent(new window.parent.CustomEvent('oi:close-popup'));
    };
    window.addEventListener('pagehide', api.dispose);
  } catch (err) { /* Not the same-origin demo. Use the real browser API. */ }
})();
