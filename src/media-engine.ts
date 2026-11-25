import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  LIMITS,
  type AudioTrimState,
  type ExportArtifact,
  type GifFrameData,
  type ImageFormat,
  type LoadedAudio,
  type LoadedSticker,
  type SquareCropRect,
  type StickerEditState,
  type StikSoundProjectManifest
} from './types';
import {
  injectWhatsAppExifAndAudioIntoWebp,
  extractAudioFromWebpBytes
} from './webp-riff-audio';

export { injectWhatsAppExifAndAudioIntoWebp, extractAudioFromWebpBytes };

/**
 * Computes a 1:1 square crop anchored at normalized (cropX, cropY) in [0, 1].
 * Output size is capped at 512x512 and aligned to an even integer for hardware H.264/VP9 video encoders.
 */
export function computeSquareCrop(
  srcWidth: number,
  srcHeight: number,
  cropX = 0.5,
  cropY = 0.5,
  force512 = true
): SquareCropRect {
  const safeW = Math.max(2, Math.round(srcWidth));
  const safeH = Math.max(2, Math.round(srcHeight));
  const cropSide = Math.min(safeW, safeH);

  const rawOut = force512 ? LIMITS.STICKER_DIMENSION_PX : Math.min(LIMITS.STICKER_DIMENSION_PX, cropSide);
  const outputSize = rawOut <= 2 ? 2 : rawOut - (rawOut % 2);

  const nx = Number.isFinite(cropX) ? Math.max(0, Math.min(1, cropX)) : 0.5;
  const ny = Number.isFinite(cropY) ? Math.max(0, Math.min(1, cropY)) : 0.5;

  const srcX = Math.round((safeW - cropSide) * nx);
  const srcY = Math.round((safeH - cropSide) * ny);

  return { srcX, srcY, cropSide, outputSize };
}

/**
 * Decodes animated GIF frames if ImageDecoder is supported in the browser.
 */
export async function decodeAnimatedGifFrames(bytes: Uint8Array): Promise<GifFrameData[]> {
  const AnyWindow = window as unknown as { ImageDecoder?: any };
  if (typeof AnyWindow.ImageDecoder === 'undefined') return [];

  try {
    const decoder = new AnyWindow.ImageDecoder({ data: bytes.slice(), type: 'image/gif' });
    await decoder.tracks.ready;
    const frameCount: number = decoder.tracks.selectedTrack?.frameCount ?? 1;
    if (frameCount <= 1) {
      decoder.close();
      return [];
    }

    const frames: GifFrameData[] = [];
    for (let i = 0; i < frameCount; i++) {
      const res = await decoder.decode({ frameIndex: i });
      const vf = res.image;
      const c = document.createElement('canvas');
      c.width = vf.displayWidth;
      c.height = vf.displayHeight;
      const cctx = c.getContext('2d')!;
      cctx.drawImage(vf, 0, 0);
      const delayMs = Math.max(25, Math.round((vf.duration ?? 100_000) / 1000));
      vf.close();
      frames.push({ canvas: c, delayMs });
    }
    decoder.close();
    return frames;
  } catch {
    return [];
  }
}

/**
 * Detects corner background color from an image element or canvas.
 */
export function detectCornerBackgroundColor(source: CanvasImageSource, w: number, h: number): { r: number; g: number; b: number; hasAlpha: boolean } {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 48;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h, 0, 0, 48, 48);
  const data = ctx.getImageData(0, 0, 48, 48).data;

  let transparentPixels = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 220) transparentPixels++;
  }
  const hasAlpha = transparentPixels > 25;

  const corners: Array<[number, number]> = [
    [1, 1],
    [46, 1],
    [1, 46],
    [46, 46]
  ];
  let r = 0, g = 0, b = 0;
  for (const [cx, cy] of corners) {
    const idx = (cy * 48 + cx) * 4;
    r += data[idx]!;
    g += data[idx + 1]!;
    b += data[idx + 2]!;
  }
  return {
    r: Math.round(r / 4),
    g: Math.round(g / 4),
    b: Math.round(b / 4),
    hasAlpha
  };
}

/**
 * Removes solid background using edge flood-fill or global chroma threshold with soft feathering.
 */
