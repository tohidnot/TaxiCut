// ProjectStore: single source of truth for the project, with undo history.
// Pure Node module (no electron import) so the MCP server can run standalone.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  Clip,
  ClipColor,
  MainOp,
  MediaAsset,
  OpResult,
  Project,
  Track,
  TrackKind,
} from '../shared/types';
import { CLIP_FILTERS, DEFAULT_CLIP_COLOR, normClipColor, normOpacity, textTemplateById } from '../shared/types';
import { overlappingClip, trackHasRoom } from '../shared/timeline';

export interface StoreListener {
  (project: Project, filePath: string | null): void;
}

const MAX_HISTORY = 100;

const VALID_ASPECTS = new Set(['16:9', '9:16', '1:1', '4:3', '4:5', 'custom']);

/** Fill in fields added after v1 files were written (aspect, clip transforms). */
function migrateProject(p: Project): void {
  if (!VALID_ASPECTS.has(p.aspect as string)) p.aspect = '16:9';
  if (!Number.isFinite(p.customW) || p.customW < 16) p.customW = 1920;
  if (!Number.isFinite(p.customH) || p.customH < 16) p.customH = 1080;
  for (const t of p.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (!Number.isFinite(c.scale) || c.scale <= 0) c.scale = 1;
      if (typeof (c as { audioMuted?: unknown }).audioMuted !== 'boolean') c.audioMuted = false;
      if (!Number.isFinite(c.posX)) c.posX = 0;
      if (!Number.isFinite(c.posY)) c.posY = 0;
      for (const k of ['cropL', 'cropT', 'cropR', 'cropB'] as const) {
        if (!Number.isFinite(c[k]) || c[k] < 0 || c[k] > 0.9) c[k] = 0;
      }
      if (c.cropL + c.cropR >= 1) { c.cropL = 0; c.cropR = 0; }
      if (c.cropT + c.cropB >= 1) { c.cropT = 0; c.cropB = 0; }
      if (typeof c.filter !== 'string') c.filter = '';
      c.color = normClipColor((c as { color?: Partial<ClipColor> }).color);
      (c as { opacity?: unknown }).opacity = normOpacity((c as { opacity?: unknown }).opacity);
      if (c.kind === 'text') {
        if (typeof c.text !== 'string') c.text = 'Text';
        if (typeof c.fontFamily !== 'string' || !c.fontFamily) c.fontFamily = 'Arial';
        if (!Number.isFinite(c.fontSize) || c.fontSize < 8) c.fontSize = 72;
        if (typeof c.textColor !== 'string' || !c.textColor) c.textColor = '#ffffff';
        if (typeof c.textBg !== 'string') c.textBg = '';
        if (typeof c.bold !== 'boolean') c.bold = false;
        if (c.textAlign !== 'left' && c.textAlign !== 'center' && c.textAlign !== 'right') c.textAlign = 'center';
      }
    }
  }
}

export class ProjectStore {
  project: Project = ProjectStore.empty();
  filePath: string | null = null;
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private listeners = new Set<StoreListener>();

  static empty(name = 'Untitled Project'): Project {
    return {
      version: 1,
      name,
      aspect: '16:9',
      customW: 1920,
      customH: 1080,
      media: [],
      tracks: [
        { id: randomUUID(), kind: 'video', name: 'V1', muted: false, locked: false, clips: [] },
        { id: randomUUID(), kind: 'audio', name: 'A1', muted: false, locked: false, clips: [] },
      ],
      modified: false,
    };
  }

