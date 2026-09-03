// ffmpeg/ffprobe helpers: probing, thumbnails, audio extraction, timeline export.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import type { Clip, MediaAsset, Project, Track } from '../shared/types';
import { clipFilterById } from '../shared/types';

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
 * Video filter mapping a clip onto the W×H canvas, mirroring the preview:
 * source crop, then contain-fit base, then user scale (multiplier) and x/y
 * offset (fractions of canvas size, 0 = centered). Identity settings keep
 * the legacy filter.
 */
export function clipVideoFilter(
  media: MediaAsset | undefined,
  clip: Clip,
  W: number,
  H: number,
  FPS: number,
): string {
  const tail = `setsar=1,fps=${FPS},format=yuv420p`;
  const s = Number.isFinite(clip.scale) && clip.scale > 0 ? clip.scale : 1;
  const ox = Number.isFinite(clip.posX) ? clip.posX : 0;
  const oy = Number.isFinite(clip.posY) ? clip.posY : 0;
  const cl = Number.isFinite(clip.cropL) ? clip.cropL : 0;
  const ct = Number.isFinite(clip.cropT) ? clip.cropT : 0;
  const cr = Number.isFinite(clip.cropR) ? clip.cropR : 0;
  const cb = Number.isFinite(clip.cropB) ? clip.cropB : 0;
  let mw = media && media.width > 0 ? media.width : 0;
  let mh = media && media.height > 0 ? media.height : 0;
  const filt = clipFilterById(clip.filter).ff;
  const parts: string[] = [];
  if ((cl > 0 || ct > 0 || cr > 0 || cb > 0) && mw > 0 && mh > 0 && cl + cr < 1 && ct + cb < 1) {
    const cwS = evenDown(mw * (1 - cl - cr), mw);
    const chS = evenDown(mh * (1 - ct - cb), mh);
    const cxS = clampInt(mw * cl, 0, mw - cwS) & ~1;
    const cyS = clampInt(mh * ct, 0, mh - chS) & ~1;
    parts.push(`crop=${cwS}:${chS}:${cxS}:${cyS}`);
    mw = cwS;
    mh = chS;
  }
  if ((Math.abs(s - 1) < 1e-6 && ox === 0 && oy === 0) || mw === 0 || mh === 0) {
    if (parts.length === 0 && !filt) {
      return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,${tail}`;
    }
    parts.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`);
    if (filt) parts.push(filt);
    parts.push(tail);
    return parts.join(',');
  }
  const f = Math.min(W / mw, H / mh);
  const dw = evenUp(mw * f * s);
  const dh = evenUp(mh * f * s);
  parts.push(`scale=${dw}:${dh}`);
  let cw = dw;
  let ch = dh;
  if (dw > W || dh > H) {
    cw = evenDown(Math.min(dw, W), dw);
    ch = evenDown(Math.min(dh, H), dh);
    const cx = clampInt((dw - cw) / 2 - ox * W, 0, dw - cw) & ~1;
    const cy = clampInt((dh - ch) / 2 - oy * H, 0, dh - ch) & ~1;
    parts.push(`crop=${cw}:${ch}:${cx}:${cy}`);
  }
  if (cw < W || ch < H) {
    const px = clampInt((W - cw) / 2 + ox * W, 0, W - cw);
    const py = clampInt((H - ch) / 2 + oy * H, 0, H - ch);
    parts.push(`pad=${W}:${H}:${px}:${py}:black`);
  }
  if (filt) parts.push(filt);
  parts.push(tail);
  return parts.join(',');
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
  const unmutedVideoTracks = project.tracks.filter((t) => t.kind === 'video' && !t.muted);
  const videoTrack: Track | undefined = unmutedVideoTracks[0];
  const mainVideoClips = videoTrack ? [...videoTrack.clips].sort((a, b) => a.startSec - b.startSec) : [];
  const audioClips = project.tracks
    .filter((t) => t.kind === 'audio' && !t.muted)
    .flatMap((t) => t.clips)
    .sort((a, b) => a.startSec - b.startSec);
  // Text overlays from any unmuted video track (burned onto the picture).
  const textClips = project.tracks
    .filter((t) => t.kind === 'video' && !t.muted)
    .flatMap((t) => t.clips)
    .filter((c) => c.kind === 'text' && (c.text ?? '').trim().length > 0)
    .sort((a, b) => a.startSec - b.startSec);

  if (mainVideoClips.length === 0 && audioClips.length === 0 && textClips.length === 0)
    throw new Error('Timeline is empty — nothing to export');

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

    if (mainVideoClips.length === 0 && (audioClips.length > 0 || textClips.length > 0)) {
      // Audio-only (or text-only): generate black background matching content duration
      const totalDur = Math.max(
        0,
        ...audioClips.map((c) => c.startSec + c.durationSec),
        ...textClips.map((c) => c.startSec + c.durationSec),
      );
      await renderBlack(Math.max(1, totalDur));
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
        const audioFilter =
          `volume=${dbToGain(clip.volumeDb).toFixed(4)}` +
          (clip.fadeInSec > 0 ? `,afade=t=in:st=0:d=${clip.fadeInSec}` : '') +
          (clip.fadeOutSec > 0
            ? `,afade=t=out:st=${Math.max(0, dur - clip.fadeOutSec)}:d=${clip.fadeOutSec}`
            : '');
        const args = ['-y', '-hide_banner', '-loglevel', 'error'];
        if (media && clip.kind !== 'image' && media.kind !== 'image') {
          args.push('-ss', clip.inSec.toFixed(3), '-i', media.path, '-t', dur.toFixed(3));
        } else if (media) {
          // image clip: loop the still
          args.push('-loop', '1', '-t', dur.toFixed(3), '-i', media.path);
        } else {
          // plain color/text placeholder: black segment
          args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
        }
        const hasSrcAudio = media?.hasAudio && media.kind !== 'image';
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

      // Fill remaining gap if audio clips extend beyond last video clip
      const maxAudioEnd = audioClips.reduce((max, c) => Math.max(max, c.startSec + c.durationSec), 0);
      if (maxAudioEnd > cursorSec + 0.03) {
        await renderBlack(maxAudioEnd - cursorSec);
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

    // 3) mix standalone audio clips (from audio tracks) over the concat result
    if (audioClips.length > 0) {
      const inputs: string[] = ['-i', pictureSrc];
      const filters: string[] = [];
      const mixLabels: string[] = ['[0:a]'];
      audioClips.forEach((clip, i) => {
        const media = mediaById.get(clip.mediaId);
        if (!media || !media.hasAudio) return;
        const n = i + 1;
        inputs.push('-ss', clip.inSec.toFixed(3), '-t', clip.durationSec.toFixed(3), '-i', media.path);
        const delayMs = Math.round(clip.startSec * 1000);
        filters.push(
          `[${n}:a]volume=${dbToGain(clip.volumeDb).toFixed(4)},adelay=${delayMs}|${delayMs}[a${n}]`,
        );
        mixLabels.push(`[a${n}]`);
      });
      if (mixLabels.length > 1) {
        filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0[aout]`);
        await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
          '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', outPath]);
      } else {
        await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', pictureSrc, '-c', 'copy', outPath]);
      }
    } else if (pictureSrc !== outPath) {
      await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', pictureSrc, '-c', 'copy', outPath]);
    }
    // else: text was already burned straight to outPath — nothing left to do.

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
