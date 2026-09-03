import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditor, op } from '../store';
import { formatTimecode } from '../time';
import { canvasSize, clipFilterById, type CanvasAspect, type Clip, type MediaAsset, type Project } from '../../../shared/types';
import {
  IconPlay,
  IconPause,
  IconStepBack,
  IconStepForward,
  IconJumpStart,
  IconAudio,
  IconCenter,
  IconCrop,
  IconCheck,
} from './Icons';

/** Convert clip volume dB to a <media> volume gain (0..1). */
function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)));
}

function timelineDuration(tracks: Project['tracks']): number {
  let max = 0;
  for (const t of tracks) {
    for (const c of t.clips) max = Math.max(max, c.startSec + c.durationSec);
  }
  return max;
}

function clipTransform(c: Clip): { scale: number; posX: number; posY: number } {
  return {
    scale: Number.isFinite(c.scale) && c.scale > 0 ? c.scale : 1,
    posX: Number.isFinite(c.posX) ? c.posX : 0,
    posY: Number.isFinite(c.posY) ? c.posY : 0,
  };
}

interface ActiveTimelineClips {
  visualClip?: Clip;
  visualMedia?: MediaAsset;
  audioClip?: Clip;
  audioMedia?: MediaAsset;
  textClip?: Clip;
}

function allProjectClips(project: Project): Clip[] {
  return (project.tracks ?? []).flatMap((t) => t.clips);
}

function findClipInProject(project: Project, id: string): Clip | undefined {
  return allProjectClips(project).find((c) => c.id === id);
}

/** Topmost unmuted video-track clip wins the picture; first unmuted audio clip wins the extra audio element. */
function findTimelineClips(project: Project, head: number): ActiveTimelineClips {
  const tracks = project.tracks ?? [];
  let visualClip: Clip | undefined;
  let textClip: Clip | undefined;
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    if (t.kind !== 'video' || t.muted) continue;
    if (!visualClip) {
      const found = t.clips.find(
        (c) => c.kind !== 'text' && head >= c.startSec && head < c.startSec + c.durationSec,
      );
      if (found) visualClip = found;
    }
    if (!textClip) {
      const foundText = t.clips.find(
        (c) => c.kind === 'text' && head >= c.startSec && head < c.startSec + c.durationSec,
      );
      if (foundText) textClip = foundText;
    }
    if (visualClip && textClip) break;
  }
  let audioClip: Clip | undefined;
  for (const t of tracks) {
    if (t.kind !== 'audio' || t.muted) continue;
    const found = t.clips.find((c) => head >= c.startSec && head < c.startSec + c.durationSec);
    if (found) {
      audioClip = found;
      break;
    }
  }
  const visualMedia = visualClip ? project.media.find((m) => m.id === visualClip.mediaId) : undefined;
  const audioMedia = audioClip ? project.media.find((m) => m.id === audioClip.mediaId) : undefined;
  return { visualClip, visualMedia, audioClip, audioMedia, textClip };
}

/** Point the element at this media if it isn't already. Keeps the decoder warm across gaps. */
function ensureSrc(
  el: HTMLMediaElement,
  loadedRef: React.MutableRefObject<string | null>,
  media: MediaAsset,
): void {
  if (loadedRef.current !== media.id) {
    loadedRef.current = media.id;
    el.src = window.taxicut.mediaUrl(media.path);
    el.load();
  }
}

/** Seek when drift exceeds threshold. Never piles a new seek onto one already
 *  in flight — returns true while a seek is outstanding. Retried every frame
 *  so pre-metadata seeks converge once data arrives. */
function syncClock(el: HTMLMediaElement, targetSec: number, thresholdSec: number): boolean {
  const target = Math.max(0, targetSec);
  if (!Number.isFinite(target)) return false;
  if (el.seeking) return true;
  try {
    if (Math.abs(el.currentTime - target) > thresholdSec) {
      el.currentTime = target;
      return true;
    }
  } catch {
    /* seek while loading — retried next frame */
  }
  return el.seeking;
}

function applyProps(el: HTMLMediaElement, clip: Clip): void {
  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
  if (el.playbackRate !== speed) {
    try {
      el.playbackRate = speed;
    } catch {
      /* not ready yet */
    }
  }
  const vol = dbToGain(clip.volumeDb);
  if (Math.abs(el.volume - vol) > 0.005) el.volume = vol;
}

