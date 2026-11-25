// Isolated-world bridge on https://web.whatsapp.com/*
// Relays chrome.storage / chrome.runtime messages safely into the MAIN world (`wa-main-sender.js`).

(function () {
  'use strict';

  function forwardToMain(payload) {
    if (!payload) return;
    window.postMessage({ __asWaMain: 'NEW_STICKER', payload }, location.origin);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'WA_BRIDGE_NEW_STICKER' && msg.payload) {
      forwardToMain(msg.payload);
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.__asWaBridge === 'READY') {
      chrome.storage.local.get(['pendingSoundSticker'], (res) => {
        if (res && res.pendingSoundSticker) {
          forwardToMain(res.pendingSoundSticker);
        }
      });
    } else if (ev.data.__asWaBridge === 'CLEAR_PENDING') {
      chrome.storage.local.remove(['pendingSoundSticker']);
    }
  });
})();