export function removeBackgroundInPlace(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bgColor: { r: number; g: number; b: number },
  tolerance: number,
  floodFillOnly: boolean
): void {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const tr = bgColor.r;
  const tg = bgColor.g;
  const tb = bgColor.b;
  const tol = tolerance * 1.9;
  const tolSq = tol * tol;
  const featherSq = (tol + 24) * (tol + 24);

  const distSq = (idx: number): number => {
    const dr = data[idx]! - tr;
    const dg = data[idx + 1]! - tg;
    const db = data[idx + 2]! - tb;
    return dr * dr + dg * dg + db * db;
  };

  if (floodFillOnly) {
    const total = width * height;
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0, tail = 0;

    const push = (px: number, py: number) => {
      const pos = py * width + px;
      if (visited[pos]) return;
      visited[pos] = 1;
      const idx = pos * 4;
      if (data[idx + 3] === 0 || distSq(idx) <= tolSq) {
        queue[tail++] = pos;
      }
    };

    for (let x = 0; x < width; x++) {
      push(x, 0);
      push(x, height - 1);
    }
    for (let y = 1; y < height - 1; y++) {
      push(0, y);
      push(width - 1, y);
    }

    while (head < tail) {
      const pos = queue[head++]!;
      data[pos * 4 + 3] = 0;
      const x = pos % width;
      const y = (pos / width) | 0;
      if (x > 0) push(x - 1, y);
      if (x < width - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < height - 1) push(x, y + 1);
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const d = distSq(i);
      if (d <= tolSq) {
        data[i + 3] = 0;
      } else if (d < featherSq) {
        data[i + 3] = Math.round(data[i + 3]! * ((Math.sqrt(d) - tol) / 24));
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

// Reusable scratch canvases for ultra-fast 512x512 sticker rendering
const subjectScratch = document.createElement('canvas');
subjectScratch.width = 512;
subjectScratch.height = 512;
const subjectScratchCtx = subjectScratch.getContext('2d', { willReadFrequently: true })!;

const silScratch = document.createElement('canvas');
silScratch.width = 512;
silScratch.height = 512;
const silScratchCtx = silScratch.getContext('2d')!;

// Processed sprite cache (subject + bg removal + die-cut white border) so 60fps beat-bounce
// skips pixel flood-fill and 20-pass border stamping completely (~150x faster on mobile!)
const cachedComposite = document.createElement('canvas');
cachedComposite.width = 512;
cachedComposite.height = 512;
const cachedCompositeCtx = cachedComposite.getContext('2d')!;
let cachedCompositeKey = '';

const sourceIdMap = new WeakMap<object, number>();
let nextSourceId = 1;
function getSourceId(src: CanvasImageSource): number {
  const obj = src as unknown as object;
  let id = sourceIdMap.get(obj);
  if (!id) {
    id = nextSourceId++;
    sourceIdMap.set(obj, id);
  }
  return id;
}

export function invalidateStickerRenderCache(): void {
  cachedCompositeKey = '';
}

/**
 * Safely seeks an HTMLVideoElement to targetSec with a bounded timeout so VFR/mobile
 * videos never stall or hang an export pipeline.
 */
export async function seekVideoTo(video: HTMLVideoElement, targetSec: number, timeoutMs = 650): Promise<void> {
  const maxT = Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 0.03) : targetSec;
  const clamped = Math.max(0, Math.min(targetSec, maxT));
  if (Math.abs(video.currentTime - clamped) < 0.015 && video.readyState >= 2) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    video.addEventListener('seeked', finish, { once: true });
    try {
      video.currentTime = clamped;
    } catch {
      finish();
    }
  });
}

function drawCaptionOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, edit: StickerEditState): void {
  const caption = edit.captionText.trim();
  if (!caption) return;
  ctx.save();
  ctx.font = '900 44px system-ui, -apple-system, Impact, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const ty = edit.captionPos === 'top' ? 54 : H - 48;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#020617';
  ctx.strokeText(caption, W / 2, ty);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#FFFFFF';
  ctx.strokeText(caption, W / 2, ty);
  ctx.fillStyle = edit.captionColor;
  ctx.fillText(caption, W / 2, ty);
  ctx.restore();
}

/**
 * Renders a 512x512 sticker frame onto targetCanvas with hover-crop, cached background removal,
 * die-cut white stroke, optional matte background, caption text, and audio beat pulse.
 * Uses GPU direct-draw fast paths for live video and sprite caching for 60fps mobile rendering.
 */
