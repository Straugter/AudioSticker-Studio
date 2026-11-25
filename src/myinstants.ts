import { LIMITS } from './types';

export interface ResolvedMyInstantsSound {
  title: string;
  mediaUrl: string;
  pageUrl: string | null;
  bytes: Uint8Array;
}

const PRIMARY_BUTTON_REGEX =
  /id=["']instant-page-button(?:-element)?["'][^>]*?(?:data-url|onclick)=["'][^"']*?(\/media\/sounds\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\.(?:mp3|wav|ogg|m4a))/i;
const DOWNLOAD_LINK_REGEX =
  /href=["'](\/media\/sounds\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\.(?:mp3|wav|ogg|m4a))["'][^>]*?download/i;
const MEDIA_PATH_REGEX =
  /(?:https:\/\/(?:www\.)?myinstants\.com)?(\/media\/sounds\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\.(?:mp3|wav|ogg|m4a))(?:\?[^"'\s<>)]*)?/i;

const OG_TITLE_REGEX = /<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i;
const TITLE_TAG_REGEX = /<title[^>]*>([^<]+)<\/title>/i;

function cleanTitle(raw: string | null): string {
  if (!raw) return 'MyInstants Sound';
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s*[-|]\s*(?:Myinstants|Bot[oó]n de sonido|Instant Sound Button|Sound Button).*$/i, '')
    .trim()
    .slice(0, 80) || 'MyInstants Sound';
}

export function isMyInstantsUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      (u.hostname === 'www.myinstants.com' || u.hostname === 'myinstants.com')
    );
  } catch {
    return false;
  }
}

export function extractMyInstantsFromHtml(html: string): { title: string; mediaUrl: string } {
  const match =
    html.match(PRIMARY_BUTTON_REGEX) ??
    html.match(DOWNLOAD_LINK_REGEX) ??
    html.match(MEDIA_PATH_REGEX);

  if (!match || !match[1]) {
    throw new Error('No se encontró el archivo MP3 dentro de la página de MyInstants.');
  }

  const mediaUrl = `https://www.myinstants.com${match[1]}`;
  const og = html.match(OG_TITLE_REGEX);
  const tt = html.match(TITLE_TAG_REGEX);
  const title = cleanTitle(og?.[1] ?? tt?.[1] ?? null);

  return { title, mediaUrl };
}

async function fetchWithCorsFallback(targetUrl: string): Promise<Uint8Array> {
  const candidates = [
    targetUrl,
    `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
  ];

  let lastErr: unknown = null;
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
      window.clearTimeout(timer);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 100 && buf.byteLength <= LIMITS.MAX_AUDIO_BYTES) {
        return new Uint8Array(buf);
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('No se pudo descargar desde MyInstants.');
}

export async function resolveMyInstantsUrl(rawUrl: string): Promise<ResolvedMyInstantsSound> {
  const trimmed = rawUrl.trim();
  const parsed = new URL(trimmed);

  // Direct /media/sounds/*.mp3 URL
  if (/^\/media\/sounds\/[^/]+\.(mp3|wav|ogg|m4a)$/i.test(parsed.pathname)) {
    const directUrl = `https://www.myinstants.com${parsed.pathname}`;
    const bytes = await fetchWithCorsFallback(directUrl);
    const filename = parsed.pathname.split('/').pop() ?? 'myinstants.mp3';
    return {
      title: filename.replace(/\.[^.]+$/, ''),
      mediaUrl: directUrl,
      pageUrl: null,
      bytes
    };
  }

  // Instant page URL (/instant/... or /es/instant/...)
  const canonicalUrl = `https://www.myinstants.com${parsed.pathname.endsWith('/') ? parsed.pathname : parsed.pathname + '/'}`;
  const htmlBytes = await fetchWithCorsFallback(canonicalUrl);
  const html = new TextDecoder('utf-8').decode(htmlBytes);
  const extracted = extractMyInstantsFromHtml(html);
  const audioBytes = await fetchWithCorsFallback(extracted.mediaUrl);

  return {
    title: extracted.title,
    mediaUrl: extracted.mediaUrl,
    pageUrl: canonicalUrl,
    bytes: audioBytes
  };
}
