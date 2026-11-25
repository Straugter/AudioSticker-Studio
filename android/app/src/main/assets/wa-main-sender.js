// MAIN-world script running inside https://web.whatsapp.com/*
// Works in BOTH:
//   1) Chrome Extension v2.0 (PC Desktop) — Shadow DOM dock UI on web.whatsapp.com
//   2) Invisible Android APK Background Engine (MainActivity.java) — zero visible WhatsApp Web;
//      sends REAL native Sound Stickers (🔊) to self chat ("Tú") or any chosen chat and opens
//      the official WhatsApp Android app (`com.whatsapp`) immediately!

(function () {
  'use strict';
  if (window.__AS_WA_MAIN_LOADED__) return;
  window.__AS_WA_MAIN_LOADED__ = true;

  const SOUND_PROPS = [
    'sound_stickers_consumption_enabled',
    'sound_stickers_creation_enabled',
    'sound_stickers_audio_playing_enabled'
  ];

  const isAndroidBackgroundEngine = Boolean(window.AndroidPayloadBridge);

  // ------------------------------------------------------------------ WhatsApp Web internal module helpers
  function hasLoader() {
    return typeof window.require === 'function' && typeof window.__d === 'function';
  }

  function ns(name) {
    if (typeof window.importNamespace === 'function') {
      try {
        const m = window.importNamespace(name);
        if (m) return m;
      } catch (_) {}
    }
    return window.require(name);
  }

  function def(name) {
    const m = ns(name);
    return m && m.default !== undefined ? m.default : m;
  }

  async function loadLazy(name, timeoutMs = 15000) {
    try {
      return ns(name);
    } catch (_) {}
    if (typeof window.requireLazy !== 'function') {
      throw new Error(`Módulo ${name} no disponible`);
    }
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Tiempo agotado cargando ${name}`)), timeoutMs);
      window.requireLazy([name], () => {
        clearTimeout(t);
        resolve();
      });
    });
    return ns(name);
  }

  let gatingForced = false;
  function forceSoundStickers() {
    if (gatingForced) return true;
    try {
      const AB = ns('WAWebABProps');
      const orig = AB.getABPropConfigValue;
      if (typeof orig === 'function' && !orig.__asPatched) {
        const patched = function (name) {
          if (SOUND_PROPS.includes(name)) return true;
          return orig.apply(this, arguments);
        };
        patched.__asPatched = true;
        AB.getABPropConfigValue = patched;
      }
    } catch (_) {}

    let G = null;
    try {
      G = ns('WAWebSoundStickerGating');
    } catch (_) {}

    const checkOk = () => {
      try {
        return G && G.isSoundStickerCreationEnabled() === true && G.isSoundStickerConsumptionEnabled() === true;
      } catch (_) {
        return false;
      }
    };

    if (G && !checkOk()) {
      try {
        G.isSoundStickerConsumptionEnabled = () => true;
        G.isSoundStickerCreationEnabled = () => true;
        G.isSoundStickerPlaybackEnabled = () => true;
      } catch (_) {}
    }
    gatingForced = !!G && checkOk();
    return gatingForced;
  }

  function base64ToUint8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toB64(v) {
    if (v == null || typeof v === 'string') return v;
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer || v);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  async function sha256B64(bytes) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
    let s = '';
    for (let i = 0; i < h.length; i++) s += String.fromCharCode(h[i]);
    return btoa(s);
  }

  function getActiveChat() {
    return ns('WAWebChatCollection').ChatCollection.getActive() || null;
  }

  function getSelfWidString() {
    try {
      const Me = ns('WAWebUserPrefsMeUser');
      const wid = (Me.getMaybeMePnUser && Me.getMaybeMePnUser()) || (Me.getMeUserOrThrow && Me.getMeUserOrThrow());
      return wid ? String(wid._serialized || wid) : '';
    } catch (_) {
      return '';
    }
  }

  async function getSelfChat() {
    const Me = ns('WAWebUserPrefsMeUser');
    const CC = ns('WAWebChatCollection').ChatCollection;
    const getters = ['getMaybeMePnUser', 'getMeUserOrThrow', 'getMaybeMeLidUser'];
    let firstWid = null;
    for (const g of getters) {
      try {
        const wid = Me[g] && Me[g]();
        if (!wid) continue;
        firstWid = firstWid || wid;
        const c = CC.get(wid) || CC.get(String(wid._serialized || wid));
        if (c) return c;
      } catch (_) {}
    }
    if (!firstWid) throw new Error('No se pudo encontrar tu propio chat (Tú).');
    const r = await ns('WAWebFindChatAction').findOrCreateLatestChat(firstWid, 'forwardSelectedModals');
    return (r && (r.chat || r)) || null;
  }

  function getRecentChatsList() {
    const list = [{ jid: '__SELF__', name: '⭐ Mi Chat (Tú)', isGroup: false, phone: '' }];
    try {
      const CC = ns('WAWebChatCollection').ChatCollection;
      const selfStr = getSelfWidString();
      const rawModels = typeof CC.getModelsArray === 'function' ? CC.getModelsArray() : Array.from(CC.models || []);
      const sorted = rawModels
        .filter((c) => c && c.id && !c.archive)
        .sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));

      for (const c of sorted) {
        if (list.length >= 18) break;
        const jid = String(c.id._serialized || c.id);
        if (!jid || jid === selfStr || jid.includes('status@broadcast') || jid.endsWith('@newsletter')) continue;
        const isGroup = jid.endsWith('@g.us');
        const phone = !isGroup && jid.endsWith('@c.us') ? jid.split('@')[0].replace(/\D/g, '') : '';
        const title = String(
          c.formattedTitle ||
            (c.contact && (c.contact.name || c.contact.pushname || c.contact.shortName)) ||
            c.name ||
            phone ||
            'Chat'
        ).trim();
        list.push({
          jid,
          name: (isGroup ? '👥 ' : '💬 ') + title.slice(0, 36),
          isGroup,
          phone
        });
      }
    } catch (_) {}
    return list;
  }

  async function resolveTargetChat(targetChatJid, destino) {
    if (targetChatJid && targetChatJid !== '__SELF__') {
      try {
        const CC = ns('WAWebChatCollection').ChatCollection;
        const found = CC.get(targetChatJid);
        if (found) return found;
      } catch (_) {}
    }
    if (destino === 'propio' || !targetChatJid || targetChatJid === '__SELF__') {
      return await getSelfChat();
    }
    return getActiveChat() || (await getSelfChat());
  }

  const noopQpl = new Proxy({}, { get: () => () => undefined });

  async function uploadAudioToWhatsApp(oggBlob, seconds, chat) {
    const MT = ns('WAWebMmsMediaTypes').MEDIA_TYPES;
    let uploadOrigin = 1;
    try {
      uploadOrigin = def('WAWebMediaGetUploadOriginForChat')(chat);
    } catch (_) {}

    const params = {
      blob: oggBlob,
      type: MT.AUDIO,
      signal: new AbortController().signal,
      uploadQpl: noopQpl,
      uploadOrigin,
      fileOrigin: undefined,
      userUploadAttemptCount: 0,
      forwardedFromWeb: false,
      isViewOnce: false,
      isHdPhoto: false
    };

    let res;
    try {
      const metrics = def('WAWebCreateMediaUploadMetrics')(params);
      res = await def('WAWebUploadManagerMainThread').encryptAndUpload(params, metrics);
    } catch (_) {
      res = await def('WAWebUploadManager').encryptAndUpload(params);
    }

    const bytes = new Uint8Array(await oggBlob.arrayBuffer());
    const filehash = await sha256B64(bytes);

    const stickerAudio = {
      deprecatedMms3Url: res.url || undefined,
      directPath: res.directPath,
      mediaKey: toB64(res.mediaKey),
      mediaKeyTimestamp: res.mediaKeyTimestamp,
      filehash,
      encFilehash: toB64(res.encFilehash),
      size: bytes.length,
      mimetype: 'audio/ogg; codecs=opus',
      duration: seconds
    };

    try {
      const ok = ns('WAWebSoundStickerUtils').isCompleteStickerAudio(stickerAudio);
      if (ok !== true) {
        throw new Error('WhatsApp rechazó la validación del audio (isCompleteStickerAudio=' + ok + ')');
      }
    } catch (err) {
      if (String(err.message || '').includes('isCompleteStickerAudio=')) throw err;
    }

    return stickerAudio;
  }

  async function sendNativeSoundSticker(chat, webpBlob, meta, stickerAudio) {
    const Opaque = def('WAWebMediaOpaqueData');
    const MediaPrep = def('WAWebMediaPrep');
    const opaque = await Opaque.createFromData(webpBlob, 'image/webp');
    const data = {
      type: 'sticker',
      mediaBlob: opaque,
      mimetype: 'image/webp',
      size: webpBlob.size,
      fullWidth: meta.side || 512,
      fullHeight: meta.side || 512,
      isAnimated: meta.isAnimated !== false,
      emojis: ['🔊']
    };
    const prep = new MediaPrep('sticker', Promise.resolve(data));
    const res = await prep.sendToChat({ chat, options: stickerAudio ? { stickerAudio } : {} });
    const OK = ns('WAWebSendMsgResultAction').SendMsgResult.OK;
    if (!res || res.messageSendResult !== OK) {
      throw new Error('WhatsApp devolvió estado: ' + (res && res.messageSendResult));
    }
    return res.msg;
  }

  async function waitForAck(msg, timeoutMs = 20000) {
    const ACK = ns('WAWebAck').ACK;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (msg.ack >= ACK.SENT) return msg.ack;
      if (msg.ack < 0) throw new Error('Error del servidor (ack ' + msg.ack + ')');
      await new Promise((r) => setTimeout(r, 250));
    }
    return msg.ack;
  }

  async function openForwardDialog(msg) {
    const React = ns('react');
    const MM = ns('WAWebModalManager');
    const FL = await loadLazy('WAWebForwardMessageFlowLoadable');
    const SU = ns('WAWebStateUtils');
    let model = msg;
    try {
      const MC = ns('WAWebMsgCollection').MsgCollection;
      model = MC.get(msg.id) || msg;
    } catch (_) {}
    const close = MM.closeModalManager || (() => MM.ModalManager.close());
    MM.ModalManager.open(
      React.createElement(FL.ForwardMessageFlowLoadable, {
        msgs: [SU.unproxy(model)],
        onClose: close,
        onForward: () => {}
      }),
      { transition: 'modal-flow' }
    );
  }

  async function publishToWhatsApp(payload, { destino = 'abierto', abrirReenviar = false, onStatus } = {}) {
    const status = onStatus || (() => {});
    if (!hasLoader()) throw new Error('WhatsApp todavía está iniciando. Espera unos segundos.');
    forceSoundStickers();

    status('Buscando chat de WhatsApp...');
    const chat = await resolveTargetChat(payload.targetChatJid, destino);
    if (!chat) {
      throw new Error(
        destino === 'propio'
          ? 'No se encontró tu chat en WhatsApp.'
          : 'Primero haz clic en un chat abierto en WhatsApp Web.'
      );
    }

    const webpBytes = base64ToUint8(payload.webpBase64);
    const oggBytes = base64ToUint8(payload.oggBase64);
    const webpBlob = new Blob([webpBytes], { type: 'image/webp' });
    const oggBlob = new Blob([oggBytes], { type: 'audio/ogg; codecs=opus' });

    status('Subiendo audio Ogg/Opus...');
    const stickerAudio = await uploadAudioToWhatsApp(oggBlob, payload.seconds || 3, chat);

    status('Enviando Sticker Real (🔊)...');
    const msg = await sendNativeSoundSticker(chat, webpBlob, payload, stickerAudio);

    if (abrirReenviar) {
      status('Confirmando envío...');
      await waitForAck(msg);
      status('Abriendo Reenviar...');
      await openForwardDialog(msg);
    }

    let targetPhone = '';
    try {
      const jid = String((chat.id && chat.id._serialized) || chat.id || '');
      const selfStr = getSelfWidString();
      if (jid && jid !== selfStr && jid.endsWith('@c.us')) {
        targetPhone = jid.split('@')[0].replace(/\D/g, '');
      }
    } catch (_) {}

    status('✅ ¡Sticker con Sonido enviado!');
    return { msg, targetPhone };
  }

  // ------------------------------------------------------------------ Bridge helpers (Android + Extension)
  let currentPayload = null;
  let previewUrls = [];
  let busy = false;
  let autoSendTriggeredForSha = null;
  let waModulesReady = false;

  function reportAndroidProgress(txt) {
    try {
      if (window.AndroidPayloadBridge && typeof window.AndroidPayloadBridge.onSendProgress === 'function') {
        window.AndroidPayloadBridge.onSendProgress(txt);
      } else if (window.AndroidPayloadBridge && typeof window.AndroidPayloadBridge.updateHeaderStatus === 'function') {
        window.AndroidPayloadBridge.updateHeaderStatus(txt);
      }
    } catch (_) {}
  }

  // Only render the floating Shadow DOM dock on Desktop Chrome Extension (not needed inside Android APK!)
  let setStatus = () => {};
  let setBusyState = (v) => {
    busy = v;
  };
  let loadDockPreview = () => {};

  if (!isAndroidBackgroundEngine) {
    function h(tag, props, ...children) {
      const el = document.createElement(tag);
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (k === 'class') el.className = v;
          else if (k === 'style') el.style.cssText = v;
          else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
          else el[k] = v;
        }
      }
      for (const c of children) {
        if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
      return el;
    }

    const host = h('div', { id: 'as-wa-native-host' });
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const CSS = `
      :host { all: initial; font-family: system-ui, "Segoe UI", Roboto, sans-serif; }
      .dock { position: fixed; bottom: 16px; right: 12px; z-index: 2147483000; width: min(318px, calc(100vw - 24px));
              background: #111b21; color: #e9edef; border: 2px solid #10b981; border-radius: 16px;
              padding: 12px 14px; box-shadow: 0 14px 36px rgba(0,0,0,0.62); font-size: 12.5px; box-sizing: border-box; }
      .dock.min { width: auto; padding: 8px 12px; }
      .hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .badge { background: #10b981; color: #020617; font-weight: 800; font-size: 10.5px; padding: 2px 7px; border-radius: 99px; }
      .title { font-weight: 800; font-size: 13px; color: #fff; }
      .minBtn { background: #202c33; border: 1px solid #2a3942; color: #cbd5e1; border-radius: 8px; width: 24px; height: 24px; cursor: pointer; font-weight: 700; }
      .body { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
      .body.hidden { display: none; }
      .previewRow { display: flex; align-items: center; gap: 10px; background: #0b141a; border: 1px solid #202c33; border-radius: 12px; padding: 8px; }
      .thumb { width: 64px; height: 64px; object-fit: contain; border-radius: 8px;
               background: repeating-conic-gradient(#222e35 0 25%, #182229 0 50%) 50% / 12px 12px; flex: none; }
      .meta { flex: 1; min-width: 0; }
      .metaTitle { font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .metaSub { font-size: 11px; color: #8696a0; margin-top: 2px; }
      .btn { width: 100%; border: 0; border-radius: 10px; padding: 9px 11px; font-weight: 800; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; transition: opacity .15s; }
      .btn:disabled { opacity: 0.45; cursor: default; }
      .btnPrimary { background: #25D366; color: #020617; }
      .btnSecondary { background: #005c4b; color: #fff; border: 1px solid rgba(37,211,102,0.4); }
      .btnGhost { background: #202c33; color: #e9edef; border: 1px solid #2a3942; padding: 6px 10px; font-weight: 700; font-size: 11px; width: auto; }
      .status { font-size: 11.5px; color: #94a3b8; line-height: 1.35; }
      .status.ok { color: #34d399; font-weight: 700; }
      .status.err { color: #fb7185; font-weight: 700; }
      .tag { font-size: 10px; background: rgba(0,0,0,0.22); padding: 2px 6px; border-radius: 6px; }
    `;

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      shadow.append(h('style', { textContent: CSS }));
    }

    const thumbImg = h('img', { class: 'thumb', alt: 'Sticker' });
    const metaTitle = h('div', { class: 'metaTitle' }, 'Esperando desde Studio...');
    const metaSub = h('div', { class: 'metaSub' }, 'Abre localhost:3000 y pulsa Enviar');
    const btnPreviewPlay = h('button', { class: 'btn btnGhost', textContent: '▶ Oír', disabled: true });
    const previewRow = h('div', { class: 'previewRow' }, thumbImg, h('div', { class: 'meta' }, metaTitle, metaSub), btnPreviewPlay);
    previewRow.style.display = 'none';

    const statusLbl = h('div', { class: 'status' }, '🔊 Modo Stickers con Sonido activado. Crea uno en Studio.');
    const btnSendOpen = h(
      'button',
      { class: 'btn btnPrimary', disabled: true },
      h('span', null, '🔊 Enviar al Chat Abierto'),
      h('span', { class: 'tag' }, 'Sticker Real')
    );
    const btnSendSelfFwd = h(
      'button',
      { class: 'btn btnSecondary', disabled: true },
      h('span', null, '⭐ Guardar en Tú + Reenviar'),
      h('span', { class: 'tag' }, 'Con diálogo')
    );

    const bodyEl = h('div', { class: 'body' }, previewRow, statusLbl, btnSendOpen, btnSendSelfFwd);
    const minBtn = h('button', { class: 'minBtn', textContent: '−', title: 'Minimizar' });
    const dockEl = h(
      'div',
      { class: 'dock' },
      h('div', { class: 'hdr' }, h('div', { style: 'display:flex;align-items:center;gap:6px' }, h('span', { class: 'badge' }, '🔊 REAL'), h('span', { class: 'title' }, 'AudioSticker Studio')), minBtn),
      bodyEl
    );
    shadow.append(dockEl);

    minBtn.addEventListener('click', () => {
      const hidden = bodyEl.classList.toggle('hidden');
      dockEl.classList.toggle('min', hidden);
      minBtn.textContent = hidden ? '+' : '−';
    });

    setStatus = (txt, mode = '') => {
      statusLbl.textContent = txt;
      statusLbl.className = 'status' + (mode ? ' ' + mode : '');
    };

    setBusyState = (isBusy) => {
      busy = isBusy;
      const ready = !!currentPayload && !busy;
      btnSendOpen.disabled = !ready;
      btnSendSelfFwd.disabled = !ready;
      btnPreviewPlay.disabled = !ready;
    };

    let activeAudioEl = null;
    loadDockPreview = (payload) => {
      previewUrls.forEach((u) => URL.revokeObjectURL(u));
      previewUrls = [];
      const webpUrl = URL.createObjectURL(new Blob([base64ToUint8(payload.webpBase64)], { type: 'image/webp' }));
      const oggUrl = URL.createObjectURL(new Blob([base64ToUint8(payload.oggBase64)], { type: 'audio/ogg; codecs=opus' }));
      previewUrls.push(webpUrl, oggUrl);
      thumbImg.src = webpUrl;
      metaTitle.textContent = payload.packName || 'AudioSticker Studio';
      metaSub.textContent = `${payload.side || 512}px · ${payload.seconds || 3}s · WebP ${payload.webpKB || '?'} KB + Opus ${payload.oggKB || '?'} KB`;
      previewRow.style.display = '';
      bodyEl.classList.remove('hidden');
      dockEl.classList.remove('min');
      minBtn.textContent = '−';
      setStatus('✨ ¡Sticker con Sonido listo! Haz clic en Enviar.', 'ok');
    };

    btnPreviewPlay.addEventListener('click', () => {
      if (!previewUrls[1]) return;
      if (activeAudioEl) {
        activeAudioEl.pause();
        activeAudioEl = null;
      }
      const u = thumbImg.src;
      thumbImg.src = '';
      thumbImg.src = u;
      activeAudioEl = new Audio(previewUrls[1]);
      activeAudioEl.play().catch(() => {});
    });

    btnSendOpen.addEventListener('click', () => triggerPublish('abierto', false, false));
    btnSendSelfFwd.addEventListener('click', () => triggerPublish('propio', true, false));
  }

  function loadStickerPayload(payload) {
    currentPayload = payload;
    loadDockPreview(payload);
    setBusyState(false);
  }

  async function triggerPublish(destino, abrirReenviar, autoOpenOfficialWhatsApp = false) {
    if (!currentPayload || busy) return;
    setBusyState(true);
    try {
      const { msg, targetPhone } = await publishToWhatsApp(currentPayload, {
        destino,
        abrirReenviar,
        onStatus: (m) => {
          setStatus(m);
          reportAndroidProgress(m);
        }
      });

      if (autoOpenOfficialWhatsApp) {
        reportAndroidProgress('Confirmando entrega...');
        await waitForAck(msg, 12000).catch(() => {});
      }

      setStatus('✅ ¡Enviado como Sticker Real con Sonido (🔊)!', 'ok');
      window.postMessage({ __asWaBridge: 'CLEAR_PENDING' }, location.origin);
      if (window.AndroidPayloadBridge && typeof window.AndroidPayloadBridge.clearPendingPayload === 'function') {
        try { window.AndroidPayloadBridge.clearPendingPayload(); } catch (_) {}
      }
      currentPayload = null;

      if (
        autoOpenOfficialWhatsApp &&
        window.AndroidPayloadBridge &&
        typeof window.AndroidPayloadBridge.onStickerSentAndOpenWhatsApp === 'function'
      ) {
        window.AndroidPayloadBridge.onStickerSentAndOpenWhatsApp(targetPhone || '');
      }
    } catch (err) {
      const msgTxt = err && err.message ? err.message : String(err);
      setStatus('❌ ' + msgTxt, 'err');
      if (window.AndroidPayloadBridge && typeof window.AndroidPayloadBridge.onSendError === 'function') {
        try { window.AndroidPayloadBridge.onSendError(msgTxt); } catch (_) {}
      }
    } finally {
      setBusyState(false);
    }
  }

  function maybeAutoSendInApk() {
    if (!waModulesReady || !currentPayload || busy) return;
    if (!currentPayload.autoSend) return;
    const sig = (currentPayload.soundSha256 || String(currentPayload.webpKB)) + '|' + (currentPayload.targetChatJid || '');
    if (autoSendTriggeredForSha === sig) return;
    autoSendTriggeredForSha = sig;
    triggerPublish('propio', false, true);
  }

  function pullFromAndroidApkBridge() {
    if (window.AndroidPayloadBridge && typeof window.AndroidPayloadBridge.peekPendingPayload === 'function') {
      try {
        const raw = window.AndroidPayloadBridge.peekPendingPayload();
        if (raw && raw.length > 20) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.webpBase64 && parsed.oggBase64) {
            loadStickerPayload(parsed);
            maybeAutoSendInApk();
          }
        }
      } catch (_) {}
    }
  }
  window.__AS_PUSH_ANDROID_PAYLOAD__ = pullFromAndroidApkBridge;
  window.__AS_REFRESH_CHATS__ = () => {
    if (waModulesReady && window.AndroidPayloadBridge && typeof window.AndroidPayloadBridge.onWhatsAppReady === 'function') {
      try {
        window.AndroidPayloadBridge.onWhatsAppReady(JSON.stringify(getRecentChatsList()));
      } catch (_) {}
    }
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.__asWaMain === 'NEW_STICKER' && ev.data.payload) {
      loadStickerPayload(ev.data.payload);
    }
  });

  // Detect WhatsApp session readiness OR login screen automatically
  (async function waitAndActivate() {
    pullFromAndroidApkBridge();
    let notifiedNeedsLogin = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      if (hasLoader()) {
        try {
          const CC = ns('WAWebChatCollection');
          const Me = ns('WAWebUserPrefsMeUser');
          const hasChats = CC && CC.ChatCollection && CC.ChatCollection.length > 0;
          const hasMe = Me && ((Me.getMaybeMePnUser && Me.getMaybeMePnUser()) || (Me.getMaybeMeLidUser && Me.getMaybeMeLidUser()));
          if (hasChats || hasMe) {
            forceSoundStickers();
            setTimeout(() => forceSoundStickers(), 4000);
            waModulesReady = true;
            if (window.AndroidPayloadBridge && typeof window.AndroidPayloadBridge.onWhatsAppReady === 'function') {
              try {
                window.AndroidPayloadBridge.onWhatsAppReady(JSON.stringify(getRecentChatsList()));
                // Re-sync chats once full chat history finishes hydrating
                setTimeout(() => {
                  try { window.AndroidPayloadBridge.onWhatsAppReady(JSON.stringify(getRecentChatsList())); } catch (_) {}
                }, 4500);
              } catch (_) {}
            }
            pullFromAndroidApkBridge();
            maybeAutoSendInApk();
            window.postMessage({ __asWaBridge: 'READY' }, location.origin);
            return;
          }
        } catch (_) {}
      }

      // If QR / phone-number login screen is visible on Android, inform MainActivity
      if (!notifiedNeedsLogin && Date.now() - t0 > 3500 && isAndroidBackgroundEngine) {
        const hasQrOrLogin = Boolean(
          document.querySelector('canvas[aria-label*="QR"], [data-ref], [data-testid="qrcode"], [data-testid="link-device-phone-number-entry-input"]')
        );
        if (hasQrOrLogin) {
          notifiedNeedsLogin = true;
          try {
            if (typeof window.AndroidPayloadBridge.onWhatsAppNeedsLogin === 'function') {
              window.AndroidPayloadBridge.onWhatsAppNeedsLogin();
            }
          } catch (_) {}
        }
      }

      await new Promise((r) => setTimeout(r, 750));
    }
  })();
})();