export function renderStickerToCanvas(
  targetCanvas: HTMLCanvasElement,
  sourceImage: CanvasImageSource,
  srcW: number,
  srcH: number,
  edit: StickerEditState,
  options: { forceTransparent?: boolean; pulseScale?: number; fastPreview?: boolean } = {}
): void {
  const W = 512;
  const H = 512;
  if (targetCanvas.width !== W) targetCanvas.width = W;
  if (targetCanvas.height !== H) targetCanvas.height = H;

  const ctx = targetCanvas.getContext('2d', { willReadFrequently: false })!;
  ctx.clearRect(0, 0, W, H);

  const isTransparent = options.forceTransparent ?? edit.transparentMode;
  if (!isTransparent) {
    ctx.fillStyle = edit.matteColor || '#FFFFFF';
    ctx.fillRect(0, 0, W, H);
  }

  const margin = edit.whiteBorder ? Math.max(14, edit.borderSize + 6) : 0;
  const targetBox = W - margin * 2;
  const pulse = options.pulseScale ?? 1.0;
  const isLiveVideo = typeof HTMLVideoElement !== 'undefined' && sourceImage instanceof HTMLVideoElement;

  // ULTRA-FAST GPU PATH: No background removal & no white border -> 1 single direct drawImage (<0.3ms!)
  if (!edit.removeBg && (!edit.whiteBorder || edit.borderSize <= 0)) {
    if (edit.fitMode === 'cover') {
      const crop = computeSquareCrop(srcW, srcH, edit.cropX, edit.cropY, true);
      const drawSide = targetBox * edit.zoom * pulse;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate((edit.rotationDeg * Math.PI) / 180);
      ctx.drawImage(
        sourceImage,
        crop.srcX,
        crop.srcY,
        crop.cropSide,
        crop.cropSide,
        -drawSide / 2,
        -drawSide / 2,
        drawSide,
        drawSide
      );
      ctx.restore();
    } else {
      const baseScale = Math.min(targetBox / srcW, targetBox / srcH) * edit.zoom * pulse;
      const dw = srcW * baseScale;
      const dh = srcH * baseScale;
      ctx.save();
      ctx.translate(W / 2 + (edit.cropX - 0.5) * 160, H / 2 + (edit.cropY - 0.5) * 160);
      ctx.rotate((edit.rotationDeg * Math.PI) / 180);
      ctx.drawImage(sourceImage, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }
    drawCaptionOverlay(ctx, W, H, edit);
    return;
  }

  // CACHED SPRITE PATH: For non-video sources (static images / GIF frames), cache processed cutout+border
  // so beat-bounce playback or repeated renders simply scale the cached 512x512 bitmap in <0.4ms!
  const cacheKey = isLiveVideo
    ? ''
    : [
        getSourceId(sourceImage),
        srcW,
        srcH,
        edit.fitMode,
        edit.cropX,
        edit.cropY,
        edit.zoom,
        edit.rotationDeg,
        edit.removeBg ? 1 : 0,
        edit.removeBg ? `${edit.bgColor.r},${edit.bgColor.g},${edit.bgColor.b},${edit.bgTolerance},${edit.floodFillEdgesOnly ? 1 : 0}` : '',
        edit.whiteBorder ? edit.borderSize : 0,
        options.fastPreview ? 1 : 0
      ].join('|');

  if (isLiveVideo || cacheKey !== cachedCompositeKey) {
    subjectScratchCtx.clearRect(0, 0, W, H);

    if (edit.fitMode === 'cover') {
      const crop = computeSquareCrop(srcW, srcH, edit.cropX, edit.cropY, true);
      const drawSide = targetBox * edit.zoom;
      subjectScratchCtx.save();
      subjectScratchCtx.translate(W / 2, H / 2);
      subjectScratchCtx.rotate((edit.rotationDeg * Math.PI) / 180);
      subjectScratchCtx.drawImage(
        sourceImage,
        crop.srcX,
        crop.srcY,
        crop.cropSide,
        crop.cropSide,
        -drawSide / 2,
        -drawSide / 2,
        drawSide,
        drawSide
      );
      subjectScratchCtx.restore();
    } else {
      const baseScale = Math.min(targetBox / srcW, targetBox / srcH) * edit.zoom;
      const dw = srcW * baseScale;
      const dh = srcH * baseScale;
      subjectScratchCtx.save();
      subjectScratchCtx.translate(W / 2 + (edit.cropX - 0.5) * 160, H / 2 + (edit.cropY - 0.5) * 160);
      subjectScratchCtx.rotate((edit.rotationDeg * Math.PI) / 180);
      subjectScratchCtx.drawImage(sourceImage, -dw / 2, -dh / 2, dw, dh);
      subjectScratchCtx.restore();
    }

    if (edit.removeBg) {
      removeBackgroundInPlace(
        subjectScratchCtx,
        W,
        H,
        edit.bgColor,
        edit.bgTolerance,
        edit.floodFillEdgesOnly
      );
    }

    cachedCompositeCtx.clearRect(0, 0, W, H);

    if (edit.whiteBorder && edit.borderSize > 0) {
      silScratchCtx.clearRect(0, 0, W, H);
      silScratchCtx.drawImage(subjectScratch, 0, 0);
      silScratchCtx.globalCompositeOperation = 'source-in';
      silScratchCtx.fillStyle = '#FFFFFF';
      silScratchCtx.fillRect(0, 0, W, H);
      silScratchCtx.globalCompositeOperation = 'source-over';

      cachedCompositeCtx.save();
      if (!options.fastPreview && !isLiveVideo) {
        cachedCompositeCtx.shadowColor = 'rgba(0, 0, 0, 0.36)';
        cachedCompositeCtx.shadowBlur = 10;
        cachedCompositeCtx.shadowOffsetY = 3;
      }

      const r = edit.borderSize;
      const steps = options.fastPreview || isLiveVideo ? 10 : Math.max(14, Math.min(24, Math.round(r * 1.8)));
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        cachedCompositeCtx.drawImage(silScratch, Math.cos(angle) * r, Math.sin(angle) * r);
      }
      cachedCompositeCtx.restore();
    }

    cachedCompositeCtx.drawImage(subjectScratch, 0, 0);
    cachedCompositeKey = cacheKey;
  }

  // Composite cached cutout+border with optional beat pulse scale
  if (Math.abs(pulse - 1.0) > 0.001) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(pulse, pulse);
    ctx.drawImage(cachedComposite, -W / 2, -H / 2);
    ctx.restore();
  } else {
    ctx.drawImage(cachedComposite, 0, 0);
  }

  drawCaptionOverlay(ctx, W, H, edit);
}

/**
 * Encodes a 512x512 WebP sticker strictly <= 100 KB and injects the official
 * WhatsApp RIFF EXIF (0x5741 "WA") binary metadata chunk.
 */
