/**
 * Overlay Ink — background service worker.
 *
 * Two jobs:
 *   1. Turn a click on the toolbar icon (or the Alt+Shift+O shortcut, which
 *      fires the same `action.onClicked` event through `_execute_action`)
 *      into a toggle of the overlay on that tab.
 *   2. Keep the toolbar badge in sync with what the overlay is doing:
 *      "EDIT" / "VIEW" while it is on, nothing while it is off.
 *
 * The overlay itself lives entirely in the content script; this file only
 * routes messages and paints the badge.
 */

const SUPPORTED_URL = /^(https?|file|ftp):/i;
const BADGE_COLORS = { edit: '#7c3aed', view: '#0f9d58' };
const FLASH_COLOR = '#dc2626';

/** Send a message to a tab; resolves with the response, or null if nobody is listening. */
function sendToTab(tabId, message) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, message, function (response) {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response || null);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

/** Make sure the content script is present in this tab (it may predate the install). */
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['common.js', 'content/overlay.js']
    });
    return true;
  } catch (err) {
    console.warn('[Overlay Ink] cannot run on this page:', err && err.message);
    return false;
  }
}

async function toggleOnTab(tabId, url) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  // `url` is only known because clicking the action grants activeTab; if it is
  // missing we simply try anyway and let executeScript decide.
  if (url && !SUPPORTED_URL.test(url)) {
    flashBadge(tabId);
    return;
  }

  let state = await sendToTab(tabId, { type: 'oi:toggle' });
  if (!state) {
    if (!(await ensureContentScript(tabId))) {
      flashBadge(tabId);
      return;
    }
    state = await sendToTab(tabId, { type: 'oi:toggle' });
  }
  if (state) paintBadge(tabId, state);
  else flashBadge(tabId);
}

function paintBadge(tabId, state) {
  const visible = Boolean(state && state.visible);
  const mode = state && state.mode === 'view' ? 'view' : 'edit';
  const title = visible
    ? 'Overlay Ink — ' + (mode === 'edit' ? 'Edit' : 'View') + ' mode on this tab (click to hide)'
    : 'Overlay Ink — click to write on this page (Alt+Shift+O)';
  setMenuTitle(visible);
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: visible ? (mode === 'edit' ? 'EDIT' : 'VIEW') : '' });
    if (visible) {
      chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: BADGE_COLORS[mode] });
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ tabId: tabId, color: '#ffffff' });
      }
    }
    chrome.action.setTitle({ tabId: tabId, title: title });
  } catch (err) {
    /* tab went away — nothing to do */
  }
}

let flashTimers = new Map();

/** Short red "!" for pages where the overlay cannot be injected. */
function flashBadge(tabId) {
  try {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: FLASH_COLOR });
    chrome.action.setBadgeText({ tabId: tabId, text: '!' });
    chrome.action.setTitle({
      tabId: tabId,
      title: 'Overlay Ink cannot run here (browser pages, the Web Store and PDF viewers are off limits)'
    });
  } catch (err) {
    return;
  }
  clearTimeout(flashTimers.get(tabId));
  flashTimers.set(tabId, setTimeout(function () {
    flashTimers.delete(tabId);
    paintBadge(tabId, { visible: false });
  }, 1800));
}

/* ---------------------------------------------------------- quick panel -- */

const PANEL = { url: 'popup/popup.html', width: 366, height: 660 };

/** Open popup.html as a small always-available window. */
function openPanel() {
  try {
    chrome.windows.create({
      url: PANEL.url,
      type: 'popup',
      width: PANEL.width,
      height: PANEL.height
    }, function () { void chrome.runtime.lastError; });
  } catch (err) {
    openOptions();
  }
}

function openOptions() {
  try {
    chrome.runtime.openOptionsPage(function () { void chrome.runtime.lastError; });
  } catch (err) {
    /* ignore */
  }
}

/* --------------------------------------------------------- context menu -- */

const MENU = { toggle: 'oi-toggle', panel: 'oi-panel', options: 'oi-options' };

function setMenuTitle(visible) {
  try {
    chrome.contextMenus.update(MENU.toggle, {
      title: visible ? 'Overlay Ink: hide the overlay' : 'Overlay Ink: write on this page'
    }, function () { void chrome.runtime.lastError; });
  } catch (err) {
    /* menu not created yet */
  }
}

function buildMenus() {
  try {
    chrome.contextMenus.removeAll(function () {
      void chrome.runtime.lastError;
      chrome.contextMenus.create({
        id: MENU.toggle,
        title: 'Overlay Ink: write on this page',
        contexts: ['action', 'page', 'selection']
      });
      chrome.contextMenus.create({
        id: MENU.panel,
        title: 'Overlay Ink: quick panel',
        contexts: ['action']
      });
      chrome.contextMenus.create({
        id: MENU.options,
        title: 'Overlay Ink: options',
        contexts: ['action']
      });
    });
  } catch (err) {
    /* ignore */
  }
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(function (info, tab) {
    if (info.menuItemId === MENU.panel) {
      openPanel();
    } else if (info.menuItemId === MENU.options) {
      openOptions();
    } else if (info.menuItemId === MENU.toggle && tab && typeof tab.id === 'number') {
      toggleOnTab(tab.id, tab.url);
    }
  });
}

/* ---------------------------------------------------------------- wiring -- */

chrome.action.onClicked.addListener(function (tab) {
  if (tab && typeof tab.id === 'number') toggleOnTab(tab.id, tab.url);
});

// The content script announces every visibility/mode change so the badge on the
// tab strip follows what the user does inside the page toolbar too.
chrome.runtime.onMessage.addListener(function (message, sender) {
  if (!message || message.type !== 'oi:state') return;
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId === 'number') paintBadge(tabId, message);
});

// A navigation throws the overlay away, so drop the badge with it.
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo && changeInfo.status === 'loading') paintBadge(tabId, { visible: false });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  clearTimeout(flashTimers.get(tabId));
  flashTimers.delete(tabId);
});

chrome.runtime.onInstalled.addListener(function (details) {
  buildMenus();
  if (details.reason === 'install') {
    console.info('[Overlay Ink] installed — click the toolbar icon (or press Alt+Shift+O) to write on a page.');
  }
});

// The service worker loses its menus when it is torn down.
chrome.runtime.onStartup.addListener(buildMenus);
