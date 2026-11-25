import {
  computeSquareCrop,
  computeWaveformPeaks,
  createSoundBundleZip,
  decodeAnimatedGifFrames,
  detectCornerBackgroundColor,
  encodeMp3BytesFromMono48k,
  encodeWavBytesFromMono48k,
  encodeWebpUnder100KB,
  extractAudioFromWebpBytes,
  extractTrimmedMono48k,
  invalidateStickerRenderCache,
  renderFusedVideoSticker,
  renderStickerToCanvas,
  unpackSoundBundleZip
} from './media-engine';
import { isMyInstantsUrl, resolveMyInstantsUrl } from './myinstants';
import { generateMascotPngBytes, synthesizePresetSound, type PresetSoundId } from './presets';
import { compileRealWhatsAppSoundSticker } from './whatsapp-sound-sticker';
import {
  LIMITS,
  type AudioFormat,
  type AudioTrimState,
  type ExportArtifact,
  type ExportProfileId,
  type ImageFormat,
  type LoadedAudio,
  type LoadedSticker,
  type StickerEditState
} from './types';

// ============================================================================
// PWA SERVICE WORKER & INSTALL PROMPT (Flush outdated caches automatically)
// ============================================================================
if ('serviceWorker' in navigator && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
  window.addEventListener('load', async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        for (const k of keys) {
          if (k !== 'audiosticker-stiksound-v6') {
            await caches.delete(k);
          }
        }
      }
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(() => {});
    } catch {}
  });
}

let deferredInstallPrompt: any = null;
const btnInstallPWA = document.getElementById('btnInstallPWA') as HTMLButtonElement | null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (btnInstallPWA) {
    btnInstallPWA.classList.remove('hidden');
  }
});

btnInstallPWA?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  btnInstallPWA.classList.add('hidden');
});

// ============================================================================
// APPLICATION STATE
// ============================================================================
let audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

const editState: StickerEditState = {
  cropX: 0.5,
  cropY: 0.5,
  zoom: 1.0,
  rotationDeg: 0,
  fitMode: 'cover',
  transparentMode: false, // false = MP4 solid background (#FFFFFF default) for maximum WhatsApp compatibility; true = WebM Alpha
  matteColor: '#FFFFFF',
  removeBg: true,
  bgColor: { r: 244, g: 246, b: 249 },
  bgTolerance: 34,
  floodFillEdgesOnly: true,
  whiteBorder: true,
  borderSize: 10,
  beatBounce: true,
  captionText: '',
  captionPos: 'bottom',
  captionColor: '#FFE600'
};

const trimState: AudioTrimState = {
  startMs: 0,
  endMs: 2200,
  maxWindowMs: 5000, // 5.0s default for WhatsApp Video Sticker
  volume: 1.05,
  fadeInOut: true
};

let currentSticker: LoadedSticker | null = null;
let currentAudio: LoadedAudio | null = null;
let readyArtifact: ExportArtifact | null = null;
let pickingEyedropper = false;
let isBusy = false;
let mascotVariant = 0;

// Playback & GIF animation state
let isPlayingAudio = false;
let activeBufferSource: AudioBufferSourceNode | null = null;
let playStartPerf = 0;
let playheadMs: number | null = null;
let playRafId: number | null = null;
let gifAnimRafId: number | null = null;
let gifAnimStartPerf = performance.now();

// ============================================================================
// DOM REFERENCES
// ============================================================================
const stickerCanvas = document.getElementById('stickerCanvas') as HTMLCanvasElement;
const stickerStageZone = document.getElementById('stickerStageZone') as HTMLElement;
const emptyStageOverlay = document.getElementById('emptyStageOverlay') as HTMLElement;
const stageLoadingOverlay = document.getElementById('stageLoadingOverlay') as HTMLElement | null;
const stageLoadingText = document.getElementById('stageLoadingText') as HTMLElement | null;
const stageResPill = document.getElementById('stageResPill') as HTMLElement;
const stageAudioPill = document.getElementById('stageAudioPill') as HTMLElement;
const eyedropperBanner = document.getElementById('eyedropperBanner') as HTMLElement;
const btnPickMedia = document.getElementById('btnPickMedia') as HTMLButtonElement | null;
const audioExtractingBanner = document.getElementById('audioExtractingBanner') as HTMLElement | null;
const audioExtractingText = document.getElementById('audioExtractingText') as HTMLElement | null;
const audioReadyDot = document.getElementById('audioReadyDot') as HTMLElement | null;

const readyVideoSection = document.getElementById('readyVideoSection') as HTMLElement;
const readyVideoEl = document.getElementById('readyVideoEl') as HTMLVideoElement;
const readyFormatBadge = document.getElementById('readyFormatBadge') as HTMLElement;
const btnCopyReady = document.getElementById('btnCopyReady') as HTMLButtonElement;
const btnShareReadyWA = document.getElementById('btnShareReadyWA') as HTMLButtonElement;
const btnDownloadReadyFile = document.getElementById('btnDownloadReadyFile') as HTMLButtonElement;
const btnBackToEdit = document.getElementById('btnBackToEdit') as HTMLButtonElement;

const toastBanner = document.getElementById('toastBanner') as HTMLElement;

// Top bar controls (StikSound style: ✕, ⋯, ⬇, ➔)
const btnResetAll = document.getElementById('btnResetAll') as HTMLButtonElement;
const btnMenuToggle = document.getElementById('btnMenuToggle') as HTMLButtonElement;
const btnDownloadToggle = document.getElementById('btnDownloadToggle') as HTMLButtonElement;
const btnArrowPreviewCopy = document.getElementById('btnArrowPreviewCopy') as HTMLButtonElement;
const btnDirectWhatsApp = document.getElementById('btnDirectWhatsApp') as HTMLButtonElement | null;

const whatsappLaunchModal = document.getElementById('whatsappLaunchModal') as HTMLElement | null;
const btnCloseWaModal = document.getElementById('btnCloseWaModal') as HTMLButtonElement | null;
const btnWaModalNativeShare = document.getElementById('btnWaModalNativeShare') as HTMLButtonElement | null;
const btnWaModalCopyImage = document.getElementById('btnWaModalCopyImage') as HTMLButtonElement | null;
const btnWaModalDownloadSeparate = document.getElementById('btnWaModalDownloadSeparate') as HTMLButtonElement | null;
const dragOutToWhatsAppCard = document.getElementById('dragOutToWhatsAppCard') as HTMLElement | null;
const modalDragOutCard = document.getElementById('modalDragOutCard') as HTMLElement | null;

const popoverMenu = document.getElementById('popoverMenu') as HTMLElement;
const popoverDownload = document.getElementById('popoverDownload') as HTMLElement;

const fileInputSticker = document.getElementById('fileInputSticker') as HTMLInputElement;
const fileInputAudio = document.getElementById('fileInputAudio') as HTMLInputElement;
const fileInputZip = document.getElementById('fileInputZip') as HTMLInputElement;

// Transparency & Style Chips
const btnModeTransparent = document.getElementById('btnModeTransparent') as HTMLButtonElement;
const btnModeWhite = document.getElementById('btnModeWhite') as HTMLButtonElement;
const btnModeBlack = document.getElementById('btnModeBlack') as HTMLButtonElement;
const inputCustomMatte = document.getElementById('inputCustomMatte') as HTMLInputElement;

const chkRemoveBg = document.getElementById('chkRemoveBg') as HTMLInputElement;
const chkWhiteBorder = document.getElementById('chkWhiteBorder') as HTMLInputElement;
const chkBeatBounce = document.getElementById('chkBeatBounce') as HTMLInputElement;

const inputCaptionText = document.getElementById('inputCaptionText') as HTMLInputElement;
const inputCaptionColor = document.getElementById('inputCaptionColor') as HTMLInputElement;
const selectCaptionPos = document.getElementById('selectCaptionPos') as HTMLSelectElement;
const inputPackName = document.getElementById('inputPackName') as HTMLInputElement | null;
const inputPackAuthor = document.getElementById('inputPackAuthor') as HTMLInputElement | null;
const extStatusBadge = document.getElementById('extStatusBadge') as HTMLElement | null;
const apkModePill = document.getElementById('apkModePill') as HTMLElement | null;
const btnOpenApkWhatsApp = document.getElementById('btnOpenApkWhatsApp') as HTMLButtonElement | null;
const btnBigSendRealWA = document.getElementById('btnBigSendRealWA') as HTMLButtonElement | null;

// Detect Native Android APK Bridge (injected by MainActivity.java in our Capacitor APK!)
interface AndroidChatOption {
  jid: string;
  name: string;
  isGroup?: boolean;
  phone?: string;
}
interface AndroidBridgeApi {
  openWhatsAppSender(payloadJson: string): void;
  openWhatsAppPairing?(): void;
  openWhatsAppSession(): void;
  openOfficialWhatsAppApp?(optionalPhone: string): void;
  shareFileDirectToWhatsApp?(base64Data: string, fileName: string, mimeType: string): void;
  getWhatsAppEngineStatus?(): string;
  consumePendingSharedMedia?(): string;
}
const androidBridge = (window as unknown as { AndroidSoundStickerBridge?: AndroidBridgeApi }).AndroidSoundStickerBridge;
const isRunningInAndroidApk = Boolean(androidBridge);

const waChatSelectorRow = document.getElementById('waChatSelectorRow') as HTMLElement | null;
const selectWaTargetChat = document.getElementById('selectWaTargetChat') as HTMLSelectElement | null;
const btnShareMp4DirectWaApp = document.getElementById('btnShareMp4DirectWaApp') as HTMLButtonElement | null;
const apkSetupModal = document.getElementById('apkSetupModal') as HTMLElement | null;
const btnCloseApkSetup = document.getElementById('btnCloseApkSetup') as HTMLButtonElement | null;
const btnStartOneTimeLink = document.getElementById('btnStartOneTimeLink') as HTMLButtonElement | null;
const btnFallbackDirectMp4Wa = document.getElementById('btnFallbackDirectMp4Wa') as HTMLButtonElement | null;

let apkWaConnected = false;
let apkWaEverLinked = false;
let pendingCompiledPayloadForLink: string | null = null;

function applyApkWaEngineState(rawJson: string): void {
  try {
    const st = JSON.parse(rawJson) as {
      connected?: boolean;
      everLinked?: boolean;
      chats?: AndroidChatOption[];
    };
    apkWaConnected = Boolean(st.connected);
    apkWaEverLinked = Boolean(st.everLinked);

    if (extStatusBadge) {
      extStatusBadge.classList.toggle('is-ready', apkWaConnected || apkWaEverLinked);
      extStatusBadge.textContent = apkWaConnected
        ? '🟢 WA Listo'
        : apkWaEverLinked
          ? '⚡ Conectando...'
          : '🔗 Sin vincular';
    }
    if (btnOpenApkWhatsApp) {
      btnOpenApkWhatsApp.textContent = apkWaConnected ? '💬 Abrir WA' : '🔗 Conectar';
    }

    if (selectWaTargetChat && waChatSelectorRow && Array.isArray(st.chats) && st.chats.length > 0) {
      const prev = selectWaTargetChat.value || '__SELF__';
      selectWaTargetChat.innerHTML = '';
      for (const c of st.chats) {
        const opt = document.createElement('option');
        opt.value = c.jid;
        opt.textContent = c.name;
        selectWaTargetChat.appendChild(opt);
      }
      if (Array.from(selectWaTargetChat.options).some((o) => o.value === prev)) {
        selectWaTargetChat.value = prev;
      }
      waChatSelectorRow.classList.remove('hidden');
    }
  } catch {}
}

