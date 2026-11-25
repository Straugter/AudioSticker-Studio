/**
 * Binary RIFF WebP Injector & Extractor for WhatsApp Stickers:
 * 1) Upgrades simple VP8/VP8L WebP files to Extended WebP (VP8X) with Alpha + EXIF flags.
 * 2) Injects the official WhatsApp Sticker EXIF chunk with TIFF tag 0x5741 ("WA") JSON metadata.
 * 3) Embeds the compressed audio track (32-64kbps MP3) directly inside the WebP RIFF container
 *    (in a custom 'SAUD' RIFF chunk and base64 EXIF metadata) while keeping the file a 100% valid
 *    512x512 image/webp sticker recognized by WhatsApp.
 * 4) Extracts embedded audio back from any AudioSticker .webp file!
 */

export interface WhatsAppStickerExifJson {
  'sticker-pack-id': string;
  'sticker-pack-name': string;
  'sticker-pack-publisher': string;
  'android-app-store-link'?: string;
  'ios-app-store-link'?: string;
  emojis?: string[];
  'is-avatar-sticker'?: number;
  'has-embedded-audio'?: boolean;
  'audio-mime'?: string;
  'audio-duration-ms'?: number;
  'audio-b64'?: string;
}

export interface EmbeddedWebpAudioResult {
  webpBytes: Uint8Array;
  blob: Blob;
  totalBytes: number;
  audioBytesLength: number;
  hasExif0x5741: boolean;
}

function writeFourCC(target: Uint8Array, offset: number, fourCC: string): void {
  for (let i = 0; i < 4; i++) {
    target[offset + i] = fourCC.charCodeAt(i) & 0xff;
  }
}

function readFourCC(source: Uint8Array, offset: number): string {
  return String.fromCharCode(
    source[offset] ?? 0,
    source[offset + 1] ?? 0,
    source[offset + 2] ?? 0,
    source[offset + 3] ?? 0
  );
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Builds the exact binary WhatsApp EXIF payload with little-endian TIFF header
 * and tag 0x5741 ("WA" in ASCII = 0x41, 0x57 in little-endian).
 */
export function buildWhatsAppExifPayload(meta: WhatsAppStickerExifJson): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(meta));
  // TIFF header (8 bytes) + 1 IFD entry count (2 bytes) + 12-byte IFD record + 4-byte next IFD (0) = 26 bytes
  // Note: some WhatsApp parsers expect the 6-byte "Exif\0\0" prefix before the TIFF header, while
  // standard libwebp / Android WhatsApp sticker parser accepts TIFF header starting at offset 0 of EXIF chunk:
  // [0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, ...len, 0x16, 0x00, 0x00, 0x00]
  const tiffHeader = new Uint8Array(22);
  const view = new DataView(tiffHeader.buffer);

  // Little-endian TIFF magic: "II" (0x49 0x49), 42 (0x002A), offset to first IFD = 8
  tiffHeader[0] = 0x49;
  tiffHeader[1] = 0x49;
  view.setUint16(2, 0x002a, true);
  view.setUint32(4, 0x00000008, true);

  // Number of directory entries = 1
  view.setUint16(8, 1, true);

  // Tag ID = 0x5741 ("WA" -> 0x41, 0x57 in LE)
  view.setUint16(10, 0x5741, true);
  // Field Type = 7 (UNDEFINED / raw bytes)
  view.setUint16(12, 7, true);
  // Byte count = jsonBytes.length
  view.setUint32(14, jsonBytes.byteLength, true);
  // Value offset = 22 (0x16)
  view.setUint32(18, 22, true);

  const payload = new Uint8Array(22 + jsonBytes.byteLength);
  payload.set(tiffHeader, 0);
  payload.set(jsonBytes, 22);
  return payload;
}

/**
 * Parses an existing WebP file into its RIFF chunks and injects:
 *   1) VP8X extended header (with EXIF bit 0x08 and Alpha bit 0x10 set, 512x512 canvas size)
 *   2) EXIF chunk with WhatsApp 0x5741 metadata (including compact base64 audio when it fits)
 *   3) SAUD chunk with raw compressed audio bytes (MP3/Opus) inside the RIFF container
 */
