// ProjectStore: single source of truth for the project, with undo history.
// Pure Node module (no electron import) so the MCP server can run standalone.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  Clip,
  MainOp,
  MediaAsset,
  OpResult,
  Project,
  Track,
  TrackKind,
} from '../shared/types';

export interface StoreListener {
  (project: Project, filePath: string | null): void;
}

const MAX_HISTORY = 100;

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

  // ---------- timeline mutations ----------
  addClip(input: {
    mediaId: string;
    trackId?: string;
    startSec?: number;
    inSec?: number;
    durationSec?: number;
  }): OpResult<Clip> {
    const media = this.media(input.mediaId);
    if (!media) return { ok: false, error: `Unknown media ${input.mediaId}` };
    const wantKind: TrackKind = media.kind === 'audio' ? 'audio' : 'video';
    let track = input.trackId
      ? this.project.tracks.find((t) => t.id === input.trackId)
      : this.project.tracks.find((t) => t.kind === wantKind);
    if (!track || track.kind !== wantKind)
      return { ok: false, error: `No ${wantKind} track available` };
    const inSec = Math.max(0, input.inSec ?? 0);
    if (media.kind !== 'image' && inSec >= media.durationSec)
      return { ok: false, error: 'inSec beyond media duration' };
    const sourceAvail =
      media.kind === 'image' ? 5.0 : media.durationSec - inSec;
    const defaultDur = media.kind === 'image' ? 5.0 : sourceAvail;
    const durationSec = Math.max(0.1, Math.min(input.durationSec ?? defaultDur, media.kind === 'image' ? 3600 : sourceAvail));
    const trackEnd = track.clips.reduce((e, c) => Math.max(e, c.startSec + c.durationSec), 0);
    const startSec = Math.max(0, input.startSec ?? trackEnd);
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
    };
    this.snapshot();
    track.clips.push(clip);
    track.clips.sort((a, b) => a.startSec - b.startSec);
    this.touch();
    return { ok: true, data: clip };
  }

  moveClip(clipId: string, startSec?: number, trackId?: string): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    const targetTrack = trackId
      ? this.project.tracks.find((t) => t.id === trackId)
      : found.track;
    if (!targetTrack) return { ok: false, error: `Unknown track ${trackId}` };
    if (targetTrack.kind !== found.track.kind) {
      return { ok: false, error: `Cannot move clip between ${found.track.kind} and ${targetTrack.kind} tracks` };
    }
    this.snapshot();
    if (trackId && targetTrack.id !== found.track.id) {
      found.track.clips.splice(found.index, 1);
      targetTrack.clips.push(found.clip);
      found.track = targetTrack;
    }
    if (startSec !== undefined) found.clip.startSec = Math.max(0, startSec);
    targetTrack.clips.sort((a, b) => a.startSec - b.startSec);
    this.touch();
    return { ok: true, data: found.clip };
  }

  /** deltaSec > 0 extends, < 0 shortens. edge 'in' adjusts source in-point and start. */
  trimClip(clipId: string, edge: 'in' | 'out', deltaSec: number): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    const { clip } = found;
    const media = this.media(clip.mediaId);
    this.snapshot();
    if (edge === 'in') {
      const newIn = Math.max(0, clip.inSec + deltaSec);
      const applied = newIn - clip.inSec;
      const minDur = 0.1;
      const maxTrim = clip.durationSec - minDur;
      const eff = Math.max(-maxTrim, applied, clip.inSec === newIn ? applied : applied);
      const realDelta = Math.max(-maxTrim, newIn - clip.inSec, -clip.inSec);
      clip.inSec += realDelta;
      clip.startSec += realDelta;
      clip.durationSec -= realDelta;
    } else {
      const maxSource =
        media && media.kind !== 'image' ? media.durationSec - clip.inSec : Number.POSITIVE_INFINITY;
      clip.durationSec = Math.max(0.1, Math.min(clip.durationSec + deltaSec, maxSource));
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
    props: Partial<Pick<Clip, 'volumeDb' | 'speed' | 'fadeInSec' | 'fadeOutSec' | 'text' | 'name'>>,
  ): OpResult<Clip> {
    const found = this.findClip(clipId);
    if (!found) return { ok: false, error: `Unknown clip ${clipId}` };
    this.snapshot();
    Object.assign(found.clip, props);
    this.touch();
    return { ok: true, data: found.clip };
  }

  addTrack(kind: TrackKind): OpResult<Track> {
    const count = this.project.tracks.filter((t) => t.kind === kind).length;
    const track: Track = {
      id: randomUUID(),
      kind,
      name: `${kind === 'video' ? 'V' : 'A'}${count + 1}`,
      muted: false,
      locked: false,
      clips: [],
    };
    this.snapshot();
    // video tracks stack above V1: insert after existing video tracks
    const idx = this.project.tracks.findLastIndex((t) => t.kind === kind);
    this.project.tracks.splice(idx + 1, 0, track);
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