if (isRunningInAndroidApk) {
  apkModePill?.classList.remove('hidden');
  btnOpenApkWhatsApp?.classList.remove('hidden');
  btnShareMp4DirectWaApp?.classList.remove('hidden');
  document.getElementById('guideSection')?.classList.add('hidden');
  if (androidBridge?.getWhatsAppEngineStatus) {
    applyApkWaEngineState(androidBridge.getWhatsAppEngineStatus());
  }
}

(window as unknown as Record<string, unknown>).__AS_WA_ENGINE_STATE__ = (raw: string) => {
  applyApkWaEngineState(raw);
};

(window as unknown as Record<string, unknown>).__AS_WA_SEND_PROGRESS__ = (msg: string) => {
  setStageLoading(true, msg);
  if (btnBigSendRealWA) btnBigSendRealWA.textContent = `⏳ ${msg}`;
  showToast(msg);
};

(window as unknown as Record<string, unknown>).__AS_WA_SEND_ERROR__ = (msg: string) => {
  isBusy = false;
  setStageLoading(false);
  if (btnDirectWhatsApp) btnDirectWhatsApp.textContent = '🔊 Enviar';
  if (btnBigSendRealWA) btnBigSendRealWA.textContent = '🔊 ENVIAR STICKER REAL A APP WHATSAPP';
  showToast(`❌ ${msg}`, true);
};

(window as unknown as Record<string, unknown>).__AS_WA_SENT_OK__ = () => {
  isBusy = false;
  setStageLoading(false);
  if (btnDirectWhatsApp) btnDirectWhatsApp.textContent = '🔊 Enviar';
  if (btnBigSendRealWA) btnBigSendRealWA.textContent = '🔊 ENVIAR STICKER REAL A APP WHATSAPP';
  showToast('✅ ¡Sticker Real con Sonido (🔊) enviado! Abriendo tu app oficial de WhatsApp...');
};

btnOpenApkWhatsApp?.addEventListener('click', () => {
  if (apkWaConnected) {
    androidBridge?.openOfficialWhatsAppApp?.('');
  } else {
    androidBridge?.openWhatsAppPairing?.();
  }
});

btnCloseApkSetup?.addEventListener('click', () => {
  pendingCompiledPayloadForLink = null;
  apkSetupModal?.classList.add('hidden');
});

apkSetupModal?.addEventListener('click', (e) => {
  if (e.target === apkSetupModal) {
    pendingCompiledPayloadForLink = null;
    apkSetupModal.classList.add('hidden');
  }
});

btnStartOneTimeLink?.addEventListener('click', () => {
  apkSetupModal?.classList.add('hidden');
  if (pendingCompiledPayloadForLink) {
    const queued = pendingCompiledPayloadForLink;
    pendingCompiledPayloadForLink = null;
    androidBridge?.openWhatsAppSender(queued);
  } else {
    androidBridge?.openWhatsAppPairing?.();
  }
});

async function shareDirectMp4ToOfficialWhatsAppApp(): Promise<void> {
  if (isBusy) return;
  if (!currentSticker) {
    showToast('Elige una foto, GIF o video primero.', true);
    return;
  }
  if (!currentAudio) {
    showToast('Agrega un audio o efecto primero.', true);
    return;
  }
  apkSetupModal?.classList.add('hidden');
  stopAudioPlayback();
  isBusy = true;
  setStageLoading(true, 'Generando Video MP4 para WhatsApp...');
  if (btnShareMp4DirectWaApp) btnShareMp4DirectWaApp.textContent = '⏳ Generando MP4...';
  try {
    const artifact = await generateArtifact('video-mp4');
    if (androidBridge?.shareFileDirectToWhatsApp) {
      androidBridge.shareFileDirectToWhatsApp(
        bytesToBase64(artifact.bytes),
        artifact.fileName,
        artifact.mimeType
      );
      showToast('📲 Abriendo tu app oficial de WhatsApp...');
    } else {
      await shareArtifactToWhatsApp(artifact);
    }
    URL.revokeObjectURL(artifact.url);
  } catch (err: any) {
    showToast(err?.message || 'Error al generar Video MP4.', true);
  } finally {
    isBusy = false;
    setStageLoading(false);
    if (btnShareMp4DirectWaApp) {
      btnShareMp4DirectWaApp.textContent = '📲 Enviar Video MP4 directo a app WhatsApp (sin vincular)';
    }
  }
}

btnShareMp4DirectWaApp?.addEventListener('click', () => void shareDirectMp4ToOfficialWhatsAppApp());
btnFallbackDirectMp4Wa?.addEventListener('click', () => void shareDirectMp4ToOfficialWhatsAppApp());

let activeMobileTab: 'sticker' | 'audio' | 'send' = 'sticker';

// Mobile Bottom Navigation Tab Switching (1. Sticker | 2. Audio | 3. Enviar WA)
function switchMobileTab(tabName: 'sticker' | 'audio' | 'send'): void {
  activeMobileTab = tabName;
  const panels: Record<'sticker' | 'audio' | 'send', HTMLElement | null> = {
    sticker: document.getElementById('tabPanelSticker'),
    audio: document.getElementById('tabPanelAudio'),
    send: document.getElementById('tabPanelSend')
  };
  (Object.keys(panels) as Array<'sticker' | 'audio' | 'send'>).forEach((k) => {
    panels[k]?.classList.toggle('mobile-active', k === tabName);
  });

  document.querySelectorAll('.mobile-nav-btn').forEach((btn) => {
    const isThis = btn.getAttribute('data-mobile-tab') === tabName;
    btn.classList.toggle('is-active', isThis);
  });

  if (tabName === 'audio') {
    audioReadyDot?.classList.add('hidden');
    requestAnimationFrame(() => {
      syncWaveformCanvasResolution();
      drawWaveformCanvas();
    });
  } else if (tabName === 'sticker') {
    requestAnimationFrame(() => renderCurrentStickerFrame());
  } else if (tabName === 'send') {
    refreshChatPreviewThumbNow();
  }
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
}

document.querySelectorAll('[data-mobile-tab]').forEach((el) => {
  el.addEventListener('click', () => {
    const tab = el.getAttribute('data-mobile-tab') as 'sticker' | 'audio' | 'send';
    if (tab) switchMobileTab(tab);
  });
});

let extensionInstalled = false;
window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data) return;
  if (ev.data.type === 'AUDIOSTICKER_EXT_STATUS' && ev.data.installed && !isRunningInAndroidApk) {
    extensionInstalled = true;
    if (extStatusBadge) {
      extStatusBadge.classList.add('is-ready');
      extStatusBadge.textContent = ev.data.waTabOpen ? '🟢 WA Conectado' : '🟢 Ext. Lista';
    }
  }
});

// Fine controls
const sliderZoom = document.getElementById('sliderZoom') as HTMLInputElement;
const lblZoom = document.getElementById('lblZoom') as HTMLElement;
const sliderTolerance = document.getElementById('sliderTolerance') as HTMLInputElement;
const lblTolerance = document.getElementById('lblTolerance') as HTMLElement;
const btnEyedropper = document.getElementById('btnEyedropper') as HTMLButtonElement;
const swatchBgColor = document.getElementById('swatchBgColor') as HTMLElement;
const chkFloodFill = document.getElementById('chkFloodFill') as HTMLInputElement;
const sliderBorderSize = document.getElementById('sliderBorderSize') as HTMLInputElement;
const lblBorderSize = document.getElementById('lblBorderSize') as HTMLElement;
const sliderRotation = document.getElementById('sliderRotation') as HTMLInputElement;
const lblRotation = document.getElementById('lblRotation') as HTMLElement;
const btnFitCover = document.getElementById('btnFitCover') as HTMLButtonElement;
const btnFitContain = document.getElementById('btnFitContain') as HTMLButtonElement;
const chkHoverCrop = document.getElementById('chkHoverCrop') as HTMLInputElement;

// Audio Timeline & MyInstants Bar
const inputMyInstantsUrl = document.getElementById('inputMyInstantsUrl') as HTMLInputElement;
const btnLoadMyInstants = document.getElementById('btnLoadMyInstants') as HTMLButtonElement;
const btnPickAudioFile = document.getElementById('btnPickAudioFile') as HTMLButtonElement;
const btnRecordMic = document.getElementById('btnRecordMic') as HTMLButtonElement;
const lblMicBtn = document.getElementById('lblMicBtn') as HTMLElement;
const recordingBanner = document.getElementById('recordingBanner') as HTMLElement;
const lblRecordingTimer = document.getElementById('lblRecordingTimer') as HTMLElement;
const btnStopMic = document.getElementById('btnStopMic') as HTMLButtonElement;

const waveformCanvas = document.getElementById('waveformCanvas') as HTMLCanvasElement;
const btnPlayToggle = document.getElementById('btnPlayToggle') as HTMLButtonElement;
const lblAudioTitle = document.getElementById('lblAudioTitle') as HTMLElement;
const lblTrimRange = document.getElementById('lblTrimRange') as HTMLElement;
const lblStartFormatted = document.getElementById('lblStartFormatted') as HTMLElement | null;
const lblEndFormatted = document.getElementById('lblEndFormatted') as HTMLElement | null;
const lblClipDurVal = document.getElementById('lblClipDurVal') as HTMLElement | null;
const sliderWindowPos = document.getElementById('sliderWindowPos') as HTMLInputElement | null;
const sliderClipDuration = document.getElementById('sliderClipDuration') as HTMLInputElement | null;
const btnCap5s = document.getElementById('btnCap5s') as HTMLButtonElement;
const btnCap10s = document.getElementById('btnCap10s') as HTMLButtonElement;
const sliderVolume = document.getElementById('sliderVolume') as HTMLInputElement;
const lblVolume = document.getElementById('lblVolume') as HTMLElement;
const chkFadeAudio = document.getElementById('chkFadeAudio') as HTMLInputElement;

// Waveform viewport zoom (1x, 4x, 12x) for buttery-smooth editing on long songs!
let waveZoomLevel = 1;
let waveViewStartMs = 0;
let waveViewEndMs = 5000;

// WhatsApp Chat Simulator Preview
const chatStickerPreviewImg = document.getElementById('chatStickerPreviewImg') as HTMLImageElement;
const btnChatSimulatorPlay = document.getElementById('btnChatSimulatorPlay') as HTMLButtonElement;
const lblChatDuration = document.getElementById('lblChatDuration') as HTMLElement;
const chatEqContainer = document.getElementById('chatEqContainer') as HTMLElement;

// ============================================================================
// TOAST NOTIFICATION HELPER
// ============================================================================
let toastTimer: number | null = null;
function showToast(msg: string, isError = false): void {
  if (!toastBanner) return;
  toastBanner.textContent = msg;
  toastBanner.classList.toggle('is-error', isError);
  toastBanner.classList.remove('hidden');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastBanner.classList.add('hidden');
  }, 4500);
}

function setStageLoading(visible: boolean, text = 'Cargando...'): void {
  if (!stageLoadingOverlay) return;
  if (stageLoadingText) stageLoadingText.textContent = text;
  stageLoadingOverlay.classList.toggle('hidden', !visible);
}