export async function encodeWebpUnder100KB(
  sticker: LoadedSticker,
  edit: StickerEditState
): Promise<{ bytes: Uint8Array; blob: Blob }> {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  renderStickerToCanvas(c, sticker.image, sticker.width, sticker.height, edit, { forceTransparent: true });

  const qualities = [0.92, 0.85, 0.78, 0.7, 0.6, 0.5];
  for (const q of qualities) {
    const rawBlob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/webp', q));
    if (!rawBlob) continue;
    const rawBytes = new Uint8Array(await rawBlob.arrayBuffer());
    const injected = injectWhatsAppExifAndAudioIntoWebp(rawBytes, null);
    if (injected.totalBytes <= LIMITS.MAX_STATIC_WEBP_BYTES || q === 0.5) {
      return { bytes: injected.webpBytes, blob: injected.blob };
    }
  }

  throw new Error('No se pudo codificar el sticker en formato WebP.');
}

/**
 * Encodes a 512x512 WebP Sticker with BOTH the official WhatsApp RIFF EXIF (0x5741)
 * AND the compressed MP3 audio track embedded directly inside the .webp RIFF container!
 */
export async function encodeWebpWithEmbeddedAudio(
  sticker: LoadedSticker,
  edit: StickerEditState,
  audio: LoadedAudio,
  trim: AudioTrimState
): Promise<ExportArtifact> {
  const durationMs = Math.max(LIMITS.MIN_TRIM_DURATION_MS, Math.min(trim.endMs - trim.startMs, trim.maxWindowMs));
  const pcm48k = extractTrimmedMono48k(audio.buffer, {
    ...trim,
    endMs: trim.startMs + durationMs
  });

  // Downsample 48kHz -> 24kHz mono and encode at compact 32kbps MP3 (~4KB/sec) so audio fits inside <100KB WebP!
  const pcm24k = new Float32Array(Math.max(1, Math.floor(pcm48k.length / 2)));
  for (let i = 0; i < pcm24k.length; i++) {
    pcm24k[i] = pcm48k[i * 2] ?? 0;
  }
  const compactAudio = encodeCompactMp3Bytes(pcm24k, 24000, 32);

  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  renderStickerToCanvas(c, sticker.image, sticker.width, sticker.height, edit, { forceTransparent: true });

  const qualities = [0.86, 0.78, 0.68, 0.58, 0.48];
  for (const q of qualities) {
    const rawBlob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/webp', q));
    if (!rawBlob) continue;
    const rawBytes = new Uint8Array(await rawBlob.arrayBuffer());

    // First try embedding both raw SAUD chunk + EXIF base64; if >100KB, embed SAUD chunk + compact EXIF header
    let injected = injectWhatsAppExifAndAudioIntoWebp(rawBytes, compactAudio.bytes, {
      audioMime: compactAudio.mime,
      audioDurationMs: durationMs,
      embedBase64InExif: rawBytes.byteLength + compactAudio.bytes.byteLength * 2.4 < LIMITS.MAX_STATIC_WEBP_BYTES
    });

    if (injected.totalBytes <= LIMITS.MAX_STATIC_WEBP_BYTES || q === 0.48) {
      return {
        profile: 'webp-audio-exif',
        bytes: injected.webpBytes,
        blob: injected.blob,
        url: URL.createObjectURL(injected.blob),
        fileName: 'audiosticker-512x512-audio.webp',
        mimeType: 'image/webp',
        extension: 'webp',
        durationMs,
        hasAlpha: true
      };
    }
  }

  throw new Error('No se pudo inyectar el audio dentro del contenedor WebP.');
}

function encodeCompactMp3Bytes(samples: Float32Array, sampleRate = 24000, kbps = 32): { bytes: Uint8Array; mime: string } {
  const AnyWin = window as unknown as { lamejs?: any };
  if (!AnyWin.lamejs) {
    return { bytes: encodeWavBytesFromMono48k(samples, sampleRate), mime: 'audio/wav' };
  }
  const encoder = new AnyWin.lamejs.Mp3Encoder(1, sampleRate, kbps);
  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const chunks: Int8Array[] = [];
  const blockSize = 1152;
  for (let i = 0; i < pcm16.length; i += blockSize) {
    const sub = pcm16.subarray(i, i + blockSize);
    const mp3buf: Int8Array = encoder.encodeBuffer(sub);
    if (mp3buf.length > 0) chunks.push(new Int8Array(mp3buf));
  }
  const endBuf: Int8Array = encoder.flush();
  if (endBuf.length > 0) chunks.push(new Int8Array(endBuf));

  let totalLen = 0;
  for (const c of chunks) totalLen += c.byteLength;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), offset);
    offset += c.byteLength;
  }
  return { bytes: out, mime: 'audio/mpeg' };
}

/**
 * Computes normalized waveform peak bars from an AudioBuffer using stride subsampling
 * so even 3-minute 48kHz audio files compute in <2ms on mobile CPUs.
 */
