/**
 * Wires the pretend toolbar icon in the demo up to the real overlay, the way
 * background.js does in an installed extension.
 */
(function () {
  'use strict';

  const icon = document.getElementById('toolbarIcon');
  const badge = document.getElementById('badge');

  if (typeof window.__overlayInkToggle !== 'function') {
    icon.disabled = true;
    icon.title = 'The content script did not load';
    return;
  }

  function paint(state) {
    badge.hidden = !state.visible;
    badge.textContent = state.mode === 'view' ? 'VIEW' : 'EDIT';
    badge.dataset.mode = state.mode;
    icon.title = state.visible
      ? 'Overlay Ink — click to hide (Alt+Shift+O)'
      : 'Overlay Ink — click to write on this page (Alt+Shift+O)';
  }

  icon.addEventListener('click', function () {
    paint(window.__overlayInkToggle());
  });

  // Alt+Shift+O mirrors the extension shortcut.
  window.addEventListener('keydown', function (event) {
    if (!event.altKey || !event.shiftKey) return;
    if (String(event.key).toLowerCase() !== 'o') return;
    event.preventDefault();
    paint(window.__overlayInkToggle());
  });

  // Keep the badge honest when the mode is switched inside the overlay.
  window.addEventListener('oi:state', function (event) {
    if (event && event.detail) paint(event.detail);
  });

  paint(window.__overlayInkState());
})();
