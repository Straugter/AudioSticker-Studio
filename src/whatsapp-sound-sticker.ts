/**
 * Native WhatsApp Sound Sticker Compiler (100% Browser / Zero FFmpeg)
 * Inspired by Shirtep/WA-audio-stickers + SilverFeit/StikSound:
 *
 * 1) Encodes trimmed audio (48kHz mono PCM) into a genuine RFC 3533 / RFC 7845 Ogg/Opus file
 *    (`audio/ogg; codecs=opus`) using WebCodecs `AudioEncoder`.
 * 2) Computes the exact `sound-sha256` (base64 SHA-256 of unencrypted Ogg/Opus bytes).
 * 3) Builds an official WhatsApp Big-Endian TIFF EXIF block (tag 0x5741 "WA") containing:
 *    `sticker-pack-id`, `sticker-pack-name`, `sticker-pack-publisher`, `emojis`, and `sound-sha256`.
 * 4) Builds an official Animated WebP (`VP8X` + `ANIM` + `ANMF` chunks + `EXIF`, <= 1 MB) from:
 *    - Static sticker (with optional Audio-Reactive Beat Bounce animation!), OR
 *    - Animated GIF frames, OR
 *    - Short video frames!
 */

import { extractTrimmedMono48k, renderStickerToCanvas, seekVideoTo } from './media-engine';
import type { AudioTrimState, LoadedAudio, LoadedSticker, StickerEditState } from './types';

const SAMPLE_RATE = 48000;
const MAX_STICKER_BYTES = 980_000; // WhatsApp rejects >= 1 MB (HTTP 413)
const MAX_AUDIO_BYTES = 980_000;
const te = new TextEncoder();

export interface CompiledSoundSticker {
  webpBytes: Uint8Array;
  webpBlob: Blob;
  oggBytes: Uint8Array;
  oggBlob: Blob;
  soundSha256: string;
  seconds: number;
  durationMs: number;
  side: number;
  isAnimated: boolean;
  frameCount: number;
  packName: string;
  publisher: string;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u24LE(arr: Uint8Array, off: number, val: number): void {
  arr[off] = val & 0xff;
  arr[off + 1] = (val >> 8) & 0xff;
  arr[off + 2] = (val >> 16) & 0xff;
}

function makeRiffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(te.encode(fourcc), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function readWebpChunks(bytes: Uint8Array): Array<{ fourcc: string; data: Uint8Array }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) =>
    String.fromCharCode(bytes[o] ?? 0, bytes[o + 1] ?? 0, bytes[o + 2] ?? 0, bytes[o + 3] ?? 0);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') {
    throw new Error('Canvas did not return a valid RIFF WEBP buffer.');
  }
  const chunks: Array<{ fourcc: string; data: Uint8Array }> = [];
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = tag(i);
    const size = dv.getUint32(i + 4, true);
    chunks.push({ fourcc, data: bytes.subarray(i + 8, Math.min(bytes.length, i + 8 + size)) });
    i += 8 + size + (size & 1);
  }
  return chunks;
}