function playQuiet(el: HTMLMediaElement): void {
  if (!el.paused) return;
  const p = el.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

interface LiveTransform {
  id: string;
  scale: number;
  posX: number;
  posY: number;
}

interface LiveCrop {
  id: string;
  l: number;
  t: number;
  r: number;
  b: number;
}

function clipCrop(c: Clip): { l: number; t: number; r: number; b: number } {
  const g = (v: unknown): number => (Number.isFinite(v) ? (v as number) : 0);
  return { l: g(c.cropL), t: g(c.cropT), r: g(c.cropR), b: g(c.cropB) };
}

interface DragState {
  mode: 'move' | 'scale';
  clipId: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  centerX: number;
  centerY: number;
  startDist: number;
  orig: { scale: number; posX: number; posY: number };
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

export default function PreviewPanel() {
  const timelineVideoRef = useRef<HTMLVideoElement>(null);
  const timelineAudioRef = useRef<HTMLAudioElement>(null);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const sourceAudioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const loadedTimelineVideoId = useRef<string | null>(null);
  const loadedTimelineAudioId = useRef<string | null>(null);
  const loadedSourceId = useRef<string | null>(null);
  /** Wall-time (performance.now) when we started holding the playhead for a seek. */
  const seekHoldStart = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [buffering, setBuffering] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  /** In-progress canvas drag (move/resize); committed to the clip on pointer-up. */
  const [liveT, setLiveT] = useState<LiveTransform | null>(null);
  /** In-progress crop drag (source fractions); committed on pointer-up. */
  const [liveCrop, setLiveCrop] = useState<LiveCrop | null>(null);
  /** Hover ref-count over the visual layer/handles (flicker-freeChrome gating). */
  const [hoverN, setHoverN] = useState(0);
  const [dragging, setDragging] = useState(false);

  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playheadSec);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const previewMode = useEditor((s) => s.previewMode);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);
  const selectedMediaId = useEditor((s) => s.selectedMediaId);
  const sourcePlayhead = useEditor((s) => s.sourcePlayheadSec);
  const setSourcePlayhead = useEditor((s) => s.setSourcePlayhead);
  const sourcePlaying = useEditor((s) => s.sourcePlaying);
  const setSourcePlaying = useEditor((s) => s.setSourcePlaying);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const select = useEditor((s) => s.select);
  const cropMode = useEditor((s) => s.cropMode);
  const setCropMode = useEditor((s) => s.setCropMode);

  const tracks = project?.tracks ?? [];
  const duration = timelineDuration(tracks);
  const aspect: CanvasAspect = project?.aspect ?? '16:9';
  const { width: canvasW, height: canvasH } = canvasSize(aspect, project?.customW, project?.customH);

  const sourceMedia = selectedMediaId
    ? project?.media.find((m) => m.id === selectedMediaId)
    : undefined;

  const { visualClip, visualMedia, audioClip: activeAudioClip, audioMedia: activeAudioMedia, textClip } =
    project ? findTimelineClips(project, playhead) : {};

  const activeSubtitleClip = tracks
    .filter((t) => !t.muted)
    .flatMap((t) => t.clips)
    .find(
      (c) =>
        c.kind !== 'text' &&
        c.text &&
        playhead >= c.startSec &&
        playhead < c.startSec + c.durationSec,
    );
  const subtitleText = activeSubtitleClip?.text;

  const currentFps = visualMedia?.fps || 30;

  // Measure the stage so the canvas box can letterbox to the aspect ratio.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setStageSize({ w: Math.max(0, r.width - 24), h: Math.max(0, r.height - 24) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale =
    stageSize.w > 0 && stageSize.h > 0
      ? Math.min(stageSize.w / canvasW, stageSize.h / canvasH)
      : 0;
  const boxW = fitScale > 0 ? Math.max(1, Math.floor(canvasW * fitScale)) : 0;
  const boxH = fitScale > 0 ? Math.max(1, Math.floor(canvasH * fitScale)) : 0;

  // Visual layer geometry: contain-fit base rect of the CROPPED region + user transform.
  const showVisualLayer =
    previewMode === 'timeline' &&
    !!visualClip &&
    (visualMedia?.kind === 'video' || visualMedia?.kind === 'image');
  const mw = visualMedia?.width || 0;
  const mh = visualMedia?.height || 0;
  const clipC = visualClip
    ? clipCrop(visualClip)
    : { l: 0, t: 0, r: 0, b: 0 };
  const effC: LiveCrop | { l: number; t: number; r: number; b: number } =
    liveCrop && visualClip && liveCrop.id === visualClip.id
      ? liveCrop
      : visualClip
        ? clipC
        : { l: 0, t: 0, r: 0, b: 0 };
  // In crop mode the layer shows the full source (untransformed); the kept
  // region is drawn as an overlay. Otherwise the layer shows the cropped
  // region with the user transform applied.
  const renderC = cropMode ? { l: 0, t: 0, r: 0, b: 0 } : effC;
  const cwFrac = Math.max(0.01, 1 - renderC.l - renderC.r);
  const chFrac = Math.max(0.01, 1 - renderC.t - renderC.b);
  const effMW = mw * cwFrac;
  const effMH = mh * chFrac;
  const baseFit = mw > 0 && mh > 0 && boxW > 0 && boxH > 0 ? Math.min(boxW / effMW, boxH / effMH) : 0;
  const baseW = baseFit > 0 ? effMW * baseFit : boxW;
  const baseH = baseFit > 0 ? effMH * baseFit : boxH;
  // Full-source fit rect (used for the crop-mode overlay).
  const fullFit = mw > 0 && mh > 0 && boxW > 0 && boxH > 0 ? Math.min(boxW / mw, boxH / mh) : 0;
  const fullW = fullFit > 0 ? mw * fullFit : boxW;
  const fullH = fullFit > 0 ? mh * fullFit : boxH;
  const fullL = (boxW - fullW) / 2;
  const fullT = (boxH - fullH) / 2;
  const clipT = visualClip ? clipTransform(visualClip) : { scale: 1, posX: 0, posY: 0 };
  const effT: LiveTransform | { scale: number; posX: number; posY: number } =
    liveT && visualClip && liveT.id === visualClip.id ? liveT : visualClip ? clipT : { scale: 1, posX: 0, posY: 0 };
  const layerStyle: React.CSSProperties = {
    left: (boxW - baseW) / 2,
    top: (boxH - baseH) / 2,
    width: baseW,
    height: baseH,
    transform: cropMode ? 'none' : `translate(${effT.posX * boxW}px, ${effT.posY * boxH}px) scale(${effT.scale})`,
    transformOrigin: 'center',
    cursor: cropMode ? 'default' : 'move',
    touchAction: 'none',
    display: showVisualLayer ? 'block' : 'none',
  };
  // Inner media fills the outer box so the cropped region shows through:
  // inner is full-source sized, offset by the crop insets.
  const innerStyle: React.CSSProperties = {
    position: 'absolute',
    width: `${100 / cwFrac}%`,
    height: `${100 / chFrac}%`,
    left: `${(-renderC.l / cwFrac) * 100}%`,
    top: `${(-renderC.t / chFrac) * 100}%`,
  };
  // Kept-region rect in box pixels (crop-mode overlay + handles).
  const keepL = fullL + effC.l * fullW;
  const keepT = fullT + effC.t * fullH;
  const keepW = fullW * Math.max(0.01, 1 - effC.l - effC.r);
  const keepH = fullH * Math.max(0.01, 1 - effC.t - effC.b);
  // Live color look for the picture layer.
  const cssFilter = visualClip ? clipFilterById(visualClip.filter).css : 'none';
  const innerWithFilter: React.CSSProperties = {
    ...innerStyle,
    filter: cssFilter === 'none' ? undefined : cssFilter,
  };
  // Transformed rect in box pixels (for the resize handles).
  const rectCX = boxW / 2 + effT.posX * boxW;
  const rectCY = boxH / 2 + effT.posY * boxH;
  const rectW = baseW * effT.scale;
  const rectH = baseH * effT.scale;

  // -------------------------------------------------------------
  // Canvas drag (move) + corner-drag (uniform scale), CapCut-style.
  // Live state only; committed to the clip on pointer-up (one undo step).
  // -------------------------------------------------------------
  const beginDrag = (e: React.PointerEvent, mode: 'move' | 'scale', target: Clip | undefined) => {
    e.preventDefault();
    e.stopPropagation();
    if (!target || boxW <= 0 || boxH <= 0 || cropMode) return;
    const t = clipTransform(target);
    const box = boxRef.current?.getBoundingClientRect();
    const centerX = box ? box.left + box.width / 2 + t.posX * boxW : e.clientX;
    const centerY = box ? box.top + box.height / 2 + t.posY * boxH : e.clientY;
    dragRef.current = {
      mode,
      clipId: target.id,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      centerX,
      centerY,
      startDist: Math.max(4, Math.hypot(e.clientX - centerX, e.clientY - centerY)),
      orig: t,
    };
    setDragging(true);
    setLiveT({ id: target.id, ...t });
    try {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic or already-released pointer — drag still works via window events */
    }
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || boxW <= 0 || boxH <= 0) return;
    const proj = useEditor.getState().project;
    const target = proj ? findClipInProject(proj, d.clipId) : undefined;
    if (!target) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (d.mode === 'move') {
      setLiveT({
        id: d.clipId,
        scale: d.orig.scale,
        posX: d.orig.posX + (e.clientX - d.startX) / boxW,
        posY: d.orig.posY + (e.clientY - d.startY) / boxH,
      });
    } else {
      const dist = Math.max(4, Math.hypot(e.clientX - d.centerX, e.clientY - d.centerY));
      const scale = Math.max(0.05, Math.min(8, d.orig.scale * (dist / d.startDist)));
      setLiveT({ id: d.clipId, scale, posX: d.orig.posX, posY: d.orig.posY });
    }
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!d) {
      setLiveT(null);
      return;
    }
    const moved = Math.hypot(d.lastX - d.startX, d.lastY - d.startY);
    if (moved < 4) {
      // Treat as a click: select the clip so handles stick around.
      setLiveT(null);
      select(d.clipId);
      return;
    }
    setLiveT((cur) => {
      if (cur && cur.id === d.clipId) {
        const changed =
          Math.abs(cur.scale - d.orig.scale) > 1e-4 ||
          Math.abs(cur.posX - d.orig.posX) > 1e-4 ||
          Math.abs(cur.posY - d.orig.posY) > 1e-4;
        if (changed) {
          op({
            op: 'clip:setProps',
            clipId: d.clipId,
            scale: round4(cur.scale),
            posX: round4(cur.posX),
            posY: round4(cur.posY),
          });
        }
      }
      return null;
    });
  };

  const handleCursor = (corner: 'nw' | 'ne' | 'sw' | 'se'): string =>
    corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';

  // Hover ref-count over the layer/handles (enter/leave pairs can't flicker).
  const hoverEnter = () => setHoverN((n) => n + 1);
  const hoverLeave = () => setHoverN((n) => Math.max(0, n - 1));

  // Transform chrome shows while interacting, hovering the video, or when the
  // active clip is selected. It hides when the pointer leaves the viewer.
  const isActiveSelected = !!visualClip && selectedClipId === visualClip.id;
  const showChrome =
    previewMode === 'timeline' && !cropMode && !!visualClip && (dragging || hoverN > 0 || isActiveSelected);

  const renderHandles = () => {
    if (!showChrome || boxW <= 0) return null;
    const corners: { id: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }[] = [
      { id: 'nw', x: rectCX - rectW / 2, y: rectCY - rectH / 2 },
      { id: 'ne', x: rectCX + rectW / 2, y: rectCY - rectH / 2 },
      { id: 'sw', x: rectCX - rectW / 2, y: rectCY + rectH / 2 },
      { id: 'se', x: rectCX + rectW / 2, y: rectCY + rectH / 2 },
    ];
    return (
      <>
        {corners.map((c) => (
          <div
            key={c.id}
            className="canvas-handle"
            style={{ left: c.x - 6, top: c.y - 6, cursor: handleCursor(c.id) }}
            onPointerDown={(e) => beginDrag(e, 'scale', visualClip)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerEnter={hoverEnter}
            onPointerLeave={hoverLeave}
          />
        ))}
      </>
    );
  };

  // -------------------------------------------------------------
  // Crop mode: edge/corner handles adjust source-fraction insets.
  // Live state only; committed to the clip on pointer-up (one undo step).
  // -------------------------------------------------------------
  const cropDragRef = useRef<null | {
    clipId: string;
    edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    orig: { l: number; t: number; r: number; b: number };
  }>(null);

  const clampCropBox = (c: { l: number; t: number; r: number; b: number }) => {
    const out = {
      l: Math.max(0, Math.min(0.9, c.l)),
      t: Math.max(0, Math.min(0.9, c.t)),
      r: Math.max(0, Math.min(0.9, c.r)),
      b: Math.max(0, Math.min(0.9, c.b)),
    };
    if (out.l + out.r > 0.95) {
      const k = 0.95 / (out.l + out.r);
      out.l *= k;
      out.r *= k;
    }
    if (out.t + out.b > 0.95) {
      const k = 0.95 / (out.t + out.b);
      out.t *= k;
      out.b *= k;
    }
    return out;
  };

  const beginCropDrag = (e: React.PointerEvent, edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw') => {
    e.preventDefault();
    e.stopPropagation();
    if (!visualClip || boxW <= 0 || fullW <= 0) return;
    const c = visualClip ? clipCrop(visualClip) : { l: 0, t: 0, r: 0, b: 0 };
    cropDragRef.current = {
      clipId: visualClip.id,
      edge,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      orig: liveCrop && liveCrop.id === visualClip.id
        ? { l: liveCrop.l, t: liveCrop.t, r: liveCrop.r, b: liveCrop.b }
        : c,
    };
    setDragging(true);
    setLiveCrop({ id: visualClip.id, ...cropDragRef.current.orig });
    try {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const moveCropDrag = (e: React.PointerEvent) => {
    const d = cropDragRef.current;
    if (!d || !visualClip || d.clipId !== visualClip.id || fullW <= 0 || fullH <= 0) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const fx = (e.clientX - box.left - fullL) / fullW;
    const fy = (e.clientY - box.top - fullT) / fullH;
    const next = { ...d.orig };
    if (d.edge.includes('e')) next.r = 1 - fx;
    if (d.edge.includes('w')) next.l = fx;
    if (d.edge.includes('n')) next.t = fy;
    if (d.edge.includes('s')) next.b = 1 - fy;
    setLiveCrop({ id: d.clipId, ...clampCropBox(next) });
  };

  const endCropDrag = () => {
    const d = cropDragRef.current;
    cropDragRef.current = null;
    setDragging(false);
    if (!d) {
      setLiveCrop(null);
      return;
    }
    setLiveCrop((cur) => {
      if (cur && cur.id === d.clipId) {
        const changed =
          Math.abs(cur.l - d.orig.l) > 1e-4 || Math.abs(cur.t - d.orig.t) > 1e-4 ||
          Math.abs(cur.r - d.orig.r) > 1e-4 || Math.abs(cur.b - d.orig.b) > 1e-4;
        if (changed) {
          op({
            op: 'clip:setProps',
            clipId: d.clipId,
            cropL: round4(cur.l),
            cropT: round4(cur.t),
            cropR: round4(cur.r),
            cropB: round4(cur.b),
          });
        }
      }
      return null;
    });
  };

  const cropEdgeCursor = (edge: string): string => {
    if (edge === 'n' || edge === 's') return 'ns-resize';
    if (edge === 'e' || edge === 'w') return 'ew-resize';
    return edge === 'nw' || edge === 'se' ? 'nwse-resize' : 'nesw-resize';
  };

  const renderCropOverlay = () => {
    if (!cropMode || !showVisualLayer || boxW <= 0 || fullW <= 0) return null;
    const shade: React.CSSProperties = {
      position: 'absolute',
      background: 'rgba(0,0,0,0.55)',
      pointerEvents: 'none',
      zIndex: 4,
    };
    const edges: { id: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'; x: number; y: number }[] = [
      { id: 'n', x: keepL + keepW / 2, y: keepT },
      { id: 's', x: keepL + keepW / 2, y: keepT + keepH },
      { id: 'e', x: keepL + keepW, y: keepT + keepH / 2 },
      { id: 'w', x: keepL, y: keepT + keepH / 2 },
      { id: 'nw', x: keepL, y: keepT },
      { id: 'ne', x: keepL + keepW, y: keepT },
      { id: 'sw', x: keepL, y: keepT + keepH },
      { id: 'se', x: keepL + keepW, y: keepT + keepH },
    ];
    return (
      <>
        <div style={{ ...shade, left: fullL, top: fullT, width: fullW, height: effC.t * fullH }} />
        <div style={{ ...shade, left: fullL, top: keepT + keepH, width: fullW, height: Math.max(0, fullT + fullH - keepT - keepH) }} />
        <div style={{ ...shade, left: fullL, top: keepT, width: effC.l * fullW, height: keepH }} />
        <div style={{ ...shade, left: keepL + keepW, top: keepT, width: Math.max(0, fullL + fullW - keepL - keepW), height: keepH }} />
        <div
          style={{
            position: 'absolute',
            left: keepL,
            top: keepT,
            width: keepW,
            height: keepH,
            border: '1px dashed var(--accent)',
            pointerEvents: 'none',
            zIndex: 4,
          }}
        />
        {edges.map((c) => (
          <div
            key={c.id}
            className="canvas-handle"
            style={{ left: c.x - 6, top: c.y - 6, cursor: cropEdgeCursor(c.id) }}
            onPointerDown={(e) => beginCropDrag(e, c.id)}
            onPointerMove={moveCropDrag}
            onPointerUp={endCropDrag}
            onPointerCancel={endCropDrag}
          />
        ))}
      </>
    );
  };

  // Escape exits crop mode.
  useEffect(() => {
    if (!cropMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCropMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cropMode, setCropMode]);

  // -------------------------------------------------------------
  // Text overlay (kind === 'text'): positioned by the same canvas
  // transform, draggable/resizable, double-click to edit inline.
  // -------------------------------------------------------------
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [hoverTN, setHoverTN] = useState(0);
  const [textRect, setTextRect] = useState({ x: 0, y: 0, w: 0, h: 0 });

  const showTextLayer = previewMode === 'timeline' && !!textClip && !cropMode;
  const textT: LiveTransform | { scale: number; posX: number; posY: number } =
    liveT && textClip && liveT.id === textClip.id
      ? liveT
      : textClip
        ? clipTransform(textClip)
        : { scale: 1, posX: 0, posY: 0 };
  const textFontPx = boxH > 0 ? Math.max(8, ((textClip?.fontSize || 72) * boxH) / 1080) : 16;
  const isTextSelected = !!textClip && selectedClipId === textClip.id;
  const showTextChrome =
    !!showTextLayer &&
    !!textClip &&
    (hoverTN > 0 || isTextSelected || liveT?.id === textClip.id || editingTextId === textClip.id);

  // Measure the laid-out text box for handle placement. Deps exclude the
  // playhead so this never runs on playback ticks.
  useLayoutEffect(() => {
    if (!showTextChrome) return;
    const box = boxRef.current?.getBoundingClientRect();
    const el = textLayerRef.current;
    if (!box || !el) return;
    const r = el.getBoundingClientRect();
    const next = { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
    setTextRect((prev) =>
      Math.abs(prev.x - next.x) > 0.5 ||
      Math.abs(prev.y - next.y) > 0.5 ||
      Math.abs(prev.w - next.w) > 0.5 ||
      Math.abs(prev.h - next.h) > 0.5
        ? next
        : prev,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showTextChrome,
    textClip?.id,
    textClip?.text,
    textClip?.fontSize,
    textClip?.fontFamily,
    textClip?.bold,
    textClip?.textAlign,
    textClip?.textColor,
    textClip?.textBg,
    textClip?.scale,
    textClip?.posX,
    textClip?.posY,
    boxW,
    boxH,
    liveT,
    editingTextId,
  ]);

  const textPointerHandlers = {
    onPointerDown: (e: React.PointerEvent) => beginDrag(e, 'move', textClip),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onPointerEnter: () => setHoverTN((n) => n + 1),
    onPointerLeave: () => setHoverTN((n) => Math.max(0, n - 1)),
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (textClip && editingTextId !== textClip.id) {
        setEditingTextId(textClip.id);
        setEditText(textClip.text ?? '');
      }
    },
  };

  const commitTextEdit = (save: boolean) => {
    const id = editingTextId;
    setEditingTextId(null);
    if (!save || !id || !project) return;
    const cur = findClipInProject(project, id);
    const v = editText;
    if (cur && v.trim().length > 0 && v !== (cur.text ?? '')) {
      op({ op: 'clip:setProps', clipId: id, text: v, name: v.slice(0, 40) });
    }
  };

  const renderTextHandles = () => {
    if (!showTextChrome || !textClip || boxW <= 0 || textRect.w <= 0) return null;
    const corners: { id: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }[] = [
      { id: 'nw', x: textRect.x, y: textRect.y },
      { id: 'ne', x: textRect.x + textRect.w, y: textRect.y },
      { id: 'sw', x: textRect.x, y: textRect.y + textRect.h },
      { id: 'se', x: textRect.x + textRect.w, y: textRect.y + textRect.h },
    ];
    return (
      <>
        {corners.map((c) => (
          <div
            key={c.id}
            className="canvas-handle"
            style={{ left: c.x - 6, top: c.y - 6, cursor: handleCursor(c.id) }}
            onPointerDown={(e) => beginDrag(e, 'scale', textClip)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerEnter={() => setHoverTN((n) => n + 1)}
            onPointerLeave={() => setHoverTN((n) => Math.max(0, n - 1))}
          />
        ))}
      </>
    );
  };

  // -------------------------------------------------------------
  // 1) Timeline playback: wall-clock drives the playhead, media slaves to it.
  //    Effect depends only on [playing, previewMode] so crossing clip
  //    boundaries never tears down the RAF loop (the old freeze).
  // -------------------------------------------------------------
  useEffect(() => {
    if (previewMode !== 'timeline') {
      timelineVideoRef.current?.pause();
      timelineAudioRef.current?.pause();
      return;
    }
    if (!playing) {
      timelineVideoRef.current?.pause();
      timelineAudioRef.current?.pause();
      return;
    }

    let raf = 0;
    let lastWall = performance.now();
    setMediaError(null);
    seekHoldStart.current = null;

    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastWall) / 1000));
      lastWall = now;

      const st = useEditor.getState();
      const proj = st.project;
      if (!proj) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const head = st.playheadSec;
      const total = timelineDuration(proj.tracks ?? []);

      if (total > 0 && head >= total) {
        st.setPlaying(false);
        return;
      }

      const { visualClip: vc, visualMedia: vm, audioClip: ac, audioMedia: am } =
        findTimelineClips(proj, head);

      // While the picture element is seeking (or still loading data), hold the
      // playhead still so the seek target can't run away — re-seeking every
      // frame to a moving target is what stalls playback. Escape after 1s so
      // a wedged seek can never freeze the timecode for good.
      let holdForSeek = false;
      const v = timelineVideoRef.current;
      if (v) {
        if (vm?.kind === 'video' && vc) {
          ensureSrc(v, loadedTimelineVideoId, vm);
          applyProps(v, vc);
          const target = vc.inSec + (head - vc.startSec) * vc.speed;
          const drifted = Math.abs(v.currentTime - Math.max(0, target)) > 0.35;
          const seekOutstanding = syncClock(v, target, 0.35);
          if ((drifted || v.seeking) && (seekOutstanding || v.readyState < 2)) {
            holdForSeek = true;
          }
          playQuiet(v);
        } else if (!v.paused) {
          v.pause();
        }
      }

      const a = timelineAudioRef.current;
      if (a) {
        if (am && ac) {
          ensureSrc(a, loadedTimelineAudioId, am);
          applyProps(a, ac);
          syncClock(a, ac.inSec + (head - ac.startSec) * ac.speed, 0.35);
          playQuiet(a);
        } else if (!a.paused) {
          a.pause();
        }
      }

      if (holdForSeek) {
        if (seekHoldStart.current == null) seekHoldStart.current = now;
        if (now - seekHoldStart.current < 1000) {
          raf = requestAnimationFrame(tick);
          return;
        }
      }
      seekHoldStart.current = null;

      const next = head + dt;
      if (total > 0 && next >= total) {
        st.setPlayhead(total);
        st.setPlaying(false);
        return;
      }
      st.setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, previewMode]);

  // -------------------------------------------------------------
  // 2) Scrub sync while paused: snap media to the playhead.
  //    Never clears src (old code reloaded on every gap → flash/freeze).
  // -------------------------------------------------------------
  useEffect(() => {
    if (previewMode !== 'timeline' || playing) return;
    if (!project) return;
    const v = timelineVideoRef.current;
    if (v) {
      if (visualMedia?.kind === 'video' && visualClip) {
        ensureSrc(v, loadedTimelineVideoId, visualMedia);
        applyProps(v, visualClip);
        if (!v.paused) v.pause();
        syncClock(v, visualClip.inSec + (playhead - visualClip.startSec) * visualClip.speed, 0.04);
      } else if (!v.paused) {
        v.pause();
      }
    }
    const a = timelineAudioRef.current;
    if (a) {
      if (activeAudioMedia && activeAudioClip) {
        ensureSrc(a, loadedTimelineAudioId, activeAudioMedia);
        applyProps(a, activeAudioClip);
        if (!a.paused) a.pause();
        syncClock(a, activeAudioClip.inSec + (playhead - activeAudioClip.startSec) * activeAudioClip.speed, 0.04);
      } else if (!a.paused) {
        a.pause();
      }
    }
  }, [previewMode, playing, playhead, project, visualClip, visualMedia, activeAudioClip, activeAudioMedia]);

  // -------------------------------------------------------------
  // 3) Source playback: same wall-clock pattern. Deps exclude the
  //    playhead itself — the old [.., sourcePlayhead] dep restarted
  //    the loop every frame and stalled after a few seconds.
  // -------------------------------------------------------------
  useEffect(() => {
    if (previewMode !== 'source' || !sourceMedia) {
      sourceVideoRef.current?.pause();
      sourceAudioRef.current?.pause();
      return;
    }
    if (sourceMedia.kind === 'image') return;
    if (!sourcePlaying) {
      sourceVideoRef.current?.pause();
      sourceAudioRef.current?.pause();
      return;
    }

    let raf = 0;
    let lastWall = performance.now();
    setMediaError(null);
    seekHoldStart.current = null;

    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastWall) / 1000));
      lastWall = now;
      const st = useEditor.getState();
      const media = st.project?.media.find((m) => m.id === st.selectedMediaId);
      if (!media || media.kind === 'image') {
        raf = requestAnimationFrame(tick);
        return;
      }
      const head = st.sourcePlayheadSec;
      const total = media.durationSec || 0;
      if (total > 0 && head >= total) {
        st.setSourcePlaying(false);
        return;
      }

      let holdForSeek = false;
      const el =
        media.kind === 'video' ? sourceVideoRef.current : sourceAudioRef.current;
      if (el) {
        ensureSrc(el, loadedSourceId, media);
        if (el.volume !== 1) el.volume = 1;
        if (el.playbackRate !== 1) {
          try {
            el.playbackRate = 1;
          } catch {
            /* not ready */
          }
        }
        const drifted = Math.abs(el.currentTime - Math.max(0, head)) > 0.35;
        const seekOutstanding = syncClock(el, head, 0.35);
        if ((drifted || el.seeking) && (seekOutstanding || el.readyState < 2)) {
          holdForSeek = true;
        }
        playQuiet(el);
      }

      if (holdForSeek) {
        if (seekHoldStart.current == null) seekHoldStart.current = now;
        if (now - seekHoldStart.current < 1000) {
          raf = requestAnimationFrame(tick);
          return;
        }
      }
      seekHoldStart.current = null;

      const next = head + dt;
      if (total > 0 && next >= total) {
        st.setSourcePlayhead(total);
        st.setSourcePlaying(false);
        return;
      }
      st.setSourcePlayhead(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [previewMode, sourcePlaying, sourceMedia?.id]);

  // Source scrub while paused.
  useEffect(() => {
    if (previewMode !== 'source' || sourcePlaying || !sourceMedia) return;
    if (sourceMedia.kind === 'image') return;
    const el =
      sourceMedia.kind === 'video' ? sourceVideoRef.current : sourceAudioRef.current;
    if (!el) return;
    ensureSrc(el, loadedSourceId, sourceMedia);
    if (!el.paused) el.pause();
    syncClock(el, sourcePlayhead, 0.04);
  }, [previewMode, sourcePlaying, sourcePlayhead, sourceMedia]);

  // Keep the non-active engine parked when switching modes.
  useEffect(() => {
    if (previewMode === 'timeline') {
      sourceVideoRef.current?.pause();
      sourceAudioRef.current?.pause();
      setSourcePlaying(false);
    } else {
      timelineVideoRef.current?.pause();
      timelineAudioRef.current?.pause();
      setPlaying(false);
    }
    setBuffering(false);
    setCropMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode]);

  const step = (frames: number) => {
    if (previewMode === 'timeline') {
      setPlaying(false);
      setPlayhead(Math.max(0, Math.min(duration, playhead + frames / currentFps)));
    } else if (sourceMedia) {
      setSourcePlaying(false);
      const fps = sourceMedia.fps || 30;
      setSourcePlayhead(Math.max(0, Math.min(sourceMedia.durationSec, sourcePlayhead + frames / fps)));
    }
  };

  const togglePlay = () => {
    if (previewMode === 'timeline') {
      if (!playing && duration > 0 && playhead >= duration) setPlayhead(0);
      setPlaying(!playing);
    } else if (sourceMedia?.kind !== 'image') {
      if (!sourcePlaying && sourceMedia && sourcePlayhead >= sourceMedia.durationSec) {
        setSourcePlayhead(0);
      }
      setSourcePlaying(!sourcePlaying);
    }
  };

  const activePlayhead = previewMode === 'timeline' ? playhead : sourcePlayhead;
  const activeDuration = previewMode === 'timeline' ? duration : (sourceMedia?.durationSec ?? 0);
  const isPlaying = previewMode === 'timeline' ? playing : sourcePlaying;
  const showSourceVideo = previewMode === 'source' && sourceMedia?.kind === 'video';
  const subtitleSize = Math.round(Math.max(12, Math.min(24, (boxW || 640) / 30)));

  const onNeedBuffer = () => setBuffering(true);
  const onCanPlay = () => setBuffering(false);
  const onMediaError = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const el = e.currentTarget;
    const err = el.error;
    if (err && err.code !== err.MEDIA_ERR_ABORTED) {
      setMediaError(`Playback error (code ${err.code}). The file may use an unsupported codec — try transcoding to H.264/AAC.`);
    }
    setBuffering(false);
  };

  const layerPointerHandlers = {
    onPointerDown: (e: React.PointerEvent) => beginDrag(e, 'move', visualClip),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onPointerEnter: hoverEnter,
    onPointerLeave: hoverLeave,
  };

  const centerActiveClip = () => {
    if (visualClip) {
      op({ op: 'clip:setProps', clipId: visualClip.id, posX: 0, posY: 0 });
    }
  };

  return (
    <div className="preview-panel">
      <div className="panel-header">
        <div className="preview-tabs">
          <button
            className={`tab-btn ${previewMode === 'timeline' ? 'active' : ''}`}
            onClick={() => setPreviewMode('timeline')}
          >
            Timeline
          </button>
          {sourceMedia && (
            <button
              className={`tab-btn ${previewMode === 'source' ? 'active' : ''}`}
              onClick={() => setPreviewMode('source')}
            >
              Source: {sourceMedia.name}
            </button>
          )}
        </div>
        <div className="spacer" />
        {previewMode === 'timeline' ? (
          <div className="preview-tools">
            <AspectMenu
              aspect={aspect}
              customW={project?.customW ?? 1920}
              customH={project?.customH ?? 1080}
            />
            <button
              className="icon"
              title="Center video on canvas"
              disabled={!visualClip}
              onClick={centerActiveClip}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              <IconCenter size={13} />
            </button>
            <button
              className={`icon${cropMode ? ' accent' : ''}`}
              title={cropMode ? 'Exit crop mode (Esc)' : 'Crop mode'}
              disabled={!showVisualLayer}
              onClick={() => setCropMode(!cropMode)}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              <IconCrop size={13} />
            </button>
          </div>
        ) : (
          <span className="meta">
            {sourceMedia
              ? `${sourceMedia.kind.toUpperCase()}${sourceMedia.width ? ` · ${sourceMedia.width}×${sourceMedia.height}` : ''}${sourceMedia.fps ? ` · ${sourceMedia.fps.toFixed(0)}fps` : ''}`
              : '16:9 · Fit'}
          </span>
        )}
      </div>

      <div className="preview-stage" ref={stageRef}>
        <div className="preview-wrap">
          {previewMode === 'timeline' ? (
            <div
              ref={boxRef}
              className="canvas-box"
              style={
                boxW > 0 && boxH > 0
                  ? { width: boxW, height: boxH }
                  : { width: '100%', height: '100%', aspectRatio: `${canvasW} / ${canvasH}` }
              }
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) select(null);
              }}
            >
              {/* Transformable video layer (always mounted so the ref stays valid). */}
              <div className="canvas-layer" style={layerStyle} {...layerPointerHandlers}>
                <div className="canvas-inner" style={innerWithFilter}>
                  <video
                    ref={timelineVideoRef}
                    playsInline
                    preload="auto"
                    onWaiting={onNeedBuffer}
                    onStalled={onNeedBuffer}
                    onPlaying={onCanPlay}
                    onCanPlay={onCanPlay}
                    onError={onMediaError}
                  />
                </div>
              </div>

              {/* Transformable image layer. */}
              {visualMedia?.kind === 'image' && visualClip && (
                <div className="canvas-layer" style={layerStyle} {...layerPointerHandlers}>
                  <div className="canvas-inner" style={innerWithFilter}>
                    <img src={window.taxicut.mediaUrl(visualMedia.path)} alt="" draggable={false} />
                  </div>
                </div>
              )}

              {renderHandles()}
              {renderCropOverlay()}

              {/* Text overlay layer (drag/resize like video, double-click to edit). */}
              {showTextLayer && textClip && (
                <div
                  ref={textLayerRef}
                  className="canvas-text"
                  style={{
                    left: boxW / 2,
                    top: boxH / 2,
                    width: 'max-content',
                    maxWidth: boxW,
                    transform: `translate(${textT.posX * boxW}px, ${textT.posY * boxH}px) scale(${textT.scale}) translate(-50%, -50%)`,
                    fontFamily: textClip.fontFamily || 'Arial',
                    fontSize: textFontPx,
                    fontWeight: textClip.bold ? 700 : 400,
                    color: textClip.textColor || '#ffffff',
                    background: textClip.textBg || 'transparent',
                    textAlign: textClip.textAlign || 'center',
                  }}
                  {...textPointerHandlers}
                >
                  {editingTextId === textClip.id ? (
                    <textarea
                      className="canvas-text-edit"
                      value={editText}
                      rows={3}
                      onChange={(e) => setEditText(e.target.value)}
                      onBlur={() => commitTextEdit(true)}
                      onPointerDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          commitTextEdit(false);
                        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          commitTextEdit(true);
                        } else {
                          e.stopPropagation();
                        }
                      }}
                      ref={(el) => {
                        el?.focus();
                        el?.select();
                      }}
                      style={{
                        fontFamily: 'inherit',
                        fontSize: 'inherit',
                        fontWeight: 'inherit',
                        color: 'inherit',
                        textAlign: 'inherit',
                      }}
                    />
                  ) : (
                    textClip.text
                  )}
                </div>
              )}
              {renderTextHandles()}

              {/* Timeline audio-only indicator (no video clip under playhead but audio is present). */}
              {!visualClip && (activeAudioMedia || visualMedia?.kind === 'audio') && (
                <div className="preview-audio-indicator" style={{ position: 'absolute', inset: 0, justifyContent: 'center' }}>
                  <span className="audio-icon"><IconAudio size={42} /></span>
                  <span className="audio-title">{(activeAudioMedia ?? visualMedia)?.name}</span>
                </div>
              )}

              {/* Timeline empty state */}
              {!visualClip && !activeAudioMedia && (
                <div className="preview-empty-stage" style={{ position: 'absolute', inset: 0 }}>
                  {tracks.every((t) => t.clips.length === 0) ? (
                    <div className="preview-empty-hint">
                      Timeline is empty.
                      <br />
                      Drag media from Library or Desktop to add clips.
                    </div>
                  ) : null}
                </div>
              )}

              {/* Subtitle text overlay */}
              {subtitleText && (
                <div className="preview-subtitle" style={{ fontSize: subtitleSize }}>{subtitleText}</div>
              )}

              {buffering && isPlaying && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 10,
                    left: 0,
                    right: 0,
                    textAlign: 'center',
                    fontSize: 11,
                    color: 'var(--text-dim)',
                    pointerEvents: 'none',
                  }}
                >
                  Buffering…
                </div>
              )}
              {mediaError && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 28,
                    left: 12,
                    right: 12,
                    textAlign: 'center',
                    fontSize: 11,
                    color: 'var(--danger)',
                    pointerEvents: 'none',
                  }}
                >
                  {mediaError}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Source elements: always mounted so refs stay valid. */}
              <video
                ref={sourceVideoRef}
                className="preview-media"
                playsInline
                preload="auto"
                onWaiting={onNeedBuffer}
                onStalled={onNeedBuffer}
                onPlaying={onCanPlay}
                onCanPlay={onCanPlay}
                onError={onMediaError}
                style={{ display: showSourceVideo ? 'block' : 'none' }}
              />
              {sourceMedia?.kind === 'image' && (
                <img
                  src={window.taxicut.mediaUrl(sourceMedia.path)}
                  className="preview-media preview-image"
                  alt=""
                />
              )}
              {sourceMedia?.kind === 'audio' && (
                <div className="preview-audio-indicator">
                  <span className="audio-icon"><IconAudio size={42} /></span>
                  <span className="audio-title">{sourceMedia.name}</span>
                </div>
              )}
            </>
          )}
          <audio
            ref={timelineAudioRef}
            preload="auto"
            onWaiting={onNeedBuffer}
            onPlaying={onCanPlay}
            onError={onMediaError}
            style={{ display: 'none' }}
          />
          <audio
            ref={sourceAudioRef}
            preload="auto"
            onWaiting={onNeedBuffer}
            onPlaying={onCanPlay}
            onError={onMediaError}
            style={{ display: 'none' }}
          />
        </div>
      </div>

      <div className="transport">
        <span className="tc">
          {formatTimecode(activePlayhead, currentFps)} / {formatTimecode(activeDuration, currentFps)}
        </span>
        <button className="icon" onClick={() => step(-1)} title="Back 1 frame (Left Arrow)">
          <IconStepBack size={13} />
        </button>
        <button className="icon" onClick={togglePlay} title="Play/Pause (Space)">
          {isPlaying ? <IconPause size={13} /> : <IconPlay size={13} />}
        </button>
        <button className="icon" onClick={() => step(1)} title="Forward 1 frame (Right Arrow)">
          <IconStepForward size={13} />
        </button>
        <button
          className="icon"
          onClick={() => {
            if (previewMode === 'timeline') {
              setPlaying(false);
              setPlayhead(0);
            } else {
              setSourcePlaying(false);
              setSourcePlayhead(0);
            }
          }}
          title="Return to start"
        >
          <IconJumpStart size={13} />
        </button>
      </div>
    </div>
  );
}

