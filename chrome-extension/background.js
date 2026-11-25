// Background Service Worker:
// Relays compiled Native Sound Stickers (Animated WebP + Ogg/Opus) from AudioSticker Studio -> WhatsApp Web MAIN world.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'STUDIO_PING') {
    chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
      sendResponse({ ok: true, extensionVersion: '2.0.0', waTabOpen: tabs.length > 0 });
    });
    return true;
  }

  if (message.type === 'STUDIO_SEND_SOUND_STICKER') {
    const payload = message.payload;
    chrome.storage.local.set({ pendingSoundSticker: payload }, async () => {
      try {
        const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
        if (tabs.length > 0 && tabs[0].id) {
          const waTab = tabs[0];
          await chrome.tabs.update(waTab.id, { active: true });
          if (waTab.windowId != null) {
            await chrome.windows.update(waTab.windowId, { focused: true }).catch(() => {});
          }
          chrome.tabs.sendMessage(waTab.id, {
            type: 'WA_BRIDGE_NEW_STICKER',
            payload
          }).catch(() => {});
        } else {
          await chrome.tabs.create({ url: 'https://web.whatsapp.com' });
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    });
    return true;
  }
});