  onChange(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.project, this.filePath);
  }

  /** Push current state onto undo stack before a mutation. */
  private snapshot(): void {
    this.undoStack.push(structuredClone(this.project));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  private touch(): void {
    this.project.modified = true;
    this.emit();
  }

  // ---------- lookup helpers ----------
  media(id: string): MediaAsset | undefined {
    return this.project.media.find((m) => m.id === id);
  }

  findClip(clipId: string): { track: Track; clip: Clip; index: number } | null {
    for (const track of this.project.tracks) {
      const index = track.clips.findIndex((c) => c.id === clipId);
      if (index >= 0) return { track, clip: track.clips[index], index };
    }
    return null;
  }

  timelineDuration(): number {
    let end = 0;
    for (const t of this.project.tracks)
      for (const c of t.clips) end = Math.max(end, c.startSec + c.durationSec);
    return end;
  }

  // ---------- project lifecycle ----------
  newProject(name = 'Untitled Project'): OpResult {
    this.project = ProjectStore.empty(name);
    this.filePath = null;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
    return { ok: true, data: { name } };
  }

  async open(path: string): Promise<OpResult> {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as Project;
      if (parsed.version !== 1 || !Array.isArray(parsed.tracks))
        return { ok: false, error: 'Not a TaxiCut project file' };
      migrateProject(parsed);
      this.project = parsed;
      this.filePath = path;
      this.undoStack = [];
      this.redoStack = [];
      this.project.modified = false;
      this.emit();
      return { ok: true, data: { name: parsed.name, path } };
    } catch (e) {
      return { ok: false, error: `Open failed: ${(e as Error).message}` };
    }
  }

  async save(path?: string): Promise<OpResult> {
    const target = path ?? this.filePath;
    if (!target) return { ok: false, error: 'No path. Provide a path to save.' };
    try {
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(this.project, null, 2), 'utf8');
      const { rename } = await import('node:fs/promises');
      await rename(tmp, target);
      this.filePath = target;
      this.project.modified = false;
      this.emit();
      return { ok: true, data: { path: target } };
    } catch (e) {
      return { ok: false, error: `Save failed: ${(e as Error).message}` };
    }
  }

  // ---------- media ----------
  addMedia(asset: MediaAsset): MediaAsset {
    this.project.media.push(asset);
    this.project.modified = true;
    this.emit();
    return asset;
  }

  deleteMedia(mediaId: string): OpResult<{ removed: string }> {
    const idx = this.project.media.findIndex((m) => m.id === mediaId);
    if (idx === -1) return { ok: false, error: `Unknown media ${mediaId}` };
    this.snapshot();
    this.project.media.splice(idx, 1);
    for (const track of this.project.tracks) {
      track.clips = track.clips.filter((c) => c.mediaId !== mediaId);
    }
    this.touch();
    return { ok: true, data: { removed: mediaId } };
  }

  // ---------- layered tracks: clips on the SAME track never overlap ----------
  // (range rule lives in shared/timeline so preview/export/TimelinePanel agree)
  /** True when [start, start+dur) touches no other clip on the track. */
  trackHasRoom(track: Track, start: number, dur: number, excludeClipId?: string): boolean {
    return trackHasRoom(track, start, dur, excludeClipId);
  }

  /** Insert a track without snapshotting (caller owns the undo snapshot).
   *  `atSameKindIndex` is the position within the same-kind group
   *  (video: 0 = background / V1, length = new foreground; audio: 0 = A1). */
  private insertTrack(kind: TrackKind, atSameKindIndex?: number): Track {
    let maxN = 0;
    for (const t of this.project.tracks) {
      if (t.kind !== kind) continue;
      const m = /^([VA])(\d+)$/.exec(t.name);
      if (m) maxN = Math.max(maxN, parseInt(m[2], 10));
    }
    const track: Track = {
      id: randomUUID(),
      kind,
      name: `${kind === 'video' ? 'V' : 'A'}${maxN + 1}`,
      muted: false,
      locked: false,
      clips: [],
    };
    const firstIdx = this.project.tracks.findIndex((t) => t.kind === kind);
    const sameCount = this.project.tracks.filter((t) => t.kind === kind).length;
    let spliceAt: number;
    if (firstIdx < 0) {
      // Keep videos before audios even when a kind-group is missing.
      spliceAt = kind === 'video' ? 0 : this.project.tracks.length;
    } else if (atSameKindIndex === undefined) {
      // Default: append after last of this kind (video = new top layer).
      spliceAt = this.project.tracks.findLastIndex((t) => t.kind === kind) + 1;
    } else {
      const clamped = Math.max(0, Math.min(sameCount, Math.round(atSameKindIndex)));
      spliceAt = firstIdx + clamped;
    }
    this.project.tracks.splice(spliceAt, 0, track);
    return track;
  }

  private kindIndex(track: Track): number {
    return this.project.tracks.filter((t) => t.kind === track.kind).findIndex((t) => t.id === track.id);
  }

  private relocateClipTo(found: { track: Track; clip: Clip; index: number }, dest: Track): void {
    if (dest.id === found.track.id) return;
    found.track.clips.splice(found.index, 1);
    dest.clips.push(found.clip);
    dest.clips.sort((a, b) => a.startSec - b.startSec);
  }

  private swapClipTracks(a: Clip, source: Track, b: Clip, dest: Track): void {
    const ai = source.clips.findIndex((c) => c.id === a.id);
    const bi = dest.clips.findIndex((c) => c.id === b.id);
    if (ai < 0 || bi < 0) return;
    source.clips.splice(ai, 1);
    dest.clips.splice(bi, 1);
    dest.clips.push(a);
    source.clips.push(b);
    source.clips.sort((x, y) => x.startSec - y.startSec);
    dest.clips.sort((x, y) => x.startSec - y.startSec);
  }

  /**
   * Put `found.clip` on `dest` at `startSec`. Same-track overlaps are never
   * created: join dest when it has room, otherwise swap with the overlapping
   * clip if the source can take it, otherwise insert a new track at `insertAt`
   * (same-kind index) and place the clip there.
   * Caller owns the undo snapshot. Returns the track the clip ended on.
   */
  private placeClipOnTrack(
    found: { track: Track; clip: Clip; index: number },
    dest: Track,
    startSec: number,
    insertAt: number,
  ): Track {
    found.clip.startSec = startSec;
    if (dest.id === found.track.id) {
      dest.clips.sort((a, b) => a.startSec - b.startSec);
      return dest;
    }
    if (dest.kind !== found.track.kind) return found.track;
    if (dest.locked) {
      const t = this.insertTrack(found.track.kind, insertAt);
      this.relocateClipTo(found, t);
      return t;
    }
    if (this.trackHasRoom(dest, startSec, found.clip.durationSec, found.clip.id)) {
      this.relocateClipTo(found, dest);
      return dest;
    }
    const other = overlappingClip(dest, startSec, found.clip.durationSec, found.clip.id);
    if (other && this.trackHasRoom(found.track, other.startSec, other.durationSec, found.clip.id)) {
      this.swapClipTracks(found.clip, found.track, other, dest);
      return dest;
    }
    const t = this.insertTrack(found.track.kind, insertAt);
    this.relocateClipTo(found, t);
    return t;
  }

  /**
   * Resolve the layer for a [start, dur) range: prefer the requested track,
   * else the first unlocked same-kind track with room, else auto-create a new
   * layer. Always returns a track with room (a locked preferred track is
   * treated as no preference — locked tracks are never modified).
   */
  private resolveLayer(
    wantKind: TrackKind,
    start: number,
    dur: number,
    preferredTrackId?: string,
    excludeClipId?: string,
  ): Track {
    const byId = preferredTrackId
      ? this.project.tracks.find((t) => t.id === preferredTrackId)
      : undefined;
    if (byId && byId.kind === wantKind && !byId.locked &&
      this.trackHasRoom(byId, start, dur, excludeClipId)) {
      return byId;
    }
    const free = this.project.tracks.find(
      (t) => t.kind === wantKind && !t.locked && this.trackHasRoom(t, start, dur, excludeClipId),
    );
    if (free) return free;
    return this.insertTrack(wantKind);
  }

  // ---------- timeline mutations ----------
  addClip(input: {
    mediaId: string;
    trackId?: string;
    startSec?: number;
    inSec?: number;
    durationSec?: number;
    text?: string;
    template?: string;
  }): OpResult<Clip> {
    if (input.mediaId === 'text') return this.addTextClip(input);
    const media = this.media(input.mediaId);
    if (!media) return { ok: false, error: `Unknown media ${input.mediaId}` };
    const wantKind: TrackKind = media.kind === 'audio' ? 'audio' : 'video';
    const inSec = Math.max(0, input.inSec ?? 0);
    if (media.kind !== 'image' && inSec >= media.durationSec)
      return { ok: false, error: 'inSec beyond media duration' };
    const sourceAvail =
      media.kind === 'image' ? 5.0 : media.durationSec - inSec;
    const defaultDur = media.kind === 'image' ? 5.0 : sourceAvail;
    const durationSec = Math.max(0.1, Math.min(input.durationSec ?? defaultDur, media.kind === 'image' ? 3600 : sourceAvail));
    const preferred = input.trackId
      ? this.project.tracks.find((t) => t.id === input.trackId)
      : this.project.tracks.find((t) => t.kind === wantKind);
    const fallbackEnd = this.project.tracks
      .filter((t) => t.kind === wantKind)
      .reduce((e, t) => Math.max(e, ...t.clips.map((c) => c.startSec + c.durationSec)), 0);
    const startSec = Math.max(0, input.startSec ?? fallbackEnd);
    const clip: Clip = {
      id: randomUUID(),
      mediaId: media.id,
      name: media.name,
      startSec,
      durationSec,
      inSec,
      speed: 1,
      volumeDb: 0,
      audioMuted: false,
      fadeInSec: 0,
      fadeOutSec: 0,
      kind: media.kind,
      scale: 1,
      posX: 0,
      posY: 0,
      cropL: 0,
      cropT: 0,
      cropR: 0,
      cropB: 0,
      filter: '',
      color: { ...DEFAULT_CLIP_COLOR },
      opacity: 1,
      fontFamily: 'Arial',
      fontSize: 72,
      textColor: '#ffffff',
      textBg: '',
      bold: false,
      textAlign: 'center',
    };
    this.snapshot();
    const track = this.resolveLayer(wantKind, startSec, durationSec, preferred?.id);
    if (track.kind !== wantKind)
      return { ok: false, error: `No ${wantKind} track available` };
    track.clips.push(clip);
    track.clips.sort((a, b) => a.startSec - b.startSec);
    this.touch();
    return { ok: true, data: clip };
  }

  /** Standalone text overlay clip (no media). Lives on a video track. */
  addTextClip(input: {
    trackId?: string;
    startSec?: number;
    durationSec?: number;
    text?: string;
    template?: string;
  }): OpResult<Clip> {
    const tpl = textTemplateById(input.template);
    const durationSec = Math.max(0.5, Math.min(input.durationSec ?? 3, 3600));
    const preferred = input.trackId
      ? this.project.tracks.find((t) => t.id === input.trackId)
      : this.project.tracks.find((t) => t.kind === 'video');
    const fallbackEnd = this.project.tracks
      .filter((t) => t.kind === 'video')
      .reduce((e, t) => Math.max(e, ...t.clips.map((c) => c.startSec + c.durationSec)), 0);
    const startSec = Math.max(0, input.startSec ?? fallbackEnd);
    const text = typeof input.text === 'string' && input.text.length > 0 ? input.text : tpl.sample;
    const clip: Clip = {
      id: randomUUID(),
      mediaId: 'text',
      name: text.slice(0, 40),
      startSec,
      durationSec,
      inSec: 0,
      speed: 1,
      volumeDb: 0,
      audioMuted: false,
      fadeInSec: 0,
      fadeOutSec: 0,
      kind: 'text',
      scale: tpl.scale,
      posX: tpl.posX,
      posY: tpl.posY,
      cropL: 0,
      cropT: 0,
      cropR: 0,
      cropB: 0,
      filter: '',
      color: { ...DEFAULT_CLIP_COLOR },
      opacity: 1,
      text,
      fontFamily: tpl.fontFamily,
      fontSize: tpl.fontSize,
      textColor: tpl.textColor,
      textBg: tpl.textBg,
      bold: tpl.bold,
      textAlign: tpl.textAlign,
    };
    this.snapshot();
    const track = this.resolveLayer('video', startSec, durationSec, preferred?.id);
    if (track.kind !== 'video')
      return { ok: false, error: 'No video track available for text' };
    track.clips.push(clip);
    track.clips.sort((a, b) => a.startSec - b.startSec);
    this.touch();
    return { ok: true, data: clip };
  }

  moveClip(
    clipId: string,
    startSec?: number,
    trackId?: string,
    place: 'auto' | 'layer' = 'auto',
  ): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    if (found.track.locked) return { ok: false, error: `Track ${found.track.name} is locked` };
    const requestedTrack = trackId
      ? this.project.tracks.find((t) => t.id === trackId)
      : found.track;
    if (!requestedTrack) return { ok: false, error: `Unknown track ${trackId}` };
    if (requestedTrack.locked && requestedTrack.id !== found.track.id)
      return { ok: false, error: `Track ${requestedTrack.name} is locked` };
    if (requestedTrack.kind !== found.track.kind) {
      return { ok: false, error: `Cannot move clip between ${found.track.kind} and ${requestedTrack.kind} tracks` };
    }
    const newStart = Math.max(0, startSec ?? found.clip.startSec);
    this.snapshot();
    if (place === 'layer' && requestedTrack.id !== found.track.id) {
      // Explicit lane drop: land on the hovered layer. Occupied ranges swap
      // (or insert a new track at that z-index) instead of bouncing away.
      this.placeClipOnTrack(found, requestedTrack, newStart, this.kindIndex(requestedTrack));
      this.touch();
      return { ok: true, data: found.clip };
    }
    // Overlaps are resolved by layering: an occupied target bumps the clip
    // onto a free layer (auto-created when needed), never on top of a sibling.
    const targetTrack = this.resolveLayer(
      found.track.kind, newStart, found.clip.durationSec, requestedTrack.id, found.clip.id,
    );
    if (targetTrack.id !== found.track.id) {
      found.track.clips.splice(found.index, 1);
      targetTrack.clips.push(found.clip);
    }
    found.clip.startSec = newStart;
    targetTrack.clips.sort((a, b) => a.startSec - b.startSec);
    this.touch();
    return { ok: true, data: found.clip };
  }

  /**
   * Change a clip's stacking order without changing its timeline time.
   * `direction` is visual: +1 = toward the top of the timeline (video
   * foreground / audio A1). `position` jumps to the front or back of the
   * stack. `toIndex` is the same-kind index (video 0 = background).
   * Occupied destinations swap or insert a layer — they never no-op.
   */
  reorderClip(
    clipId: string,
    opts: { direction?: 1 | -1; toIndex?: number; position?: 'front' | 'back' },
  ): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    if (found.track.locked) return { ok: false, error: `Track ${found.track.name} is locked` };
    const kind = found.track.kind;
    const same = this.project.tracks.filter((t) => t.kind === kind);
    const cur = same.findIndex((t) => t.id === found.track.id);
    if (cur < 0) return { ok: false, error: `Unknown clip ${clipId}` };

    const frontIdx = kind === 'video' ? same.length - 1 : 0;
    const backIdx = kind === 'video' ? 0 : same.length - 1;
    const startSec = found.clip.startSec;

    if (opts.position === 'front' || opts.position === 'back') {
      const edge = opts.position === 'front' ? frontIdx : backIdx;
      if (cur === edge) return { ok: true, data: found.clip };
      const dest = same[edge];
      const insertAt = opts.position === 'front'
        ? (kind === 'video' ? same.length : 0)
        : (kind === 'video' ? 0 : same.length);
      this.snapshot();
      this.placeClipOnTrack(found, dest, startSec, insertAt);
      this.touch();
      return { ok: true, data: found.clip };
    }

    if (opts.toIndex !== undefined) {
      const target = Math.max(0, Math.min(same.length, Math.round(opts.toIndex)));
      if (target === cur) return { ok: true, data: found.clip };
      this.snapshot();
      if (target >= same.length) {
        const t = this.insertTrack(kind, same.length);
        this.relocateClipTo(found, t);
      } else {
        this.placeClipOnTrack(found, same[target], startSec, target);
      }
      this.touch();
      return { ok: true, data: found.clip };
    }

    if (opts.direction !== 1 && opts.direction !== -1) {
      return { ok: false, error: 'reorderClip needs direction, toIndex, or position' };
    }
    // Video array grows toward the foreground; audio array grows toward the bottom.
    const arrayDir = kind === 'video' ? opts.direction : (-opts.direction as 1 | -1);
    const want = cur + arrayDir;
    this.snapshot();
    if (want < 0) {
      const t = this.insertTrack(kind, 0);
      found.clip.startSec = startSec;
      this.relocateClipTo(found, t);
    } else if (want >= same.length) {
      const t = this.insertTrack(kind, same.length);
      found.clip.startSec = startSec;
      this.relocateClipTo(found, t);
    } else {
      const insertAt = arrayDir > 0 ? want + 1 : want;
      this.placeClipOnTrack(found, same[want], startSec, insertAt);
    }
    this.touch();
    return { ok: true, data: found.clip };
  }

  /** deltaSec > 0 extends, < 0 shortens. edge 'in' adjusts source in-point and start.
   *  Trims clamp at neighboring clips: same-track overlaps are never created. */
  trimClip(clipId: string, edge: 'in' | 'out', deltaSec: number): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    if (found.track.locked) return { ok: false, error: `Track ${found.track.name} is locked` };
    const { track, clip } = found;
    const media = this.media(clip.mediaId);
    // Sibling bounds on the same track (clips stay sorted by startSec).
    const siblings = [...track.clips].sort((a, b) => a.startSec - b.startSec);
    const idx = siblings.findIndex((c) => c.id === clip.id);
    const prevEnd = idx > 0 ? siblings[idx - 1].startSec + siblings[idx - 1].durationSec : 0;
    const nextStart = idx >= 0 && idx < siblings.length - 1
      ? siblings[idx + 1].startSec
      : Number.POSITIVE_INFINITY;
    this.snapshot();
    if (edge === 'in') {
      // newStart must stay within [prevEnd, clipEnd - minDur].
      // The source in-point moves speed× the timeline delta (see splitClip).
      // Stills (image) and text have no source bounds: they extend freely.
      const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
      const clipEnd = clip.startSec + clip.durationSec;
      const wantStart = Math.max(prevEnd, Math.min(clip.startSec + deltaSec, clipEnd - 0.1));
      const realDelta = wantStart - clip.startSec;
      const isStill = clip.kind === 'image' || clip.kind === 'text' || media?.kind === 'image';
      const maxBack = isStill ? Number.NEGATIVE_INFINITY : -clip.inSec / speed; // cannot move in-point before source start
      const applied = Math.max(maxBack, realDelta);
      if (!isStill) clip.inSec = Math.max(0, clip.inSec + applied * speed);
      clip.startSec += applied;
      clip.durationSec -= applied;
    } else {
      const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
      const maxSource =
        media && media.kind !== 'image' ? (media.durationSec - clip.inSec) / speed : Number.POSITIVE_INFINITY;
      const maxEnd = Math.min(clip.startSec + maxSource, nextStart);
      clip.durationSec = Math.max(0.1, Math.min(clip.durationSec + deltaSec, maxEnd - clip.startSec));
    }
    this.touch();
    return { ok: true, data: clip };
  }

  splitClip(clipId: string, atSec: number): OpResult<{ first: Clip; second: Clip }> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    if (found.track.locked) return { ok: false, error: `Track ${found.track.name} is locked` };
    const { track, clip } = found;
    const rel = atSec - clip.startSec;
    if (rel <= 0.05 || rel >= clip.durationSec - 0.05)
      return { ok: false, error: 'Split point outside clip (or too close to edge)' };
    this.snapshot();
    const second: Clip = {
      ...structuredClone(clip),
      id: randomUUID(),
      startSec: clip.startSec + rel,
      durationSec: clip.durationSec - rel,
      inSec: clip.inSec + rel * clip.speed,
    };
    clip.durationSec = rel;
    track.clips.push(second);
    track.clips.sort((a, b) => a.startSec - b.startSec);
    this.touch();
    return { ok: true, data: { first: clip, second } };
  }

  deleteClip(clipId: string, ripple = false): OpResult<{ removed: string; ripple: boolean }> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    if (found.track.locked) return { ok: false, error: `Track ${found.track.name} is locked` };
    const { track, clip, index } = found;
    this.snapshot();
    track.clips.splice(index, 1);
    if (ripple) {
      const gap = clip.durationSec;
      const at = clip.startSec;
      for (const t of this.project.tracks)
        for (const c of t.clips) if (c.startSec >= at) c.startSec = Math.max(0, c.startSec - gap);
    }
    this.touch();
    return { ok: true, data: { removed: clipId, ripple } };
  }

  /** Copy/paste: clone a clip with a new id, preserving every prop, placed
   *  via the layer resolver (never overlaps). One undo step. */
  duplicateClip(clipId: string, startSec?: number, trackId?: string): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    const wantKind = found.track.kind;
    const at = Math.max(0, startSec ?? found.clip.startSec + found.clip.durationSec);
    const preferred = trackId
      ? this.project.tracks.find((t) => t.id === trackId)
      : found.track;
    if (preferred && preferred.kind !== wantKind)
      return { ok: false, error: `Cannot paste ${wantKind} clip onto ${preferred.kind} track` };
    if (preferred && preferred.locked)
      return { ok: false, error: `Track ${preferred.name} is locked` };
    this.snapshot();
    const clone: Clip = { ...structuredClone(found.clip), id: randomUUID(), startSec: at };
    // No excludeClipId: the source clip stays on its track, so the room
    // check must see it (otherwise the clone could land overlapping it).
    const dest = this.resolveLayer(wantKind, at, clone.durationSec, preferred?.id);
    dest.clips.push(clone);
    dest.clips.sort((a, b) => a.startSec - b.startSec);
    this.touch();
    return { ok: true, data: clone };
  }

  setClipProps(
    clipId: string,
    props: Partial<Pick<Clip, 'volumeDb' | 'speed' | 'audioMuted' | 'fadeInSec' | 'fadeOutSec' | 'text' | 'name' | 'scale' | 'posX' | 'posY' | 'cropL' | 'cropT' | 'cropR' | 'cropB' | 'filter' | 'fontFamily' | 'fontSize' | 'textColor' | 'textBg' | 'bold' | 'textAlign' | 'opacity'>> & { color?: Partial<ClipColor> },
  ): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    if (found.track.locked) return { ok: false, error: `Track ${found.track.name} is locked` };
    if (props.scale !== undefined && (!Number.isFinite(props.scale) || props.scale <= 0))
      return { ok: false, error: 'scale must be a positive number' };
    if (props.opacity !== undefined && (!Number.isFinite(props.opacity) || props.opacity! < 0 || props.opacity! > 1))
      return { ok: false, error: 'opacity must be between 0 and 1' };
    if (props.speed !== undefined &&
      (!Number.isFinite(props.speed) || props.speed! < 0.1 || props.speed! > 10))
      return { ok: false, error: 'speed must be between 0.1 and 10' };
    if (props.audioMuted !== undefined && typeof props.audioMuted !== 'boolean')
      return { ok: false, error: 'audioMuted must be a boolean' };
    for (const k of ['posX', 'posY'] as const) {
      if (props[k] !== undefined && !Number.isFinite(props[k]))
        return { ok: false, error: `${k} must be a finite number` };
    }
    for (const k of ['cropL', 'cropT', 'cropR', 'cropB'] as const) {
      if (props[k] !== undefined && (!Number.isFinite(props[k]) || props[k]! < 0 || props[k]! > 0.9))
        return { ok: false, error: `${k} must be between 0 and 0.9` };
    }
    const merged = { ...found.clip, ...props };
    if (merged.cropL + merged.cropR >= 1 || merged.cropT + merged.cropB >= 1)
      return { ok: false, error: 'crop insets must leave a non-empty frame' };
    if (props.filter !== undefined && !CLIP_FILTERS.some((f) => f.id === props.filter))
      return { ok: false, error: `Unknown filter ${props.filter}` };
    if (props.fontSize !== undefined && (!Number.isFinite(props.fontSize) || props.fontSize < 8 || props.fontSize > 500))
      return { ok: false, error: 'fontSize must be between 8 and 500' };
    if (props.textAlign !== undefined && props.textAlign !== 'left' && props.textAlign !== 'center' && props.textAlign !== 'right')
      return { ok: false, error: 'textAlign must be left, center, or right' };
    if (props.bold !== undefined && typeof props.bold !== 'boolean')
      return { ok: false, error: 'bold must be a boolean' };
    let color: ClipColor | undefined;
    if (props.color !== undefined) {
      if (typeof props.color !== 'object' || props.color === null)
        return { ok: false, error: 'color must be an object' };
      color = normClipColor({ ...found.clip.color, ...props.color });
    }
    // Retime (CapCut-style): keep the same source content, so the timeline
    // duration scales inversely with speed. Clamped to the available source
    // and to the next sibling so a retime can never overlap or over-read.
    let retimedDur: number | null = null;
    if (props.speed !== undefined && props.speed !== found.clip.speed) {
      const oldSpeed = Number.isFinite(found.clip.speed) && found.clip.speed > 0 ? found.clip.speed : 1;
      const newSpeed = props.speed!;
      const media = this.media(found.clip.mediaId);
      const srcLen = found.clip.durationSec * oldSpeed;
      const srcAvail = media && media.kind !== 'image'
        ? Math.max(0, media.durationSec - found.clip.inSec)
        : Number.POSITIVE_INFINITY;
      const sibs = [...found.track.clips].sort((a, b) => a.startSec - b.startSec);
      const idx = sibs.findIndex((c) => c.id === found.clip.id);
      const nextStart = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1].startSec : Number.POSITIVE_INFINITY;
      retimedDur = Math.max(
        0.1,
        Math.min(srcLen / newSpeed, srcAvail / newSpeed, nextStart - found.clip.startSec),
      );
    }
    this.snapshot();
    const { color: _ignored, opacity: _op, ...rest } = props;
    Object.assign(found.clip, rest);
    if (_op !== undefined) found.clip.opacity = normOpacity(_op);
    if (color) found.clip.color = color;
    if (retimedDur !== null && Number.isFinite(retimedDur)) found.clip.durationSec = retimedDur;
    this.touch();
    return { ok: true, data: found.clip };
  }

  setAspect(aspect: string, width?: number, height?: number): OpResult {
    if (!VALID_ASPECTS.has(aspect))
      return { ok: false, error: `Unknown aspect ${aspect}` };
    let customW = this.project.customW;
    let customH = this.project.customH;
    if (aspect === 'custom') {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width! < 16 || height! < 16)
        return { ok: false, error: 'custom aspect needs width/height >= 16' };
      customW = Math.round(width!);
      customH = Math.round(height!);
    }
    this.snapshot();
    this.project.aspect = aspect as Project['aspect'];
    this.project.customW = customW;
    this.project.customH = customH;
    this.touch();
    return { ok: true };
  }

  addTrack(kind: TrackKind, atIndex?: number): OpResult<Track> {
    this.snapshot();
    const track = this.insertTrack(kind, atIndex);
    this.touch();
    return { ok: true, data: track };
  }

  deleteTrack(trackId: string): OpResult<{ removed: string }> {
    if (this.project.tracks.length <= 1) {
      return { ok: false, error: 'Cannot delete the only track' };
    }
    const idx = this.project.tracks.findIndex((t) => t.id === trackId);
    if (idx === -1) return { ok: false, error: `Unknown track ${trackId}` };
    this.snapshot();
    this.project.tracks.splice(idx, 1);
    this.touch();
    return { ok: true, data: { removed: trackId } };
  }

  setTrackMute(trackId: string, muted: boolean): OpResult {
    const track = this.project.tracks.find((t) => t.id === trackId);
    if (!track) return { ok: false, error: `Unknown track ${trackId}` };
    this.snapshot();
    track.muted = muted;
    this.touch();
    return { ok: true };
  }

  /** Mute/unmute every clip's audio on a track in one undo step (picture untouched). */
  setTrackAudioMute(trackId: string, muted: boolean): OpResult {
    const track = this.project.tracks.find((t) => t.id === trackId);
    if (!track) return { ok: false, error: `Unknown track ${trackId}` };
    if (track.locked) return { ok: false, error: `Track ${track.name} is locked` };
    this.snapshot();
    for (const c of track.clips) c.audioMuted = muted;
    this.touch();
    return { ok: true };
  }

  setTrackLock(trackId: string, locked: boolean): OpResult {
    const track = this.project.tracks.find((t) => t.id === trackId);
    if (!track) return { ok: false, error: `Unknown track ${trackId}` };
    this.snapshot();
    track.locked = locked;
    this.touch();
    return { ok: true };
  }

  /**
   * Reshuffle track stacking order (undoable). Only reorders within the same
   * kind (video layers composite bottom-to-top in array order; audio mixes).
   * `toIndex` is the position within the same-kind list (0 = bottom V1 / top A1).
   * `direction` moves one step: +1 = toward foreground for video.
   */
  moveTrack(trackId: string, toIndex?: number, direction?: 1 | -1): OpResult<Track> {
    const track = this.project.tracks.find((t) => t.id === trackId);
    if (!track) return { ok: false, error: `Unknown track ${trackId}` };
    const same = this.project.tracks.filter((t) => t.kind === track.kind);
    const cur = same.findIndex((t) => t.id === trackId);
    let next = cur;
    if (direction === 1) next = cur + 1;
    else if (direction === -1) next = cur - 1;
    else if (toIndex !== undefined) next = Math.round(toIndex);
    else return { ok: false, error: 'moveTrack needs toIndex or direction' };
    next = Math.max(0, Math.min(same.length - 1, next));
    if (next === cur) return { ok: true, data: track };
    this.snapshot();
    const reordered = [...same];
    reordered.splice(cur, 1);
    reordered.splice(next, 0, track);
    // Splice the reordered kind-group back where the group started,
    // preserving video-before-audio grouping.
    const firstIdx = this.project.tracks.findIndex((t) => t.kind === track.kind);
    const without = this.project.tracks.filter((t) => t.kind !== track.kind);
    // Videos live before audios: reinsert videos at 0, audios at end.
    if (track.kind === 'video') {
      this.project.tracks = [...reordered, ...without.filter((t) => t.kind === 'audio')];
      // Preserve any non-video/audio kinds (future-proof) at the end.
      const others = without.filter((t) => t.kind !== 'audio');
      if (others.length > 0) this.project.tracks.push(...others);
    } else {
      const videos = without.filter((t) => t.kind === 'video');
      const others = without.filter((t) => t.kind !== 'video');
      this.project.tracks = [...videos, ...reordered, ...others];
    }
    // Keep firstIdx reference unused-safe (grouping rebuild above).
    void firstIdx;
    this.touch();
    return { ok: true, data: track };
  }

  // ---------- history ----------
  undo(): OpResult {
    const prev = this.undoStack.pop();
    if (!prev) return { ok: false, error: 'Nothing to undo' };
    this.redoStack.push(structuredClone(this.project));
    this.project = prev;
    this.project.modified = true;
    this.emit();
    return { ok: true };
  }

  redo(): OpResult {
    const next = this.redoStack.pop();
    if (!next) return { ok: false, error: 'Nothing to redo' };
    this.undoStack.push(structuredClone(this.project));
    this.project = next;
    this.project.modified = true;
    this.emit();
    return { ok: true };
  }

  // ---------- MainOp dispatch (shared by IPC and MCP) ----------
  async dispatch(op: MainOp): Promise<OpResult> {
    try {
      switch (op.op) {
        case 'project:get':
          return { ok: true, data: { project: this.project, filePath: this.filePath } };
        case 'project:new':
          return this.newProject(op.name);
        case 'project:open':
          return op.path ? this.open(op.path) : { ok: false, error: 'path required' };
        case 'project:save':
          return this.save(op.path);
        case 'media:delete':
          return this.deleteMedia(op.mediaId);
        case 'timeline:addClip':
          return this.addClip(op);
        case 'timeline:moveClip':
          return this.moveClip(op.clipId, op.startSec, op.trackId, op.place);
        case 'timeline:reorderClip':
          return this.reorderClip(op.clipId, op);
        case 'timeline:trimClip':
          return this.trimClip(op.clipId, op.edge, op.deltaSec);
        case 'timeline:splitClip':
          return this.splitClip(op.clipId, op.atSec);
        case 'timeline:deleteClip':
          return this.deleteClip(op.clipId, op.ripple);
        case 'timeline:duplicateClip':
          return this.duplicateClip(op.clipId, op.startSec, op.trackId);
        case 'clip:setProps':
          return this.setClipProps(op.clipId, op);
        case 'project:setAspect':
          return this.setAspect(op.aspect, op.width, op.height);
        case 'track:add':
          return this.addTrack(op.kind, op.atIndex);
        case 'track:delete':
          return this.deleteTrack(op.trackId);
        case 'track:move':
          return this.moveTrack(op.trackId, op.toIndex, op.direction);
        case 'track:setMute':
          return this.setTrackMute(op.trackId, op.muted);
        case 'track:setAudioMute':
          return this.setTrackAudioMute(op.trackId, op.muted);
        case 'track:setLock':
          return this.setTrackLock(op.trackId, op.locked);
        case 'history:undo':
          return this.undo();
        case 'history:redo':
          return this.redo();
        default:
          return { ok: false, error: `Unsupported op in store: ${(op as MainOp).op}` };
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
