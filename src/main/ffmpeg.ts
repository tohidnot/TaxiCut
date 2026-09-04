// ffmpeg/ffprobe helpers: probing, thumbnails, audio extraction, timeline export.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import type { Clip, MediaAsset, Project } from '../shared/types';
import { clipColorFf, clipFilterById } from '../shared/types';
import {
  allAudioTrackClips,
  allBaseVideoClips,
  allOverlayVideoClips,
  allTextClips,
} from '../shared/timeline';

const run = promisify(execFile);

const CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function findBin(name: string): string {
  for (const dir of CANDIDATES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return name; // hope it's on PATH
}

export const FFMPEG = process.env.TAXICUT_FFMPEG ?? findBin('ffmpeg');
export const FFPROBE = process.env.TAXICUT_FFPROBE ?? findBin('ffprobe');

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export async function probeMedia(path: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
  ]);
  const info = JSON.parse(stdout);
  const video = (info.streams ?? []).find((s: { codec_type: string }) => s.codec_type === 'video');
  const audio = (info.streams ?? []).find((s: { codec_type: string }) => s.codec_type === 'audio');
  const fpsRaw = video?.r_frame_rate ?? '0/1';
  const [num, den] = String(fpsRaw).split('/').map(Number);
  const fps = den ? num / den : 0;
  return {
    durationSec: parseFloat(info.format?.duration ?? '0') || 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: fps || 30,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg']);

export function mediaKind(path: string, probe: ProbeResult): MediaAsset['kind'] {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext) || (!probe.hasVideo && probe.hasAudio)) return 'audio';
  return 'video';
}

