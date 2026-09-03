// Local speech-to-text with Parakeet TDT v3 (GGUF). No cloud APIs.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { ASR_CLI_PATH, ASR_MODEL_PATH } from '../shared/asrDefaults';
import type { TranscriptSegment } from '../shared/types';
import { extractAudio16k } from './ffmpeg';

const run = promisify(execFile);

export function asrAvailable(): boolean {
  return existsSync(ASR_CLI_PATH) && existsSync(ASR_MODEL_PATH);
}

interface ParakeetWord {
  w?: string;
  word?: string;
  text?: string;
  start?: number;
  end?: number;
}

/** Parse parakeet-cli JSON output (word timestamps) into readable segments. */
function segmentsFromWords(words: ParakeetWord[], maxGapSec = 0.8, maxWords = 14): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  let cur: TranscriptSegment | null = null;
  let count = 0;
  for (const w of words) {
    const text = (w.w ?? w.word ?? w.text ?? '').trim();
    if (!text) continue;
    const start = Number(w.start ?? 0);
    const end = Number(w.end ?? start);
    if (!cur || start - cur.endSec > maxGapSec || count >= maxWords) {
      cur = { startSec: start, endSec: end, text: '' };
      segs.push(cur);
      count = 0;
    }
    cur.text = cur.text ? `${cur.text} ${text}` : text;
    cur.endSec = end;
    count++;
  }
  return segs.filter((s) => s.text);
}

/** Transcribe a media file with the local Parakeet model. Returns timed segments. */
export async function transcribe(inputPath: string): Promise<TranscriptSegment[]> {
  if (!asrAvailable())
    throw new Error(
      `Parakeet ASR not found (cli: ${ASR_CLI_PATH}, model: ${ASR_MODEL_PATH}). ` +
        'Set TAXICUT_PARAKEET_CLI / TAXICUT_PARAKEET_MODEL to override.',
    );
  const wav = await extractAudio16k(inputPath);
  const { stdout } = await run(
    ASR_CLI_PATH,
    ['transcribe', '--model', ASR_MODEL_PATH, '--input', wav,
      '--decoder', 'tdt', '--timestamps', '--json', '--threads', '4'],
    { maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 },
  );
  return parseTranscript(stdout);
}

export function parseTranscript(json: string): TranscriptSegment[] {
  const data = JSON.parse(json);
  // tolerate several plausible output shapes
  const words: ParakeetWord[] =
    data.words ?? data.word_timestamps ?? data.tokens ?? data.timestamps ?? [];
  if (Array.isArray(words) && words.length > 0) return segmentsFromWords(words);
  if (Array.isArray(data.segments)) {
    return data.segments.map((s: { start: number; end: number; text: string }) => ({
      startSec: s.start,
      endSec: s.end,
      text: String(s.text ?? '').trim(),
    }));
  }
  if (typeof data.text === 'string' && data.text.trim())
    return [{ startSec: 0, endSec: data.duration ?? 0, text: data.text.trim() }];
  return [];
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

export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${srtTime(s.startSec)} --> ${srtTime(s.endSec)}\n${s.text}\n`)
    .join('\n');
}