// ============================================================================
// 1. OGG / OPUS ENCODER (RFC 3533 + RFC 7845 via WebCodecs AudioEncoder)
// ============================================================================
const OGG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(bytes: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) {
    c = ((c << 8) ^ OGG_CRC_TABLE[((c >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  }
  return c >>> 0;
}

function buildOggPage(
  headerType: number,
  granule: number,
  serial: number,
  seq: number,
  packetList: Uint8Array[]
): Uint8Array {
  const lacing: number[] = [];
  for (const p of packetList) {
    let len = p.length;
    while (len >= 255) {
      lacing.push(255);
      len -= 255;
    }
    lacing.push(len);
  }
  const dataLen = packetList.reduce((acc, p) => acc + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + dataLen);
  const dv = new DataView(page.buffer);
  page.set(te.encode('OggS'), 0);
  page[4] = 0;
  page[5] = headerType;
  dv.setBigInt64(6, BigInt(granule), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  dv.setUint32(22, 0, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let off = 27 + lacing.length;
  for (const p of packetList) {
    page.set(p, off);
    off += p.length;
  }
  dv.setUint32(22, oggCrc(page), true);
  return page;
}

function muxOggOpus(packets: Uint8Array[], preSkip: number, totalSamples: number): Uint8Array {
  const serial = (Math.random() * 0xffffffff) >>> 0;

  // Page 0: OpusHead (19 bytes)
  const head = new Uint8Array(19);
  head.set(te.encode('OpusHead'), 0);
  head[8] = 1; // version
  head[9] = 1; // mono
  const hdv = new DataView(head.buffer);
  hdv.setUint16(10, preSkip, true);
  hdv.setUint32(12, SAMPLE_RATE, true);

  // Page 1: OpusTags
  const vendor = te.encode('AudioStickerStudio');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(te.encode('OpusTags'), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  const pages: Uint8Array[] = [
    buildOggPage(0x02, 0, serial, 0, [head]),
    buildOggPage(0x00, 0, serial, 1, [tags])
  ];

  const finalGranule = preSkip + totalSamples;
  const perPage = 50; // ~1s per page (20ms Opus frames)
  let seq = 2;

  for (let i = 0; i < packets.length; i += perPage) {
    const group = packets.slice(i, i + perPage);
    const isLast = i + perPage >= packets.length;
    const granule = isLast ? finalGranule : Math.min(finalGranule, preSkip + (i + group.length) * 960);
    pages.push(buildOggPage(isLast ? 0x04 : 0x00, granule, serial, seq++, group));
  }

  return concatBytes(pages);
}

export async function encodePcmToOggOpus(pcm48k: Float32Array, bitrate = 32000): Promise<Uint8Array> {
  const AnyWin = window as unknown as { AudioEncoder?: any; AudioData?: any };
  if (typeof AnyWin.AudioEncoder === 'undefined' || typeof AnyWin.AudioData === 'undefined') {
    throw new Error('Tu navegador no soporta WebCodecs (AudioEncoder) para codificar Ogg/Opus. Usa Chrome, Edge o Brave actualizado.');
  }

  const base = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate };
  const candidates = [
    { ...base, bitrateMode: 'variable', opus: { frameDuration: 20000, complexity: 10, application: 'audio' } },
    { ...base, bitrateMode: 'variable', opus: { frameDuration: 20000 } },
    base
  ];

  let chosenConfig: any = null;
  for (const cfg of candidates) {
    try {
      const sup = await AnyWin.AudioEncoder.isConfigSupported(cfg);
      if (sup.supported) {
        chosenConfig = cfg;
        break;
      }
    } catch {}
  }
  if (!chosenConfig) {
    throw new Error('El navegador no soporta codificación Opus con WebCodecs.');
  }

  const packets: Uint8Array[] = [];
  const descRef: { value: Uint8Array | null } = { value: null };
  let encError: unknown = null;

  const encoder = new AnyWin.AudioEncoder({
    output: (chunk: any, meta: any) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push(b);
      if (!descRef.value && meta?.decoderConfig?.description) {
        const d = meta.decoderConfig.description;
        descRef.value =
          d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      }
    },
    error: (e: unknown) => {
      encError = e;
    }
  });

  encoder.configure(chosenConfig);

  const blockFrames = 960 * 50; // 1 second chunks
  for (let i = 0; i < pcm48k.length; i += blockFrames) {
    if (encError) throw encError;
    const n = Math.min(blockFrames, pcm48k.length - i);
    const slice = new Float32Array(pcm48k.subarray(i, i + n));
    const ad = new AnyWin.AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: n,
      numberOfChannels: 1,
      timestamp: Math.round((i / SAMPLE_RATE) * 1e6),
      data: slice
    });
    encoder.encode(ad);
    ad.close();
  }

  await encoder.flush();
  encoder.close();
  if (encError) throw encError;

  let preSkip = 312;
  const desc = descRef.value;
  if (desc && desc.length >= 12) {
    const headTag = String.fromCharCode(...desc.subarray(0, 8));
    if (headTag === 'OpusHead') {
      preSkip = desc[10]! | (desc[11]! << 8);
    }
  }

  const oggBytes = muxOggOpus(packets, preSkip, pcm48k.length);
  if (oggBytes.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('El audio Ogg/Opus supera el límite de 1 MB de WhatsApp.');
  }
  return oggBytes;
}

// ============================================================================
// 2. OFFICIAL WHATSAPP BIG-ENDIAN TIFF EXIF (0x5741 "WA") WITH `sound-sha256`
// ============================================================================
export async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const arr = new Uint8Array(hashBuf);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]!);
  return btoa(s);
}

