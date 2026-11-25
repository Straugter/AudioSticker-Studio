export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'video';
export type AudioFormat = 'mp3' | 'wav' | 'ogg' | 'm4a' | 'aac' | 'webm';

export type ExportProfileId =
  | 'webp-audio-exif'
  | 'video-mp4'
  | 'video-webm-alpha'
  | 'sound-bundle'
  | 'standard-webp'
  | 'audio-mp3'
  | 'audio-wav';

export const LIMITS = {
  MAX_IMAGE_BYTES: 20 * 1024 * 1024,
  MAX_AUDIO_BYTES: 25 * 1024 * 1024,
  MAX_VIDEO_AUDIO_DECODE_BYTES: 45 * 1024 * 1024,
  MAX_AUDIO_DURATION_MS: 180_000,
  MIN_TRIM_DURATION_MS: 200,
  DEFAULT_VIDEO_MAX_AUDIO_MS: 5000, // 5.0s default for WhatsApp Video Sticker
  EXTENDED_MAX_AUDIO_MS: 10000,     // 10.0s extended audio mode
  STICKER_DIMENSION_PX: 512,
  MAX_STATIC_WEBP_BYTES: 102_400,   // 100 KB WhatsApp static WebP limit
  WAVEFORM_BUCKETS: 220,
  OPUS_SAMPLE_RATE: 48_000,
  DEFAULT_MATTE_COLOR: '#FFFFFF'
} as const;

export interface SquareCropRect {
  srcX: number;
  srcY: number;
  cropSide: number;
  outputSize: number;
}

export interface GifFrameData {
  canvas: HTMLCanvasElement;
  delayMs: number;
}

export interface StickerEditState {
  cropX: number; // 0..1 normalized hover/drag crop center
  cropY: number; // 0..1 normalized hover/drag crop center
  zoom: number;  // 0.5..2.5
  rotationDeg: number;
  fitMode: 'cover' | 'contain';
  transparentMode: boolean; // true -> WebM Alpha / WebP, false -> Solid Matte for MP4
  matteColor: string;       // '#FFFFFF' | '#000000' | custom hex
  removeBg: boolean;
  bgColor: { r: number; g: number; b: number };
  bgTolerance: number;
  floodFillEdgesOnly: boolean;
  whiteBorder: boolean;
  borderSize: number;
  beatBounce: boolean;      // Subtle pulse reactive to audio in video export
  captionText: string;
  captionPos: 'top' | 'bottom';
  captionColor: string;
}

export interface LoadedSticker {
  name: string;
  format: ImageFormat;
  bytes: Uint8Array;
  image: HTMLImageElement;
  width: number;
  height: number;
  hasAlpha: boolean;
  animated: boolean;
  gifFrames: GifFrameData[];
  videoEl?: HTMLVideoElement;
  videoUrl?: string;
  videoDurationMs?: number;
  videoFile?: File;
}

export interface LoadedAudio {
  name: string;
  format: AudioFormat;
  bytes: Uint8Array;
  buffer: AudioBuffer;
  durationMs: number;
  peaks: Float32Array;
  sourceType: 'local' | 'myinstants' | 'mic' | 'synth';
  sourceUrl?: string;
}

export interface AudioTrimState {
  startMs: number;
  endMs: number;
  maxWindowMs: 5000 | 10000;
  volume: number;
  fadeInOut: boolean;
}

export interface ExportArtifact {
  profile: ExportProfileId;
  bytes: Uint8Array;
  blob: Blob;
  url: string;
  fileName: string;
  mimeType: string;
  extension: string;
  durationMs?: number;
  hasAlpha?: boolean;
}

export interface StikSoundProjectManifest {
  schema_version: '1.0';
  project: {
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
  };
  sticker: {
    source_name: string;
    format: ImageFormat;
    width: number;
    height: number;
    edit: Partial<StickerEditState>;
  };
  audio: {
    source_name: string;
    duration_ms: number;
    start_ms: number;
    end_ms: number;
    volume: number;
  };
  bundle: {
    kind: 'sound-bundle';
    created_at: string;
    files: {
      sticker: 'sticker.webp';
      audio: 'sound.wav';
    };
    limits: {
      sticker_px: 512;
      max_static_bytes: 102400;
      max_audio_ms: number;
    };
    whatsapp_native: false;
  };
}
