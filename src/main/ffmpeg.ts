// ffmpeg/ffprobe helpers: probing, thumbnails, audio extraction, timeline export.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import type { Clip, MediaAsset, Project, Track } from '../shared/types';

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

/** Render the project to an mp4 via per-clip intermediates + concat, then mix extra audio tracks. */
export async function exportProject(
  project: Project,
  outPath: string,
  opts: ExportOptions = {},
): Promise<void> {
  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const FPS = opts.fps ?? 30;
  const videoTrack: Track | undefined = project.tracks.find((t) => t.kind === 'video');
  const mainVideoClips = videoTrack ? [...videoTrack.clips].sort((a, b) => a.startSec - b.startSec) : [];
  const audioClips = project.tracks
    .filter((t) => t.kind === 'audio' && !t.muted)
    .flatMap((t) => t.clips)
    .sort((a, b) => a.startSec - b.startSec);

  if (mainVideoClips.length === 0 && audioClips.length === 0)
    throw new Error('Timeline is empty — nothing to export');

  const dir = await mkdtemp(join(tmpdir(), 'taxicut-export-'));
  const mediaById = new Map(project.media.map((m) => [m.id, m]));
  try {
    // 1) render each video clip to a uniform intermediate
    const segments: string[] = [];
    for (const [i, clip] of mainVideoClips.entries()) {
      const media = mediaById.get(clip.mediaId);
      if (!media) throw new Error(`Missing media for clip ${clip.name}`);
      const seg = join(dir, `seg-${String(i).padStart(4, '0')}.mp4`);
      const dur = clip.durationSec;
      const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p`;
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
      if (hasSrcAudio) {
        args.push('-vf', vf, '-af', audioFilter, '-c:v', 'libx264', '-preset', 'veryfast',
          '-crf', String(opts.crf ?? 18), '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', seg);
      } else {
        args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
          '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(opts.crf ?? 18),
          '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', seg);
      }
      await run(FFMPEG, args, { maxBuffer: 4 * 1024 * 1024 });
      segments.push(seg);
      opts.onProgress?.((i + 1) / (mainVideoClips.length + 1));
    }

    // 2) concat video segments
    const listFile = join(dir, 'concat.txt');
    await writeFile(listFile, segments.map((s) => `file '${s}'`).join('\n'));
    const concatOut = join(dir, 'video.mp4');
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatOut]);

    // 3) mix standalone audio clips (from audio tracks) over the concat result
    if (audioClips.length > 0) {
      const inputs: string[] = ['-i', concatOut];
      const filters: string[] = [];
      const mixLabels: string[] = ['[0:a]'];
      audioClips.forEach((clip, i) => {
        const media = mediaById.get(clip.mediaId);
        if (!media || !media.hasAudio) return;
        const n = i + 1;
        inputs.push('-ss', clip.inSec.toFixed(3), '-t', clip.durationSec.toFixed(3), '-i', media.path);
        const delayMs = Math.round(clip.startSec * 1000);
        filters.push(
          `[${n}:a]volume=${dbToGain(clip.volumeDb).toFixed(4)},adelay=${delayMs}|${delayMs},apad[a${n}]`,
        );
        mixLabels.push(`[a${n}]`);
      });
      if (mixLabels.length > 1) {
        filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0[aout]`);
        await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
          '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', outPath]);
      } else {
        await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', concatOut, '-c', 'copy', outPath]);
      }
    } else {
      await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', concatOut, '-c', 'copy', outPath]);
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
