// Isolated content script running on AudioSticker Studio (http://localhost:* / 127.0.0.1:*)
// Announces extension presence to the Studio web app and forwards compiled Sound Stickers to WhatsApp Web.

(function () {
  'use strict';

  function announceStatus() {
    chrome.runtime.sendMessage({ type: 'STUDIO_PING' }, (resp) => {
      if (chrome.runtime.lastError) return;
      window.postMessage(
        {
          type: 'AUDIOSTICKER_EXT_STATUS',
          installed: true,
          version: resp?.extensionVersion || '2.0.0',
          waTabOpen: !!resp?.waTabOpen
        },
        '*'
      );
    });
  }

  announceStatus();
  setInterval(announceStatus, 4000);

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'AUDIOSTICKER_SEND_REAL_STICKER') {
      chrome.runtime.sendMessage(
        {
          type: 'STUDIO_SEND_SOUND_STICKER',
          payload: event.data.payload
        },
        (resp) => {
          window.postMessage(
            {
              type: 'AUDIOSTICKER_SEND_ACK',
              ok: !chrome.runtime.lastError && !!resp?.ok,
              error: chrome.runtime.lastError?.message || resp?.error || null
            },
            '*'
          );
        }
      );
    }
  });
})();