export function computeWaveformPeaks(buffer: AudioBuffer, buckets: number = LIMITS.WAVEFORM_BUCKETS): Float32Array {
  const ch = buffer.getChannelData(0);
  const total = ch.length;
  const step = Math.max(1, Math.floor(total / buckets));
  const innerStride = Math.max(1, Math.floor(step / 64));
  const peaks = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    const start = i * step;
    const end = Math.min(total, start + step);
    let max = 0;
    for (let j = start; j < end; j += innerStride) {
      const v = Math.abs(ch[j]!);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

/**
 * Extracts trimmed & resampled 48kHz mono PCM samples for video/audio encoding.
 */
export function extractTrimmedMono48k(buffer: AudioBuffer, trim: AudioTrimState): Float32Array {
  const srcRate = buffer.sampleRate;
  const startSample = Math.max(0, Math.floor((trim.startMs / 1000) * srcRate));
  const endSample = Math.min(buffer.length, Math.floor((trim.endMs / 1000) * srcRate));
  const sliceLen = Math.max(1, endSample - startSample);

  const mono = new Float32Array(sliceLen);
  const nCh = buffer.numberOfChannels;
  const fadeLen = trim.fadeInOut ? Math.min(Math.floor(srcRate * 0.12), Math.floor(sliceLen * 0.2)) : 0;

  for (let c = 0; c < nCh; c++) {
    const chData = buffer.getChannelData(c);
    for (let i = 0; i < sliceLen; i++) {
      mono[i] = (mono[i] ?? 0) + (chData[startSample + i] ?? 0) / nCh;
    }
  }

  for (let i = 0; i < sliceLen; i++) {
    let env = 1.0;
    if (fadeLen > 0) {
      if (i < fadeLen) env = i / fadeLen;
      else if (i > sliceLen - fadeLen) env = (sliceLen - i) / fadeLen;
    }
    mono[i] = Math.max(-1, Math.min(1, mono[i]! * trim.volume * env));
  }

  const targetRate = LIMITS.OPUS_SAMPLE_RATE;
  if (srcRate === targetRate) return mono;

  const outLen = Math.max(1, Math.round((sliceLen * targetRate) / srcRate));
  const resampled = new Float32Array(outLen);
  const ratio = srcRate / targetRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.min(sliceLen - 1, Math.floor(pos));
    const next = Math.min(sliceLen - 1, idx + 1);
    const frac = pos - idx;
    resampled[i] = mono[idx]! * (1 - frac) + mono[next]! * frac;
  }
  return resampled;
}

/**
 * Encodes 48kHz mono Float32 samples into a 16-bit PCM WAV byte array.
 */
export function encodeWavBytesFromMono48k(samples: Float32Array, sampleRate = 48000): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const q = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767);
    view.setInt16(44 + i * 2, q, true);
  }
  return out;
}

/**
 * Encodes 48kHz mono Float32 samples into MP3 using global lamejs (with WAV fallback).
 */
export function encodeMp3BytesFromMono48k(samples: Float32Array, sampleRate = 48000): { bytes: Uint8Array; ext: 'mp3' | 'wav'; mime: string } {
  const AnyWin = window as unknown as { lamejs?: any };
  if (!AnyWin.lamejs) {
    return { bytes: encodeWavBytesFromMono48k(samples, sampleRate), ext: 'wav', mime: 'audio/wav' };
  }

  const encoder = new AnyWin.lamejs.Mp3Encoder(1, sampleRate, 128);
  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const chunks: Int8Array[] = [];
  const blockSize = 1152;
  for (let i = 0; i < pcm16.length; i += blockSize) {
    const sub = pcm16.subarray(i, i + blockSize);
    const mp3buf: Int8Array = encoder.encodeBuffer(sub);
    if (mp3buf.length > 0) chunks.push(new Int8Array(mp3buf));
  }
  const endBuf: Int8Array = encoder.flush();
  if (endBuf.length > 0) chunks.push(new Int8Array(endBuf));

  let totalLen = 0;
  for (const c of chunks) totalLen += c.byteLength;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), offset);
    offset += c.byteLength;
  }

  return { bytes: out, ext: 'mp3', mime: 'audio/mpeg' };
}

/**
 * Renders a fused Video-Sticker (MP4 H.264+AAC or WebM VP9 Alpha+Opus) combining the 512x512 sticker
 * (static or animated GIF + optional beat bounce) and the trimmed audio track!
 * Follows SilverFeit/StikSound's dual-engine approach:
 *   1) Zero-dependency WebCodecs (VideoEncoder + AudioEncoder + mp4-muxer / webm-muxer)
 *   2) Universal MediaRecorder fallback (Canvas.captureStream + AudioContext MediaStreamDestination)
 */