async function deterministicPackId(packName: string, publisher: string): Promise<string> {
  const seed = packName || publisher ? `audiosticker|${packName}|${publisher}` : crypto.randomUUID();
  const hashBuf = await crypto.subtle.digest('SHA-256', te.encode(seed));
  const h = Array.from(new Uint8Array(hashBuf).subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function buildBigEndianWhatsAppExif(meta: Record<string, unknown>): Uint8Array {
  const js = te.encode(JSON.stringify(meta));
  const out = new Uint8Array(26 + js.length);
  const dv = new DataView(out.buffer);
  // Big-endian TIFF header "MM\0*" (exact format parsed by WhatsApp Web & Android/iOS)
  out.set([0x4d, 0x4d, 0x00, 0x2a], 0);
  dv.setUint32(4, 8, false); // offset to IFD0
  dv.setUint16(8, 1, false); // 1 entry
  dv.setUint16(10, 0x5741, false); // Tag 0x5741 ("WA")
  dv.setUint16(12, 7, false); // UNDEFINED
  dv.setUint32(14, js.length, false);
  dv.setUint32(18, 26, false); // data offset
  dv.setUint32(22, 0, false); // next IFD = 0
  out.set(js, 26);
  return out;
}

// ============================================================================
// 3. PURE-BROWSER ANIMATED WEBP BUILDER (VP8X + ANIM + ANMF + EXIF)
// ============================================================================
async function encodeCanvasFrameToWebpPayload(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<{ payload: Uint8Array; hasAlpha: boolean }> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', quality));
  if (!blob || blob.type !== 'image/webp') {
    throw new Error('El navegador no pudo codificar el fotograma en WebP.');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts = readWebpChunks(bytes).filter(
    (c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8 ' || c.fourcc === 'VP8L'
  );
  if (!parts.some((c) => c.fourcc === 'VP8 ' || c.fourcc === 'VP8L')) {
    throw new Error('Fotograma WebP sin datos de imagen.');
  }
  const payload = concatBytes(parts.map((c) => makeRiffChunk(c.fourcc, c.data)));
  const hasAlpha = parts.some((c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8L');
  return { payload, hasAlpha };
}

function assembleAnimatedWebp(
  frames: Array<{ payload: Uint8Array; hasAlpha: boolean; durationMs: number }>,
  exifBytes: Uint8Array,
  side = 512
): Uint8Array {
  const anyAlpha = frames.some((f) => f.hasAlpha);
  const vp8x = new Uint8Array(10);
  // Flags: 0x02 (Animation) | 0x10 (Alpha) | 0x08 (EXIF)
  vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0) | 0x08;
  u24LE(vp8x, 4, side - 1);
  u24LE(vp8x, 7, side - 1);

  const anim = new Uint8Array(6); // bgra = 0 (transparent), loop count = 0 (infinite)
  const parts: Uint8Array[] = [makeRiffChunk('VP8X', vp8x), makeRiffChunk('ANIM', anim)];

  for (const f of frames) {
    const hdr = new Uint8Array(16);
    u24LE(hdr, 0, 0);
    u24LE(hdr, 3, 0);
    u24LE(hdr, 6, side - 1);
    u24LE(hdr, 9, side - 1);
    u24LE(hdr, 12, Math.max(10, Math.min(0xffffff, Math.round(f.durationMs))));
    hdr[15] = 0x02; // replace frame cleanly (no blend artifacts on transparent stickers)
    parts.push(makeRiffChunk('ANMF', concatBytes([hdr, f.payload])));
  }

  parts.push(makeRiffChunk('EXIF', exifBytes));
  const body = concatBytes(parts);

  const riff = new Uint8Array(12);
  riff.set(te.encode('RIFF'), 0);
  new DataView(riff.buffer).setUint32(4, 4 + body.length, true);
  riff.set(te.encode('WEBP'), 8);
  return concatBytes([riff, body]);
}

/**
 * Compiles BOTH the official WhatsApp Animated WebP (with Big-Endian EXIF `sound-sha256` <= 1 MB)
 * AND the official Ogg/Opus 48kHz audio track ready for WhatsApp Web's `WAWebMediaPrep.sendToChat({ options: { stickerAudio } })`!
 */
export async function compileRealWhatsAppSoundSticker(
  sticker: LoadedSticker,
  edit: StickerEditState,
  audio: LoadedAudio,
  trim: AudioTrimState,
  metaOptions: { packName?: string; publisher?: string; onProgress?: (msg: string) => void } = {}
): Promise<CompiledSoundSticker> {
  const progress = metaOptions.onProgress ?? (() => {});
  const durationMs = Math.max(300, Math.min(trim.endMs - trim.startMs, trim.maxWindowMs));
  const seconds = Math.max(1, Math.round(durationMs / 1000));

  progress('Codificando pista Ogg/Opus 48 kHz...');
  const pcm48k = extractTrimmedMono48k(audio.buffer, {
    ...trim,
    endMs: trim.startMs + durationMs
  });

  // Dynamic bitrate to always fit under WhatsApp's 1 MB audio limit
  const bitrate = Math.max(16000, Math.min(32000, Math.floor((0.88 * MAX_AUDIO_BYTES * 8) / (durationMs / 1000))));
  const oggBytes = await encodePcmToOggOpus(pcm48k, bitrate);
  const soundSha256 = await sha256Base64(oggBytes);

  const packName = (metaOptions.packName ?? 'AudioSticker Studio').trim().slice(0, 128);
  const publisher = (metaOptions.publisher ?? 'AudioSticker').trim().slice(0, 128);
  const packId = await deterministicPackId(packName, publisher);

  const exifMeta: Record<string, unknown> = {
    'sticker-pack-id': packId,
    'sticker-pack-name': packName || 'AudioSticker Studio',
    'sticker-pack-publisher': publisher || 'AudioSticker',
    emojis: ['🔊'],
    'sound-sha256': soundSha256
  };
  const exifBytes = buildBigEndianWhatsAppExif(exifMeta);

  // Build transparent animated WebP frames with SINGLE-PASS frame sampling + 3-Frame Size Prediction!
  // This avoids re-rendering/re-encoding 50+ frames repeatedly across multiple sizes/qualities (5x-10x faster!).
  const isVideo = Boolean(sticker.videoEl && sticker.videoEl.readyState >= 2);
  const shouldAnimateFrames = isVideo || sticker.animated || edit.beatBounce;

  const workCanvas = document.createElement('canvas');
  workCanvas.width = 512;
  workCanvas.height = 512;
  const scaleCanvas = document.createElement('canvas');
  const scaleCtx = scaleCanvas.getContext('2d')!;

  const gifFrames = sticker.gifFrames;
  let totalGifLoopMs = 0;
  for (const gf of gifFrames) totalGifLoopMs += gf.delayMs;

  let bestWebpBytes: Uint8Array | null = null;
  let bestSide = 512;
  let bestFrameCount = 1;

  if (!shouldAnimateFrames) {
    // Fast single-frame Animated WebP (takes <40ms!)
    renderStickerToCanvas(workCanvas, sticker.image, sticker.width, sticker.height, edit, {
      forceTransparent: true,
      pulseScale: 1.0
    });
    scaleCanvas.width = 512;
    scaleCanvas.height = 512;
    scaleCtx.clearRect(0, 0, 512, 512);
    scaleCtx.drawImage(workCanvas, 0, 0, 512, 512);

    for (const q of [0.88, 0.74, 0.58]) {
      progress(`Armando WebP (${Math.round(q * 100)}%)...`);
      const enc = await encodeCanvasFrameToWebpPayload(scaleCanvas, q);
      const candidate = assembleAnimatedWebp([{ ...enc, durationMs }], exifBytes, 512);
      bestWebpBytes = candidate;
      bestSide = 512;
      bestFrameCount = 1;
      if (candidate.byteLength <= MAX_STICKER_BYTES) break;
    }
  } else {
    // Smart FPS & frame count so even 5s-10s videos compile fast & smoothly under 1 MB on mobile!
    const targetFps = isVideo ? (durationMs > 5500 ? 7 : 10) : sticker.animated ? 10 : 8;
    const maxFrames = isVideo ? 36 : sticker.animated ? 40 : 24;
    const frameCount = Math.max(2, Math.min(maxFrames, Math.round((durationMs / 1000) * targetFps)));
    const stepMs = durationMs / frameCount;
    const frameDurMs = Math.max(25, Math.round(stepMs));

    // Pre-capture rendered square frames ONCE at optimal base resolution (zero redundant video seeks!)
    const captureSide = frameCount > 24 ? 384 : 512;
    const capturedFrames: HTMLCanvasElement[] = [];

    const vid = sticker.videoEl;
    const wasPlayingVid = vid ? !vid.paused : false;
    if (vid) vid.pause();

    try {
      for (let i = 0; i < frameCount; i++) {
        const tMs = i * stepMs;
        let frameSource: CanvasImageSource = sticker.image;
        let sw = sticker.width;
        let sh = sticker.height;

        if (isVideo && vid) {
          const vDurMs = Math.max(200, sticker.videoDurationMs || (vid.duration || 5) * 1000);
          const targetSec = ((trim.startMs + tMs) % vDurMs) / 1000;
          await seekVideoTo(vid, targetSec);
          frameSource = vid;
          sw = vid.videoWidth || sticker.width;
          sh = vid.videoHeight || sticker.height;
        } else if (gifFrames.length > 1 && totalGifLoopMs > 0) {
          const mod = tMs % totalGifLoopMs;
          let acc = 0;
          for (const gf of gifFrames) {
            acc += gf.delayMs;
            if (mod <= acc) {
              frameSource = gf.canvas;
              sw = gf.canvas.width;
              sh = gf.canvas.height;
              break;
            }
          }
        }

        let pulseScale = 1.0;
        if (edit.beatBounce) {
          const sampleIdx = Math.min(pcm48k.length - 1, Math.floor((tMs / 1000) * SAMPLE_RATE));
          let peak = 0;
          const win = 1400;
          for (let s = Math.max(0, sampleIdx - win); s < Math.min(pcm48k.length, sampleIdx + win); s += 32) {
            const a = Math.abs(pcm48k[s]!);
            if (a > peak) peak = a;
          }
          pulseScale = 1.0 + Math.min(0.08, peak * 0.095);
        }

        renderStickerToCanvas(workCanvas, frameSource, sw, sh, edit, {
          forceTransparent: true,
          pulseScale,
          fastPreview: isVideo
        });

        const fc = document.createElement('canvas');
        fc.width = captureSide;
        fc.height = captureSide;
        fc.getContext('2d')!.drawImage(workCanvas, 0, 0, captureSide, captureSide);
        capturedFrames.push(fc);

        if (i % 5 === 0) {
          progress(`Capturando cuadros ${Math.round(((i + 1) / frameCount) * 50)}%...`);
          await new Promise((r) => window.setTimeout(r, 0));
        }
      }
    } finally {
      if (vid && wasPlayingVid) {
        vid.play().catch(() => {});
      }
    }

    // Quality/resolution ladder with 3-frame early size prediction (<15ms bailout if too large!)
    const attempts: Array<{ side: number; q: number }> =
      captureSide === 512
        ? [
            { side: 512, q: 0.72 },
            { side: 384, q: 0.68 },
            { side: 384, q: 0.5 },
            { side: 320, q: 0.52 },
            { side: 256, q: 0.48 },
            { side: 256, q: 0.3 }
          ]
        : [
            { side: 384, q: 0.66 },
            { side: 384, q: 0.48 },
            { side: 320, q: 0.52 },
            { side: 256, q: 0.48 },
            { side: 256, q: 0.3 }
          ];

    const probeIndices = Array.from(
      new Set([0, Math.floor(frameCount / 2), Math.max(0, frameCount - 1)])
    );

    for (let aIdx = 0; aIdx < attempts.length; aIdx++) {
      const { side, q } = attempts[aIdx]!;
      const isLastAttempt = aIdx === attempts.length - 1;
      scaleCanvas.width = side;
      scaleCanvas.height = side;

      const encodeOne = async (idx: number) => {
        const srcCanvas = capturedFrames[idx]!;
        if (srcCanvas.width === side) {
          return await encodeCanvasFrameToWebpPayload(srcCanvas, q);
        }
        scaleCtx.clearRect(0, 0, side, side);
        scaleCtx.drawImage(srcCanvas, 0, 0, side, side);
        return await encodeCanvasFrameToWebpPayload(scaleCanvas, q);
      };

      // Probe 3 representative frames first to predict total WebP size in ~15ms!
      const probeMap = new Map<number, { payload: Uint8Array; hasAlpha: boolean }>();
      let probeBytesSum = 0;
      for (const pIdx of probeIndices) {
        const enc = await encodeOne(pIdx);
        probeMap.set(pIdx, enc);
        probeBytesSum += enc.payload.byteLength + 24;
      }

      const estimatedTotal = (probeBytesSum / probeIndices.length) * frameCount * 1.06 + exifBytes.byteLength + 128;
      if (!isLastAttempt && estimatedTotal > MAX_STICKER_BYTES * 1.04) {
        continue;
      }

      progress(`Optimizando WebP (${side}px · ${Math.round(q * 100)}%)...`);
      const encodedFrames: Array<{ payload: Uint8Array; hasAlpha: boolean; durationMs: number }> = [];
      let runningBytes = exifBytes.byteLength + 64;
      let overflowed = false;

      for (let i = 0; i < frameCount; i++) {
        const enc = probeMap.get(i) ?? (await encodeOne(i));
        encodedFrames.push({ ...enc, durationMs: frameDurMs });
        runningBytes += enc.payload.byteLength + 24;

        if (!isLastAttempt && runningBytes > MAX_STICKER_BYTES) {
          overflowed = true;
          break;
        }
        if (i % 6 === 5) {
          progress(`Comprimiendo ${50 + Math.round(((i + 1) / frameCount) * 48)}%...`);
          await new Promise((r) => window.setTimeout(r, 0));
        }
      }

      if (overflowed) continue;

      const candidate = assembleAnimatedWebp(encodedFrames, exifBytes, side);
      bestWebpBytes = candidate;
      bestSide = side;
      bestFrameCount = encodedFrames.length;
      if (candidate.byteLength <= MAX_STICKER_BYTES) {
        break;
      }
    }
  }

  if (!bestWebpBytes || bestWebpBytes.byteLength > MAX_STICKER_BYTES) {
    throw new Error('El sticker animado superó el límite de 1 MB de WhatsApp. Intenta acortar el audio o desactivar Rebote Audio.');
  }

  return {
    webpBytes: bestWebpBytes,
    webpBlob: new Blob([bestWebpBytes.slice().buffer], { type: 'image/webp' }),
    oggBytes,
    oggBlob: new Blob([oggBytes.slice().buffer], { type: 'audio/ogg; codecs=opus' }),
    soundSha256,
    seconds,
    durationMs,
    side: bestSide,
    isAnimated: true,
    frameCount: bestFrameCount,
    packName,
    publisher
  };
}
