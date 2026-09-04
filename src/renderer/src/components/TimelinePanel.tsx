import React, { useMemo, useRef, useState } from 'react';
import { useEditor, op } from '../store';
import { formatTimecode } from '../time';
import type { Clip, Track, TrackKind } from '../../../shared/types';
import {
  IconUndo,
  IconRedo,
  IconSplit,
  IconTrash,
  IconRipple,
  IconPlus,
  IconMinus,
  IconVideo,
  IconAudio,
  IconImage,
  IconSubtitles,
  IconEye,
  IconEyeOff,
  IconSpeaker,
  IconSpeakerOff,
  IconLock,
  IconUnlock,
  IconClose,
} from './Icons';

import { resolveDropTarget } from '../../../shared/timeline';

interface DragState {
  clipId: string;
  mode: 'move' | 'l' | 'r';
  deltaSec: number;
  originalStartSec: number;
  originalDurationSec: number;
  targetTrackId: string;
  /** Lane the store will actually place the clip on (null = auto-creates a layer). */
  resolvedTrackId: string | null;
  isNewUpperLayer?: boolean;
  isNewLowerLayer?: boolean;
}

export default function TimelinePanel() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playheadSec);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const setZoom = useEditor((s) => s.setZoom);
  const selectedId = useEditor((s) => s.selectedClipId);
  const select = useEditor((s) => s.select);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);

  const [activeDrag, setActiveDrag] = useState<DragState | null>(null);
  const [snapTime, setSnapTime] = useState<number | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [willCreateLayer, setWillCreateLayer] = useState(false);
  const [isHoveringNewLayer, setIsHoveringNewLayer] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clip: Clip; track: Track } | null>(null);
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);

  const tracks = project?.tracks ?? [];
  // Display order: top video layer first (array end = foreground), then audio.
  // DOM order no longer matches array order — always map lanes via data-track-id.
  const displayTracks = useMemo(() => {
    const video = tracks.filter((t) => t.kind === 'video').reverse();
    const audio = tracks.filter((t) => t.kind === 'audio');
    return [...video, ...audio];
  }, [tracks]);
  // Legacy same-track overlaps (the store now auto-layers instead): flag them red.
  const overlapIds = useMemo(() => {
    const bad = new Set<string>();
    for (const t of tracks) {
      const cs = [...t.clips].sort((a, b) => a.startSec - b.startSec);
      for (let i = 1; i < cs.length; i++) {
        if (cs[i].startSec < cs[i - 1].startSec + cs[i - 1].durationSec - 1e-6) {
          bad.add(cs[i].id);
          bad.add(cs[i - 1].id);
        }
      }
    }
    return bad;
  }, [tracks]);
  const duration = Math.max(
    30,
    ...tracks.flatMap((t) => t.clips.map((c) => c.startSec + c.durationSec + 10)),
  );
  const width = duration * pxPerSec;

  const secFromEvent = (e: React.MouseEvent | React.DragEvent): number => {
    const scroller = scrollRef.current;
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left + scroller.scrollLeft) / pxPerSec);
  };

  // Edge auto-scroll: when the pointer nears the scroll viewport edges,
  // pan so the user can drag/scrub beyond the visible area. Returns nothing;
  // callers re-read scroll offsets afterwards.
  const autoScroll = (clientX: number, clientY?: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const margin = 28;
    const step = 26;
    if (clientX < rect.left + margin) scroller.scrollLeft -= step;
    else if (clientX > rect.right - margin) scroller.scrollLeft += step;
    if (clientY !== undefined) {
      if (clientY < rect.top + margin) scroller.scrollTop -= step;
      else if (clientY > rect.bottom - margin) scroller.scrollTop += step;
    }
  };

  // Live drag/trim geometry for a clip (shared by the clip and its ghost).
  const liveGeom = (c: Clip): { start: number; dur: number } => {
    let s = c.startSec;
    let d = c.durationSec;
    if (activeDrag && activeDrag.clipId === c.id) {
      if (activeDrag.mode === 'move') {
        s = Math.max(0, c.startSec + activeDrag.deltaSec);
      } else if (activeDrag.mode === 'l') {
        s = Math.max(0, c.startSec + activeDrag.deltaSec);
        d = Math.max(0.1, c.durationSec - activeDrag.deltaSec);
      } else if (activeDrag.mode === 'r') {
        d = Math.max(0.1, c.durationSec + activeDrag.deltaSec);
      }
    }
    return { start: s, dur: d };
  };
  const draggedClip: Clip | null = activeDrag
    ? (tracks.flatMap((t) => t.clips).find((c) => c.id === activeDrag.clipId) ?? null)
    : null;
  const draggedKind: TrackKind | undefined = draggedClip
    ? tracks.find((tr) => tr.clips.some((c) => c.id === draggedClip.id))?.kind
    : undefined;

  const getSnapTargets = (excludeClipId?: string): number[] => {
    const targets = new Set<number>([0, playhead]);
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.id === excludeClipId) continue;
        targets.add(c.startSec);
        targets.add(c.startSec + c.durationSec);
      }
    }
    return Array.from(targets);
  };

  const splitAtPlayhead = () => {
    let targetClipId = selectedId;
    if (!targetClipId) {
      for (const t of tracks) {
        const found = t.clips.find((c) => playhead > c.startSec && playhead < c.startSec + c.durationSec);
        if (found) {
          targetClipId = found.id;
          break;
        }
      }
    }
    if (targetClipId) {
      op({ op: 'timeline:splitClip', clipId: targetClipId, atSec: playhead });
    }
  };

  const deleteSelected = (ripple = false) => {
    if (selectedId) {
      op({ op: 'timeline:deleteClip', clipId: selectedId, ripple });
      select(null);
    }
  };

  const moveLayer = (clip: Clip, dir: 1 | -1) =>
    op({ op: 'timeline:reorderClip', clipId: clip.id, direction: dir });

  const setClipStack = (clip: Clip, position: 'front' | 'back') =>
    op({ op: 'timeline:reorderClip', clipId: clip.id, position });

  // Track stacking reshuffle: array order = bottom-to-top for video.
  // Display is reversed for video (top = foreground), in-order for audio.
  const moveTrackDisplay = async (track: Track, dirDisplay: -1 | 1) => {
    const same = tracks.filter((t) => t.kind === track.kind);
    const curPos = same.findIndex((t) => t.id === track.id);
    if (curPos < 0) return;
    const dispPos = track.kind === 'video' ? same.length - 1 - curPos : curPos;
    const nextDisp = dispPos + dirDisplay;
    if (nextDisp < 0 || nextDisp >= same.length) return;
    const nextPos = track.kind === 'video' ? same.length - 1 - nextDisp : nextDisp;
    await op({ op: 'track:move', trackId: track.id, toIndex: nextPos });
  };

  const dropTrackOnto = async (dragId: string, overId: string) => {
    if (dragId === overId) return;
    const drag = tracks.find((t) => t.id === dragId);
    const over = tracks.find((t) => t.id === overId);
    if (!drag || !over || drag.kind !== over.kind) return;
    const same = tracks.filter((t) => t.kind === drag.kind);
    const overPos = same.findIndex((t) => t.id === overId);
    if (overPos < 0) return;
    await op({ op: 'track:move', trackId: dragId, toIndex: overPos });
  };

  const onClipPointerDown = (
    e: React.PointerEvent,
    clip: Clip,
    sourceTrack: Track,
    mode: 'move' | 'l' | 'r',
  ) => {
    if (sourceTrack.locked) return;
    e.stopPropagation();
    select(clip.id);

    let currentDelta = 0;
    let currentTargetTrackId = sourceTrack.id;
    let currentResolvedId: string | null = sourceTrack.id;
    let isNewLayer = false;
    let newLayerEdge: 'front' | 'back' = 'front';

    setActiveDrag({
      clipId: clip.id,
      mode,
      deltaSec: 0,
      originalStartSec: clip.startSec,
      originalDurationSec: clip.durationSec,
      targetTrackId: sourceTrack.id,
      resolvedTrackId: sourceTrack.id,
      isNewUpperLayer: false,
      isNewLowerLayer: false,
    });

    const snapTargets = getSnapTargets(clip.id);
    const snapDist = 8 / pxPerSec;

    // Trim bounds mirror the store clamp (trimClip, speed-aware) so the live
    // preview never over-extends and snaps back on release.
    const trimMedia = project?.media.find((m) => m.id === clip.mediaId);
    const trimSpeed = Number.isFinite(clip.speed) && (clip.speed as number) > 0 ? (clip.speed as number) : 1;
    const sibs = [...sourceTrack.clips].sort((a, b) => a.startSec - b.startSec);
    const sIdx = sibs.findIndex((c) => c.id === clip.id);
    const sibPrevEnd = sIdx > 0 ? sibs[sIdx - 1].startSec + sibs[sIdx - 1].durationSec : 0;
    const sibNextStart = sIdx >= 0 && sIdx < sibs.length - 1 ? sibs[sIdx + 1].startSec : Number.POSITIVE_INFINITY;
    const clampTrimDelta = (d: number): number => {
      if (mode === 'l') {
        // Stills (image/text) have no source in-point limit: extend freely
        // to the previous sibling. Video/audio clamp at the source start.
        const isStill = clip.kind === 'image' || clip.kind === 'text' || trimMedia?.kind === 'image';
        const lo = isStill
          ? sibPrevEnd - clip.startSec
          : Math.max(-clip.inSec / trimSpeed, sibPrevEnd - clip.startSec);
        return Math.max(lo, Math.min(d, clip.durationSec - 0.1));
      }
      if (mode === 'r') {
        const maxSource = trimMedia && trimMedia.kind !== 'image'
          ? (trimMedia.durationSec - clip.inSec) / trimSpeed
          : Number.POSITIVE_INFINITY;
        const hi = Math.min(maxSource, sibNextStart - clip.startSec) - clip.durationSec;
        return Math.max(0.1 - clip.durationSec, Math.min(d, hi));
      }
      return d;
    };

    // Absolute timeline time under a clientX (scroll-aware).
    const secAt = (clientX: number): number => {
      const scroller = scrollRef.current;
      if (!scroller) return 0;
      const rect = scroller.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left + scroller.scrollLeft) / pxPerSec);
    };
    // Grab anchors: the drag follows the content under the cursor (not raw
    // clientX deltas), so pans and scrolls never detach the clip mid-drag.
    const grabSec = secAt(e.clientX);
    const grabOffset = grabSec - clip.startSec; // move/l: within-clip grab point
    const grabEndOffset = clip.startSec + clip.durationSec - grabSec; // r: distance to end edge
    const lastPointer = { x: e.clientX, y: e.clientY };

    // Lane hit-test shared by pointer moves and the auto-scroll tick.
    const laneAt = (clientY: number): { targetId: string; isNew: boolean; edge?: 'front' | 'back' } => {
      if (!lanesRef.current) return { targetId: currentTargetTrackId, isNew: false };
      const lanes = Array.from(lanesRef.current.querySelectorAll('[data-track-id]')) as HTMLElement[];
      const sameLanes = lanes.filter((lane) => {
        const t = tracks.find((tr) => tr.id === lane.dataset.trackId);
        return t && t.kind === sourceTrack.kind && !t.locked;
      });
      if (sameLanes.length > 0) {
        const first = sameLanes[0].getBoundingClientRect();
        const last = sameLanes[sameLanes.length - 1].getBoundingClientRect();
        // Past the visually-top same-kind lane: new front layer.
        if (clientY < first.top) return { targetId: currentTargetTrackId, isNew: true, edge: 'front' };
        // Past the visually-bottom same-kind lane: new back layer.
        if (clientY > last.bottom) return { targetId: currentTargetTrackId, isNew: true, edge: 'back' };
      }
      for (const lane of lanes) {
        const r = lane.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          const t = tracks.find((tr) => tr.id === lane.dataset.trackId);
          if (t && t.kind === sourceTrack.kind && !t.locked) return { targetId: t.id, isNew: false };
          break;
        }
      }
      return { targetId: currentTargetTrackId, isNew: false };
    };

    const applyLane = (lane: { targetId: string; isNew: boolean; edge?: 'front' | 'back' }): void => {
      isNewLayer = lane.isNew;
      if (lane.edge) newLayerEdge = lane.edge;
      if (!lane.isNew) currentTargetTrackId = lane.targetId;
    };

    const resolveCurrent = (start: number): void => {
      if (isNewLayer) {
        currentResolvedId = null;
        return;
      }
      // Explicit lane targeting: land on the hovered layer even when it is
      // occupied (the store swaps or inserts instead of bouncing away).
      if (currentTargetTrackId !== sourceTrack.id) {
        currentResolvedId = currentTargetTrackId;
        return;
      }
      const proj = useEditor.getState().project;
      if (!proj) {
        currentResolvedId = currentTargetTrackId;
        return;
      }
      const r = resolveDropTarget(proj, sourceTrack.kind, start, clip.durationSec, currentTargetTrackId, clip.id);
      currentResolvedId = r ? r.id : null;
    };

    const pushDragState = (delta: number): void => {
      setActiveDrag({
        clipId: clip.id,
        mode,
        deltaSec: delta,
        originalStartSec: clip.startSec,
        originalDurationSec: clip.durationSec,
        targetTrackId: currentTargetTrackId,
        resolvedTrackId: currentResolvedId,
        isNewUpperLayer: isNewLayer && newLayerEdge === 'front',
        isNewLowerLayer: isNewLayer && newLayerEdge === 'back',
      });
    };

    // Continuous edge auto-scroll: pointermove stops firing when the pointer
    // is parked (but still held) in the scroll margin, so without this tick
    // long extends/moves stall at the viewport edge and need re-grabbing.
    // The tick pans and re-derives the drag from the pointer position, so an
    // extend runs uninterrupted all the way to the source end (or any lane).
    const scrollTimer = window.setInterval(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const MARGIN = 28;
      const STEP = 30;
      let dx = 0;
      let dy = 0;
      if (lastPointer.x < rect.left + MARGIN) dx = -STEP;
      else if (lastPointer.x > rect.right - MARGIN) dx = STEP;
      if (mode === 'move') {
        if (lastPointer.y < rect.top + MARGIN) dy = -STEP;
        else if (lastPointer.y > rect.bottom - MARGIN) dy = STEP;
      }
      if (dx === 0 && dy === 0) return;
      scroller.scrollLeft += dx;
      scroller.scrollTop += dy;
      const secNow = secAt(lastPointer.x);
      if (mode === 'r') {
        currentDelta = clampTrimDelta(secNow + grabEndOffset - (clip.startSec + clip.durationSec));
      } else {
        // move/l: the grabbed point tracks the pointer.
        let d = secNow - grabOffset - clip.startSec;
        d = mode === 'move' ? Math.max(-clip.startSec, d) : clampTrimDelta(d);
        currentDelta = d;
        if (mode === 'move') {
          applyLane(laneAt(lastPointer.y));
          resolveCurrent(Math.max(0, clip.startSec + currentDelta));
        }
      }
      setSnapTime(null);
      pushDragState(currentDelta);
    }, 50);

    const onMove = (ev: PointerEvent) => {
      lastPointer.x = ev.clientX;
      lastPointer.y = ev.clientY;
      // Absolute pointer time: unlike clientX deltas this stays glued to the
      // content under the cursor across auto-scrolls (no detach while panning).
      let effectiveDelta = secAt(ev.clientX) - grabSec;
      let matchedSnap: number | null = null;

      if (mode === 'move') {
        autoScroll(ev.clientX, ev.clientY);
        const candidateStart = Math.max(0, clip.startSec + effectiveDelta);
        const candidateEnd = candidateStart + clip.durationSec;
        for (const target of snapTargets) {
          if (Math.abs(candidateStart - target) < snapDist) {
            effectiveDelta = target - clip.startSec;
            matchedSnap = target;
            break;
          }
          if (Math.abs(candidateEnd - target) < snapDist) {
            effectiveDelta = target - clip.durationSec - clip.startSec;
            matchedSnap = target;
            break;
          }
        }
        effectiveDelta = Math.max(-clip.startSec, effectiveDelta);

        // Hovered lane, or past the stack edge for a new front/back layer.
        applyLane(laneAt(ev.clientY));
      } else if (mode === 'l') {
        autoScroll(ev.clientX);
        const candidateStart = clip.startSec + effectiveDelta;
        for (const target of snapTargets) {
          if (Math.abs(candidateStart - target) < snapDist) {
            effectiveDelta = target - clip.startSec;
            matchedSnap = target;
            break;
          }
        }
        effectiveDelta = clampTrimDelta(effectiveDelta);
      } else if (mode === 'r') {
        autoScroll(ev.clientX);
        const candidateEnd = clip.startSec + clip.durationSec + effectiveDelta;
        for (const target of snapTargets) {
          if (Math.abs(candidateEnd - target) < snapDist) {
            effectiveDelta = target - (clip.startSec + clip.durationSec);
            matchedSnap = target;
            break;
          }
        }
        effectiveDelta = clampTrimDelta(effectiveDelta);
      }

      setSnapTime(matchedSnap);
      currentDelta = effectiveDelta;
      if (mode === 'move') {
        // Resolve the landing lane live (same rule as the store): the ghost
        // follows where the clip will actually land, not just the hover.
        resolveCurrent(Math.max(0, clip.startSec + currentDelta));
      }
      pushDragState(effectiveDelta);
    };

    const onUp = async () => {
      finishDrag();
      setActiveDrag(null);
      setSnapTime(null);

      if (mode === 'move') {
        const newStart = Math.max(0, clip.startSec + currentDelta);

        if (isNewLayer || currentResolvedId === null) {
          // Past the stack edge: insert a new front or back layer and land on it.
          const atIndex =
            (newLayerEdge === 'back' && sourceTrack.kind === 'video') ||
            (newLayerEdge === 'front' && sourceTrack.kind === 'audio')
              ? 0
              : undefined;
          const r = await op({ op: 'track:add', kind: sourceTrack.kind, atIndex });
          if (r.ok && r.data) {
            const newTrack = r.data as Track;
            await op({
              op: 'timeline:moveClip',
              clipId: clip.id,
              startSec: newStart,
              trackId: newTrack.id,
              place: 'layer',
            });
          }
        } else if (Math.abs(newStart - clip.startSec) > 0.01 || currentResolvedId !== sourceTrack.id) {
          await op({
            op: 'timeline:moveClip',
            clipId: clip.id,
            startSec: newStart,
            trackId: currentResolvedId,
            place: currentResolvedId !== sourceTrack.id ? 'layer' : 'auto',
          });
        }
      } else {
        if (Math.abs(currentDelta) > 0.01) {
          await op({
            op: 'timeline:trimClip',
            clipId: clip.id,
            edge: mode === 'l' ? 'in' : 'out',
            deltaSec: currentDelta,
          });
        }
      }
    };

    // Interrupted gestures (touch cancel, window blur, alerts) revert the
    // drag instead of committing a half-finished jump or wedging the ghost.
    const onAbort = () => {
      finishDrag();
      setActiveDrag(null);
      setSnapTime(null);
    };

    const finishDrag = () => {
      window.clearInterval(scrollTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onAbort);
      window.removeEventListener('blur', onAbort);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onAbort);
    window.addEventListener('blur', onAbort);
  };

  // Client mirror of the store's layer rule: two clips on the same track
  // never overlap. Prefer the hovered track when the range is free, else the
  // first unlocked track with room, else create a new layer track.
  const trackHasRoom = (t: Track, start: number, dur: number): boolean =>
    !t.clips.some(
      (c) => start < c.startSec + c.durationSec - 1e-6 && c.startSec < start + dur - 1e-6,
    );

  const findRoomTrack = async (
    kind: TrackKind,
    start: number,
    dur: number,
    preferredTrack?: Track,
  ): Promise<string> => {
    if (
      preferredTrack && preferredTrack.kind === kind && !preferredTrack.locked &&
      trackHasRoom(preferredTrack, start, dur)
    ) {
      return preferredTrack.id;
    }
    const free = tracks.find((t) => t.kind === kind && !t.locked && trackHasRoom(t, start, dur));
    if (free) return free.id;
    const r = await op({ op: 'track:add', kind });
    if (r.ok && r.data) return (r.data as Track).id;
    return tracks[0]?.id ?? '';
  };

  // "Will create layer" hint while dragging over an occupied lane region.
  const updateLayerHint = (t: Track, e: React.DragEvent) => {
    const probe = secFromEvent(e);
    setWillCreateLayer(t.clips.some((c) => probe >= c.startSec && probe < c.startSec + c.durationSec));
  };

  const handleTrackDrop = async (e: React.DragEvent, targetTrack?: Track, forceNewLayer = false) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTrackId(null);
    setWillCreateLayer(false);
    setIsHoveringNewLayer(false);
    setPreviewMode('timeline');

    const startSec = secFromEvent(e);

    // 1) From Library (single id, or JSON array for multi-drag)
    const rawMedia = e.dataTransfer.getData('application/x-taxicut-media');
    if (rawMedia) {
      let ids: string[] = [];
      try {
        const parsed: unknown = JSON.parse(rawMedia);
        ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [rawMedia];
      } catch {
        ids = [rawMedia];
      }
      // Chain multiple items end-to-end (video and audio chains separately).
      let curV = startSec;
      let curA = startSec;
      for (const mediaId of ids) {
        const asset = project?.media.find((m) => m.id === mediaId);
        if (!asset) continue;
        const kind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
        const dur = asset.kind === 'image' ? 5 : asset.durationSec || 5;
        const at = kind === 'audio' ? curA : curV;
        let destTrackId = targetTrack?.id;
        if (forceNewLayer) {
          const r = await op({ op: 'track:add', kind });
          if (r.ok && r.data) destTrackId = (r.data as Track).id;
        } else {
          destTrackId = await findRoomTrack(kind, at, dur, targetTrack);
        }
        await op({ op: 'timeline:addClip', mediaId, trackId: destTrackId, startSec: at });
        if (kind === 'audio') curA += dur;
        else curV += dur;
      }
      return;
    }

    // 2) From OS file drop (Finder / Desktop)
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const paths = files
        .map((f) => window.taxicut.getPathForFile(f))
        .filter((p): p is string => Boolean(p && p.length > 0));

      if (paths.length > 0) {
        const r = await op({ op: 'media:import', paths });
        if (r.ok && Array.isArray(r.data)) {
          let curStart = startSec;
          for (const asset of r.data as { id: string; kind: 'video' | 'audio' | 'image'; durationSec: number }[]) {
            const kind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
            const dur = asset.kind === 'image' ? 5 : asset.durationSec || 5;
            let destTrackId: string;
            if (forceNewLayer) {
              const tr = await op({ op: 'track:add', kind });
              destTrackId = tr.ok && tr.data ? (tr.data as Track).id : await findRoomTrack(kind, curStart, dur, targetTrack);
            } else {
              destTrackId = await findRoomTrack(kind, curStart, dur, targetTrack);
            }
            await op({ op: 'timeline:addClip', mediaId: asset.id, trackId: destTrackId, startSec: curStart });
            curStart += dur;
          }
        }
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
      deleteSelected(e.shiftKey);
    }
  };

  const rulerTicks: number[] = [];
  const step = pxPerSec > 90 ? 1 : pxPerSec > 45 ? 2 : pxPerSec > 20 ? 5 : 10;
  for (let t = 0; t <= duration; t += step) rulerTicks.push(t);

  return (
    <div
      className="timeline"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={() => setContextMenu(null)}
    >
      <div className="timeline-toolbar">
        <button className="icon" onClick={() => op({ op: 'history:undo' })} title="Undo (Cmd+Z)">
          <IconUndo size={13} />
        </button>
        <button className="icon" onClick={() => op({ op: 'history:redo' })} title="Redo (Cmd+Shift+Z)">
          <IconRedo size={13} />
        </button>
        <span style={{ width: 8 }} />
        <button
          className="icon"
          onClick={splitAtPlayhead}
          title="Split clip at playhead (Cmd+B / S)"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconSplit size={13} /> Split
        </button>
        <button
          className="icon"
          onClick={() => deleteSelected(false)}
          disabled={!selectedId}
          title="Delete selected clip (Backspace)"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconTrash size={13} /> Delete
        </button>
        <button
          className="icon"
          onClick={() => deleteSelected(true)}
          disabled={!selectedId}
          title="Ripple delete selected clip (Shift+Backspace)"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconRipple size={13} /> Ripple
        </button>
        <span style={{ width: 8 }} />
        <button
          className="icon"
          onClick={() => op({ op: 'track:add', kind: 'video' })}
          title="Add video layer track"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconPlus size={11} /> <IconVideo size={12} /> Video
        </button>
        <button
          className="icon"
          onClick={() => op({ op: 'track:add', kind: 'audio' })}
          title="Add audio track"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconPlus size={11} /> <IconAudio size={12} /> Audio
        </button>
        <button
          className="icon"
          onClick={async () => {
            const r = await op({ op: 'timeline:addClip', mediaId: 'text', startSec: playhead });
            if (r.ok && r.data) select((r.data as Clip).id);
            else if (!r.ok) alert(r.error);
          }}
          title="Add text overlay at playhead"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconPlus size={11} /> <IconSubtitles size={12} /> Text
        </button>
        <div className="right">
          <button className="icon" onClick={() => setZoom(Math.max(10, pxPerSec - 15))} title="Zoom out">
            <IconMinus size={13} />
          </button>
          <input
            type="range"
            min={10}
            max={200}
            value={pxPerSec}
            onChange={(e) => setZoom(Number(e.target.value))}
            title="Timeline Zoom"
            style={{ accentColor: 'var(--accent)', width: 100 }}
          />
          <button className="icon" onClick={() => setZoom(Math.min(200, pxPerSec + 15))} title="Zoom in">
            <IconPlus size={13} />
          </button>
        </div>
      </div>

      <div className="timeline-body">
        <div className="track-headers" ref={headersRef}>
          <div style={{ height: 22, borderBottom: '1px solid var(--border)' }} />
          {/* Header row for upper new layer indicator if dragging */}
          {(activeDrag?.isNewUpperLayer || (activeDrag?.resolvedTrackId === null && !activeDrag?.isNewLowerLayer) || isHoveringNewLayer) && (
            <div className="track-header new-layer-header">
              + New top layer
            </div>
          )}
          {displayTracks.map((t, i) => {
            const siblings = t.kind === 'video'
              ? tracks.filter((x) => x.kind === 'video')
              : tracks.filter((x) => x.kind === 'audio');
            const num = siblings.findIndex((x) => x.id === t.id) + 1;
            const chip = `${t.kind === 'video' ? 'V' : 'A'}${num}`;
            const sameLen = siblings.length;
            const dispIdx = t.kind === 'video'
              ? sameLen - 1 - siblings.findIndex((x) => x.id === t.id)
              : siblings.findIndex((x) => x.id === t.id);
            const canUp = dispIdx > 0;
            const canDown = dispIdx < sameLen - 1;
            const layerTip = t.kind !== 'video'
              ? `${t.name} · audio layer — drag the grip to reshuffle`
              : siblings.findIndex((x) => x.id === t.id) === siblings.length - 1
                ? `${t.name} · top video layer (foreground) — drag the grip to reshuffle`
                : `${t.name} · video layer below ${siblings[siblings.findIndex((x) => x.id === t.id) + 1]?.name} — drag the grip to reshuffle`;
            const showLowerHint = !!activeDrag?.isNewLowerLayer &&
              t.kind === draggedKind && displayTracks[i + 1]?.kind !== t.kind;
            const startTrackDrag = (e: React.DragEvent) => {
              e.dataTransfer.setData('application/x-taxicut-track', t.id);
              e.dataTransfer.effectAllowed = 'move';
              setDragTrackId(t.id);
              const header = (e.currentTarget as HTMLElement).closest('.track-header');
              if (header) e.dataTransfer.setDragImage(header, 16, 16);
            };
            return (
            <React.Fragment key={t.id}>
            <div
              className={`track-header${dropTrackId === t.id ? ' drop-track' : ''}${dragTrackId === t.id ? ' dragging-track' : ''}`}
              title={layerTip}
              onDragOver={(e) => {
                const drag = tracks.find((x) => x.id === dragTrackId);
                if (!drag || drag.kind !== t.kind || drag.id === t.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dropTrackId !== t.id) setDropTrackId(t.id);
              }}
              onDragLeave={() => {
                if (dropTrackId === t.id) setDropTrackId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragTrackId || e.dataTransfer.getData('application/x-taxicut-track');
                setDragTrackId(null);
                setDropTrackId(null);
                if (id) dropTrackOnto(id, t.id);
              }}
              onDragEnd={() => {
                setDragTrackId(null);
                setDropTrackId(null);
              }}
            >
              <span
                className="track-drag-grip"
                title="Drag to reshuffle track order"
                draggable
                onDragStart={startTrackDrag}
              >
                ⋮⋮
              </span>
              <span className={`track-kind-chip ${t.kind}`}>{chip}</span>
              {t.name !== chip && <b className="track-name">{t.name}</b>}
              <div className="track-layer-btns">
                <button
                  className="track-action-btn"
                  disabled={!canUp}
                  draggable={false}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => moveTrackDisplay(t, -1)}
                  title={t.kind === 'video' ? 'Move layer up (toward foreground)' : 'Move track up'}
                >
                  ↑
                </button>
                <button
                  className="track-action-btn"
                  disabled={!canDown}
                  draggable={false}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => moveTrackDisplay(t, 1)}
                  title={t.kind === 'video' ? 'Move layer down (toward background)' : 'Move track down'}
                >
                  ↓
                </button>
              </div>
              <div className="track-actions">
                <button
                  className={`track-action-btn ${t.muted ? 'active' : ''}`}
                  draggable={false}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => op({ op: 'track:setMute', trackId: t.id, muted: !t.muted })}
                  title={t.kind === 'audio'
                    ? (t.muted ? 'Unmute track audio' : 'Mute track audio')
                    : (t.muted ? 'Show track' : 'Hide track picture (and its audio)')}
                >
                  {t.kind === 'audio' ? (
                    t.muted ? <IconSpeakerOff size={12} /> : <IconSpeaker size={12} />
                  ) : (
                    t.muted ? <IconEyeOff size={12} /> : <IconEye size={12} />
                  )}
                </button>
                {t.kind === 'video' && (() => {
                  const sounding = t.clips.filter((c) =>
                    c.kind !== 'text' &&
                    (c.kind === 'audio' || project?.media.find((m) => m.id === c.mediaId)?.hasAudio),
                  );
                  const allMuted = sounding.length > 0 && sounding.every((c) => c.audioMuted);
                  return (
                    <button
                      className={`track-action-btn ${allMuted ? 'active' : ''}`}
                      draggable={false}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => op({ op: 'track:setAudioMute', trackId: t.id, muted: !allMuted })}
                      title={allMuted ? 'Unmute track audio (picture stays)' : 'Mute track audio (picture stays)'}
                    >
                      {allMuted ? <IconSpeakerOff size={12} /> : <IconSpeaker size={12} />}
                    </button>
                  );
                })()}
                <button
                  className={`track-action-btn ${t.locked ? 'active' : ''}`}
                  draggable={false}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => op({ op: 'track:setLock', trackId: t.id, locked: !t.locked })}
                  title={t.locked ? 'Unlock track' : 'Lock track'}
                >
                  {t.locked ? <IconLock size={12} /> : <IconUnlock size={12} />}
                </button>
                {tracks.length > 1 && (
                  <button
                    className="track-action-btn delete"
                    draggable={false}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      if (t.clips.length === 0 || confirm(`Delete track ${t.name} and its clips?`)) {
                        op({ op: 'track:delete', trackId: t.id });
                      }
                    }}
                    title={`Delete track ${t.name}`}
                  >
                    <IconClose size={11} />
                  </button>
                )}
              </div>
            </div>
            {showLowerHint && (
              <div className="track-header new-layer-header">+ New bottom layer</div>
            )}
            </React.Fragment>
            );
          })}
        </div>

        <div
          className="tracks-scroll"
          ref={scrollRef}
          onScroll={() => {
            if (headersRef.current && scrollRef.current) {
              headersRef.current.scrollTop = scrollRef.current.scrollTop;
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => handleTrackDrop(e)}
        >
          <div className="tracks-inner" style={{ width, minWidth: '100%' }}>
            <div
              className="ruler"
                onMouseDown={(e) => {
                setPreviewMode('timeline');
                setPlayhead(secFromEvent(e));
                const onMove = (ev: MouseEvent) => {
                  const scroller = scrollRef.current;
                  if (!scroller) return;
                  autoScroll(ev.clientX);
                  const rect = scroller.getBoundingClientRect();
                  setPlayhead(Math.max(0, (ev.clientX - rect.left + scroller.scrollLeft) / pxPerSec));
                };
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            >
              {rulerTicks.map((t) => (
                <div key={t} className="ruler-tick" style={{ left: t * pxPerSec }}>
                  {t % (step * 2) === 0 ? formatTimecode(t).slice(3) : ''}
                </div>
              ))}
            </div>

            {/* Drop zone above tracks to auto-create a new layer */}
            {(activeDrag?.isNewUpperLayer || (activeDrag?.resolvedTrackId === null && !activeDrag?.isNewLowerLayer) || isHoveringNewLayer) && (
              <div
                className={`new-layer-drop-zone ${(activeDrag?.isNewUpperLayer || (activeDrag?.resolvedTrackId === null && !activeDrag?.isNewLowerLayer)) || isHoveringNewLayer ? 'active' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsHoveringNewLayer(true);
                }}
                onDragLeave={() => setIsHoveringNewLayer(false)}
                onDrop={(e) => handleTrackDrop(e, undefined, true)}
              >
                + Drop to create new top layer
              </div>
            )}

            <div ref={lanesRef}>
              {displayTracks.map((t, i) => {
                const isDragTarget = activeDrag?.targetTrackId === t.id;
                const isResolvedLane = activeDrag?.mode === 'move' && activeDrag.resolvedTrackId === t.id;
                const showLowerZone = !!activeDrag?.isNewLowerLayer &&
                  t.kind === draggedKind && displayTracks[i + 1]?.kind !== t.kind;

                return (
                  <React.Fragment key={t.id}>
                  <div
                    className={`track-lane ${t.kind} ${dragOverTrackId === t.id || activeDrag?.targetTrackId === t.id ? 'drag-over' : ''} ${isResolvedLane ? 'drop-target' : ''}`}
                    data-track-id={t.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverTrackId(t.id);
                      updateLayerHint(t, e);
                    }}
                    onDragLeave={() => {
                      setDragOverTrackId(null);
                      setWillCreateLayer(false);
                    }}
                    onDrop={(e) => handleTrackDrop(e, t)}
                  >
                    {dragOverTrackId === t.id && willCreateLayer && !activeDrag && (
                      <span className="layer-will-create">＋ new layer (occupied)</span>
                    )}
                    {activeDrag?.mode === 'move' && dragOverTrackId === t.id && isDragTarget &&
                      !isResolvedLane && activeDrag.resolvedTrackId !== undefined && (() => {
                        const r = activeDrag.resolvedTrackId
                          ? tracks.find((x) => x.id === activeDrag.resolvedTrackId)
                          : null;
                        return (
                          <span className="layer-will-create">
                            {r ? `→ lands on ${r.name} (occupied)` : '＋ new layer (occupied)'}
                          </span>
                        );
                      })()}
                    {t.clips.map((c) => {
                      const media = project?.media.find((m) => m.id === c.mediaId);
                      const thumbUrl = media?.thumbnailPath ? window.taxicut.mediaUrl(media.thumbnailPath) : null;
                      const imageUrl = media?.kind === 'image' ? window.taxicut.mediaUrl(media.path) : null;
                      const previewUrl = thumbUrl || imageUrl;

                      // Live coordinates while dragging/trimming.
                      const { start: liveStart, dur: liveDur } = liveGeom(c);

                      const clipWidth = Math.max(6, liveDur * pxPerSec);
                      const frameCount = Math.min(30, Math.max(1, Math.floor(clipWidth / 75)));

                      return (
                        <div
                          key={c.id}
                          className={`clip ${c.kind} ${c.id === selectedId ? 'selected' : ''} ${overlapIds.has(c.id) ? 'overlap' : ''}`}
                          style={{
                            left: liveStart * pxPerSec,
                            width: clipWidth,
                            opacity: t.locked ? 0.6 : 1,
                          }}
                          title={overlapIds.has(c.id)
                            ? `${c.name} (${formatTimecode(c.durationSec).slice(3)}) — overlaps a sibling; drag it to a free layer`
                            : `${c.name} (${formatTimecode(c.durationSec).slice(3)})`}
                          onPointerDown={(e) => onClipPointerDown(e, c, t, 'move')}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            select(c.id);
                            setContextMenu({ x: e.clientX, y: e.clientY, clip: c, track: t });
                          }}
                        >
                          {/* Video/Image Filmstrip Frame Previews */}
                          {previewUrl && (
                            <div className="clip-filmstrip">
                              {Array.from({ length: frameCount }).map((_, idx) => (
                                <div
                                  key={idx}
                                  className="clip-frame"
                                  style={{
                                    backgroundImage: `url("${previewUrl}")`,
                                  }}
                                />
                              ))}
                            </div>
                          )}

                          {/* Audio Waveform Effect */}
                          {t.kind === 'audio' && (
                            <div className="clip-waveform">
                              {Array.from({ length: Math.min(50, Math.max(4, Math.floor(clipWidth / 10))) }).map((_, idx) => {
                                const h = 25 + ((idx * 37 + 19) % 60);
                                return <div key={idx} className="wave-bar" style={{ height: `${h}%` }} />;
                              })}
                            </div>
                          )}

                          {!t.locked && (
                            <div
                              className="handle l"
                              onPointerDown={(e) => onClipPointerDown(e, c, t, 'l')}
                              title="Trim Start"
                            />
                          )}

                          {/* Clip Header Badge */}
                          <div className="clip-badge">
                            {c.text ? (
                              <IconSubtitles size={10} />
                            ) : t.kind === 'audio' ? (
                              <IconAudio size={10} />
                            ) : media?.kind === 'image' ? (
                              <IconImage size={10} />
                            ) : (
                              <IconVideo size={10} />
                            )}
                            <span className="clip-title">{c.text ?? c.name}</span>
                            <span className="clip-dur">{formatTimecode(c.durationSec).slice(3)}</span>
                          </div>

                          {!t.locked && (
                            <div
                              className="handle r"
                              onPointerDown={(e) => onClipPointerDown(e, c, t, 'r')}
                              title="Trim End"
                            />
                          )}
                        </div>
                      );
                    })}
                    {/* Ghost: where the dragged clip will land (resolved lane — the
                        store auto-layers onto it when the hovered range is busy). */}
                    {activeDrag?.mode === 'move' && activeDrag.resolvedTrackId === t.id && draggedClip &&
                      !t.clips.some((c) => c.id === draggedClip.id) && (() => {
                        const g = liveGeom(draggedClip);
                        return (
                          <div
                            className={`clip ghost ${draggedClip.kind}`}
                            style={{ left: g.start * pxPerSec, width: Math.max(6, g.dur * pxPerSec) }}
                          >
                            <span className="clip-title">{draggedClip.text ?? draggedClip.name}</span>
                          </div>
                        );
                      })()}
                  </div>
                  {showLowerZone && (
                    <div className="new-layer-drop-zone active">+ Drop to create new bottom layer</div>
                  )}
                  </React.Fragment>
                );
              })}
            </div>

            {/* Snap visual guide line */}
            {snapTime !== null && (
              <div className="snap-line" style={{ left: snapTime * pxPerSec }} />
            )}

            {/* Playhead */}
            <div className="playhead" style={{ left: playhead * pxPerSec }}>
              <div className="playhead-label">{formatTimecode(playhead).slice(3, 11)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Clip Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              splitAtPlayhead();
              setContextMenu(null);
            }}
          >
            <IconSplit size={12} /> Split at Playhead
          </div>
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              op({ op: 'timeline:deleteClip', clipId: contextMenu.clip.id, ripple: false });
              select(null);
              setContextMenu(null);
            }}
          >
            <IconTrash size={12} /> Delete Clip
          </div>
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              op({ op: 'timeline:deleteClip', clipId: contextMenu.clip.id, ripple: true });
              select(null);
              setContextMenu(null);
            }}
          >
            <IconRipple size={12} /> Ripple Delete
          </div>
          {contextMenu.clip.kind !== 'text' && (
            <div
              className="context-menu-item"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={() => {
                op({
                  op: 'clip:setProps',
                  clipId: contextMenu.clip.id,
                  audioMuted: !contextMenu.clip.audioMuted,
                });
                setContextMenu(null);
              }}
            >
              {contextMenu.clip.audioMuted ? <IconSpeaker size={12} /> : <IconSpeakerOff size={12} />}
              {contextMenu.clip.audioMuted ? 'Unmute audio' : 'Mute audio'}
            </div>
          )}
          <div className="context-menu-divider" />
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              setClipStack(contextMenu.clip, 'front');
              setContextMenu(null);
            }}
            title="Bring this clip to the front of the stack (Cmd+Shift+])"
          >
            ⇈ Bring to front
          </div>
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              moveLayer(contextMenu.clip, 1);
              setContextMenu(null);
            }}
            title="Move up one layer (Cmd+]) — creates a layer past the top"
          >
            ↑ Move up a layer
          </div>
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              moveLayer(contextMenu.clip, -1);
              setContextMenu(null);
            }}
            title="Move down one layer (Cmd+[) — creates a layer past the bottom"
          >
            ↓ Move down a layer
          </div>
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              setClipStack(contextMenu.clip, 'back');
              setContextMenu(null);
            }}
            title="Send this clip to the back of the stack (Cmd+Shift+[)"
          >
            ⇊ Send to back
          </div>
        </div>
      )}
    </div>
  );
}