export function injectWhatsAppExifAndAudioIntoWebp(
  rawWebp: Uint8Array,
  audioBytes: Uint8Array | null,
  options: {
    packId?: string;
    packName?: string;
    publisher?: string;
    audioMime?: string;
    audioDurationMs?: number;
    embedBase64InExif?: boolean;
  } = {}
): EmbeddedWebpAudioResult {
  if (
    rawWebp.byteLength < 16 ||
    readFourCC(rawWebp, 0) !== 'RIFF' ||
    readFourCC(rawWebp, 8) !== 'WEBP'
  ) {
    throw new Error('El archivo de entrada no es un contenedor RIFF WEBP válido.');
  }

  // Parse existing RIFF chunks
  const chunks: Array<{ fourCC: string; data: Uint8Array }> = [];
  let offset = 12;
  const view = new DataView(rawWebp.buffer, rawWebp.byteOffset, rawWebp.byteLength);

  while (offset + 8 <= rawWebp.byteLength) {
    const fourCC = readFourCC(rawWebp, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = Math.min(rawWebp.byteLength, dataStart + chunkSize);
    if (fourCC !== 'EXIF' && fourCC !== 'SAUD') {
      chunks.push({
        fourCC,
        data: rawWebp.slice(dataStart, dataEnd)
      });
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  // Ensure VP8X chunk exists at index 0 with EXIF (0x08) and Alpha (0x10) flags
  let vp8x = chunks.find((c) => c.fourCC === 'VP8X');
  if (!vp8x) {
    const vp8xData = new Uint8Array(10);
    // Flags byte 0: bit 4 (0x10 = Alpha) | bit 3 (0x08 = EXIF) = 0x18
    vp8xData[0] = 0x18;
    // Canvas Width - 1 (511 = 0x0001FF in 24-bit LE at bytes 4..6)
    vp8xData[4] = 0xff;
    vp8xData[5] = 0x01;
    vp8xData[6] = 0x00;
    // Canvas Height - 1 (511 = 0x0001FF in 24-bit LE at bytes 7..9)
    vp8xData[7] = 0xff;
    vp8xData[8] = 0x01;
    vp8xData[9] = 0x00;
    vp8x = { fourCC: 'VP8X', data: vp8xData };
    chunks.unshift(vp8x);
  } else if (vp8x.data.byteLength >= 10) {
    // Enable EXIF bit (0x08) and Alpha bit (0x10)
    vp8x.data[0] = (vp8x.data[0] ?? 0) | 0x08 | 0x10;
  }

  // Build WhatsApp 0x5741 EXIF JSON
  const hasAudio = Boolean(audioBytes && audioBytes.byteLength > 0);
  const exifMeta: WhatsAppStickerExifJson = {
    'sticker-pack-id': options.packId ?? 'com.audiosticker.stiksound',
    'sticker-pack-name': options.packName ?? 'AudioSticker Studio',
    'sticker-pack-publisher': options.publisher ?? 'AudioSticker',
    'android-app-store-link': '',
    'ios-app-store-link': '',
    emojis: ['🔊', '🔥'],
    'has-embedded-audio': hasAudio,
    'audio-mime': options.audioMime ?? 'audio/mpeg',
    'audio-duration-ms': options.audioDurationMs ?? 0
  };

  if (hasAudio && audioBytes && (options.embedBase64InExif ?? true)) {
    exifMeta['audio-b64'] = uint8ToBase64(audioBytes);
  }

  const exifPayload = buildWhatsAppExifPayload(exifMeta);
  chunks.push({ fourCC: 'EXIF', data: exifPayload });

  // Also append raw SAUD RIFF chunk so binary parsers can read the raw audio directly without base64 decoding
  if (hasAudio && audioBytes) {
    chunks.push({ fourCC: 'SAUD', data: audioBytes });
  }

  // Calculate total RIFF payload size
  let riffPayloadSize = 4; // "WEBP"
  for (const ch of chunks) {
    riffPayloadSize += 8 + ch.data.byteLength + (ch.data.byteLength % 2);
  }

  const out = new Uint8Array(8 + riffPayloadSize);
  const outView = new DataView(out.buffer);
  writeFourCC(out, 0, 'RIFF');
  outView.setUint32(4, riffPayloadSize, true);
  writeFourCC(out, 8, 'WEBP');

  let writePos = 12;
  for (const ch of chunks) {
    writeFourCC(out, writePos, ch.fourCC);
    outView.setUint32(writePos + 4, ch.data.byteLength, true);
    out.set(ch.data, writePos + 8);
    writePos += 8 + ch.data.byteLength;
    if (ch.data.byteLength % 2 === 1) {
      out[writePos] = 0;
      writePos += 1;
    }
  }

  const blob = new Blob([out.slice().buffer], { type: 'image/webp' });
  return {
    webpBytes: out,
    blob,
    totalBytes: out.byteLength,
    audioBytesLength: audioBytes?.byteLength ?? 0,
    hasExif0x5741: true
  };
}

/**
 * Extracts the embedded audio track & WhatsApp EXIF 0x5741 metadata from an AudioSticker .webp file!
 */
export function extractAudioFromWebpBytes(webpBytes: Uint8Array): {
  exifMeta: WhatsAppStickerExifJson | null;
  audioBytes: Uint8Array | null;
  audioMime: string;
} {
  if (
    webpBytes.byteLength < 16 ||
    readFourCC(webpBytes, 0) !== 'RIFF' ||
    readFourCC(webpBytes, 8) !== 'WEBP'
  ) {
    return { exifMeta: null, audioBytes: null, audioMime: 'audio/mpeg' };
  }

  let offset = 12;
  const view = new DataView(webpBytes.buffer, webpBytes.byteOffset, webpBytes.byteLength);
  let exifMeta: WhatsAppStickerExifJson | null = null;
  let saudBytes: Uint8Array | null = null;

  while (offset + 8 <= webpBytes.byteLength) {
    const fourCC = readFourCC(webpBytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = Math.min(webpBytes.byteLength, dataStart + chunkSize);

    if (fourCC === 'SAUD' && dataEnd > dataStart) {
      saudBytes = webpBytes.slice(dataStart, dataEnd);
    } else if (fourCC === 'EXIF' && dataEnd > dataStart + 22) {
      const exifSlice = webpBytes.slice(dataStart, dataEnd);
      // Locate JSON start '{' inside EXIF chunk
      const braceIdx = exifSlice.indexOf(0x7b); // '{'
      if (braceIdx >= 0) {
        try {
          const jsonText = new TextDecoder('utf-8').decode(exifSlice.subarray(braceIdx));
          exifMeta = JSON.parse(jsonText) as WhatsAppStickerExifJson;
        } catch {}
      }
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  let audioBytes = saudBytes;
  if (!audioBytes && exifMeta?.['audio-b64']) {
    try {
      audioBytes = base64ToUint8(exifMeta['audio-b64']);
    } catch {}
  }

  return {
    exifMeta,
    audioBytes,
    audioMime: exifMeta?.['audio-mime'] ?? 'audio/mpeg'
  };
}
