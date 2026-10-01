/**
 * A stand-in for the browser's extension APIs, so that demo/index.html can run
 * the real content script on an ordinary web page. Only the handful of calls
 * content/overlay.js makes are implemented, backed by localStorage so the demo
 * remembers your note.
 *
 * This file has nothing to do with the installed extension — the browser
 * provides the real thing there.
 */
(function () {
  'use strict';

  const KEY = 'overlay-ink-demo:';
  const listeners = [];

  function read(key) {
    try {
      const raw = localStorage.getItem(KEY + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (err) {
      return undefined;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(KEY + key, JSON.stringify(value));
    } catch (err) { /* private mode */ }
  }

  window.chrome = {
    runtime: {
      id: 'overlay-ink-demo',
      lastError: undefined,
      // The content script asks for the handwriting font; in the demo it is a
      // plain relative path back to the repository root.
      getURL: function (path) { return '../' + path; },
      // The real content script reports visibility/mode changes to the worker;
      // here it becomes an event the demo page can listen for.
      sendMessage: function (message, callback) {
        if (message && message.type === 'oi:state') {
          window.dispatchEvent(new CustomEvent('oi:state', { detail: message }));
        }
        if (callback) callback(undefined);
      },
      onMessage: { addListener: function () {} }
    },
    storage: {
      local: {
        get: function (keys, callback) {
          const out = {};
          if (typeof keys === 'string') out[keys] = read(keys);
          else if (Array.isArray(keys)) keys.forEach(function (k) { out[k] = read(k); });
          else Object.keys(read('__all__') || {}).forEach(function (k) { out[k] = read(k); });
          setTimeout(function () { callback(out); }, 0);
        },
        set: function (values, callback) {
          const changes = {};
          Object.keys(values).forEach(function (key) {
            changes[key] = { oldValue: read(key), newValue: values[key] };
            write(key, values[key]);
          });
          listeners.slice().forEach(function (fn) { fn(changes, 'local'); });
          if (callback) setTimeout(callback, 0);
        }
      },
      onChanged: {
        addListener: function (fn) { listeners.push(fn); }
      }
    }
  };
})();