function releaseStickerResources(sticker: LoadedSticker | null): void {
  if (!sticker) return;
  if (sticker.videoEl) {
    try {
      sticker.videoEl.pause();
      sticker.videoEl.removeAttribute('src');
      sticker.videoEl.load();
    } catch {}
  }
  if (sticker.videoUrl && sticker.videoUrl.startsWith('blob:')) {
    try { URL.revokeObjectURL(sticker.videoUrl); } catch {}
  }
  invalidateStickerRenderCache();
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function clearReadyArtifact(): void {
  if (readyArtifact) {
    URL.revokeObjectURL(readyArtifact.url);
    readyArtifact = null;
  }
  readyVideoSection.classList.add('hidden');
  stickerStageZone.classList.remove('hidden');
}

// ============================================================================
// STICKER IMPORT & RENDERING PIPELINE
// ============================================================================
function sniffImageFormat(bytes: Uint8Array, fileName: string): ImageFormat {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  if (/\.gif$/i.test(fileName)) return 'gif';
  if (/\.webp$/i.test(fileName)) return 'webp';
  if (/\.png$/i.test(fileName)) return 'png';
  return 'jpeg';
}

export async function importStickerFromBytes(bytes: Uint8Array, name: string, preserveEdit = false): Promise<void> {
  clearReadyArtifact();
  releaseStickerResources(currentSticker);
  const format = sniffImageFormat(bytes, name);
  const blob = new Blob([bytes.slice().buffer], { type: `image/${format}` });
  const url = URL.createObjectURL(blob);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo cargar la imagen.'));
    img.src = url;
  });

  const width = img.naturalWidth || img.width || 512;
  const height = img.naturalHeight || img.height || 512;
  const gifFrames = format === 'gif' ? await decodeAnimatedGifFrames(bytes) : [];

  const cornerInfo = detectCornerBackgroundColor(img, width, height);
  if (!preserveEdit) {
    editState.cropX = 0.5;
    editState.cropY = 0.5;
    editState.zoom = 1.0;
    editState.rotationDeg = 0;
    editState.bgColor = { r: cornerInfo.r, g: cornerInfo.g, b: cornerInfo.b };
    editState.removeBg = !cornerInfo.hasAlpha;
    chkRemoveBg.checked = editState.removeBg;
    sliderZoom.value = '100';
    lblZoom.textContent = '100%';
    sliderRotation.value = '0';
    lblRotation.textContent = '0°';
  }
  swatchBgColor.style.backgroundColor = rgbToHex(editState.bgColor.r, editState.bgColor.g, editState.bgColor.b);

  currentSticker = {
    name,
    format,
    bytes,
    image: img,
    width,
    height,
    hasAlpha: cornerInfo.hasAlpha,
    animated: gifFrames.length > 1,
    gifFrames
  };

  emptyStageOverlay.classList.add('hidden');
  stickerCanvas.classList.remove('hidden');

  startOrUpdateCanvasRenderLoop();
  updateStageBadges();
  refreshChatPreviewThumbNow();

  // Check if this .webp file already carries embedded RIFF SAUD / EXIF 0x5741 audio inside it!
  if (format === 'webp') {
    const extracted = extractAudioFromWebpBytes(bytes);
    if (extracted.audioBytes && extracted.audioBytes.byteLength > 64) {
      try {
        await importAudioFromBytes(extracted.audioBytes, 'Audio-Embebido-en-WebP.mp3', 'local');
        showToast('🔊 ¡Sticker .WebP con Audio detectado! Imagen y sonido cargados.');
      } catch {}
    }
  }
}

// Lightweight 256x256 offscreen canvas for chat thumbnail (never stalls main 60fps canvas!)
const chatThumbCanvas = document.createElement('canvas');
chatThumbCanvas.width = 256;
chatThumbCanvas.height = 256;
const chatThumbCtx = chatThumbCanvas.getContext('2d')!;
let lastChatThumbPerf = 0;
let chatThumbTimer: number | null = null;

function refreshChatPreviewThumbNow(): void {
  if (!currentSticker) return;
  lastChatThumbPerf = performance.now();
  chatThumbCtx.clearRect(0, 0, 256, 256);
  chatThumbCtx.drawImage(stickerCanvas, 0, 0, 256, 256);
  chatStickerPreviewImg.src = chatThumbCanvas.toDataURL('image/webp', 0.78);
}

function scheduleChatPreviewThumb(): void {
  if (chatThumbTimer !== null) return;
  const isDesktop = window.innerWidth >= 1024;
  if (!isDesktop && activeMobileTab !== 'send') return;
  const elapsed = performance.now() - lastChatThumbPerf;
  const delay = currentSticker?.videoEl || currentSticker?.animated ? Math.max(450, 900 - elapsed) : 140;
  chatThumbTimer = window.setTimeout(() => {
    chatThumbTimer = null;
    refreshChatPreviewThumbNow();
  }, delay);
}

let pendingRenderRaf: number | null = null;
function scheduleRender(fastPreview = false): void {
  if (pendingRenderRaf !== null) return;
  pendingRenderRaf = requestAnimationFrame((now) => {
    pendingRenderRaf = null;
    renderCurrentStickerFrame(now, fastPreview);
  });
}

function renderCurrentStickerFrame(nowPerf = performance.now(), fastPreview = false): void {
  if (!currentSticker) return;

  let source: CanvasImageSource = currentSticker.image;
  let sw = currentSticker.width;
  let sh = currentSticker.height;

  const vid = currentSticker.videoEl;
  if (vid && vid.readyState >= 2) {
    // Keep live video loop tightly synced to active trim window [startMs, endMs]
    const vDurSec = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 5;
    const winStartSec = Math.min(Math.max(0, trimState.startMs / 1000), Math.max(0, vDurSec - 0.1));
    const winEndSec = Math.min(vDurSec, Math.max(winStartSec + 0.25, trimState.endMs / 1000));
    if (!vid.paused && (vid.currentTime < winStartSec - 0.08 || vid.currentTime >= winEndSec)) {
      try {
        vid.currentTime = winStartSec;
      } catch {}
    }
    source = vid;
    sw = vid.videoWidth || currentSticker.width;
    sh = vid.videoHeight || currentSticker.height;
  } else if (currentSticker.animated && currentSticker.gifFrames.length > 1) {
    let totalLoop = 0;
    for (const f of currentSticker.gifFrames) totalLoop += f.delayMs;
    if (totalLoop > 0) {
      const elapsed = (nowPerf - gifAnimStartPerf) % totalLoop;
      let acc = 0;
      for (const f of currentSticker.gifFrames) {
        acc += f.delayMs;
        if (elapsed <= acc) {
          source = f.canvas;
          sw = f.canvas.width;
          sh = f.canvas.height;
          break;
        }
      }
    }
  }

  let pulseScale = 1.0;
  if (isPlayingAudio && editState.beatBounce && currentAudio && playheadMs !== null) {
    const ratio = Math.max(0, Math.min(1, playheadMs / Math.max(1, currentAudio.durationMs)));
    const bucketIdx = Math.min(
      currentAudio.peaks.length - 1,
      Math.floor(ratio * currentAudio.peaks.length)
    );
    const amp = currentAudio.peaks[bucketIdx] ?? 0;
    pulseScale = 1.0 + Math.min(0.08, amp * 0.09);
  }

  renderStickerToCanvas(stickerCanvas, source, sw, sh, editState, {
    pulseScale,
    fastPreview: fastPreview || Boolean(vid)
  });

  scheduleChatPreviewThumb();
}

function startOrUpdateCanvasRenderLoop(): void {
  if (gifAnimRafId !== null) {
    cancelAnimationFrame(gifAnimRafId);
    gifAnimRafId = null;
  }

  const needsLoop = Boolean(currentSticker && (currentSticker.videoEl || currentSticker.animated || isPlayingAudio));
  if (needsLoop) {
    let lastDrawPerf = 0;
    const loop = (now: number) => {
      // Skip hidden mobile canvas draws when user is on Audio/Send tab (saves battery & CPU!)
      const stageVisible = window.innerWidth >= 1024 || activeMobileTab === 'sticker';
      const minInterval = currentSticker?.videoEl && !isPlayingAudio ? 32 : 16; // ~30fps idle video preview, 60fps audio beat
      if (stageVisible && now - lastDrawPerf >= minInterval) {
        lastDrawPerf = now;
        renderCurrentStickerFrame(now, true);
      }
      if (currentSticker && (currentSticker.videoEl || currentSticker.animated || isPlayingAudio)) {
        gifAnimRafId = requestAnimationFrame(loop);
      }
    };
    gifAnimRafId = requestAnimationFrame(loop);
  } else {
    renderCurrentStickerFrame();
  }
}

function updateStageBadges(): void {
  if (!currentSticker) {
    stageResPill.classList.add('hidden');
    return;
  }
  const crop = computeSquareCrop(currentSticker.width, currentSticker.height, editState.cropX, editState.cropY, true);
  const tag = currentSticker.videoEl
    ? ` · 🎬 ${((currentSticker.videoDurationMs ?? 0) / 1000).toFixed(1)}s`
    : currentSticker.animated
      ? ' · GIF'
      : '';
  stageResPill.textContent = `${crop.outputSize}×${crop.outputSize}${tag}`;
  stageResPill.classList.remove('hidden');

  if (currentAudio) {
    const clipSec = ((trimState.endMs - trimState.startMs) / 1000).toFixed(1);
    stageAudioPill.textContent = `🔊 ${clipSec}s`;
    stageAudioPill.classList.remove('hidden');
  } else {
    stageAudioPill.classList.add('hidden');
  }
}

// ============================================================================
// AUDIO IMPORT, WAVEFORM & PLAYBACK
// ============================================================================
export async function importAudioFromBytes(
  bytes: Uint8Array,
  name: string,
  sourceType: LoadedAudio['sourceType'] = 'local',
  preserveTrim = false
): Promise<void> {
  stopAudioPlayback();
  clearReadyArtifact();

  const actx = getAudioContext();
  const decoded = await actx.decodeAudioData(bytes.slice().buffer);
  const durationMs = Math.round(decoded.duration * 1000);
  // Use higher peak resolution (600 buckets) so zoomed waveforms remain sharp even on 4-minute songs!
  const peaks = computeWaveformPeaks(decoded, 600);

  const extMatch = name.match(/\.(mp3|wav|ogg|m4a|aac|webm)$/i);
  const format = (extMatch ? extMatch[1]!.toLowerCase() : 'mp3') as AudioFormat;

  currentAudio = {
    name,
    format,
    bytes,
    buffer: decoded,
    durationMs,
    peaks,
    sourceType
  };

  if (!preserveTrim) {
    trimState.startMs = 0;
    trimState.endMs = Math.min(durationMs, trimState.maxWindowMs);
    // Auto-select comfortable zoom for long songs (> 30s) so handles are never tiny or jumpy!
    setWaveZoom(durationMs > 60000 ? 12 : durationMs > 25000 ? 4 : 1);
  } else {
    enforceTrimWindow('end');
    updateWaveformViewport();
  }

  syncAudioTimelineUI();
  drawWaveformCanvas();
  updateStageBadges();
}

function formatTimeMs(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSec = safe / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = (totalSec % 60).toFixed(1).padStart(4, '0');
  return `${mins}:${secs}`;
}

function updateWaveformViewport(): void {
  if (!currentAudio) {
    waveViewStartMs = 0;
    waveViewEndMs = 5000;
    return;
  }
  const total = Math.max(100, currentAudio.durationMs);
  if (waveZoomLevel <= 1) {
    waveViewStartMs = 0;
    waveViewEndMs = total;
    return;
  }
  const span = Math.max(trimState.maxWindowMs * 1.6, total / waveZoomLevel);
  const clampedSpan = Math.min(total, span);
  const center = (trimState.startMs + trimState.endMs) / 2;
  let vs = center - clampedSpan / 2;
  vs = Math.max(0, Math.min(vs, total - clampedSpan));
  waveViewStartMs = vs;
  waveViewEndMs = vs + clampedSpan;
}

function setWaveZoom(level: number): void {
  waveZoomLevel = level;
  document.querySelectorAll('.wave-zoom-btn').forEach((btn) => {
    const z = Number(btn.getAttribute('data-wave-zoom'));
    btn.classList.toggle('is-active', z === level);
  });
  updateWaveformViewport();
  drawWaveformCanvas();
}

