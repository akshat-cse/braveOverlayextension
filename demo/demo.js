/** The fake browser toolbar opens the same popup Brave opens. */
(function () {
  'use strict';

  const icon = document.getElementById('toolbarIcon');
  const badge = document.getElementById('badge');
  const popup = document.getElementById('demoPopup');
  const notice = document.getElementById('demoNotice');
  const version = document.querySelector('.browserChrome').dataset.version;
  let noticeTimer;

  if (typeof window.__overlayInkState !== 'function') {
    icon.disabled = true; icon.title = 'The content script did not load'; return;
  }

  function paint(state) {
    badge.hidden = !state.visible;
    badge.textContent = state.mode === 'view' ? 'VIEW' : 'EDIT';
    badge.dataset.mode = state.mode;
    icon.title = state.visible ? 'Overlay Ink — open controls (' + state.mode + ' mode)' : 'Overlay Ink — open controls (Alt+Shift+O)';
  }

  function closePopup() {
    const frame = popup.querySelector('iframe');
    if (frame) {
      try { if (frame.contentWindow.__overlayInkDemoDispose) frame.contentWindow.__overlayInkDemoDispose(); } catch (err) { /* ignore */ }
      frame.remove();
    }
    popup.hidden = true;
    icon.setAttribute('aria-expanded', 'false');
  }

  function openPopup() {
    if (!popup.hidden) return;
    const frame = document.createElement('iframe');
    frame.title = 'Overlay Ink extension popup controls';
    frame.src = '../popup/popup.html?demo=1&v=' + version;
    popup.appendChild(frame);
    popup.hidden = false;
    icon.setAttribute('aria-expanded', 'true');
  }

  icon.addEventListener('click', function () {
    if (popup.hidden) openPopup(); else closePopup();
  });

  // Like a native extension popup: dismiss on an outside click without hiding
  // the overlay, and let that same click place a note on the clear canvas.
  window.addEventListener('pointerdown', function (event) {
    if (popup.hidden || popup.contains(event.target) || icon.contains(event.target)) return;
    closePopup();
  }, true);

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !popup.hidden) {
      event.preventDefault(); event.stopImmediatePropagation(); closePopup(); return;
    }
    if (!event.altKey || !event.shiftKey || String(event.key).toLowerCase() !== 'o') return;
    event.preventDefault();
    if (popup.hidden) openPopup(); else closePopup();
  }, true);

  window.addEventListener('oi:close-popup', closePopup);
  window.addEventListener('oi:state', function (event) { if (event.detail) paint(event.detail); });
  window.addEventListener('oi:demo-options', function () {
    notice.textContent = 'In Brave, this opens the extension’s options and shortcut settings. All page controls are already in the popup here.';
    notice.hidden = false; clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { notice.hidden = true; }, 6500);
  });

  let clicks = 0;
  document.getElementById('sampleAction').addEventListener('click', function (event) {
    clicks += 1; event.currentTarget.textContent = 'Page button clicked ' + clicks + (clicks === 1 ? ' time' : ' times');
  });
  paint(window.__overlayInkState());
})();