export async function renderFusedVideoSticker(
  sticker: LoadedSticker,
  edit: StickerEditState,
  audio: LoadedAudio,
  trim: AudioTrimState,
  container: 'mp4' | 'webm-alpha'
): Promise<ExportArtifact> {
  const durationMs = Math.max(LIMITS.MIN_TRIM_DURATION_MS, Math.min(trim.endMs - trim.startMs, trim.maxWindowMs));
  const pcm48k = extractTrimmedMono48k(audio.buffer, {
    ...trim,
    endMs: trim.startMs + durationMs
  });

  const isWebm = container === 'webm-alpha';
  const AnyWin = window as unknown as {
    VideoEncoder?: any;
    AudioEncoder?: any;
    VideoFrame?: any;
    AudioData?: any;
  };

  // Path 1: Fast In-Memory WebCodecs + mp4-muxer / webm-muxer
  if (
    typeof AnyWin.VideoEncoder !== 'undefined' &&
    typeof AnyWin.AudioEncoder !== 'undefined' &&
    typeof AnyWin.VideoFrame !== 'undefined' &&
    typeof AnyWin.AudioData !== 'undefined'
  ) {
    const videoCodec = isWebm ? 'vp09.00.10.08' : 'avc1.42001f';
    const audioCodec = isWebm ? 'opus' : 'mp4a.40.2';

    try {
      const vConfig: any = {
        codec: videoCodec,
        width: 512,
        height: 512,
        bitrate: 1_400_000,
        framerate: 24,
        ...(isWebm ? { alpha: 'keep' } : { avc: { format: 'avc' } })
      };
      const aConfig: any = {
        codec: audioCodec,
        sampleRate: 48000,
        numberOfChannels: 1,
        bitrate: isWebm ? 64_000 : 128_000
      };

      const vSup = await AnyWin.VideoEncoder.isConfigSupported(vConfig);
      const aSup = await AnyWin.AudioEncoder.isConfigSupported(aConfig);

      if (vSup.supported && aSup.supported) {
        return await encodeWithWebCodecsMuxer(
          sticker,
          edit,
          pcm48k,
          durationMs,
          trim.startMs,
          isWebm,
          vConfig,
          aConfig
        );
      }
    } catch (webCodecsErr) {
      console.warn('WebCodecs muxer failed, falling back to MediaRecorder:', webCodecsErr);
    }
  }

  // Path 2: Universal Canvas.captureStream + MediaRecorder fallback
  return await encodeWithMediaRecorderFallback(sticker, edit, pcm48k, durationMs, trim.startMs, isWebm);
}

