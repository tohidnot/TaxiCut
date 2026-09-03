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
import { CLIP_FILTERS, DEFAULT_CLIP_COLOR, normClipColor, textTemplateById } from '../shared/types';

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
      if (!Number.isFinite(c.posX)) c.posX = 0;
      if (!Number.isFinite(c.posY)) c.posY = 0;
      for (const k of ['cropL', 'cropT', 'cropR', 'cropB'] as const) {
        if (!Number.isFinite(c[k]) || c[k] < 0 || c[k] > 0.9) c[k] = 0;
      }
      if (c.cropL + c.cropR >= 1) { c.cropL = 0; c.cropR = 0; }
      if (c.cropT + c.cropB >= 1) { c.cropT = 0; c.cropB = 0; }
      if (typeof c.filter !== 'string') c.filter = '';
      c.color = normClipColor((c as { color?: Partial<ClipColor> }).color);
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
  /** Half-open range overlap test. Touching edges are fine. */
  private static rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
    return a0 < b1 - 1e-6 && b0 < a1 - 1e-6;
  }

  /** True when [start, start+dur) touches no other clip on the track. */
  trackHasRoom(track: Track, start: number, dur: number, excludeClipId?: string): boolean {
    const end = start + dur;
    return !track.clips.some(
      (c) => c.id !== excludeClipId &&
        ProjectStore.rangesOverlap(start, end, c.startSec, c.startSec + c.durationSec),
    );
  }

  /** Insert a track without snapshotting (caller owns the undo snapshot). */
  private insertTrack(kind: TrackKind): Track {
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
    // Video layers stack above V1 (end of array = top layer); audio appends at the end.
    const idx = this.project.tracks.findLastIndex((t) => t.kind === kind);
    this.project.tracks.splice(idx + 1, 0, track);
    return track;
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

  moveClip(clipId: string, startSec?: number, trackId?: string): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    const requestedTrack = trackId
      ? this.project.tracks.find((t) => t.id === trackId)
      : found.track;
    if (!requestedTrack) return { ok: false, error: `Unknown track ${trackId}` };
    if (requestedTrack.kind !== found.track.kind) {
      return { ok: false, error: `Cannot move clip between ${found.track.kind} and ${requestedTrack.kind} tracks` };
    }
    const newStart = Math.max(0, startSec ?? found.clip.startSec);
    this.snapshot();
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

  /** deltaSec > 0 extends, < 0 shortens. edge 'in' adjusts source in-point and start.
   *  Trims clamp at neighboring clips: same-track overlaps are never created. */
  trimClip(clipId: string, edge: 'in' | 'out', deltaSec: number): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
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
      const clipEnd = clip.startSec + clip.durationSec;
      const wantStart = Math.max(prevEnd, Math.min(clip.startSec + deltaSec, clipEnd - 0.1));
      const realDelta = wantStart - clip.startSec;
      const maxBack = -clip.inSec; // cannot move in-point before source start
      const applied = Math.max(maxBack, realDelta);
      clip.inSec += applied;
      clip.startSec += applied;
      clip.durationSec -= applied;
    } else {
      const maxSource =
        media && media.kind !== 'image' ? media.durationSec - clip.inSec : Number.POSITIVE_INFINITY;
      const maxEnd = Math.min(clip.startSec + maxSource, nextStart);
      clip.durationSec = Math.max(0.1, Math.min(clip.durationSec + deltaSec, maxEnd - clip.startSec));
    }
    this.touch();
    return { ok: true, data: clip };
  }

  splitClip(clipId: string, atSec: number): OpResult<{ first: Clip; second: Clip }> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
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

  setClipProps(
    clipId: string,
    props: Partial<Pick<Clip, 'volumeDb' | 'speed' | 'fadeInSec' | 'fadeOutSec' | 'text' | 'name' | 'scale' | 'posX' | 'posY' | 'cropL' | 'cropT' | 'cropR' | 'cropB' | 'filter' | 'fontFamily' | 'fontSize' | 'textColor' | 'textBg' | 'bold' | 'textAlign'>> & { color?: Partial<ClipColor> },
  ): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    if (props.scale !== undefined && (!Number.isFinite(props.scale) || props.scale <= 0))
      return { ok: false, error: 'scale must be a positive number' };
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
    this.snapshot();
    const { color: _ignored, ...rest } = props;
    Object.assign(found.clip, rest);
    if (color) found.clip.color = color;
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

  addTrack(kind: TrackKind): OpResult<Track> {
    this.snapshot();
    // video tracks stack above V1: insert after existing video tracks
    const track = this.insertTrack(kind);
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

  setTrackLock(trackId: string, locked: boolean): OpResult {
    const track = this.project.tracks.find((t) => t.id === trackId);
    if (!track) return { ok: false, error: `Unknown track ${trackId}` };
    this.snapshot();
    track.locked = locked;
    this.touch();
    return { ok: true };
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
          return this.moveClip(op.clipId, op.startSec, op.trackId);
        case 'timeline:trimClip':
          return this.trimClip(op.clipId, op.edge, op.deltaSec);
        case 'timeline:splitClip':
          return this.splitClip(op.clipId, op.atSec);
        case 'timeline:deleteClip':
          return this.deleteClip(op.clipId, op.ripple);
        case 'clip:setProps':
          return this.setClipProps(op.clipId, op);
        case 'project:setAspect':
          return this.setAspect(op.aspect, op.width, op.height);
        case 'track:add':
          return this.addTrack(op.kind);
        case 'track:delete':
          return this.deleteTrack(op.trackId);
        case 'track:setMute':
          return this.setTrackMute(op.trackId, op.muted);
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
