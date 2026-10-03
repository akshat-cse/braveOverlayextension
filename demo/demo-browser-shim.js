/**
 * Browser API stand-in for the web demo only. The demo uses the real content
 * script AND the real popup, connected as if they were separate extension
 * contexts. Installed extensions get all of these APIs from Brave instead.
 */
(function () {
  'use strict';

  const KEY = 'overlay-ink-demo:';
  const memory = {};
  const contentListeners = [];
  const storageListeners = [];
  const popupSubscribers = new Set();
  const TAB = { id: 1, url: 'https://example.com/research/reading-notes' };

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function read(key) {
    try {
      const raw = localStorage.getItem(KEY + key);
      if (raw !== null) return JSON.parse(raw);
    } catch (err) { /* file demo or private mode: use memory */ }
    return clone(memory[key]);
  }
  function write(key, value) {
    memory[key] = clone(value);
    try { localStorage.setItem(KEY + key, JSON.stringify(value)); } catch (err) { /* private mode */ }
  }
  function fireStorage(changes) {
    storageListeners.slice().forEach(function (fn) { fn(changes, 'local'); });
  }

  const storage = {
    local: {
      get: function (keys, callback) {
        const out = {};
        if (typeof keys === 'string') out[keys] = read(keys);
        else if (Array.isArray(keys)) keys.forEach(function (key) { out[key] = read(key); });
        else ['oiSettings', 'oiBlocks', 'oiText'].forEach(function (key) { out[key] = read(key); });
        setTimeout(function () { callback(out); }, 0);
      },
      set: function (values, callback) {
        const changes = {};
        Object.keys(values).forEach(function (key) {
          changes[key] = { oldValue: read(key), newValue: clone(values[key]) };
          write(key, values[key]);
        });
        fireStorage(changes);
        if (callback) setTimeout(callback, 0);
      }
    },
    onChanged: {
      addListener: function (fn) { storageListeners.push(fn); },
      removeListener: function (fn) {
        const index = storageListeners.indexOf(fn);
        if (index !== -1) storageListeners.splice(index, 1);
      }
    }
  };

  function sendToContent(message) {
    let response;
    contentListeners.slice().forEach(function (fn) {
      fn(clone(message), {}, function (value) { response = clone(value); });
    });
    return response;
  }

  window.chrome = {
    runtime: {
      id: 'overlay-ink-demo', lastError: undefined,
      getURL: function (path) { return new URL('../' + path, window.location.href).href; },
      sendMessage: function (message, callback) {
        if (message && message.type === 'oi:state') {
          window.dispatchEvent(new CustomEvent('oi:state', { detail: clone(message) }));
          popupSubscribers.forEach(function (subscriber) {
            subscriber.listeners.slice().forEach(function (fn) { fn(clone(message), { tab: TAB }); });
          });
        }
        if (callback) callback(undefined);
      },
      onMessage: { addListener: function (fn) { contentListeners.push(fn); } }
    },
    storage: storage
  };

  window.__overlayInkDemoBrowser = {
    sendToContent: sendToContent,
    createPopupApi: function () {
      const subscriber = { listeners: [] };
      popupSubscribers.add(subscriber);
      return {
        chrome: {
          runtime: {
            id: 'overlay-ink-demo', lastError: undefined,
            onMessage: {
              addListener: function (fn) { subscriber.listeners.push(fn); },
              removeListener: function (fn) {
                subscriber.listeners = subscriber.listeners.filter(function (listener) { return listener !== fn; });
              }
            },
            openOptionsPage: function (callback) {
              window.dispatchEvent(new CustomEvent('oi:demo-options'));
              if (callback) setTimeout(callback, 0);
            }
          },
          storage: storage,
          tabs: {
            query: function (query, callback) { setTimeout(function () { callback([clone(TAB)]); }, 0); },
            sendMessage: function (tabId, message, callback) {
              const response = tabId === TAB.id ? sendToContent(message) : null;
              if (callback) setTimeout(function () { callback(response); }, 0);
            }
          },
          scripting: {
            executeScript: function () {
              return typeof window.__overlayInkState === 'function' ? Promise.resolve([]) : Promise.reject(new Error('Demo is not ready'));
            }
          }
        },
        dispose: function () { popupSubscribers.delete(subscriber); }
      };
    }
  };

  // Keep another open copy of the demo in step with localStorage too.
  window.addEventListener('storage', function (event) {
    if (!event.key || !event.key.startsWith(KEY)) return;
    try {
      const key = event.key.slice(KEY.length);
      fireStorage({ [key]: {
        oldValue: event.oldValue === null ? undefined : JSON.parse(event.oldValue),
        newValue: event.newValue === null ? undefined : JSON.parse(event.newValue)
      } });
    } catch (err) { /* ignore corrupt external values */ }
  });
})();