async function encodeWithWebCodecsMuxer(
  sticker: LoadedSticker,
  edit: StickerEditState,
  pcm48k: Float32Array,
  durationMs: number,
  clipStartMs: number,
  isWebm: boolean,
  vConfig: any,
  aConfig: any
): Promise<ExportArtifact> {
  const AnyWin = window as unknown as {
    VideoEncoder: any;
    AudioEncoder: any;
    VideoFrame: any;
    AudioData: any;
  };

  const mp4Target = isWebm ? null : new Mp4Target();
  const webmTarget = isWebm ? new WebmTarget() : null;

  const mp4Muxer = mp4Target
    ? new Mp4Muxer({
        target: mp4Target,
        video: { codec: 'avc', width: 512, height: 512 },
        audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 1 },
        fastStart: 'in-memory'
      })
    : null;

  const webmMuxer = webmTarget
    ? new WebmMuxer({
        target: webmTarget,
        video: { codec: 'V_VP9', width: 512, height: 512, alpha: true },
        audio: { codec: 'A_OPUS', sampleRate: 48000, numberOfChannels: 1 }
      })
    : null;

  let encoderError: unknown = null;

  const videoEncoder = new AnyWin.VideoEncoder({
    output: (chunk: any, meta: any) => {
      try {
        mp4Muxer?.addVideoChunk(chunk, meta);
        webmMuxer?.addVideoChunk(chunk, meta);
      } catch (e) {
        encoderError = e;
      }
    },
    error: (e: any) => {
      encoderError = e;
    }
  });

  videoEncoder.configure(vConfig);

  const audioEncoder = new AnyWin.AudioEncoder({
    output: (chunk: any, meta: any) => {
      try {
        mp4Muxer?.addAudioChunk(chunk, meta);
        webmMuxer?.addAudioChunk(chunk, meta);
      } catch (e) {
        encoderError = e;
      }
    },
    error: (e: any) => {
      encoderError = e;
    }
  });

  audioEncoder.configure(aConfig);

  const fps = sticker.videoEl ? 18 : 24;
  const totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps));
  const frameDurationUs = Math.round(1_000_000 / fps);
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = 512;
  frameCanvas.height = 512;

  const gifFrames = sticker.gifFrames;
  let totalGifLoopMs = 0;
  for (const gf of gifFrames) totalGifLoopMs += gf.delayMs;

  const vid = sticker.videoEl;
  const wasPlayingVid = vid ? !vid.paused : false;
  if (vid) vid.pause();

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (encoderError) throw encoderError;
      const tMs = (i / fps) * 1000;
      let frameSource: CanvasImageSource = sticker.image;
      let srcW = sticker.width;
      let srcH = sticker.height;

      if (vid && vid.readyState >= 2) {
        const vDurMs = Math.max(200, sticker.videoDurationMs || (vid.duration || 5) * 1000);
        const targetSec = ((clipStartMs + tMs) % vDurMs) / 1000;
        await seekVideoTo(vid, targetSec);
        frameSource = vid;
        srcW = vid.videoWidth || sticker.width;
        srcH = vid.videoHeight || sticker.height;
      } else if (gifFrames.length > 1 && totalGifLoopMs > 0) {
        const modMs = tMs % totalGifLoopMs;
        let acc = 0;
        for (const gf of gifFrames) {
          acc += gf.delayMs;
          if (modMs <= acc) {
            frameSource = gf.canvas;
            srcW = gf.canvas.width;
            srcH = gf.canvas.height;
            break;
          }
        }
      }

      let pulseScale = 1.0;
      if (edit.beatBounce) {
        const sampleIdx = Math.min(pcm48k.length - 1, Math.floor((tMs / 1000) * 48000));
        let peak = 0;
        const win = 1200;
        for (let s = Math.max(0, sampleIdx - win); s < Math.min(pcm48k.length, sampleIdx + win); s += 16) {
          const a = Math.abs(pcm48k[s]!);
          if (a > peak) peak = a;
        }
        pulseScale = 1.0 + Math.min(0.08, peak * 0.09);
      }

      renderStickerToCanvas(frameCanvas, frameSource, srcW, srcH, edit, {
        forceTransparent: isWebm,
        pulseScale
      });

      const vf = new AnyWin.VideoFrame(frameCanvas, {
        timestamp: i * frameDurationUs,
        duration: frameDurationUs
      });
      videoEncoder.encode(vf, { keyFrame: i === 0 || i % fps === 0 });
      vf.close();

      if (i % 8 === 7) {
        await new Promise((r) => window.setTimeout(r, 0));
      }
    }
  } finally {
    if (vid && wasPlayingVid) {
      vid.play().catch(() => {});
    }
  }

  // Feed audio in 1024-sample frames (standard AAC-LC / Opus frame size)
  const chunkFrames = 1024;
  for (let offset = 0; offset < pcm48k.length; offset += chunkFrames) {
    if (encoderError) throw encoderError;
    const slice = pcm48k.subarray(offset, Math.min(pcm48k.length, offset + chunkFrames));
    const tsUs = Math.round((offset / 48000) * 1_000_000);
    const ad = new AnyWin.AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: slice.length,
      numberOfChannels: 1,
      timestamp: tsUs,
      data: slice.slice()
    });
    audioEncoder.encode(ad);
    ad.close();
  }

  await videoEncoder.flush();
  await audioEncoder.flush();
  if (videoEncoder.state !== 'closed') videoEncoder.close();
  if (audioEncoder.state !== 'closed') audioEncoder.close();

  if (encoderError) throw encoderError;

  if (mp4Muxer && mp4Target) {
    mp4Muxer.finalize();
    const bytes = new Uint8Array(mp4Target.buffer);
    if (bytes.byteLength < 256) throw new Error('Empty MP4 buffer');
    const blob = new Blob([bytes.slice().buffer], { type: 'video/mp4' });
    return {
      profile: 'video-mp4',
      bytes,
      blob,
      url: URL.createObjectURL(blob),
      fileName: 'stiksound-whatsapp.mp4',
      mimeType: 'video/mp4',
      extension: 'mp4',
      durationMs,
      hasAlpha: false
    };
  }

  webmMuxer!.finalize();
  const bytes = new Uint8Array(webmTarget!.buffer);
  if (bytes.byteLength < 256) throw new Error('Empty WebM buffer');
  const blob = new Blob([bytes.slice().buffer], { type: 'video/webm' });
  return {
    profile: 'video-webm-alpha',
    bytes,
    blob,
    url: URL.createObjectURL(blob),
    fileName: 'stiksound-alpha.webm',
    mimeType: 'video/webm',
    extension: 'webm',
    durationMs,
    hasAlpha: true
  };
}

