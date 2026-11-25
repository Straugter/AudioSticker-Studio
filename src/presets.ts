import { encodeWavBytesFromMono48k } from './media-engine';

export type PresetSoundId = 'vine-boom' | 'bruh-bass' | 'anime-sparkle' | 'arcade-win' | 'airhorn';

/**
 * Generates built-in 100% offline viral sound effects as 48kHz AudioBuffers + WAV bytes.
 */
export function synthesizePresetSound(
  actx: AudioContext,
  presetId: PresetSoundId
): { buffer: AudioBuffer; bytes: Uint8Array; name: string } {
  const sr = 48000;
  let duration = 2.4;
  let name = 'Efecto Sonoro';

  if (presetId === 'vine-boom') {
    duration = 2.2;
    name = 'Vine Boom (Sub Bass Drop)';
  } else if (presetId === 'bruh-bass') {
    duration = 2.0;
    name = 'Bass Punch & Wobble';
  } else if (presetId === 'anime-sparkle') {
    duration = 2.6;
    name = 'Anime Sparkle Chime';
  } else if (presetId === 'arcade-win') {
    duration = 3.2;
    name = 'Arcade Level Up Jingle';
  } else if (presetId === 'airhorn') {
    duration = 2.3;
    name = 'MLG Triple Airhorn';
  }

  const len = Math.floor(sr * duration);
  const buffer = actx.createBuffer(1, len, sr);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let s = 0;

    if (presetId === 'vine-boom') {
      // Deep 808 pitch-drop impact + sub rumble
      const freq = 42 + 135 * Math.exp(-t * 14);
      const env = Math.exp(-t * 1.95);
      const click = t < 0.025 ? Math.sin(2 * Math.PI * 320 * t) * (1 - t / 0.025) * 0.6 : 0;
      const raw = Math.sin(2 * Math.PI * freq * t) * 1.45 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.35 + click;
      s = Math.tanh(raw * 1.6) * env;
    } else if (presetId === 'bruh-bass') {
      // Punchy distorted bass wobble hit
      const env = Math.exp(-t * 2.2);
      const wobble = 55 + Math.sin(2 * Math.PI * 8 * t) * 12;
      const raw = Math.sin(2 * Math.PI * wobble * t) * 1.3 + Math.sin(2 * Math.PI * (wobble * 1.5) * t) * 0.5;
      s = Math.tanh(raw * 1.8) * env;
    } else if (presetId === 'anime-sparkle') {
      // Magical arpeggio chime
      const notes = [587.33, 739.99, 880, 1174.66, 1479.98, 1760, 2349.32];
      for (let n = 0; n < notes.length; n++) {
        const start = n * 0.11;
        if (t >= start) {
          const lt = t - start;
          const env = Math.exp(-lt * 3.2);
          s += Math.sin(2 * Math.PI * notes[n]! * lt) * 0.25 * env;
          s += Math.sin(2 * Math.PI * (notes[n]! * 2) * lt) * 0.08 * env;
        }
      }
    } else if (presetId === 'arcade-win') {
      const notes = [
        { s: 0.05, d: 0.18, f: 523.25 },
        { s: 0.24, d: 0.18, f: 659.25 },
        { s: 0.43, d: 0.18, f: 783.99 },
        { s: 0.62, d: 0.4, f: 1046.5 },
        { s: 1.08, d: 0.2, f: 783.99 },
        { s: 1.32, d: 0.65, f: 1046.5 },
        { s: 2.05, d: 0.25, f: 880.0 },
        { s: 2.35, d: 0.7, f: 1174.66 }
      ];
      for (const nt of notes) {
        if (t >= nt.s && t <= nt.s + nt.d) {
          const lt = t - nt.s;
          const env = Math.sin((lt / nt.d) * Math.PI);
          s += (Math.sin(2 * Math.PI * nt.f * lt) * 0.55 + Math.sin(2 * Math.PI * nt.f * 2 * lt) * 0.18) * env;
        }
      }
    } else if (presetId === 'airhorn') {
      // Triple DJ Airhorn blasts
      const blasts = [
        [0.05, 0.28],
        [0.38, 0.62],
        [0.72, 1.85]
      ];
      for (const [bStart, bEnd] of blasts) {
        if (t >= bStart! && t <= bEnd!) {
          const lt = t - bStart!;
          const dur = bEnd! - bStart!;
          const env = lt < 0.02 ? lt / 0.02 : lt > dur - 0.08 ? (dur - lt) / 0.08 : 1.0;
          const freqs = [480, 610, 745, 960];
          let horn = 0;
          for (const f of freqs) {
            horn += Math.sin(2 * Math.PI * f * t + Math.sin(2 * Math.PI * 18 * t) * 0.25) * 0.32;
          }
          s = Math.tanh(horn * 2.2) * env;
        }
      }
    }

    data[i] = Math.max(-0.96, Math.min(0.96, s));
  }

  const bytes = encodeWavBytesFromMono48k(data, sr);
  return { buffer, bytes, name };
}