function syncWaveformCanvasResolution(): void {
  const rect = waveformCanvas.getBoundingClientRect();
  if (rect.width < 40) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(86 * dpr);
  if (Math.abs(waveformCanvas.width - targetW) > 6 || waveformCanvas.height !== targetH) {
    waveformCanvas.width = targetW;
    waveformCanvas.height = targetH;
  }
}

if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => {
    syncWaveformCanvasResolution();
    drawWaveformCanvas();
  });
  ro.observe(waveformCanvas);
}

function enforceTrimWindow(changedHandle: 'start' | 'end'): void {
  if (!currentAudio) return;
  const total = currentAudio.durationMs;
  const maxWin = trimState.maxWindowMs;
  const minWin = LIMITS.MIN_TRIM_DURATION_MS;

  trimState.startMs = Math.max(0, Math.min(trimState.startMs, Math.max(0, total - minWin)));
  trimState.endMs = Math.max(
    Math.min(total, trimState.startMs + minWin),
    Math.min(trimState.endMs, total)
  );

  if (trimState.endMs - trimState.startMs > maxWin) {
    if (changedHandle === 'start') {
      trimState.endMs = Math.min(total, trimState.startMs + maxWin);
    } else {
      trimState.startMs = Math.max(0, trimState.endMs - maxWin);
    }
  }
}

function syncAudioTimelineUI(): void {
  if (!currentAudio) {
    lblAudioTitle.textContent = 'Sin audio cargado';
    lblTrimRange.textContent = 'Duración: 0.0s';
    return;
  }
  const clipMs = Math.max(LIMITS.MIN_TRIM_DURATION_MS, trimState.endMs - trimState.startMs);
  const durSec = (clipMs / 1000).toFixed(2);
  const maxSec = (trimState.maxWindowMs / 1000).toFixed(0);

  lblAudioTitle.textContent = currentAudio.name;
  lblTrimRange.textContent = `Duración: ${(clipMs / 1000).toFixed(1)}s / ${maxSec}s`;
  if (lblStartFormatted) lblStartFormatted.textContent = formatTimeMs(trimState.startMs);
  if (lblEndFormatted) lblEndFormatted.textContent = formatTimeMs(trimState.endMs);
  if (lblClipDurVal) lblClipDurVal.textContent = `${durSec}s`;
  lblChatDuration.textContent = `${(clipMs / 1000).toFixed(1)}s`;

  // Sync smooth position & duration sliders
  if (sliderWindowPos) {
    const maxStart = Math.max(0, currentAudio.durationMs - clipMs);
    sliderWindowPos.max = String(Math.round(maxStart));
    sliderWindowPos.value = String(Math.round(trimState.startMs));
  }
  if (sliderClipDuration) {
    const maxDur = Math.min(currentAudio.durationMs, trimState.maxWindowMs);
    sliderClipDuration.min = String(LIMITS.MIN_TRIM_DURATION_MS);
    sliderClipDuration.max = String(Math.round(maxDur));
    sliderClipDuration.value = String(Math.round(clipMs));
  }

  updateStageBadges();
}

function drawWaveformCanvas(): void {
  const W = waveformCanvas.width;
  const H = waveformCanvas.height;
  const wctx = waveformCanvas.getContext('2d')!;
  wctx.clearRect(0, 0, W, H);

  wctx.fillStyle = '#020617';
  wctx.fillRect(0, 0, W, H);

  if (!currentAudio) return;

  const total = Math.max(1, currentAudio.durationMs);
  const viewStart = waveViewStartMs;
  const viewSpan = Math.max(100, waveViewEndMs - waveViewStartMs);
  const msToX = (ms: number) => ((ms - viewStart) / viewSpan) * W;

  const sx = msToX(trimState.startMs);
  const ex = msToX(trimState.endMs);
  const rulerH = 18;
  const waveH = H - rulerH;

  // Highlight active clip window
  const clampedSx = Math.max(0, sx);
  const clampedEx = Math.min(W, ex);
  if (clampedEx > clampedSx) {
    wctx.fillStyle = 'rgba(37, 211, 102, 0.17)';
    wctx.fillRect(clampedSx, 0, clampedEx - clampedSx, waveH);
  }

  // Draw waveform peaks visible in current zoom viewport
  const peaks = currentAudio.peaks;
  const numBars = 140;
  const stepPx = W / numBars;
  const barW = Math.max(1.5, stepPx * 0.68);

  for (let i = 0; i < numBars; i++) {
    const x = i * stepPx;
    const barMsStart = viewStart + (i / numBars) * viewSpan;
    const barMsEnd = viewStart + ((i + 1) / numBars) * viewSpan;
    const bStart = Math.max(0, Math.floor((barMsStart / total) * peaks.length));
    const bEnd = Math.min(peaks.length, Math.max(bStart + 1, Math.ceil((barMsEnd / total) * peaks.length)));

    let maxPeak = 0;
    for (let b = bStart; b < bEnd; b++) {
      if (peaks[b]! > maxPeak) maxPeak = peaks[b]!;
    }

    const inWin = barMsEnd >= trimState.startMs && barMsStart <= trimState.endMs;
    const amp = Math.min(1, maxPeak * trimState.volume);
    const bh = Math.max(3, amp * (waveH * 0.82));
    wctx.fillStyle = inWin ? '#25D366' : 'rgba(100, 116, 139, 0.35)';
    wctx.fillRect(x, (waveH - bh) / 2, barW, bh);
  }

  // Dim regions outside active selection
  wctx.fillStyle = 'rgba(2, 6, 23, 0.56)';
  if (sx > 0) wctx.fillRect(0, 0, Math.min(W, sx), waveH);
  if (ex < W) wctx.fillRect(Math.max(0, ex), 0, W - Math.max(0, ex), waveH);

  // Top & bottom glowing trim frame
  if (clampedEx > clampedSx) {
    wctx.strokeStyle = 'rgba(37, 211, 102, 0.75)';
    wctx.lineWidth = 2;
    wctx.strokeRect(clampedSx, 1, clampedEx - clampedSx, waveH - 2);
  }

  // Start Handle (Green pill)
  if (sx >= -12 && sx <= W + 12) {
    wctx.fillStyle = '#25D366';
    wctx.fillRect(sx - 2, 0, 4, waveH);
    wctx.beginPath();
    wctx.roundRect(sx - 8, 6, 16, 22, 5);
    wctx.fill();
    wctx.fillStyle = '#022c22';
    wctx.fillRect(sx - 1, 11, 2, 12);
  }

  // End Handle (Cyan pill)
  if (ex >= -12 && ex <= W + 12) {
    wctx.fillStyle = '#06B6D4';
    wctx.fillRect(ex - 2, 0, 4, waveH);
    wctx.beginPath();
    wctx.roundRect(ex - 8, waveH - 28, 16, 22, 5);
    wctx.fill();
    wctx.fillStyle = '#083344';
    wctx.fillRect(ex - 1, waveH - 23, 2, 12);
  }

  // Active Playhead Cursor
  if (isPlayingAudio && playheadMs !== null) {
    const px = msToX(playheadMs);
    if (px >= 0 && px <= W) {
      wctx.strokeStyle = '#FFFFFF';
      wctx.lineWidth = 2.5;
      wctx.beginPath();
      wctx.moveTo(px, 0);
      wctx.lineTo(px, waveH);
      wctx.stroke();
    }
  }

  // Crisp Time Ruler along the bottom
  wctx.fillStyle = '#0f172a';
  wctx.fillRect(0, waveH, W, rulerH);
  wctx.fillStyle = '#94a3b8';
  wctx.font = '10px "JetBrains Mono", monospace';
  wctx.textBaseline = 'middle';
  const tickCount = 5;
  for (let t = 0; t <= tickCount; t++) {
    const tMs = viewStart + (t / tickCount) * viewSpan;
    const tx = (t / tickCount) * W;
    wctx.textAlign = t === 0 ? 'left' : t === tickCount ? 'right' : 'center';
    const padX = t === 0 ? 4 : t === tickCount ? -4 : 0;
    wctx.fillText(formatTimeMs(tMs), tx + padX, waveH + rulerH / 2 + 1);
  }
}

function stopAudioPlayback(): void {
  if (activeBufferSource) {
    try { activeBufferSource.stop(); } catch {}
    activeBufferSource.disconnect();
    activeBufferSource = null;
  }
  if (playRafId !== null) {
    cancelAnimationFrame(playRafId);
    playRafId = null;
  }
  isPlayingAudio = false;
  playheadMs = null;
  btnPlayToggle.textContent = '▶';
  chatEqContainer.classList.remove('eq-playing');
  drawWaveformCanvas();
  startOrUpdateCanvasRenderLoop();
}

function toggleAudioPlayback(): void {
  if (isPlayingAudio) {
    stopAudioPlayback();
    return;
  }
  if (!currentAudio) return;

  const actx = getAudioContext();
  const src = actx.createBufferSource();
  src.buffer = currentAudio.buffer;

  const gainNode = actx.createGain();
  const now = actx.currentTime;
  const clipSec = Math.max(0.1, (trimState.endMs - trimState.startMs) / 1000);

  if (trimState.fadeInOut && clipSec > 0.35) {
    const f = Math.min(0.14, clipSec * 0.2);
    gainNode.gain.setValueAtTime(0.001, now);
    gainNode.gain.linearRampToValueAtTime(trimState.volume, now + f);
    gainNode.gain.setValueAtTime(trimState.volume, now + clipSec - f);
    gainNode.gain.linearRampToValueAtTime(0.001, now + clipSec);
  } else {
    gainNode.gain.setValueAtTime(trimState.volume, now);
  }

  src.connect(gainNode);
  gainNode.connect(actx.destination);
  src.start(0, trimState.startMs / 1000, clipSec);

  // Sync live video preview to exact audio trim start for lip-synced playback!
  if (currentSticker?.videoEl && currentSticker.videoEl.readyState >= 2) {
    try {
      const vDur = Math.max(0.2, currentSticker.videoEl.duration || 5);
      currentSticker.videoEl.currentTime = (trimState.startMs / 1000) % vDur;
      currentSticker.videoEl.play().catch(() => {});
    } catch {}
  }

  activeBufferSource = src;
  isPlayingAudio = true;
  playStartPerf = performance.now();
  btnPlayToggle.textContent = '■';
  chatEqContainer.classList.add('eq-playing');
  startOrUpdateCanvasRenderLoop();

  src.onended = () => stopAudioPlayback();

  const tick = () => {
    if (!isPlayingAudio) return;
    const elapsedMs = performance.now() - playStartPerf;
    const durMs = trimState.endMs - trimState.startMs;
    if (elapsedMs <= durMs) {
      playheadMs = trimState.startMs + elapsedMs;
      drawWaveformCanvas();
      playRafId = requestAnimationFrame(tick);
    } else {
      stopAudioPlayback();
    }
  };
  playRafId = requestAnimationFrame(tick);
}