async function encodeWithMediaRecorderFallback(
  sticker: LoadedSticker,
  edit: StickerEditState,
  pcm48k: Float32Array,
  durationMs: number,
  clipStartMs: number,
  isWebm: boolean
): Promise<ExportArtifact> {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;

  const actx = new AudioContext({ sampleRate: 48000 });
  const audioBuffer = actx.createBuffer(1, pcm48k.length, 48000);
  audioBuffer.copyToChannel( new Float32Array(pcm48k), 0);
  const source = actx.createBufferSource();
  source.buffer = audioBuffer;
  const dest = actx.createMediaStreamDestination();
  source.connect(dest);

  const videoStream = canvas.captureStream(24);
  const combined = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const mimeCandidates = isWebm
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const chosenMime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(combined, { mimeType: chosenMime });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: chosenMime }));
    recorder.onerror = () => reject(new Error('Error en MediaRecorder.'));
  });

  const startPerf = performance.now();
  const gifFrames = sticker.gifFrames;
  let totalGifLoopMs = 0;
  for (const gf of gifFrames) totalGifLoopMs += gf.delayMs;

  const vid = sticker.videoEl;
  if (vid && vid.readyState >= 2) {
    try {
      const vDurSec = Math.max(0.2, (sticker.videoDurationMs || (vid.duration || 5) * 1000) / 1000);
      vid.currentTime = (clipStartMs / 1000) % vDurSec;
      vid.play().catch(() => {});
    } catch {}
  }

  const drawTick = () => {
    const elapsedMs = performance.now() - startPerf;
    let frameSource: CanvasImageSource = sticker.image;
    let srcW = sticker.width;
    let srcH = sticker.height;

    if (vid && vid.readyState >= 2) {
      frameSource = vid;
      srcW = vid.videoWidth || sticker.width;
      srcH = vid.videoHeight || sticker.height;
    } else if (gifFrames.length > 1 && totalGifLoopMs > 0) {
      const modMs = elapsedMs % totalGifLoopMs;
      let acc = 0;
      for (const gf of gifFrames) {
        acc += gf.delayMs;
        if (modMs <= acc) {
          frameSource = gf.canvas;
          srcW = gf.canvas.width;
          srcH = gf.canvas.height;
          break;
        }
      }
    }

    let pulseScale = 1.0;
    if (edit.beatBounce) {
      const idx = Math.min(pcm48k.length - 1, Math.floor((elapsedMs / 1000) * 48000));
      pulseScale = 1.0 + Math.min(0.08, Math.abs(pcm48k[idx] ?? 0) * 0.09);
    }

    renderStickerToCanvas(canvas, frameSource, srcW, srcH, edit, {
      forceTransparent: isWebm,
      pulseScale
    });
  };

  drawTick();
  const intervalId = window.setInterval(drawTick, 42);
  recorder.start();
  source.start();

  await new Promise((r) => window.setTimeout(r, durationMs));
  window.clearInterval(intervalId);
  try { source.stop(); } catch {}
  if (recorder.state !== 'inactive') recorder.stop();

  const outBlob = await done;
  await actx.close().catch(() => {});

  const outIsMp4 = chosenMime.includes('mp4');
  const bytes = new Uint8Array(await outBlob.arrayBuffer());
  const mimeType = outIsMp4 ? 'video/mp4' : 'video/webm';
  const ext = outIsMp4 ? 'mp4' : 'webm';

  return {
    profile: isWebm ? 'video-webm-alpha' : 'video-mp4',
    bytes,
    blob: outBlob,
    url: URL.createObjectURL(outBlob),
    fileName: `stiksound-whatsapp.${ext}`,
    mimeType,
    extension: ext,
    durationMs,
    hasAlpha: !outIsMp4 && isWebm
  };
}

/**
 * Packages a StikSound .stiksound.zip bundle (manifest.json + sticker.webp + sound.wav).
 */
export async function createSoundBundleZip(
  sticker: LoadedSticker,
  edit: StickerEditState,
  audio: LoadedAudio,
  trim: AudioTrimState
): Promise<ExportArtifact> {
  const { bytes: webpBytes } = await encodeWebpUnder100KB(sticker, edit);
  const pcm48k = extractTrimmedMono48k(audio.buffer, trim);
  const wavBytes = encodeWavBytesFromMono48k(pcm48k, 48000);
  const nowIso = new Date().toISOString();

  const manifest: StikSoundProjectManifest = {
    schema_version: '1.0',
    project: {
      id: 'stiksound-' + Date.now().toString(36),
      name: sticker.name.replace(/\.[^.]+$/, '') || 'stiksound',
      created_at: nowIso,
      updated_at: nowIso
    },
    sticker: {
      source_name: sticker.name,
      format: sticker.format,
      width: sticker.width,
      height: sticker.height,
      edit
    },
    audio: {
      source_name: audio.name,
      duration_ms: audio.durationMs,
      start_ms: trim.startMs,
      end_ms: trim.endMs,
      volume: trim.volume
    },
    bundle: {
      kind: 'sound-bundle',
      created_at: nowIso,
      files: {
        sticker: 'sticker.webp',
        audio: 'sound.wav'
      },
      limits: {
        sticker_px: 512,
        max_static_bytes: 102400,
        max_audio_ms: trim.maxWindowMs
      },
      whatsapp_native: false
    }
  };

  const zipped = zipSync(
    {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      'sticker.webp': webpBytes,
      'sound.wav': wavBytes
    },
    { level: 6 }
  );

  const bytes = new Uint8Array(zipped);
  const blob = new Blob([bytes.slice().buffer], { type: 'application/zip' });
  return {
    profile: 'sound-bundle',
    bytes,
    blob,
    url: URL.createObjectURL(blob),
    fileName: 'proyecto.stiksound.zip',
    mimeType: 'application/zip',
    extension: 'zip',
    durationMs: trim.endMs - trim.startMs
  };
}

/**
 * Unpacks a .stiksound.zip project archive.
 */
export function unpackSoundBundleZip(zipBytes: Uint8Array): {
  manifest: StikSoundProjectManifest | null;
  stickerBytes: Uint8Array | null;
  audioBytes: Uint8Array | null;
} {
  const entries = unzipSync(zipBytes);
  let manifest: StikSoundProjectManifest | null = null;
  if (entries['manifest.json']) {
    try {
      manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as StikSoundProjectManifest;
    } catch {
      manifest = null;
    }
  }
  const stickerBytes = entries['sticker.webp'] ?? entries['sticker.png'] ?? null;
  const audioBytes = entries['sound.wav'] ?? entries['sound.ogg'] ?? entries['sound.mp3'] ?? null;
  return { manifest, stickerBytes, audioBytes };
}
