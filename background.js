/**
 * Overlay Ink — MV3 background worker.
 *
 * The action opens popup/popup.html; it does not toggle the canvas directly.
 * The popup owns On/Off and every other control. This worker only follows the
 * page state for the EDIT / VIEW badge and exposes an Options context menu.
 */
const BADGE_COLORS = { edit: '#7c3aed', view: '#0f9d58' };

function paintBadge(tabId, state) {
  const visible = Boolean(state && state.visible);
  const mode = state && state.mode === 'view' ? 'view' : 'edit';
  const title = visible
    ? 'Overlay Ink — ' + (mode === 'edit' ? 'Edit' : 'View') + ' mode (click for controls)'
    : 'Overlay Ink — open controls (Alt+Shift+O)';
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: visible ? (mode === 'edit' ? 'EDIT' : 'VIEW') : '' });
    if (visible) {
      chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: BADGE_COLORS[mode] });
      if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId: tabId, color: '#ffffff' });
    }
    chrome.action.setTitle({ tabId: tabId, title: title });
  } catch (err) { /* The tab went away. */ }
}

function openOptions() {
  try {
    chrome.runtime.openOptionsPage(function () { void chrome.runtime.lastError; });
  } catch (err) { /* ignore */ }
}

function buildMenus() {
  if (!chrome.contextMenus) return;
  try {
    // Also removes the old toggle / separate-window controls after an upgrade.
    chrome.contextMenus.removeAll(function () {
      void chrome.runtime.lastError;
      chrome.contextMenus.create({ id: 'oi-options', title: 'Overlay Ink: options', contexts: ['action'] });
    });
  } catch (err) { /* ignore */ }
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(function (info) {
    if (info.menuItemId === 'oi-options') openOptions();
  });
}

chrome.runtime.onMessage.addListener(function (message, sender) {
  if (!message || message.type !== 'oi:state') return;
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId === 'number') paintBadge(tabId, message);
});

// A navigation throws the overlay away, so the badge follows it.
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo && changeInfo.status === 'loading') paintBadge(tabId, { visible: false });
});

chrome.runtime.onInstalled.addListener(function () {
  buildMenus();
  console.info('[Overlay Ink] click the toolbar icon to open controls, turn On, then close the popup and write.');
});
chrome.runtime.onStartup.addListener(buildMenus);