// ============================================================================
// EXPORT, PREVIEW & CLIPBOARD / WHATSAPP SHARE
// ============================================================================
async function generateArtifact(profile: ExportProfileId): Promise<ExportArtifact> {
  if (!currentSticker) throw new Error('Primero sube o pega una imagen o sticker.');

  if (profile === 'standard-webp') {
    const { bytes, blob } = await encodeWebpUnder100KB(currentSticker, editState);
    return {
      profile,
      bytes,
      blob,
      url: URL.createObjectURL(blob),
      fileName: 'sticker-whatsapp-512x512.webp',
      mimeType: 'image/webp',
      extension: 'webp',
      hasAlpha: true
    };
  }

  if (!currentAudio) throw new Error('Agrega un audio, efecto o enlace de MyInstants primero.');

  if (profile === 'webp-audio-exif') {
    const compiled = await compileRealWhatsAppSoundSticker(currentSticker, editState, currentAudio, trimState, {
      packName: inputPackName?.value || 'AudioSticker Studio',
      publisher: inputPackAuthor?.value || 'AudioSticker'
    });
    // Also trigger download of the paired .ogg Opus file alongside the animated .webp
    triggerFileDownload(compiled.oggBlob, 'audiosticker-audio.ogg');
    return {
      profile,
      bytes: compiled.webpBytes,
      blob: compiled.webpBlob,
      url: URL.createObjectURL(compiled.webpBlob),
      fileName: 'audiosticker-512x512.webp',
      mimeType: 'image/webp',
      extension: 'webp',
      durationMs: compiled.durationMs,
      hasAlpha: true
    };
  }

  if (profile === 'audio-mp3') {
    const pcm48k = extractTrimmedMono48k(currentAudio.buffer, trimState);
    const { bytes, ext, mime } = encodeMp3BytesFromMono48k(pcm48k, 48000);
    const blob = new Blob([bytes.slice().buffer], { type: mime });
    return {
      profile,
      bytes,
      blob,
      url: URL.createObjectURL(blob),
      fileName: `stiksound-audio.${ext}`,
      mimeType: mime,
      extension: ext,
      durationMs: trimState.endMs - trimState.startMs
    };
  }

  if (profile === 'audio-wav') {
    const pcm48k = extractTrimmedMono48k(currentAudio.buffer, trimState);
    const bytes = encodeWavBytesFromMono48k(pcm48k, 48000);
    const blob = new Blob([bytes.slice().buffer], { type: 'audio/wav' });
    return {
      profile,
      bytes,
      blob,
      url: URL.createObjectURL(blob),
      fileName: 'stiksound-audio.wav',
      mimeType: 'audio/wav',
      extension: 'wav',
      durationMs: trimState.endMs - trimState.startMs
    };
  }

  if (profile === 'sound-bundle') {
    return await createSoundBundleZip(currentSticker, editState, currentAudio, trimState);
  }

  const container = profile === 'video-webm-alpha' ? 'webm-alpha' : 'mp4';
  return await renderFusedVideoSticker(currentSticker, editState, currentAudio, trimState, container);
}

async function copyStickerPngToClipboard(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      const pngBlob = await new Promise<Blob | null>((r) => stickerCanvas.toBlob(r, 'image/png'));
      if (pngBlob) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Exact StikSound Desktop trick:
 * Sends the generated .mp4 / .webm file to our local Node server (/api/copy-file-clipboard)
 * which runs PowerShell `Set-Clipboard -LiteralPath` so the REAL video file with sound is placed
 * on the Windows system clipboard (CF_HDROP)! Then Ctrl+V in WhatsApp PC or WhatsApp Web pastes the MP4 with audio!
 */
async function copyFileToWindowsClipboard(artifact: ExportArtifact): Promise<boolean> {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    try {
      const res = await fetch('/api/copy-file-clipboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': artifact.fileName
        },
        body: artifact.blob
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) return true;
      }
    } catch {}
  }
  return await copyStickerPngToClipboard();
}

async function copyArtifactToClipboard(artifact: ExportArtifact): Promise<boolean> {
  return await copyFileToWindowsClipboard(artifact);
}

// Enable Chromium native file drag-out (DownloadURL) so the user can drag the card directly into WhatsApp PC or Web
function bindDragOutCard(el: HTMLElement | null): void {
  if (!el) return;
  el.addEventListener('dragstart', (e: DragEvent) => {
    if (!readyArtifact || !e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(
      'DownloadURL',
      `${readyArtifact.mimeType}:${readyArtifact.fileName}:${readyArtifact.url}`
    );
  });
}
bindDragOutCard(dragOutToWhatsAppCard);
bindDragOutCard(modalDragOutCard);

function triggerFileDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function shareArtifactToWhatsApp(artifact: ExportArtifact): Promise<void> {
  const file = new File([artifact.blob], artifact.fileName, { type: artifact.mimeType });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'AudioSticker Studio (StikSound)',
        text: 'Sticker con sonido para WhatsApp'
      });
      return;
    } catch {}
  }
  triggerFileDownload(artifact.blob, artifact.fileName);
}

// Arrow (➔): StikSound's signature 1-click Preview Fused Video-Sticker + Copy to Clipboard
async function handleArrowPreviewAndCopy(): Promise<void> {
  if (isBusy) return;
  if (!currentSticker) {
    showToast('Pega o sube un sticker primero (Ctrl+V).', true);
    return;
  }
  if (!currentAudio) {
    showToast('Agrega un audio, efecto o link de MyInstants primero.', true);
    return;
  }

  stopAudioPlayback();
  popoverDownload.classList.add('hidden');
  popoverMenu.classList.add('hidden');
  isBusy = true;
  setStageLoading(true, 'Fusionando Video MP4...');
  btnArrowPreviewCopy.textContent = '⏳ ...';
  showToast('⏳ Fusionando Sticker 512×512 + Audio...');

  try {
    const targetProfile: ExportProfileId = editState.transparentMode ? 'video-webm-alpha' : 'video-mp4';
    const artifact = await generateArtifact(targetProfile);
    if (readyArtifact) URL.revokeObjectURL(readyArtifact.url);
    readyArtifact = artifact;

    readyVideoEl.src = artifact.url;
    readyFormatBadge.textContent = `${artifact.extension.toUpperCase()} · 512×512 · ${((artifact.durationMs ?? 0) / 1000).toFixed(1)}s`;
    stickerStageZone.classList.add('hidden');
    readyVideoSection.classList.remove('hidden');

    const copiedRealFile = await copyFileToWindowsClipboard(artifact);
    showToast(
      copiedRealFile
        ? `✅ ¡Archivo ${artifact.fileName} copiado al portapapeles de Windows! Ve a WhatsApp PC o Web y presiona Ctrl + V.`
        : '✅ ¡Fusionado! Arrastra la caja verde a tu WhatsApp o descárgalo.'
    );
  } catch (err: any) {
    showToast(err?.message || 'Error al fusionar el sticker con audio.', true);
  } finally {
    isBusy = false;
    setStageLoading(false);
    btnArrowPreviewCopy.textContent = '🎬 MP4';
  }
}

async function handleDirectDownload(profile: ExportProfileId): Promise<void> {
  if (isBusy) return;
  popoverDownload.classList.add('hidden');
  popoverMenu.classList.add('hidden');
  stopAudioPlayback();
  isBusy = true;
  btnDownloadToggle.textContent = '⏳';

  try {
    const artifact = await generateArtifact(profile);
    triggerFileDownload(artifact.blob, artifact.fileName);
    showToast(`Descargado: ${artifact.fileName}`);
    URL.revokeObjectURL(artifact.url);
  } catch (err: any) {
    showToast(err?.message || 'No se pudo exportar el archivo.', true);
  } finally {
    isBusy = false;
    btnDownloadToggle.textContent = '⬇';
  }
}

// ============================================================================
// EVENT LISTENERS BINDING
// ============================================================================

// 1. Global Ctrl+V / Cmd+V Paste (Image, GIF, or MyInstants URL!)
window.addEventListener('paste', async (e: ClipboardEvent) => {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && target.id !== 'inputMyInstantsUrl') {
    return;
  }

  const items = e.clipboardData?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          await importStickerFromBytes(new Uint8Array(await file.arrayBuffer()), file.name || 'pegado.png');
          showToast('Sticker pegado desde el portapapeles (Ctrl+V).');
          return;
        }
      }
      if (item.type.startsWith('audio/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          await importAudioFromBytes(new Uint8Array(await file.arrayBuffer()), file.name || 'audio.mp3');
          showToast('Audio pegado desde el portapapeles.');
          return;
        }
      }
    }
  }

  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (text && isMyInstantsUrl(text)) {
    e.preventDefault();
    inputMyInstantsUrl.value = text;
    await loadMyInstantsSound(text);
  }
});

// 2. Stage Drag & Drop (accepts both Sticker Images/GIFs AND Audio Files OR .stiksound.zip!)
stickerStageZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  stickerStageZone.classList.add('is-dragover');
});
stickerStageZone.addEventListener('dragleave', () => {
  stickerStageZone.classList.remove('is-dragover');
});
stickerStageZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  stickerStageZone.classList.remove('is-dragover');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;

  if (/\.zip$/i.test(f.name)) {
    await openStikSoundZipFile(f);
  } else if (f.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(f.name)) {
    await importVideoAsSticker(f);
  } else if (f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(f.name)) {
    await importAudioFromBytes(new Uint8Array(await f.arrayBuffer()), f.name, 'local');
    showToast(`Audio cargado: ${f.name}`);
  } else if (f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.name)) {
    await importStickerFromBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    showToast(`Sticker cargado: ${f.name}`);
  }
});

// 3. Zero-Click Hover Crop (1:1) & Touch Drag / Eyedropper on Sticker Stage
let isDraggingStage = false;
function updateCropFromPointer(clientX: number, clientY: number): void {
  const rect = stickerCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  editState.cropX = Number(nx.toFixed(3));
  editState.cropY = Number(ny.toFixed(3));
  scheduleRender(true);
}

stickerStageZone.addEventListener('mousemove', (e) => {
  if (!currentSticker || pickingEyedropper) return;
  if (chkHoverCrop.checked && currentSticker.width !== currentSticker.height) {
    updateCropFromPointer(e.clientX, e.clientY);
  } else if (isDraggingStage) {
    updateCropFromPointer(e.clientX, e.clientY);
  }
});

stickerCanvas.addEventListener('mousedown', (e) => {
  if (!currentSticker) return;
  if (pickingEyedropper) {
    const rect = stickerCanvas.getBoundingClientRect();
    const px = Math.max(0, Math.min(511, Math.round(((e.clientX - rect.left) / rect.width) * 512)));
    const py = Math.max(0, Math.min(511, Math.round(((e.clientY - rect.top) / rect.height) * 512)));

    const prevRemove = editState.removeBg;
    editState.removeBg = false;
    renderCurrentStickerFrame();
    const ctx = stickerCanvas.getContext('2d')!;
    const data = ctx.getImageData(px, py, 1, 1).data;
    editState.bgColor = { r: data[0]!, g: data[1]!, b: data[2]! };
    swatchBgColor.style.backgroundColor = rgbToHex(data[0]!, data[1]!, data[2]!);
    pickingEyedropper = false;
    eyedropperBanner.classList.add('hidden');
    editState.removeBg = prevRemove || true;
    chkRemoveBg.checked = true;
    renderCurrentStickerFrame();
    return;
  }
  isDraggingStage = true;
});

window.addEventListener('mouseup', () => {
  isDraggingStage = false;
});

stickerCanvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    isDraggingStage = true;
  }
}, { passive: true });

stickerCanvas.addEventListener('touchmove', (e) => {
  if (!isDraggingStage || e.touches.length !== 1) return;
  e.preventDefault();
  updateCropFromPointer(e.touches[0]!.clientX, e.touches[0]!.clientY);
}, { passive: false });

stickerCanvas.addEventListener('touchend', () => {
  isDraggingStage = false;
});

emptyStageOverlay.addEventListener('click', () => {
  fileInputSticker.click();
});

btnPickMedia?.addEventListener('click', () => {
  fileInputSticker.click();
});

// Close popovers cleanly when tapping anywhere outside
document.addEventListener('click', (e) => {
  const target = e.target as Node | null;
  if (!target) return;
  if (!popoverDownload.classList.contains('hidden') && !popoverDownload.contains(target) && !btnDownloadToggle.contains(target)) {
    popoverDownload.classList.add('hidden');
  }
  if (!popoverMenu.classList.contains('hidden') && !popoverMenu.contains(target) && !btnMenuToggle.contains(target)) {
    popoverMenu.classList.add('hidden');
  }
});