export async function makeThumbnail(mediaPath: string, cacheDir: string): Promise<string | null> {
  try {
    await mkdir(cacheDir, { recursive: true });
    const out = join(cacheDir, `${basename(mediaPath)}.thumb.jpg`);
    await run(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', '0.5', '-i', mediaPath,
      '-frames:v', '1', '-vf', 'scale=320:-2', out,
    ]);
    return existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

export interface ExportOptions {
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  onProgress?: (fraction: number) => void;
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Finite positive playback speed (legacy files may hold garbage). */
function validSpeed(s: unknown): number {
  return Number.isFinite(s) && (s as number) > 0 ? (s as number) : 1;
}

/**
 * atempo accepts 0.5..2.0 — chain factors for wider retimes (store clamps
 * speed to 0.1..10). Empty when neutral.
 */
function atempoChain(speed: number): string[] {
  if (!Number.isFinite(speed) || Math.abs(speed - 1) < 1e-6) return [];
  const parts: string[] = [];
  let s = speed;
  while (s > 2.0001) {
    parts.push('atempo=2.0000');
    s /= 2;
  }
  while (s < 0.4999) {
    parts.push('atempo=0.5000');
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts;
}

/** Timeline duration -> source seconds consumed (images stills ignore speed). */
export function clipSourceDur(clip: Clip): number {
  return clip.durationSec * validSpeed(clip.speed);
}

/** Volume + fades for a timeline clip (times are timeline-relative). */
function clipAudioFilter(clip: Clip): string {
  const parts = [
    ...atempoChain(validSpeed(clip.speed)),
    `volume=${dbToGain(clip.volumeDb).toFixed(4)}`,
  ];
  if (clip.fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${clip.fadeInSec}`);
  if (clip.fadeOutSec > 0) {
    parts.push(
      `afade=t=out:st=${Math.max(0, clip.durationSec - clip.fadeOutSec)}:d=${clip.fadeOutSec}`,
    );
  }
  return parts.join(',');
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(v)));
/** Round to a positive even int (yuv420p-safe dimension). */
const evenUp = (v: number): number => Math.max(2, Math.round(v / 2) * 2);
/** Round down to an even int within [2, limit] (crop-safe dimension). */
const evenDown = (v: number, limit: number): number => {
  const c = Math.max(2, Math.min(limit, Math.floor(v)));
  return Math.min(c - (c % 2), limit - (limit % 2));
};

/**
 * Shared canvas geometry for a clip on a W×H canvas, mirroring the preview:
 * source crop, then contain-fit base, then user scale (multiplier) and x/y
 * offset (fractions of canvas size, 0 = centered). The full-frame filter
 * (clipVideoFilter) and the layer overlay builder (clipOverlayGeom) both
 * derive from this so preview, export base, and export overlays agree.
 */
interface ClipGeom {
  /** Source-space crop filter (null when none). */
  srcCrop: string | null;
  /** Display size after contain-fit × user scale (before centering crop). */
  dw: number;
  dh: number;
  /** Size after the centering crop (what actually lands on the canvas). */
  cw: number;
  ch: number;
  cx: number;
  cy: number;
  /** Canvas position of the top-left corner (pad offsets). */
  px: number;
  py: number;
  centerCrop: boolean;
  pad: boolean;
  identity: boolean;
}

function clipGeom(
  media: MediaAsset | undefined,
  clip: Clip,
  W: number,
  H: number,
): ClipGeom {
  const s = Number.isFinite(clip.scale) && clip.scale > 0 ? clip.scale : 1;
  const ox = Number.isFinite(clip.posX) ? clip.posX : 0;
  const oy = Number.isFinite(clip.posY) ? clip.posY : 0;
  const cl = Number.isFinite(clip.cropL) ? clip.cropL : 0;
  const ct = Number.isFinite(clip.cropT) ? clip.cropT : 0;
  const cr = Number.isFinite(clip.cropR) ? clip.cropR : 0;
  const cb = Number.isFinite(clip.cropB) ? clip.cropB : 0;
  let mw = media && media.width > 0 ? media.width : 0;
  let mh = media && media.height > 0 ? media.height : 0;
  let srcCrop: string | null = null;
  if ((cl > 0 || ct > 0 || cr > 0 || cb > 0) && mw > 0 && mh > 0 && cl + cr < 1 && ct + cb < 1) {
    const cwS = evenDown(mw * (1 - cl - cr), mw);
    const chS = evenDown(mh * (1 - ct - cb), mh);
    const cxS = clampInt(mw * cl, 0, mw - cwS) & ~1;
    const cyS = clampInt(mh * ct, 0, mh - chS) & ~1;
    srcCrop = `crop=${cwS}:${chS}:${cxS}:${cyS}`;
    mw = cwS;
    mh = chS;
  }
  const identity = (Math.abs(s - 1) < 1e-6 && ox === 0 && oy === 0) || mw === 0 || mh === 0;
  if (identity) {
    return { srcCrop, dw: 0, dh: 0, cw: 0, ch: 0, cx: 0, cy: 0, px: 0, py: 0, centerCrop: false, pad: false, identity: true };
  }
  const f = Math.min(W / mw, H / mh);
  const dw = evenUp(mw * f * s);
  const dh = evenUp(mh * f * s);
  let cw = dw;
  let ch = dh;
  let cx = 0;
  let cy = 0;
  let centerCrop = false;
  if (dw > W || dh > H) {
    centerCrop = true;
    cw = evenDown(Math.min(dw, W), dw);
    ch = evenDown(Math.min(dh, H), dh);
    cx = clampInt((dw - cw) / 2 - ox * W, 0, dw - cw) & ~1;
    cy = clampInt((dh - ch) / 2 - oy * H, 0, dh - ch) & ~1;
  }
  const pad = cw < W || ch < H;
  const px = clampInt((W - cw) / 2 + ox * W, 0, W - cw);
  const py = clampInt((H - ch) / 2 + oy * H, 0, H - ch);
  return { srcCrop, dw, dh, cw, ch, cx, cy, px, py, centerCrop, pad, identity: false };
}
function clipOpacity(clip: Clip): number {
  const o = Number((clip as { opacity?: unknown }).opacity);
  if (!Number.isFinite(o)) return 1;
  return Math.max(0, Math.min(1, o));
}

/**
 * Video filter mapping a clip onto the W×H canvas. Identity settings keep
 * the legacy filter.
 */
export function clipVideoFilter(
  media: MediaAsset | undefined,
  clip: Clip,
  W: number,
  H: number,
  FPS: number,
): string {
  // Retime: the export reads duration×speed source seconds, then setpts
  // squeezes them back onto the timeline duration (stills ignore speed).
  const speed = media?.kind === 'image' ? 1 : validSpeed(clip.speed);
  const retime = Math.abs(speed - 1) > 1e-6 ? `setpts=${(1 / speed).toFixed(6)}*PTS,` : '';
  const tail = `setsar=1,${retime}fps=${FPS},format=yuv420p`;
  const filt = clipFilterById(clip.filter).ff;
  const colFf = clipColorFf(clip.color);
  const grade = [filt, colFf].filter(Boolean).join(',');
  const opacity = clipOpacity(clip);
  // Base picture blends over black: opacity premultiplies RGB toward black.
  const fade = opacity < 0.999
    ? `colorchannelmixer=rr=${opacity.toFixed(3)}:gg=${opacity.toFixed(3)}:bb=${opacity.toFixed(3)}`
    : '';
  const g = clipGeom(media, clip, W, H);
  const parts: string[] = [];
  if (g.srcCrop) parts.push(g.srcCrop);
  if (g.identity) {
    if (parts.length === 0 && !grade && !fade) {
      return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,${tail}`;
    }
    parts.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`);
  } else {
    parts.push(`scale=${g.dw}:${g.dh}`);
    if (g.centerCrop) parts.push(`crop=${g.cw}:${g.ch}:${g.cx}:${g.cy}`);
    if (g.pad) parts.push(`pad=${W}:${H}:${g.px}:${g.py}:black`);
  }
  if (grade) parts.push(grade);
  if (fade) parts.push(fade);
  parts.push(tail);
  return parts.join(',');
}

/**
 * Overlay geometry for upper-layer video/image clips (V2+): the same display
 * size/position as clipVideoFilter but without the canvas pad — the caller
 * positions it with the overlay filter at (x, y).
 */
export function clipOverlayGeom(
  media: MediaAsset | undefined,
  clip: Clip,
  W: number,
  H: number,
  FPS: number,
): { filter: string; x: string; y: string } {
  const speed = media?.kind === 'image' ? 1 : validSpeed(clip.speed);
  const retime = Math.abs(speed - 1) > 1e-6 ? `setpts=${(1 / speed).toFixed(6)}*PTS,` : '';
  const opacity = clipOpacity(clip);
  // Overlays keep alpha so the overlay filter blends over the base picture.
  const tail = opacity < 0.999
    ? `setsar=1,${retime}fps=${FPS},format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)},format=yuva420p`
    : `setsar=1,${retime}fps=${FPS},format=yuv420p`;
  const filt = clipFilterById(clip.filter).ff;
  const colFf = clipColorFf(clip.color);
  const grade = [filt, colFf].filter(Boolean).join(',');
  const g = clipGeom(media, clip, W, H);
  const parts: string[] = [];
  if (g.srcCrop) parts.push(g.srcCrop);
  if (g.identity) {
    parts.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
    if (grade) parts.push(grade);
    parts.push(tail);
    // Even-forced: yuv420p overlay positions must be multiples of 2.
    return { filter: parts.join(','), x: 'trunc((W-w)/4)*2', y: 'trunc((H-h)/4)*2' };
  }
  parts.push(`scale=${g.dw}:${g.dh}`);
  if (g.centerCrop) parts.push(`crop=${g.cw}:${g.ch}:${g.cx}:${g.cy}`);
  if (grade) parts.push(grade);
  parts.push(tail);
  return { filter: parts.join(','), x: String(g.px & ~1), y: String(g.py & ~1) };
}

/** #rrggbb/#rgb -> [r, g, b] for the PNG renderer (null when not hex). */
function hexRgb(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const FONT_DIRS: string[] =
  process.platform === 'darwin'
    ? ['/System/Library/Fonts/Supplemental', '/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library/Fonts')]
    : process.platform === 'win32'
      ? ['C:\\Windows\\Fonts']
      : ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/truetype/liberation', '/usr/share/fonts', '/usr/local/share/fonts'];

const FONT_TABLE: Record<string, { n: string[]; b: string[] }> = {
  arial: { n: ['Arial.ttf'], b: ['Arial Bold.ttf'] },
  helvetica: { n: ['Helvetica.ttc'], b: ['Helvetica.ttc'] },
  times: { n: ['Times New Roman.ttf'], b: ['Times New Roman Bold.ttf'] },
  'times new roman': { n: ['Times New Roman.ttf'], b: ['Times New Roman Bold.ttf'] },
  courier: { n: ['Courier New.ttf'], b: ['Courier New Bold.ttf'] },
  'courier new': { n: ['Courier New.ttf'], b: ['Courier New Bold.ttf'] },
  georgia: { n: ['Georgia.ttf'], b: ['Georgia Bold.ttf'] },
  verdana: { n: ['Verdana.ttf'], b: ['Verdana Bold.ttf'] },
  impact: { n: ['Impact.ttf'], b: ['Impact.ttf'] },
};

function fontCandidates(family: string, bold: boolean): string[] {
  const e = FONT_TABLE[(family || '').toLowerCase()] ?? FONT_TABLE['arial'];
  const base = [...(bold ? e.b : e.n), ...e.n];
  const lower = base.map((s) => s.toLowerCase());
  return [...new Set([...base, ...lower, 'DejaVuSans.ttf', 'Arial.ttf', 'arial.ttf', 'Helvetica.ttc'])];
}

/** System font file for drawtext, or null when nothing usable is found. */
export function resolveFontfile(family: string, bold: boolean): string | null {
  for (const dir of FONT_DIRS) {
    for (const f of fontCandidates(family, bold)) {
      const p = join(dir, f);
      try {
        if (existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

const PYTHON = process.env.TAXICUT_PYTHON ?? 'python3';

/**
 * Renders text with Pillow (transparent PNG). Args: fontfile fontsize color
 * bgcolor align pad outPng base64Text. Prints "W H" of the rendered image.
 */
const TEXT_PNG_SCRIPT = `
import sys, base64
from PIL import Image, ImageDraw, ImageFont
fontfile, fontsize, color, bgcolor, align, pad, out, b64 = sys.argv[1:9]
text = base64.b64decode(b64).decode('utf-8')
fontsize = int(fontsize); pad = int(pad)
def hexrgb(s):
    s = s.strip().lstrip('#')
    if len(s) == 3: s = ''.join(c * 2 for c in s)
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
try:
    font = ImageFont.truetype(fontfile, fontsize)
except Exception:
    font = ImageFont.load_default()
ascent, descent = font.getmetrics()
line_h = ascent + descent
spacing = int(fontsize * 0.2)
lines = text.split('\\n')
widths = []
for ln in lines:
    bb = font.getbbox(ln if ln else ' ')
    widths.append(max(0, bb[2] - bb[0]))
bw = max(widths) if widths else 1
bh = line_h * len(lines) + spacing * (len(lines) - 1)
W, H = max(1, bw + pad * 2), max(1, bh + pad * 2)
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
if bgcolor:
    d.rectangle([0, 0, W - 1, H - 1], fill=hexrgb(bgcolor) + (255,))
fg = hexrgb(color) + (255,)
y = pad
for ln in lines:
    if align == 'left':
        x, anc = pad, 'la'
    elif align == 'right':
        x, anc = W - pad, 'ra'
    else:
        x, anc = W // 2, 'ma'
    d.text((x, y), ln, font=font, fill=fg, anchor=anc)
    y += line_h + spacing
img.save(out)
print(f'{W} {H}')
`;

export interface TextOverlayJob {
  clip: Clip;
  png: string;
  x: number;
  y: number;
}

/** Render each text clip to a transparent PNG; returns overlay jobs (skips failures). */
export async function renderTextOverlays(
  clips: Clip[],
  W: number,
  H: number,
  dir: string,
): Promise<TextOverlayJob[]> {
  const jobs: TextOverlayJob[] = [];
  let warned = false;
  const warnOnce = (): void => {
    if (!warned) {
      warned = true;
      console.warn('text overlay rendering unavailable (need python3 + Pillow); skipping text');
    }
  };
  let i = 0;
  for (const clip of clips) {
    const raw = (clip.text ?? '').trim();
    if (!raw) continue;
    try {
      const fontfile = resolveFontfile(clip.fontFamily || 'Arial', !!clip.bold);
      if (!fontfile) continue;
      const s = Number.isFinite(clip.scale) && clip.scale > 0 ? clip.scale : 1;
      const fs = Math.max(8, Math.round((clip.fontSize || 72) * (H / 1080) * s));
      const color = hexRgb(clip.textColor || '#ffffff') ? (clip.textColor as string) : '#ffffff';
      const bg = hexRgb(clip.textBg || '') ? (clip.textBg as string) : '';
      const pad = bg ? Math.max(2, Math.round(fs / 5)) : 0;
      const out = join(dir, `text-${i++}.png`);
      const { stdout } = await run(PYTHON, [
        '-c', TEXT_PNG_SCRIPT,
        fontfile, String(fs), color, bg, clip.textAlign || 'center',
        String(pad), out, Buffer.from(raw, 'utf8').toString('base64'),
      ]);
      const m = /(\d+)\s+(\d+)/.exec(stdout);
      if (!m) continue;
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      if (!(w > 0 && h > 0)) continue;
      jobs.push({
        clip,
        png: out,
        x: Math.round(W / 2 + (clip.posX || 0) * W - w / 2),
        y: Math.round(H / 2 + (clip.posY || 0) * H - h / 2),
      });
    } catch {
      warnOnce();
    }
  }
  return jobs;
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/** Render the project to an mp4 via per-clip intermediates + concat, then mix extra audio tracks. */
export async function exportProject(
  project: Project,
  outPath: string,
  opts: ExportOptions = {},
): Promise<void> {
  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const FPS = opts.fps ?? 30;
  // Layering matches the live preview exactly (shared/timeline): the base
  // picture is the first unmuted video track holding clips, every other
  // unmuted video track composites over it, and all audio mixes together.
  const mainVideoClips = allBaseVideoClips(project);
  const overlayClips = allOverlayVideoClips(project);
  const audioClips = allAudioTrackClips(project);
  const textClips = allTextClips(project);

  if (mainVideoClips.length === 0 && overlayClips.length === 0 &&
    audioClips.length === 0 && textClips.length === 0)
    throw new Error('Timeline is empty — nothing to export');

  // Full composition length: the base picture is padded with black so that
  // overlays, audio, or text running past its end still render.
  const totalDur = Math.max(
    0.1,
    ...mainVideoClips.map((c) => c.startSec + c.durationSec),
    ...overlayClips.map((c) => c.startSec + c.durationSec),
    ...audioClips.map((c) => c.startSec + c.durationSec),
    ...textClips.map((c) => c.startSec + c.durationSec),
  );

  const dir = await mkdtemp(join(tmpdir(), 'taxicut-export-'));
  const mediaById = new Map(project.media.map((m) => [m.id, m]));
  try {
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p`;
    const segments: string[] = [];
    let segIndex = 0;
    let cursorSec = 0;

    const renderBlack = async (dur: number) => {
      const seg = join(dir, `black-${String(segIndex++).padStart(4, '0')}.mp4`);
      await run(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-t', dur.toFixed(3), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`,
        '-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(opts.crf ?? 18),
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', seg,
      ]);
      segments.push(seg);
    };

    if (mainVideoClips.length === 0) {
      // No base picture (overlay-only, audio-only, or text-only timeline):
      // generate a black background spanning the whole composition.
      await renderBlack(Math.max(1, totalDur));
      cursorSec = Math.max(1, totalDur);
    } else {
      // 1) render each video clip to a uniform intermediate, filling gaps with black
      for (const [i, clip] of mainVideoClips.entries()) {
        const gap = clip.startSec - cursorSec;
        if (gap > 0.03) {
          await renderBlack(gap);
          cursorSec += gap;
        }

        const media = mediaById.get(clip.mediaId);
        if (!media && clip.kind !== 'text') throw new Error(`Missing media for clip ${clip.name}`);
        const seg = join(dir, `seg-${String(segIndex++).padStart(4, '0')}.mp4`);
        const dur = clip.durationSec;
        const audioFilter = clipAudioFilter(clip);
        const args = ['-y', '-hide_banner', '-loglevel', 'error'];
        if (media && clip.kind !== 'image' && media.kind !== 'image') {
          // Retimed reads: consume duration×speed source seconds; the video
          // setpts + audio atempo squeeze them back onto the timeline.
          // Clamped so legacy over-long clips can't over-read past EOF.
          const srcAvail = media.durationSec > 0 ? Math.max(0.1, media.durationSec - clip.inSec) : dur;
          const srcDur = Math.max(0.1, Math.min(clipSourceDur(clip), srcAvail));
          args.push('-ss', clip.inSec.toFixed(3), '-i', media.path, '-t', srcDur.toFixed(3));
        } else if (media) {
          // image clip: loop the still
          args.push('-loop', '1', '-t', dur.toFixed(3), '-i', media.path);
        } else {
          // plain color/text placeholder: black segment
          args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
        }
        const hasSrcAudio = media?.hasAudio && media.kind !== 'image' && !clip.audioMuted;
        const clipVf = clipVideoFilter(media, clip, W, H, FPS);
        if (hasSrcAudio) {
          args.push('-vf', clipVf, '-af', audioFilter, '-c:v', 'libx264', '-preset', 'veryfast',
            '-crf', String(opts.crf ?? 18), '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', seg);
        } else {
          args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-vf', clipVf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(opts.crf ?? 18),
            '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', seg);
        }
        await run(FFMPEG, args, { maxBuffer: 4 * 1024 * 1024 });
        segments.push(seg);
        cursorSec = clip.startSec + clip.durationSec;
        opts.onProgress?.((i + 1) / (mainVideoClips.length + 1));
      }

      // Pad the base picture with black up to the full composition length so
      // overlays, audio, or text running past its end still render.
      if (totalDur > cursorSec + 0.03) {
        await renderBlack(totalDur - cursorSec);
        cursorSec = totalDur;
      }
    }

    // 2) concat video segments
    const listFile = join(dir, 'concat.txt');
    await writeFile(listFile, segments.map((s) => `file '${s}'`).join('\n'));
    const concatOut = join(dir, 'video.mp4');
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatOut]);

    // 2b) burn text overlays onto the picture (before the audio mix)
    let pictureSrc = concatOut;
    const textJobs = await renderTextOverlays(textClips, W, H, dir);
    if (textJobs.length > 0) {
      const textOut = audioClips.length > 0 ? join(dir, 'text.mp4') : outPath;
      const inputs: string[] = ['-i', concatOut];
      const parts: string[] = [];
      let label = '0:v';
      textJobs.forEach((j, i) => {
        const end = j.clip.startSec + j.clip.durationSec;
        inputs.push('-framerate', String(FPS), '-loop', '1', '-t', end.toFixed(3), '-i', j.png);
        const out = i === textJobs.length - 1 ? 'vout' : `v${i + 1}`;
        parts.push(
          `[${label}][${i + 1}:v]overlay=${j.x}:${j.y}` +
          `:enable='between(t,${j.clip.startSec.toFixed(3)},${end.toFixed(3)})'[${out}]`,
        );
        label = out;
      });
      await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
        '-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '0:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(opts.crf ?? 18),
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', textOut]);
      pictureSrc = textOut;
    }

    // 2c) composite upper-layer video/image clips over the picture.
    // Each overlay keeps its canvas transform (scale/pos/crop/filter/grade).
    // allOverlayVideoClips guarantees media; the defensive filter preserves
    // input numbering so [n:v] labels always match the -i order.
    const overs = overlayClips.filter((c) => mediaById.get(c.mediaId));
    if (overs.length > 0) {
      const overOut = join(dir, 'overlay.mp4');
      const inputs: string[] = ['-i', pictureSrc];
      const parts: string[] = [];
      let label = '0:v';
      overs.forEach((clip, i) => {
        const media = mediaById.get(clip.mediaId)!;
        const end = clip.startSec + clip.durationSec;
        const n = i + 1;
        if (media.kind === 'image') {
          inputs.push('-loop', '1', '-t', clip.durationSec.toFixed(3), '-i', media.path);
        } else {
          const srcAvail = media.durationSec > 0 ? Math.max(0.1, media.durationSec - clip.inSec) : clip.durationSec;
          const srcDur = Math.max(0.1, Math.min(clipSourceDur(clip), srcAvail));
          inputs.push('-ss', clip.inSec.toFixed(3), '-t', srcDur.toFixed(3), '-i', media.path);
        }
        const g = clipOverlayGeom(media, clip, W, H, FPS);
        const ov = `ov${n}`;
        parts.push(`[${n}:v]${g.filter}[${ov}]`);
        const out = i === overs.length - 1 ? 'vout' : `v${n}`;
        parts.push(
          `[${label}][${ov}]overlay=${g.x}:${g.y}` +
          `:enable='between(t,${clip.startSec.toFixed(3)},${end.toFixed(3)})'[${out}]`,
        );
        label = out;
        // Overlay clips with sound join the audio mix below (muted ones stay silent).
        if (media.hasAudio && media.kind !== 'image' && !clip.audioMuted) audioClips.push(clip);
      });
      await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
        '-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '0:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(opts.crf ?? 18),
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', overOut]);
      pictureSrc = overOut;
    }

    // 3) mix audio-track clips + sounding overlay clips over the picture.
    // Inputs and [n:a] labels are built in lockstep (skipped clips consume no
    // input), with per-clip retime (atempo), volume, fades, and start delay.
    {
      const inputs: string[] = ['-i', pictureSrc];
      const filters: string[] = [];
      const mixLabels: string[] = ['[0:a]'];
      let n = 0;
      for (const clip of audioClips) {
        const media = mediaById.get(clip.mediaId);
        if (!media || !media.hasAudio || media.kind === 'image' || clip.audioMuted) continue;
        n++;
        const srcAvail = media.durationSec > 0 ? Math.max(0.1, media.durationSec - clip.inSec) : clip.durationSec;
        const srcDur = Math.max(0.1, Math.min(clipSourceDur(clip), srcAvail));
        inputs.push('-ss', clip.inSec.toFixed(3), '-t', srcDur.toFixed(3), '-i', media.path);
        const delayMs = Math.round(clip.startSec * 1000);
        const chain = [...atempoChain(validSpeed(clip.speed)), `volume=${dbToGain(clip.volumeDb).toFixed(4)}`];
        if (clip.fadeInSec > 0) chain.push(`afade=t=in:st=0:d=${clip.fadeInSec}`);
        if (clip.fadeOutSec > 0) {
          chain.push(`afade=t=out:st=${Math.max(0, clip.durationSec - clip.fadeOutSec)}:d=${clip.fadeOutSec}`);
        }
        chain.push(`adelay=${delayMs}|${delayMs}`);
        filters.push(`[${n}:a]${chain.join(',')}[a${n}]`);
        mixLabels.push(`[a${n}]`);
      }
      if (mixLabels.length > 1) {
        filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0[aout]`);
        await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
          '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', outPath]);
      } else if (pictureSrc !== outPath) {
        await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', pictureSrc, '-c', 'copy', outPath]);
      }
      // else: text was already burned straight to outPath — nothing left to do.
    }

    // 4) Write sidecar SRT for transcription subtitle clips (titles excluded)
    const subtitleClips = project.tracks
      .filter((t) => !t.muted)
      .flatMap((t) => t.clips)
      .filter((c) => c.kind !== 'text' && Boolean(c.text))
      .sort((a, b) => a.startSec - b.startSec);
    if (subtitleClips.length > 0) {
      const srtPath = outPath.replace(/\.[^.]+$/, '') + '.srt';
      const srtLines = subtitleClips
        .map((c, i) => `${i + 1}\n${srtTime(c.startSec)} --> ${srtTime(c.startSec + c.durationSec)}\n${c.text}\n`)
        .join('\n');
      await writeFile(srtPath, srtLines, 'utf8').catch(() => {});
    }

    opts.onProgress?.(1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Extract mono 16 kHz WAV for speech recognition. */
export async function extractAudio16k(input: string, workDir?: string): Promise<string> {
  const dir = workDir ?? (await mkdtemp(join(tmpdir(), 'taxicut-asr-')));
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${basename(input)}.16k.wav`);
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', out]);
  return out;
}