/**
 * Generates a built-in mascot image as PNG bytes so the user can test immediately or cycle examples.
 */
export async function generateMascotPngBytes(variant: number): Promise<{ bytes: Uint8Array; name: string }> {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 640;
  const g = c.getContext('2d')!;

  const bgs = ['#F4F6F9', '#E0F2FE', '#FEF3C7'];
  g.fillStyle = bgs[variant % bgs.length]!;
  g.fillRect(0, 0, 640, 640);

  g.save();
  g.translate(320, 330);

  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    const rad = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rad, y);
    g.arcTo(x + w, y, x + w, y + h, rad);
    g.arcTo(x + w, y + h, x, y + h, rad);
    g.arcTo(x, y + h, x, y, rad);
    g.arcTo(x, y, x + w, y, rad);
    g.closePath();
  };

  if (variant % 3 === 0) {
    // Emerald DJ Cat
    g.fillStyle = '#10B981';
    g.beginPath();
    g.moveTo(-145, -70);
    g.lineTo(-175, -210);
    g.lineTo(-55, -155);
    g.closePath();
    g.fill();

    g.beginPath();
    g.moveTo(145, -70);
    g.lineTo(175, -210);
    g.lineTo(55, -155);
    g.closePath();
    g.fill();

    g.fillStyle = '#A7F3D0';
    g.beginPath();
    g.moveTo(-132, -92);
    g.lineTo(-154, -182);
    g.lineTo(-76, -144);
    g.closePath();
    g.fill();

    g.beginPath();
    g.moveTo(132, -92);
    g.lineTo(154, -182);
    g.lineTo(76, -144);
    g.closePath();
    g.fill();

    g.fillStyle = '#10B981';
    g.beginPath();
    g.arc(0, -10, 165, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = '#1E293B';
    g.lineWidth = 24;
    g.beginPath();
    g.arc(0, -15, 185, Math.PI * 1.08, Math.PI * 1.92);
    g.stroke();

    g.fillStyle = '#06B6D4';
    roundRect(-210, -70, 46, 115, 20);
    g.fill();
    roundRect(164, -70, 46, 115, 20);
    g.fill();

    g.fillStyle = '#0F172A';
    roundRect(-125, -55, 110, 68, 16);
    g.fill();
    roundRect(15, -55, 110, 68, 16);
    g.fill();
    g.fillRect(-20, -35, 40, 14);

    g.fillStyle = '#064E3B';
    g.beginPath();
    g.arc(0, 42, 48, 0, Math.PI);
    g.fill();

    g.fillStyle = '#FB7185';
    g.beginPath();
    g.arc(0, 62, 26, 0, Math.PI);
    g.fill();
  } else if (variant % 3 === 1) {
    // Boombox Synth Bot
    g.fillStyle = '#6366F1';
    roundRect(-170, -140, 340, 260, 44);
    g.fill();

    g.strokeStyle = '#F59E0B';
    g.lineWidth = 14;
    g.beginPath();
    g.moveTo(0, -140);
    g.lineTo(0, -210);
    g.stroke();
    g.fillStyle = '#EF4444';
    g.beginPath();
    g.arc(0, -215, 22, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#0F172A';
    g.beginPath();
    g.arc(-78, -25, 58, 0, Math.PI * 2);
    g.arc(78, -25, 58, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#22D3EE';
    g.beginPath();
    g.arc(-78, -25, 32, 0, Math.PI * 2);
    g.arc(78, -25, 32, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#FBBF24';
    roundRect(-95, 55, 190, 36, 12);
    g.fill();
  } else {
    // Fire Meme Emoji Mascot
    g.fillStyle = '#F97316';
    g.beginPath();
    g.arc(0, 0, 175, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#FEF08A';
    g.beginPath();
    g.arc(-60, -35, 34, 0, Math.PI * 2);
    g.arc(60, -35, 34, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#0F172A';
    g.beginPath();
    g.arc(-55, -35, 16, 0, Math.PI * 2);
    g.arc(55, -35, 16, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = '#0F172A';
    g.lineWidth = 14;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(0, 20, 75, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
  }

  g.restore();

  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  const bytes = new Uint8Array(await blob!.arrayBuffer());
  const names = ['Mascota-DJ-Cat.png', 'Mascota-Boombox-Bot.png', 'Mascota-Fire-Meme.png'];
  return { bytes, name: names[variant % names.length]! };
}