// 4. ULTRA-FAST ZERO-LAG VIDEO IMPORTER (Instant <120ms Live Hardware Preview + Async Background Audio!)
let activeVideoImportToken = 0;

async function extractVideoAudioInBackground(
  source: File | string,
  name: string,
  token: number
): Promise<void> {
  if (audioExtractingBanner) {
    if (audioExtractingText) audioExtractingText.textContent = 'Extrayendo pista de audio del video...';
    audioExtractingBanner.classList.remove('hidden');
  }
  try {
    let rawBuf: ArrayBuffer;
    if (typeof source === 'string') {
      const res = await fetch(source);
      if (!res.ok) throw new Error('No se pudo leer el audio del video');
      const lenHeader = Number(res.headers.get('content-length') || 0);
      if (lenHeader > LIMITS.MAX_VIDEO_AUDIO_DECODE_BYTES) {
        throw new Error('Video muy pesado (>45 MB) para decodificar audio completo');
      }
      rawBuf = await res.arrayBuffer();
    } else {
      if (source.size > LIMITS.MAX_VIDEO_AUDIO_DECODE_BYTES) {
        throw new Error('Video muy pesado (>45 MB) para decodificar audio completo');
      }
      rawBuf = await source.arrayBuffer();
    }

    if (token !== activeVideoImportToken) return;
    await importAudioFromBytes(new Uint8Array(rawBuf), `Audio · ${name}`, 'local');
    if (token !== activeVideoImportToken) return;

    if (activeMobileTab !== 'audio') {
      audioReadyDot?.classList.remove('hidden');
    }
    showToast('🔊 Audio del video listo. Ya puedes recortarlo o enviar directo.');
  } catch {
    if (token === activeVideoImportToken) {
      showToast('🎬 Video listo (sin audio detectable o muy largo). Elige un sonido o efecto.', false);
    }
  } finally {
    if (token === activeVideoImportToken) {
      audioExtractingBanner?.classList.add('hidden');
    }
  }
}

async function importVideoFromSource(source: File | string, fileName: string): Promise<void> {
  const token = ++activeVideoImportToken;
  stopAudioPlayback();
  clearReadyArtifact();
  releaseStickerResources(currentSticker);
  setStageLoading(true, 'Abriendo video...');

  const isFile = typeof source !== 'string';
  const url = isFile ? URL.createObjectURL(source) : source;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const ok = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        resolve();
      };
      const fail = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        reject(new Error('No se pudo reproducir este formato de video en el dispositivo.'));
      };
      const timer = window.setTimeout(() => {
        if (video.readyState >= 1) ok();
        else fail();
      }, 6500);
      video.addEventListener('loadeddata', ok, { once: true });
      video.addEventListener('canplay', ok, { once: true });
      video.addEventListener('error', fail, { once: true });
    });

    if (token !== activeVideoImportToken) {
      if (isFile) URL.revokeObjectURL(url);
      return;
    }

    const vw = video.videoWidth || 512;
    const vh = video.videoHeight || 512;
    const durationMs = Math.max(500, Math.round((Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 5) * 1000));

    // Capture a lightweight 256x256 poster thumbnail in <8ms (ZERO 4K frame arrays!)
    const thumbC = document.createElement('canvas');
    thumbC.width = 256;
    thumbC.height = 256;
    const crop = computeSquareCrop(vw, vh, 0.5, 0.5, true);
    thumbC.getContext('2d')!.drawImage(video, crop.srcX, crop.srcY, crop.cropSide, crop.cropSide, 0, 0, 256, 256);
    const posterUrl = thumbC.toDataURL('image/webp', 0.8);
    const posterImg = new Image();
    posterImg.src = posterUrl;
    await new Promise<void>((r) => {
      posterImg.onload = () => r();
      posterImg.onerror = () => r();
    });

    // Video defaults: full-frame cover, no solid bg cutout (keeps GPU direct draw at <0.3ms!)
    editState.cropX = 0.5;
    editState.cropY = 0.5;
    editState.zoom = 1.0;
    editState.rotationDeg = 0;
    editState.removeBg = false;
    editState.whiteBorder = false;
    chkRemoveBg.checked = false;
    chkWhiteBorder.checked = false;
    sliderZoom.value = '100';
    lblZoom.textContent = '100%';
    sliderRotation.value = '0';
    lblRotation.textContent = '0°';

    trimState.startMs = 0;
    trimState.endMs = Math.min(durationMs, trimState.maxWindowMs);

    currentSticker = {
      name: fileName,
      format: 'video',
      bytes: new Uint8Array(0),
      image: posterImg,
      width: vw,
      height: vh,
      hasAlpha: false,
      animated: true,
      gifFrames: [],
      videoEl: video,
      videoUrl: url,
      videoDurationMs: durationMs,
      videoFile: isFile ? source : undefined
    };

    emptyStageOverlay.classList.add('hidden');
    stickerCanvas.classList.remove('hidden');
    setStageLoading(false);

    video.play().catch(() => {});
    startOrUpdateCanvasRenderLoop();
    updateStageBadges();
    refreshChatPreviewThumbNow();
    showToast(`⚡ Video cargado al instante (${(durationMs / 1000).toFixed(1)}s). Extrayendo audio...`);

    // Decode audio asynchronously AFTER video is already live on screen!
    window.setTimeout(() => {
      void extractVideoAudioInBackground(source, fileName, token);
    }, 30);
  } catch (err: any) {
    setStageLoading(false);
    if (isFile) URL.revokeObjectURL(url);
    showToast(err?.message || 'Error al cargar el video.', true);
  }
}

async function importVideoAsSticker(file: File): Promise<void> {
  await importVideoFromSource(file, file.name);
}

// Receive Videos / Images / Audio shared directly from Android Gallery, TikTok or WhatsApp!
async function handleIncomingNativeSharedMedia(raw: string | { url?: string; name?: string; mime?: string }): Promise<void> {
  try {
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!info || !info.url) return;
    const url = String(info.url);
    const name = String(info.name || 'compartido');
    const mime = String(info.mime || '').toLowerCase();

    if (mime.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv|3gp)$/i.test(name)) {
      switchMobileTab('sticker');
      await importVideoFromSource(url, name);
    } else if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|opus)$/i.test(name)) {
      const res = await fetch(url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await importAudioFromBytes(bytes, name, 'local');
      switchMobileTab('audio');
      showToast(`🎵 Audio recibido: ${name}`);
    } else {
      const res = await fetch(url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      switchMobileTab('sticker');
      await importStickerFromBytes(bytes, name);
      showToast(`🖼️ Imagen recibida: ${name}`);
    }
  } catch (err: any) {
    showToast(err?.message || 'No se pudo cargar el archivo compartido.', true);
  }
}

(window as unknown as { __AS_RECEIVE_SHARED_MEDIA__?: (raw: string | object) => void }).__AS_RECEIVE_SHARED_MEDIA__ =
  (raw) => {
    void handleIncomingNativeSharedMedia(raw as any);
  };

fileInputSticker.addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) {
    if (f.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(f.name)) {
      await importVideoAsSticker(f);
    } else {
      await importStickerFromBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    }
  }
  fileInputSticker.value = '';
});

fileInputAudio.addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) {
    await importAudioFromBytes(new Uint8Array(await f.arrayBuffer()), f.name, 'local');
  }
  fileInputAudio.value = '';
});

async function openStikSoundZipFile(file: File): Promise<void> {
  try {
    const zipBytes = new Uint8Array(await file.arrayBuffer());
    const unpacked = unpackSoundBundleZip(zipBytes);
    if (unpacked.manifest?.sticker?.edit) {
      Object.assign(editState, unpacked.manifest.sticker.edit);
    }
    if (unpacked.stickerBytes) {
      await importStickerFromBytes(
        unpacked.stickerBytes,
        unpacked.manifest?.sticker?.source_name ?? 'sticker.webp',
        true
      );
    }
    if (unpacked.audioBytes) {
      if (unpacked.manifest?.audio) {
        trimState.startMs = unpacked.manifest.audio.start_ms ?? 0;
        trimState.endMs = unpacked.manifest.audio.end_ms ?? 2500;
        trimState.volume = unpacked.manifest.audio.volume ?? 1.0;
      }
      await importAudioFromBytes(
        unpacked.audioBytes,
        unpacked.manifest?.audio?.source_name ?? 'sound.wav',
        'local',
        true
      );
    }
    showToast('Proyecto .stiksound.zip abierto correctamente.');
  } catch {
    showToast('No se pudo abrir el paquete .stiksound.zip.', true);
  }
}

fileInputZip.addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await openStikSoundZipFile(f);
  fileInputZip.value = '';
});

// 5. Top Bar Buttons (✕, ⋯, ⬇, ➔)
btnResetAll.addEventListener('click', () => {
  activeVideoImportToken++;
  audioExtractingBanner?.classList.add('hidden');
  stopAudioPlayback();
  clearReadyArtifact();
  releaseStickerResources(currentSticker);
  currentSticker = null;
  currentAudio = null;
  stickerCanvas.classList.add('hidden');
  emptyStageOverlay.classList.remove('hidden');
  stageResPill.classList.add('hidden');
  stageAudioPill.classList.add('hidden');
  drawWaveformCanvas();
  syncAudioTimelineUI();
  showToast('Lienzo reiniciado. Elige una foto, GIF o video.');
});

btnMenuToggle.addEventListener('click', () => {
  popoverDownload.classList.add('hidden');
  popoverMenu.classList.toggle('hidden');
});

btnDownloadToggle.addEventListener('click', () => {
  popoverMenu.classList.add('hidden');
  popoverDownload.classList.toggle('hidden');
});

btnArrowPreviewCopy.addEventListener('click', handleArrowPreviewAndCopy);

// Helper to convert Uint8Array to base64 for Chrome Extension bridge
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return btoa(bin);
}

