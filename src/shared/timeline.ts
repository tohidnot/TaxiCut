// Shared multi-layer compositing model for TaxiCut.
//
// Single source of truth for "what shows where, when" — imported by the
// preview (renderer), the exporter (main/ffmpeg), and the store's layer rule.
// Preview and export can never disagree about layering as long as both build
// on these selectors.
//
// Model recap (CapCut/Davinci-style):
// - Clips on the SAME track never overlap (half-open ranges; touching edges OK).
// - Different video tracks MAY overlap: the base track is the first unmuted
//   video track holding any clips; every other unmuted video track composites
//   over it (array order = bottom-to-top, i.e. later tracks are foreground).
// - All unmuted audio-track clips mix together; embedded audio in video/image
//   clips on video tracks plays with its picture.
// - Text clips live on video tracks and all render (stacked); they never
//   affect the picture layers.
import type { Clip, MediaAsset, Project, Track, TrackKind } from './types';

export const OVERLAP_EPS = 1e-6;

/** Half-open range overlap test. Touching edges are fine. */
export function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 - OVERLAP_EPS && b0 < a1 - OVERLAP_EPS;
}

/** The clip on `track` that overlaps [start, start+dur), if any. */
export function overlappingClip(
  track: Track,
  start: number,
  dur: number,
  excludeClipId?: string,
): Clip | undefined {
  const end = start + dur;
  return track.clips.find(
    (c) => c.id !== excludeClipId &&
      rangesOverlap(start, end, c.startSec, c.startSec + c.durationSec),
  );
}

/** True when [start, start+dur) touches no other clip on the track. */
export function trackHasRoom(track: Track, start: number, dur: number, excludeClipId?: string): boolean {
  return !overlappingClip(track, start, dur, excludeClipId);
}

/**
 * Mirror of the store's layer rule WITHOUT creating tracks: where would
 * [start, dur) land? Returns the preferred track when it has room, else the
 * first unlocked same-kind track with room, else null (caller creates a new
 * layer). Locked tracks are never returned.
 */
export function resolveDropTarget(
  project: Project,
  wantKind: TrackKind,
  start: number,
  dur: number,
  preferredTrackId?: string,
  excludeClipId?: string,
): Track | null {
  const byId = preferredTrackId
    ? project.tracks.find((t) => t.id === preferredTrackId)
    : undefined;
  if (byId && byId.kind === wantKind && !byId.locked &&
    trackHasRoom(byId, start, dur, excludeClipId)) {
    return byId;
  }
  return project.tracks.find(
    (t) => t.kind === wantKind && !t.locked && trackHasRoom(t, start, dur, excludeClipId),
  ) ?? null;
}

export function clipActiveAt(c: Clip, head: number): boolean {
  return head >= c.startSec && head < c.startSec + c.durationSec;
}

export function mediaOf(project: Project, clip: Clip): MediaAsset | undefined {
  return project.media.find((m) => m.id === clip.mediaId);
}

/** First unmuted video track holding any clips — the picture "underneath". */
export function baseVideoTrack(project: Project): Track | undefined {
  return (project.tracks ?? []).find((t) => t.kind === 'video' && !t.muted && t.clips.length > 0);
}

export interface PlacedClip {
  track: Track;
  clip: Clip;
  media?: MediaAsset;
}

/** Base/hero lookup: track/clip may be absent (empty timeline or gap). */
export interface MaybePlaced {
  track?: Track;
  clip?: Clip;
  media?: MediaAsset;
}

/** Base picture clip active at the playhead (clip may be undefined in gaps). */
export function baseClipAt(project: Project, head: number): MaybePlaced {
  const track = baseVideoTrack(project);
  if (!track) return {};
  const clip = track.clips.find((c) => c.kind !== 'text' && clipActiveAt(c, head));
  if (!clip) return { track };
  return { track, clip, media: mediaOf(project, clip) };
}

/** Topmost active non-text visual clip (any unmuted video track). */
export function topVisualAt(project: Project, head: number): MaybePlaced {
  const tracks = project.tracks ?? [];
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    if (t.kind !== 'video' || t.muted) continue;
    const clip = t.clips.find((c) => c.kind !== 'text' && clipActiveAt(c, head));
    if (clip) return { track: t, clip, media: mediaOf(project, clip) };
  }
  return {};
}

/**
 * Every active non-text picture clip on unmuted video tracks, bottom-to-top
 * (array order). Preview canvas and hit-testing both walk this list.
 */
export function visualLayersAt(project: Project, head: number): PlacedClip[] {
  const out: PlacedClip[] = [];
  for (const t of project.tracks ?? []) {
    if (t.kind !== 'video' || t.muted) continue;
    const clip = t.clips.find((c) => c.kind !== 'text' && clipActiveAt(c, head));
    if (clip) out.push({ track: t, clip, media: mediaOf(project, clip) });
  }
  return out;
}

/**
 * Video clips the preview decoder pool should keep mounted: live at `head`
 * or starting within `preloadSec`, including muted tracks (so the eye-toggle
 * does not remount and go black).
 */