const ASPECT_META: { id: Exclude<CanvasAspect, 'custom'>; hint: string }[] = [
  { id: '16:9', hint: 'Landscape' },
  { id: '9:16', hint: 'Portrait' },
  { id: '1:1', hint: 'Square' },
  { id: '4:3', hint: 'Landscape' },
  { id: '4:5', hint: 'Portrait' },
];

function ratioWH(a: string, cw: number, ch: number): { w: number; h: number } {
  if (a === 'custom') return { w: cw > 0 ? cw : 1920, h: ch > 0 ? ch : 1080 };
  const [w, h] = a.split(':').map(Number);
  return { w: w || 16, h: h || 9 };
}

/** Little ratio glyph so users can see what 9:16 vs 1:1 means. */
function AspectShape({ w, h }: { w: number; h: number }) {
  const r = w / Math.max(1, h);
  const sw = Math.min(22, Math.max(6, 14 * r));
  const sh = Math.max(5, sw / r);
  return (
    <span
      style={{
        width: sw,
        height: sh,
        border: '1.5px solid var(--text-dim)',
        borderRadius: 2,
        flex: 'none',
      }}
    />
  );
}

function AspectMenu({ aspect, customW, customH }: { aspect: CanvasAspect; customW: number; customH: number }) {
  const [open, setOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [w, setW] = useState(String(customW));
  const [h, setH] = useState(String(customH));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setCustomizing(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open ]);

  const cur = ratioWH(aspect, customW, customH);
  const dimsOf = (a: CanvasAspect): string => {
    const s = canvasSize(a, customW, customH);
    return `${s.width} × ${s.height}`;
  };
  const pick = (a: CanvasAspect) => {
    op({ op: 'project:setAspect', aspect: a });
    setOpen(false);
  };
  const applyCustom = () => {
    const wi = Math.round(Number(w));
    const hi = Math.round(Number(h));
    if (!Number.isFinite(wi) || !Number.isFinite(hi) || wi < 16 || hi < 16) return;
    op({ op: 'project:setAspect', aspect: 'custom', width: wi, height: hi });
    setOpen(false);
    setCustomizing(false);
  };

  return (
    <div className="aspect-menu">
      <button
        className="aspect-btn"
        title="Canvas size (preview + export)"
        onClick={() => {
          setW(String(customW));
          setH(String(customH));
          setCustomizing(false);
          setOpen(!open);
        }}
      >
        <AspectShape w={cur.w} h={cur.h} />
        <span>{aspect === 'custom' ? `${customW}×${customH}` : aspect}</span>
      </button>
      {open && (
        <>
          <div
            className="aspect-backdrop"
            onPointerDown={() => {
              setOpen(false);
              setCustomizing(false);
            }}
          />
          <div className="aspect-pop">
            {!customizing ? (
              <>
                <div className="aspect-pop-title">Canvas size</div>
                {ASPECT_META.map((m) => (
                  <button
                    key={m.id}
                    className={`aspect-item${aspect === m.id ? ' active' : ''}`}
                    onClick={() => pick(m.id)}
                  >
                    <AspectShape w={ratioWH(m.id, 0, 0).w} h={ratioWH(m.id, 0, 0).h} />
                    <span className="aspect-item-label">{m.id}</span>
                    <span className="aspect-item-hint">{m.hint} · {dimsOf(m.id)}</span>
                    {aspect === m.id && <IconCheck size={12} />}
                  </button>
                ))}
                <button
                  className={`aspect-item${aspect === 'custom' ? ' active' : ''}`}
                  onClick={() => {
                    setW(String(customW));
                    setH(String(customH));
                    setCustomizing(true);
                  }}
                >
                  <AspectShape w={customW} h={customH} />
                  <span className="aspect-item-label">Custom</span>
                  <span className="aspect-item-hint">
                    {aspect === 'custom' ? dimsOf('custom') : 'Set your own size…'}
                  </span>
                  {aspect === 'custom' && <IconCheck size={12} />}
                </button>
              </>
            ) : (
              <>
                <div className="aspect-pop-title">Custom size</div>
                <div className="aspect-custom-row">
                  <label>
                    W
                    <input type="number" min={16} value={w} onChange={(e) => setW(e.target.value)} />
                  </label>
                  <span>×</span>
                  <label>
                    H
                    <input type="number" min={16} value={h} onChange={(e) => setH(e.target.value)} />
                  </label>
                </div>
                <div className="aspect-custom-row">
                  <button onClick={() => setCustomizing(false)}>Back</button>
                  <button className="accent" onClick={applyCustom}>
                    Apply
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