// Direct "🔊 Sticker Real WA" Button:
// Compiles the official Animated WebP (with Big-Endian TIFF 0x5741 EXIF `sound-sha256` <= 1MB)
// + official Ogg/Opus 48kHz audio via WebCodecs, and relays them directly to our Chrome Extension v2.0
// running in WhatsApp Web's MAIN world (`WAWebMediaPrep.sendToChat({ chat, options: { stickerAudio } })`)!
async function handleDirectSendToWhatsApp(): Promise<void> {
  if (isBusy) return;
  if (!currentSticker) {
    showToast('Pega o sube un sticker, GIF o video primero.', true);
    return;
  }
  if (!currentAudio) {
    showToast('Agrega un audio, efecto o link de MyInstants primero.', true);
    return;
  }

  stopAudioPlayback();
  popoverDownload.classList.add('hidden');
  popoverMenu.classList.add('hidden');
  isBusy = true;
  setStageLoading(true, 'Compilando Opus + WebP...');
  if (btnDirectWhatsApp) btnDirectWhatsApp.textContent = '⏳ ...';
  if (btnBigSendRealWA) btnBigSendRealWA.textContent = '⏳ Compilando Sticker con Sonido...';

  let handoffToBgAndroid = false;
  try {
    const compiled = await compileRealWhatsAppSoundSticker(
      currentSticker,
      editState,
      currentAudio,
      trimState,
      {
        packName: inputPackName?.value || 'AudioSticker Studio',
        publisher: inputPackAuthor?.value || 'AudioSticker',
        onProgress: (msg) => {
          setStageLoading(true, msg);
          if (btnDirectWhatsApp) btnDirectWhatsApp.textContent = '⏳';
          if (btnBigSendRealWA) btnBigSendRealWA.textContent = `⏳ ${msg}`;
        }
      }
    );

    const webpKB = Math.round(compiled.webpBytes.byteLength / 1024);
    const oggKB = Math.round(compiled.oggBytes.byteLength / 1024);

    const payload = {
      webpBase64: bytesToBase64(compiled.webpBytes),
      oggBase64: bytesToBase64(compiled.oggBytes),
      soundSha256: compiled.soundSha256,
      seconds: compiled.seconds,
      side: compiled.side,
      isAnimated: compiled.isAnimated,
      packName: compiled.packName,
      publisher: compiled.publisher,
      webpKB,
      oggKB
    };

    // PATH 1: Running inside our Native Android APK -> INVISIBLE background send & direct open official com.whatsapp!
    if (androidBridge) {
      const targetChatJid = selectWaTargetChat?.value || '__SELF__';
      const serialized = JSON.stringify({ ...payload, autoSend: true, targetChatJid });

      if (androidBridge.getWhatsAppEngineStatus) {
        applyApkWaEngineState(androidBridge.getWhatsAppEngineStatus());
      }

      if (!apkWaConnected && !apkWaEverLinked) {
        // First time ever -> show clear 1-time explanation modal instead of surprising user with WhatsApp Web!
        pendingCompiledPayloadForLink = serialized;
        apkSetupModal?.classList.remove('hidden');
        return;
      }

      // Already linked -> sends 100% invisibly in background (NEVER shows WhatsApp Web!) and opens official WhatsApp app!
      handoffToBgAndroid = true;
      setStageLoading(true, '⚡ Enviando en segundo plano a tu WhatsApp...');
      showToast(`⚡ Enviando Sticker Real (${webpKB} KB + ${oggKB} KB) directo a tu app de WhatsApp...`);
      androidBridge.openWhatsAppSender(serialized);
      // Safety unlock in case network drops silently
      window.setTimeout(() => {
        if (isBusy) {
          isBusy = false;
          setStageLoading(false);
          if (btnDirectWhatsApp) btnDirectWhatsApp.textContent = '🔊 Enviar';
          if (btnBigSendRealWA) btnBigSendRealWA.textContent = '🔊 ENVIAR STICKER REAL A APP WHATSAPP';
        }
      }, 28000);
      return;
    }

    // PATH 2: Desktop Browser with Chrome Extension v2.0
    window.postMessage({ type: 'AUDIOSTICKER_SEND_REAL_STICKER', payload }, '*');

    if (extensionInstalled) {
      showToast(
        `🔊 ¡Sticker Real compilado (WebP ${webpKB} KB + Opus ${oggKB} KB)! Abriendo WhatsApp Web para enviarlo con 1 clic...`
      );
    } else {
      triggerFileDownload(compiled.webpBlob, 'audiosticker-512x512.webp');
      window.setTimeout(() => triggerFileDownload(compiled.oggBlob, 'audiosticker-opus.ogg'), 300);
      showToast(
        `✅ Compilado (WebP ${webpKB} KB + Opus ${oggKB} KB). Carga "chrome-extension" en chrome://extensions o usa la APK en tu teléfono.`
      );
      document.getElementById('guideSection')?.scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err: any) {
    showToast(err?.message || 'Error al compilar el Sticker con Sonido.', true);
  } finally {
    if (!handoffToBgAndroid) {
      isBusy = false;
      setStageLoading(false);
      if (btnDirectWhatsApp) btnDirectWhatsApp.textContent = '🔊 Enviar';
      if (btnBigSendRealWA) btnBigSendRealWA.textContent = '🔊 ENVIAR STICKER REAL A APP WHATSAPP';
    }
  }
}

btnDirectWhatsApp?.addEventListener('click', handleDirectSendToWhatsApp);
btnBigSendRealWA?.addEventListener('click', handleDirectSendToWhatsApp);
btnShareReadyWA.addEventListener('click', () => {
  if (readyArtifact) {
    whatsappLaunchModal?.classList.remove('hidden');
  } else {
    handleDirectSendToWhatsApp();
  }
});

btnCloseWaModal?.addEventListener('click', () => {
  whatsappLaunchModal?.classList.add('hidden');
});

whatsappLaunchModal?.addEventListener('click', (e) => {
  if (e.target === whatsappLaunchModal) {
    whatsappLaunchModal.classList.add('hidden');
  }
});

btnWaModalNativeShare?.addEventListener('click', async () => {
  if (!readyArtifact) return;
  await shareArtifactToWhatsApp(readyArtifact);
});

btnWaModalCopyImage?.addEventListener('click', async () => {
  const ok = await copyStickerPngToClipboard();
  if (ok) {
    showToast('✅ Imagen 512×512 copiada al portapapeles. Ve a WhatsApp y presiona Ctrl + V.');
  } else {
    showToast('No se pudo copiar automáticamente al portapapeles.', true);
  }
});

btnWaModalDownloadSeparate?.addEventListener('click', async () => {
  whatsappLaunchModal?.classList.add('hidden');
  await handleDirectDownload('standard-webp');
  window.setTimeout(() => {
    handleDirectDownload('audio-mp3');
  }, 350);
});

btnDownloadReadyFile.addEventListener('click', () => {
  if (!readyArtifact) return;
  triggerFileDownload(readyArtifact.blob, readyArtifact.fileName);
});

btnCopyReady.addEventListener('click', async () => {
  if (!readyArtifact) return;
  await copyArtifactToClipboard(readyArtifact);
  showToast('¡Copiado al portapapeles! Pega (Ctrl+V) en WhatsApp.');
});

btnBackToEdit.addEventListener('click', () => {
  readyVideoSection.classList.add('hidden');
  stickerStageZone.classList.remove('hidden');
});

// Popover Download Format Buttons
document.querySelectorAll('[data-export-profile]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const profile = btn.getAttribute('data-export-profile') as ExportProfileId;
    handleDirectDownload(profile);
  });
});

// Popover Menu Actions
document.getElementById('menuOpenZip')?.addEventListener('click', () => {
  popoverMenu.classList.add('hidden');
  fileInputZip.click();
});

document.getElementById('menuSaveZip')?.addEventListener('click', () => {
  popoverMenu.classList.add('hidden');
  handleDirectDownload('sound-bundle');
});

document.getElementById('menuLoadDemo')?.addEventListener('click', async () => {
  popoverMenu.classList.add('hidden');
  mascotVariant = (mascotVariant + 1) % 3;
  await loadDefaultDemoState(mascotVariant);
  showToast('Mascota y efecto de sonido Demo cargados.');
});

// 6. Transparency & Matte Mode Chips
function updateMatteChipUI(): void {
  btnModeTransparent.classList.toggle('is-active', editState.transparentMode);
  btnModeWhite.classList.toggle('is-active', !editState.transparentMode && editState.matteColor.toUpperCase() === '#FFFFFF');
  btnModeBlack.classList.toggle('is-active', !editState.transparentMode && editState.matteColor.toUpperCase() === '#000000');
}

btnModeTransparent.addEventListener('click', () => {
  editState.transparentMode = true;
  clearReadyArtifact();
  updateMatteChipUI();
  renderCurrentStickerFrame();
});

btnModeWhite.addEventListener('click', () => {
  editState.transparentMode = false;
  editState.matteColor = '#FFFFFF';
  clearReadyArtifact();
  updateMatteChipUI();
  renderCurrentStickerFrame();
});

btnModeBlack.addEventListener('click', () => {
  editState.transparentMode = false;
  editState.matteColor = '#000000';
  clearReadyArtifact();
  updateMatteChipUI();
  renderCurrentStickerFrame();
});

inputCustomMatte.addEventListener('input', () => {
  editState.transparentMode = false;
  editState.matteColor = inputCustomMatte.value.toUpperCase();
  clearReadyArtifact();
  updateMatteChipUI();
  renderCurrentStickerFrame();
});

chkRemoveBg.addEventListener('change', () => {
  editState.removeBg = chkRemoveBg.checked;
  clearReadyArtifact();
  renderCurrentStickerFrame();
});

chkWhiteBorder.addEventListener('change', () => {
  editState.whiteBorder = chkWhiteBorder.checked;
  clearReadyArtifact();
  renderCurrentStickerFrame();
});

chkBeatBounce.addEventListener('change', () => {
  editState.beatBounce = chkBeatBounce.checked;
  clearReadyArtifact();
});

inputCaptionText.addEventListener('input', () => {
  editState.captionText = inputCaptionText.value;
  clearReadyArtifact();
  renderCurrentStickerFrame();
});

inputCaptionColor.addEventListener('input', () => {
  editState.captionColor = inputCaptionColor.value;
  clearReadyArtifact();
  renderCurrentStickerFrame();
});

selectCaptionPos.addEventListener('change', () => {
  editState.captionPos = selectCaptionPos.value as 'top' | 'bottom';
  clearReadyArtifact();
  renderCurrentStickerFrame();
});

// Fine Settings (rAF-coalesced so mobile touch sliders never lag!)
sliderZoom.addEventListener('input', () => {
  editState.zoom = Number(sliderZoom.value) / 100;
  lblZoom.textContent = `${sliderZoom.value}%`;
  scheduleRender(true);
});

sliderTolerance.addEventListener('input', () => {
  editState.bgTolerance = Number(sliderTolerance.value);
  lblTolerance.textContent = sliderTolerance.value;
  scheduleRender(true);
});

btnEyedropper.addEventListener('click', () => {
  pickingEyedropper = !pickingEyedropper;
  eyedropperBanner.classList.toggle('hidden', !pickingEyedropper);
});

chkFloodFill.addEventListener('change', () => {
  editState.floodFillEdgesOnly = chkFloodFill.checked;
  scheduleRender();
});

sliderBorderSize.addEventListener('input', () => {
  editState.borderSize = Number(sliderBorderSize.value);
  lblBorderSize.textContent = `${sliderBorderSize.value}px`;
  scheduleRender(true);
});

sliderRotation.addEventListener('input', () => {
  editState.rotationDeg = Number(sliderRotation.value);
  lblRotation.textContent = `${sliderRotation.value}°`;
  scheduleRender(true);
});

btnFitCover.addEventListener('click', () => {
  editState.fitMode = 'cover';
  btnFitCover.classList.add('is-active');
  btnFitContain.classList.remove('is-active');
  scheduleRender();
});

btnFitContain.addEventListener('click', () => {
  editState.fitMode = 'contain';
  btnFitContain.classList.add('is-active');
  btnFitCover.classList.remove('is-active');
  scheduleRender();
});

// 7. Audio Controls: MyInstants, 1-Click Viral Presets, File Upload, Mic Recording
async function loadMyInstantsSound(url: string): Promise<void> {
  if (!isMyInstantsUrl(url)) {
    showToast('Ingresa un enlace válido de myinstants.com (ej. https://www.myinstants.com/es/instant/...)', true);
    return;
  }
  try {
    btnLoadMyInstants.textContent = '⏳';
    showToast('Descargando sonido desde MyInstants...');
    const resolved = await resolveMyInstantsUrl(url);
    await importAudioFromBytes(resolved.bytes, `${resolved.title}.mp3`, 'myinstants');
    inputMyInstantsUrl.value = '';
    showToast(`MyInstants cargado: ${resolved.title}`);
  } catch (err: any) {
    showToast(err?.message || 'No se pudo extraer el audio de MyInstants.', true);
  } finally {
    btnLoadMyInstants.textContent = 'Cargar URL';
  }
}

btnLoadMyInstants.addEventListener('click', () => {
  const val = inputMyInstantsUrl.value.trim();
  if (val) loadMyInstantsSound(val);
});

inputMyInstantsUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = inputMyInstantsUrl.value.trim();
    if (val) loadMyInstantsSound(val);
  }
});