export function videoDecodeClips(
  project: Project,
  head: number,
  preloadSec = 3,
): PlacedClip[] {
  const out: PlacedClip[] = [];
  for (const t of project.tracks ?? []) {
    if (t.kind !== 'video') continue;
    for (const c of t.clips) {
      if (c.kind === 'text') continue;
      const media = mediaOf(project, c);
      if (media?.kind !== 'video') continue;
      const live = clipActiveAt(c, head);
      const upcoming = c.startSec >= head && c.startSec - head < preloadSec;
      if (live || upcoming) out.push({ track: t, clip: c, media });
    }
  }
  return out;
}

/**
 * Live picture layers besides the base clip, partitioned relative to the
 * base track: `below`/`above` hold active non-text clips on the other
 * unmuted video tracks (bottom-to-top within each group). The hero clip
 * itself is excluded so it is never rendered twice.
 */
export function layerClipsAt(
  project: Project,
  head: number,
  heroTrackId?: string,
  heroClipId?: string,
): { below: PlacedClip[]; above: PlacedClip[] } {
  const tracks = project.tracks ?? [];
  const below: PlacedClip[] = [];
  const above: PlacedClip[] = [];
  let heroIdx = tracks.length;
  if (heroTrackId) {
    const i = tracks.findIndex((t) => t.id === heroTrackId);
    if (i >= 0) heroIdx = i;
  }
  tracks.forEach((t, i) => {
    if (t.muted || t.kind !== 'video' || t.id === heroTrackId) return;
    const clip = t.clips.find(
      (c) => c.kind !== 'text' && c.id !== heroClipId && clipActiveAt(c, head),
    );
    if (!clip) return;
    const layer = { track: t, clip, media: mediaOf(project, clip) };
    if (i < heroIdx) below.push(layer);
    else above.push(layer);
  });
  return { below, above };
}

/** Active clip per unmuted audio track (all mix together). */
export function audioClipsAt(project: Project, head: number): PlacedClip[] {
  const out: PlacedClip[] = [];
  for (const t of project.tracks ?? []) {
    if (t.kind !== 'audio' || t.muted) continue;
    const clip = t.clips.find((c) => clipActiveAt(c, head));
    if (clip) out.push({ track: t, clip, media: mediaOf(project, clip) });
  }
  return out;
}

/**
 * ALL active text clips (unmuted video tracks), bottom-track-first so later
 * DOM siblings paint on top — every text layer renders, not just the topmost.
 */
export function textClipsAt(project: Project, head: number): PlacedClip[] {
  const out: PlacedClip[] = [];
  for (const t of project.tracks ?? []) {
    if (t.kind !== 'video' || t.muted) continue;
    for (const clip of t.clips) {
      if (clip.kind === 'text' && clipActiveAt(clip, head)) out.push({ track: t, clip });
    }
  }
  return out;
}

/** ALL active non-text clips carrying subtitle text (stacked captions). */
export function subtitleClipsAt(project: Project, head: number): PlacedClip[] {
  const out: PlacedClip[] = [];
  for (const t of project.tracks ?? []) {
    if (t.muted) continue;
    for (const clip of t.clips) {
      if (clip.kind !== 'text' && clip.text && clipActiveAt(clip, head)) {
        out.push({ track: t, clip, media: mediaOf(project, clip) });
      }
    }
  }
  return out;
}

// ---------- whole-timeline selectors (export) ----------

/** Non-text clips on unmuted video tracks above the base (composited over it). */
export function allOverlayVideoClips(project: Project): Clip[] {
  const base = baseVideoTrack(project);
  return (project.tracks ?? [])
    .filter((t) => t.kind === 'video' && !t.muted && t.id !== base?.id)
    .flatMap((t) => t.clips)
    .filter((c) => c.kind !== 'text' && mediaOf(project, c))
    .sort((a, b) => a.startSec - b.startSec);
}

/** Non-text base picture clips (export renders these as full-canvas segments). */
export function allBaseVideoClips(project: Project): Clip[] {
  const base = baseVideoTrack(project);
  return base ? [...base.clips].sort((a, b) => a.startSec - b.startSec) : [];
}

export function allTextClips(project: Project): Clip[] {
  return (project.tracks ?? [])
    .filter((t) => t.kind === 'video' && !t.muted)
    .flatMap((t) => t.clips)
    .filter((c) => c.kind === 'text' && (c.text ?? '').trim().length > 0)
    .sort((a, b) => a.startSec - b.startSec);
}

export function allAudioTrackClips(project: Project): Clip[] {
  return (project.tracks ?? [])
    .filter((t) => t.kind === 'audio' && !t.muted)
    .flatMap((t) => t.clips)
    .sort((a, b) => a.startSec - b.startSec);
}

/** Latest end time across every clip on every track (muted or not). */
export function timelineEnd(project: Project): number {
  let end = 0;
  for (const t of project.tracks ?? [])
    for (const c of t.clips) end = Math.max(end, c.startSec + c.durationSec);
  return end;
}