// 1-Click Viral Sound Effect Buttons
document.querySelectorAll('[data-preset-sound]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const presetId = btn.getAttribute('data-preset-sound') as PresetSoundId;
    const actx = getAudioContext();
    const { bytes, name } = synthesizePresetSound(actx, presetId);
    await importAudioFromBytes(bytes, `${name}.wav`, 'synth');
    toggleAudioPlayback();
  });
});

btnPickAudioFile.addEventListener('click', () => fileInputAudio.click());

// Microphone Recording
let mediaRecorder: MediaRecorder | null = null;
let micChunks: BlobPart[] = [];
let micStartPerf = 0;
let micTimerId: number | null = null;

async function toggleMicRecording(): Promise<void> {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) micChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (micTimerId) window.clearInterval(micTimerId);
      recordingBanner.classList.add('hidden');
      lblMicBtn.textContent = 'Grabar';
      if (!micChunks.length) return;
      const blob = new Blob(micChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
      await importAudioFromBytes(new Uint8Array(await blob.arrayBuffer()), 'Grabación de Voz.webm', 'mic');
      showToast('Nota de voz grabada y cargada en la onda.');
    };
    mediaRecorder.start(100);
    micStartPerf = performance.now();
    recordingBanner.classList.remove('hidden');
    lblMicBtn.textContent = 'Detener';
    micTimerId = window.setInterval(() => {
      const sec = (performance.now() - micStartPerf) / 1000;
      lblRecordingTimer.textContent = `00:${sec.toFixed(1).padStart(4, '0')}`;
    }, 100);
  } catch {
    showToast('Permite el acceso al micrófono en tu navegador.', true);
  }
}

btnRecordMic.addEventListener('click', toggleMicRecording);
btnStopMic.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
});

// Smooth Viewport-Aware Waveform Dragging (zero jumps!) + Position/Duration Sliders + Nudge Buttons
let waveDragMode: 'start' | 'end' | 'window' | null = null;
let waveDragStartClientMs = 0;
let waveDragInitStartMs = 0;
let waveDragSpanMs = 0;

function getWaveformEventInfo(evt: MouseEvent | TouchEvent): { ms: number; px: number } {
  const rect = waveformCanvas.getBoundingClientRect();
  const cx = 'touches' in evt ? evt.touches[0]!.clientX : evt.clientX;
  const ratio = Math.max(0, Math.min(1, (cx - rect.left) / Math.max(1, rect.width)));
  const viewSpan = Math.max(100, waveViewEndMs - waveViewStartMs);
  return {
    ms: Math.round(waveViewStartMs + ratio * viewSpan),
    px: ratio * waveformCanvas.width
  };
}

function getHandleZone(px: number): 'start' | 'end' | 'window' | 'outside' {
  const W = waveformCanvas.width;
  const viewSpan = Math.max(100, waveViewEndMs - waveViewStartMs);
  const sx = ((trimState.startMs - waveViewStartMs) / viewSpan) * W;
  const ex = ((trimState.endMs - waveViewStartMs) / viewSpan) * W;
  const winPxWidth = Math.max(0, ex - sx);

  // If the selection window is very narrow on 1x zoom, prioritize dragging the whole window cleanly!
  if (winPxWidth < 28) {
    if (px >= sx - 14 && px <= ex + 14) return 'window';
    return 'outside';
  }

  const handleRadius = Math.min(14, winPxWidth * 0.25);
  if (Math.abs(px - sx) <= handleRadius) return 'start';
  if (Math.abs(px - ex) <= handleRadius) return 'end';
  if (px > sx && px < ex) return 'window';
  return 'outside';
}

function onWaveformDown(evt: MouseEvent | TouchEvent): void {
  if (!currentAudio) return;
  const info = getWaveformEventInfo(evt);
  const zone = getHandleZone(info.px);

  waveDragSpanMs = Math.max(LIMITS.MIN_TRIM_DURATION_MS, trimState.endMs - trimState.startMs);

  if (zone === 'start' || zone === 'end') {
    waveDragMode = zone;
  } else if (zone === 'window') {
    waveDragMode = 'window';
    waveDragStartClientMs = info.ms;
    waveDragInitStartMs = trimState.startMs;
  } else {
    // Smoothly center the existing window where the user clicked (never collapses or stretches abruptly!)
    waveDragMode = 'window';
    const nextStart = Math.max(
      0,
      Math.min(Math.round(info.ms - waveDragSpanMs / 2), Math.max(0, currentAudio.durationMs - waveDragSpanMs))
    );
    trimState.startMs = nextStart;
    trimState.endMs = nextStart + waveDragSpanMs;
    waveDragStartClientMs = info.ms;
    waveDragInitStartMs = nextStart;
    clearReadyArtifact();
    syncAudioTimelineUI();
    drawWaveformCanvas();
  }
}

function onWaveformMove(evt: MouseEvent | TouchEvent): void {
  if (!currentAudio) return;
  const info = getWaveformEventInfo(evt);

  if (!waveDragMode) {
    if (!('touches' in evt)) {
      const zone = getHandleZone(info.px);
      waveformCanvas.style.cursor =
        zone === 'start' || zone === 'end' ? 'ew-resize' : zone === 'window' ? 'grab' : 'pointer';
    }
    return;
  }

  if (evt.cancelable) evt.preventDefault();

  if (waveDragMode === 'start') {
    trimState.startMs = info.ms;
    enforceTrimWindow('start');
  } else if (waveDragMode === 'end') {
    trimState.endMs = info.ms;
    enforceTrimWindow('end');
  } else {
    waveformCanvas.style.cursor = 'grabbing';
    const deltaMs = info.ms - waveDragStartClientMs;
    const maxStart = Math.max(0, currentAudio.durationMs - waveDragSpanMs);
    const nextStart = Math.max(0, Math.min(Math.round(waveDragInitStartMs + deltaMs), maxStart));
    trimState.startMs = nextStart;
    trimState.endMs = nextStart + waveDragSpanMs;
  }
  clearReadyArtifact();
  syncAudioTimelineUI();
  drawWaveformCanvas();
}

waveformCanvas.addEventListener('mousedown', onWaveformDown);
window.addEventListener('mousemove', onWaveformMove);
window.addEventListener('mouseup', () => {
  if (waveDragMode) {
    waveDragMode = null;
    updateWaveformViewport();
    drawWaveformCanvas();
  }
});

waveformCanvas.addEventListener('touchstart', onWaveformDown, { passive: true });
waveformCanvas.addEventListener('touchmove', onWaveformMove, { passive: false });
waveformCanvas.addEventListener('touchend', () => {
  if (waveDragMode) {
    waveDragMode = null;
    updateWaveformViewport();
    drawWaveformCanvas();
  }
});

// Zoom Buttons (1x, 4x, 12x)
document.querySelectorAll('.wave-zoom-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const z = Number(btn.getAttribute('data-wave-zoom')) || 1;
    setWaveZoom(z);
  });
});

// Smooth Position Slider (glides the window cleanly across any song/video length!)
sliderWindowPos?.addEventListener('input', () => {
  if (!currentAudio) return;
  const clipMs = Math.max(LIMITS.MIN_TRIM_DURATION_MS, trimState.endMs - trimState.startMs);
  const maxStart = Math.max(0, currentAudio.durationMs - clipMs);
  const nextStart = Math.max(0, Math.min(Number(sliderWindowPos.value), maxStart));
  trimState.startMs = nextStart;
  trimState.endMs = nextStart + clipMs;
  if (currentSticker?.videoEl && currentSticker.videoEl.readyState >= 2) {
    const vDur = Math.max(0.2, currentSticker.videoEl.duration || 5);
    try { currentSticker.videoEl.currentTime = (nextStart / 1000) % vDur; } catch {}
  }
  clearReadyArtifact();
  updateWaveformViewport();
  syncAudioTimelineUI();
  drawWaveformCanvas();
});

// Smooth Duration Slider (0.3s to 5s / 10s)
sliderClipDuration?.addEventListener('input', () => {
  if (!currentAudio) return;
  const newDur = Math.max(LIMITS.MIN_TRIM_DURATION_MS, Math.min(Number(sliderClipDuration.value), trimState.maxWindowMs));
  let nextStart = trimState.startMs;
  if (nextStart + newDur > currentAudio.durationMs) {
    nextStart = Math.max(0, currentAudio.durationMs - newDur);
  }
  trimState.startMs = nextStart;
  trimState.endMs = Math.min(currentAudio.durationMs, nextStart + newDur);
  clearReadyArtifact();
  updateWaveformViewport();
  syncAudioTimelineUI();
  drawWaveformCanvas();
});

// Precision Nudge Buttons (-1s, -0.1s, +0.1s, +1s)
document.querySelectorAll('[data-nudge-start]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!currentAudio) return;
    const delta = Number(btn.getAttribute('data-nudge-start')) || 0;
    const clipMs = Math.max(LIMITS.MIN_TRIM_DURATION_MS, trimState.endMs - trimState.startMs);
    const maxStart = Math.max(0, currentAudio.durationMs - clipMs);
    const nextStart = Math.max(0, Math.min(trimState.startMs + delta, maxStart));
    trimState.startMs = nextStart;
    trimState.endMs = nextStart + clipMs;
    clearReadyArtifact();
    updateWaveformViewport();
    syncAudioTimelineUI();
    drawWaveformCanvas();
  });
});

btnPlayToggle.addEventListener('click', toggleAudioPlayback);
btnChatSimulatorPlay.addEventListener('click', toggleAudioPlayback);

// 5s (Video-Sticker) vs 10s (Extended Clip) Window Cap Switch
btnCap5s.addEventListener('click', () => {
  trimState.maxWindowMs = 5000;
  btnCap5s.classList.add('is-active');
  btnCap10s.classList.remove('is-active');
  enforceTrimWindow('start');
  updateWaveformViewport();
  syncAudioTimelineUI();
  drawWaveformCanvas();
});

btnCap10s.addEventListener('click', () => {
  trimState.maxWindowMs = 10000;
  btnCap10s.classList.add('is-active');
  btnCap5s.classList.remove('is-active');
  if (currentAudio) {
    trimState.endMs = Math.min(currentAudio.durationMs, trimState.startMs + 10000);
  }
  updateWaveformViewport();
  syncAudioTimelineUI();
  drawWaveformCanvas();
});

sliderVolume.addEventListener('input', () => {
  trimState.volume = Number(sliderVolume.value) / 100;
  lblVolume.textContent = `${sliderVolume.value}%`;
  drawWaveformCanvas();
});

chkFadeAudio.addEventListener('change', () => {
  trimState.fadeInOut = chkFadeAudio.checked;
});

// ============================================================================
// INITIALIZE STUDIO (Check Pending Android Shared Media FIRST, else Demo!)
// ============================================================================
async function loadDefaultDemoState(variant = 0): Promise<void> {
  const mascot = await generateMascotPngBytes(variant);
  await importStickerFromBytes(mascot.bytes, mascot.name);
  editState.removeBg = true;
  chkRemoveBg.checked = true;
  renderCurrentStickerFrame();

  const actx = getAudioContext();
  const presetIds: PresetSoundId[] = ['arcade-win', 'vine-boom', 'anime-sparkle'];
  const sound = synthesizePresetSound(actx, presetIds[variant % presetIds.length]!);
  await importAudioFromBytes(sound.bytes, `${sound.name}.wav`, 'synth');
}

updateMatteChipUI();
syncWaveformCanvasResolution();

const pendingShared = androidBridge?.consumePendingSharedMedia?.();
if (pendingShared && pendingShared.length > 5) {
  void handleIncomingNativeSharedMedia(pendingShared);
} else {
  void loadDefaultDemoState(0);
}
