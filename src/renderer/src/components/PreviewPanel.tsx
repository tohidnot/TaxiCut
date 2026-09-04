import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditor, op } from '../store';
import { formatTimecode } from '../time';
import { canvasSize, clipColorCss, clipFilterById, type CanvasAspect, type Clip, type MediaAsset, type Project, type Track } from '../../../shared/types';
import {
  audioClipsAt,
  baseClipAt,
  clipActiveAt,
  layerClipsAt,
  mediaOf,
  subtitleClipsAt,
  textClipsAt,
  topVisualAt,
  videoDecodeClips,
  visualLayersAt,
} from '../../../shared/timeline';
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

function clipOpacity(clip: Clip | undefined): number {
  if (!clip) return 1;
  const o = Number((clip as { opacity?: unknown }).opacity);
  if (!Number.isFinite(o)) return 1;
  return Math.max(0, Math.min(1, o));
}

function allProjectClips(project: Project): Clip[] {
  return (project.tracks ?? []).flatMap((t) => t.clips);
}

function findClipInProject(project: Project, id: string): Clip | undefined {
  return allProjectClips(project).find((c) => c.id === id);
}

/** One composited timeline layer (upper/lower video tracks, extra audio tracks). */
interface StackLayer {
  track: Track;
  clip: Clip;
  media?: MediaAsset;
  /** Active right now (true) or preloading just ahead of the playhead (false). */
  live: boolean;
}

/**
 * All layers besides the base picture clip (same partition as the export
 * compositor: V1 base, upper layers over it, all audio mixed):
 * - `below`/`above`: live non-text clips on the other unmuted video tracks,
 *   plus the next upcoming video clip per track (preloaded, live=false) so
 *   its decoder is warm before the boundary — no pop-in stalls.
 * - `audio`: live clips on unmuted audio tracks, plus upcoming ones.
 * Live layers come from shared/timeline (identical to export); only the
 * decoder warm-up is preview-specific.
 */
function findTimelineLayers(
  project: Project,
  head: number,
  heroTrackId?: string,
  heroClipId?: string,
  preloadSec = 3,
): { below: StackLayer[]; above: StackLayer[]; audio: StackLayer[] } {
  const tracks = project.tracks ?? [];
  const live = layerClipsAt(project, head, heroTrackId, heroClipId);
  const below: StackLayer[] = live.below.map((l) => ({ ...l, live: true }));
  const above: StackLayer[] = live.above.map((l) => ({ ...l, live: true }));
  const audio: StackLayer[] = audioClipsAt(project, head).map((l) => ({ ...l, live: true }));
  let heroIdx = tracks.length;
  if (heroTrackId) {
    const i = tracks.findIndex((t) => t.id === heroTrackId);
    if (i >= 0) heroIdx = i;
  }
  tracks.forEach((t, i) => {
    if (t.muted) return;
    if (t.kind === 'video') {
      if (t.id === heroTrackId) return;
      if (t.clips.some((c) => c.kind !== 'text' && clipActiveAt(c, head))) return; // live already
      const next = t.clips
        .filter((c) => c.kind !== 'text' && c.startSec >= head && c.startSec - head < preloadSec)
        .sort((a, b) => a.startSec - b.startSec)[0];
      if (!next) return;
      // Images mount instantly — only videos benefit from preloading.
      const media = mediaOf(project, next);
      if (media?.kind !== 'video') return;
      const layer = { track: t, clip: next, media, live: false };
      if (i < heroIdx) below.push(layer);
      else above.push(layer);
    } else {
      if (t.clips.some((c) => clipActiveAt(c, head))) return; // live already
      const next = t.clips
        .filter((c) => c.startSec >= head && c.startSec - head < preloadSec)
        .sort((a, b) => a.startSec - b.startSec)[0];
      if (next) {
        audio.push({ track: t, clip: next, media: mediaOf(project, next), live: false });
      }
    }
  });
  return { below, above, audio };
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
  // audioMuted silences the clip without touching its saved volume.
  const muted = !!clip.audioMuted;
  if (el.muted !== muted) el.muted = muted;
  const vol = muted ? 0 : dbToGain(clip.volumeDb);
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

/** Unique URL per clip so two stacked copies of the same file decode independently. */
function clipMediaUrl(path: string, clipId: string): string {
  const base = window.taxicut.mediaUrl(path);
  return `${base}&layer=${encodeURIComponent(clipId)}`;
}

interface ClipLayout {
  w: number;
  h: number;
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Contain-fit + crop + canvas transform — shared by the compositor and hit-test. */
function clipLayout(
  clip: Clip,
  media: MediaAsset | undefined,
  boxW: number,
  boxH: number,
  t: { scale: number; posX: number; posY: number },
  c: { l: number; t: number; r: number; b: number },
  srcW?: number,
  srcH?: number,
): ClipLayout {
  const mw = srcW && srcW > 0 ? srcW : (media?.width || 0);
  const mh = srcH && srcH > 0 ? srcH : (media?.height || 0);
  const cwFrac = Math.max(0.01, 1 - c.l - c.r);
  const chFrac = Math.max(0.01, 1 - c.t - c.b);
  const effMW = (media?.width || mw) * cwFrac;
  const effMH = (media?.height || mh) * chFrac;
  const fit = (media?.width || mw) > 0 && (media?.height || mh) > 0 && boxW > 0 && boxH > 0
    ? Math.min(boxW / Math.max(1e-6, effMW), boxH / Math.max(1e-6, effMH))
    : 0;
  const layoutW = fit > 0 ? effMW * fit : boxW;
  const layoutH = fit > 0 ? effMH * fit : boxH;
  return {
    w: layoutW,
    h: layoutH,
    cx: boxW / 2 + t.posX * boxW,
    cy: boxH / 2 + t.posY * boxH,
    sx: c.l * mw,
    sy: c.t * mh,
    sw: cwFrac * mw,
    sh: chFrac * mh,
  };
}

function clipCssFilter(clip: Clip): string {
  return [clipFilterById(clip.filter).css, clipColorCss(clip.color)]
    .filter((f) => f && f !== 'none')
    .join(' ');
}

function drawClipLayer(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  media: MediaAsset | undefined,
  source: CanvasImageSource,
  boxW: number,
  boxH: number,
  t: { scale: number; posX: number; posY: number },
  c: { l: number; t: number; r: number; b: number },
): void {
  const srcW = source instanceof HTMLVideoElement
    ? (source.videoWidth || media?.width || 0)
    : source instanceof HTMLImageElement
      ? (source.naturalWidth || media?.width || 0)
      : (media?.width || 0);
  const srcH = source instanceof HTMLVideoElement
    ? (source.videoHeight || media?.height || 0)
    : source instanceof HTMLImageElement
      ? (source.naturalHeight || media?.height || 0)
      : (media?.height || 0);
  if (srcW < 2 || srcH < 2) return;
  const L = clipLayout(clip, media, boxW, boxH, t, c, srcW, srcH);
  if (L.sw < 1 || L.sh < 1 || L.w < 1 || L.h < 1) return;
  ctx.save();
  ctx.translate(L.cx, L.cy);
  ctx.scale(t.scale, t.scale);
  ctx.globalAlpha = clipOpacity(clip);
  const filter = clipCssFilter(clip);
  ctx.filter = filter || 'none';
  try {
    ctx.drawImage(source, L.sx, L.sy, L.sw, L.sh, -L.w / 2, -L.h / 2, L.w, L.h);
  } catch {
    /* decoder not ready */
  }
  ctx.restore();
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

const cornerCursor = (corner: 'nw' | 'ne' | 'sw' | 'se'): string =>
  corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';

// -------------------------------------------------------------
// Text overlay layer (kind === 'text'): one instance per active text clip
// so stacked multi-layer titles all render and stay editable. Positioned
// by the same canvas transform, draggable/resizable, double-click to edit.
// -------------------------------------------------------------
function CanvasTextClip(props: {
  clip: Clip;
  boxW: number;
  boxH: number;
  boxRef: React.RefObject<HTMLDivElement>;
  liveT: LiveTransform | null;
  selected: boolean;
  onSelect: (id: string) => void;
  onBeginDrag: (e: React.PointerEvent, mode: 'move' | 'scale', target: Clip | undefined) => void;
  onCommitText: (clipId: string, text: string) => void;
}) {
  const { clip, boxW, boxH, boxRef, liveT, selected } = props;
  const ref = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [hoverN, setHoverN] = useState(0);
  const [baseRect, setBaseRect] = useState({ x: 0, y: 0, w: 0, h: 0 });

  const isDraggingThis = !!liveT && liveT.id === clip.id;
  const t = isDraggingThis ? liveT : clipTransform(clip);
  const fontPx = boxH > 0 ? Math.max(8, ((clip.fontSize || 72) * boxH) / 1080) : 16;
  const showChrome = hoverN > 0 || selected || isDraggingThis || editing;

  // Measure once when idle (never during its own drag): per-frame
  // getBoundingClientRect + setState during a drag is what flashed.
  // While dragging, handles are derived analytically below.
  useLayoutEffect(() => {
    if (!showChrome || isDraggingThis) return;
    let raf = 0;
    const measure = () => {
      const box = boxRef.current?.getBoundingClientRect();
      const el = ref.current;
      if (!box || !el) return;
      const r = el.getBoundingClientRect();
      const next = { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
      setBaseRect((prev) =>
        Math.abs(prev.x - next.x) > 0.5 ||
        Math.abs(prev.y - next.y) > 0.5 ||
        Math.abs(prev.w - next.w) > 0.5 ||
        Math.abs(prev.h - next.h) > 0.5
          ? next
          : prev,
      );
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showChrome, isDraggingThis, clip.id, clip.text, clip.fontSize, clip.fontFamily, clip.bold,
    clip.textAlign, clip.textColor, clip.textBg, clip.scale, clip.posX, clip.posY,
    boxW, boxH, editing, boxRef,
  ]);

  // Focus once when editing opens (inline ref callbacks re-fire every
  // render and re-select-all on each keystroke — that wedged inline edits).
  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    // Place the caret at the end instead of selecting everything.
    try {
      const n = el.value.length;
      el.setSelectionRange(n, n);
    } catch {
      /* ignore */
    }
  }, [editing]);

  // Reset the draft if a different clip's text arrives mid-edit.
  useEffect(() => {
    if (!editing) setDraft(clip.text ?? '');
  }, [editing, clip.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (save: boolean) => {
    setEditing(false);
    if (save) props.onCommitText(clip.id, draft);
  };

  // Handle positions: idle = measured box; dragging = derived from the
  // base box + live transform delta (no DOM reads, no flicker).
  let rect = baseRect;
  if (isDraggingThis && baseRect.w > 0) {
    const orig = clipTransform(clip);
    const ratio = orig.scale > 0 ? liveT.scale / orig.scale : 1;
    const dx = (liveT.posX - orig.posX) * boxW;
    const dy = (liveT.posY - orig.posY) * boxH;
    const cx = baseRect.x + baseRect.w / 2 + dx;
    const cy = baseRect.y + baseRect.h / 2 + dy;
    const w = baseRect.w * ratio;
    const h = baseRect.h * ratio;
    rect = { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  const corners: { id: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }[] = [
    { id: 'nw', x: rect.x, y: rect.y },
    { id: 'ne', x: rect.x + rect.w, y: rect.y },
    { id: 'sw', x: rect.x, y: rect.y + rect.h },
    { id: 'se', x: rect.x + rect.w, y: rect.y + rect.h },
  ];

  return (
    <>
      <div
        ref={ref}
        className="canvas-text"
        style={{
          left: boxW / 2,
          top: boxH / 2,
          width: 'max-content',
          maxWidth: boxW,
          transform: `translate(${t.posX * boxW}px, ${t.posY * boxH}px) scale(${t.scale}) translate(-50%, -50%)`,
          fontFamily: clip.fontFamily || 'Arial',
          fontSize: fontPx,
          fontWeight: clip.bold ? 700 : 400,
          color: clip.textColor || '#ffffff',
          background: clip.textBg || 'transparent',
          textAlign: clip.textAlign || 'center',
          willChange: 'transform',
          opacity: Number.isFinite((clip as { opacity?: unknown }).opacity)
            ? Math.max(0, Math.min(1, Number((clip as { opacity?: unknown }).opacity)))
            : 1,
        }}
        onPointerDown={(e) => {
          if (editing) {
            e.stopPropagation();
            return;
          }
          props.onBeginDrag(e, 'move', clip);
        }}
        onPointerEnter={() => { if (!isDraggingThis) setHoverN((n) => n + 1); }}
        onPointerLeave={() => setHoverN((n) => Math.max(0, n - 1))}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelect(clip.id);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!editing) {
            setEditing(true);
            setDraft(clip.text ?? '');
          }
        }}
      >
        {editing ? (
          <textarea
            ref={editRef}
            className="canvas-text-edit"
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(true)}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                commit(false);
              } else if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || e.key === 'F2') {
                e.preventDefault();
                e.stopPropagation();
                commit(true);
              } else {
                e.stopPropagation();
              }
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
          clip.text
        )}
      </div>
      {showChrome && !editing && boxW > 0 && rect.w > 0 && corners.map((c) => (
        <div
          key={c.id}
          className="canvas-handle"
          style={{ left: c.x - 6, top: c.y - 6, cursor: cornerCursor(c.id) }}
          onPointerDown={(e) => props.onBeginDrag(e, 'scale', clip)}
          onPointerEnter={() => { if (!isDraggingThis) setHoverN((n) => n + 1); }}
          onPointerLeave={() => setHoverN((n) => Math.max(0, n - 1))}
        />
      ))}
    </>
  );
}

export default function PreviewPanel() {
  const timelineAudioRef = useRef<HTMLAudioElement>(null);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const sourceAudioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveTRef = useRef<LiveTransform | null>(null);
  const liveCropRef = useRef<LiveCrop | null>(null);
  const imageEls = useRef(new Map<string, HTMLImageElement>());
  const paintPreviewRef = useRef<() => void>(() => {});

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

  // Hero = base picture clip (first content-bearing unmuted video track —
  // shared/timeline, identical to the export compositor). Overlays never
  // move it, so the base plays through boundaries without re-buffering.
  const { track: heroTrack, clip: heroClip, media: heroMedia } =
    project ? baseClipAt(project, playhead) : {};
  // Topmost active visual (overlay or hero) — interaction fallback.
  const { clip: topClip } = project ? topVisualAt(project, playhead) : {};
  // First live audio-track clip drives the main audio element; the rest mix
  // through the per-track elements (same mix as export).
  const liveAudio = project ? audioClipsAt(project, playhead) : [];
  const activeAudioClip = liveAudio[0]?.clip;
  const activeAudioMedia = liveAudio[0]?.media;
  // EVERY active text layer renders (not just the topmost), bottom-first.
  const textLayers = project ? textClipsAt(project, playhead) : [];
  const subtitleLayers = project ? subtitleClipsAt(project, playhead) : [];

  // Interaction target: the selected clip when it is an active visual clip,
  // else the topmost active clip, else the hero. Drag/handles/crop/grade UI
  // all follow this; the hero element always shows the base picture.
  const selectedClipObj = project && selectedClipId ? findClipInProject(project, selectedClipId) : undefined;
  const selectedTrack = selectedClipObj
    ? (project?.tracks ?? []).find((t) => t.clips.some((c) => c.id === selectedClipObj.id))
    : undefined;
  const selectedIsVisual = !!selectedClipObj && !!selectedTrack &&
    selectedTrack.kind === 'video' && selectedClipObj.kind !== 'text' &&
    playhead >= selectedClipObj.startSec &&
    playhead < selectedClipObj.startSec + selectedClipObj.durationSec;
  const uiClip = (selectedIsVisual ? selectedClipObj : undefined) ?? topClip ?? heroClip;
  const uiMedia = uiClip ? project?.media.find((m) => m.id === uiClip.mediaId) : undefined;

  const pictureLayers = project ? visualLayersAt(project, playhead) : [];
  const overlayVisualActive = pictureLayers.length > 0;
  // Decoder pool: live + upcoming videos, including muted tracks (eye-toggle
  // must not remount a <video> or the layer comes back black).
  const poolClips = project ? videoDecodeClips(project, playhead) : [];
  // Per-element refs for the best-effort layer sync (keyed by track/clip id).
  // Stable callback refs: inline closures re-fire (null + element) on every
  // render, which thrashes the <video> binding mid-drag and flashes.
  const layerVideoRefs = useRef(new Map<string, HTMLVideoElement>());
  const layerAudioRefs = useRef(new Map<string, HTMLAudioElement>());
  const loadedLayerSrc = useRef(new Map<string, string>());
  const videoRefCache = useRef(new Map<string, (el: HTMLVideoElement | null) => void>());
  const audioRefCache = useRef(new Map<string, (el: HTMLAudioElement | null) => void>());
  const setLayerVideoRef = (key: string) => {
    let fn = videoRefCache.current.get(key);
    if (!fn) {
      fn = (el: HTMLVideoElement | null) => {
        if (el) {
          el.disablePictureInPicture = true;
          layerVideoRefs.current.set(key, el);
        } else {
          layerVideoRefs.current.delete(key);
        }
      };
      videoRefCache.current.set(key, fn);
    }
    return fn;
  };
  const setLayerAudioRef = (key: string) => {
    let fn = audioRefCache.current.get(key);
    if (!fn) {
      fn = (el: HTMLAudioElement | null) => {
        if (el) layerAudioRefs.current.set(key, el);
        else layerAudioRefs.current.delete(key);
      };
      audioRefCache.current.set(key, fn);
    }
    return fn;
  };

  const currentFps = heroMedia?.fps || uiMedia?.fps || 30;

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

  // Kept-region rect + full-source fit in the INTERACTION target's space
  // (the crop overlay edits uiClip, which may be an overlay layer).
  const uiMW = uiMedia?.width || 0;
  const uiMH = uiMedia?.height || 0;
  const uiClipC = uiClip ? clipCrop(uiClip) : { l: 0, t: 0, r: 0, b: 0 };
  const uiEffC: LiveCrop | { l: number; t: number; r: number; b: number } =
    liveCrop && uiClip && liveCrop.id === uiClip.id ? liveCrop : uiClip ? uiClipC : { l: 0, t: 0, r: 0, b: 0 };
  const uiFullFit = uiMW > 0 && uiMH > 0 && boxW > 0 && boxH > 0 ? Math.min(boxW / uiMW, boxH / uiMH) : 0;
  const uiFullW = uiFullFit > 0 ? uiMW * uiFullFit : boxW;
  const uiFullH = uiFullFit > 0 ? uiMH * uiFullFit : boxH;
  const uiFullL = (boxW - uiFullW) / 2;
  const uiFullT = (boxH - uiFullH) / 2;
  const keepL = uiFullL + uiEffC.l * uiFullW;
  const keepT = uiFullT + uiEffC.t * uiFullH;
  const keepW = uiFullW * Math.max(0.01, 1 - uiEffC.l - uiEffC.r);
  const keepH = uiFullH * Math.max(0.01, 1 - uiEffC.t - uiEffC.b);
  // Transformed rect of the INTERACTION target in box pixels (resize handles).
  const uiClipT = uiClip ? clipTransform(uiClip) : { scale: 1, posX: 0, posY: 0 };
  const uiEffT: LiveTransform | { scale: number; posX: number; posY: number } =
    liveT && uiClip && liveT.id === uiClip.id ? liveT : uiClip ? uiClipT : { scale: 1, posX: 0, posY: 0 };
  const uiCwFrac = Math.max(0.01, 1 - uiEffC.l - uiEffC.r);
  const uiChFrac = Math.max(0.01, 1 - uiEffC.t - uiEffC.b);
  const uiEffMW = uiMW * uiCwFrac;
  const uiEffMH = uiMH * uiChFrac;
  const uiBaseFit = uiMW > 0 && uiMH > 0 && boxW > 0 && boxH > 0 ? Math.min(boxW / uiEffMW, boxH / uiEffMH) : 0;
  const uiBaseW = uiBaseFit > 0 ? uiEffMW * uiBaseFit : 0;
  const uiBaseH = uiBaseFit > 0 ? uiEffMH * uiBaseFit : 0;
  const rectCX = boxW / 2 + uiEffT.posX * boxW;
  const rectCY = boxH / 2 + uiEffT.posY * boxH;
  const rectW = uiBaseW * uiEffT.scale;
  const rectH = uiBaseH * uiEffT.scale;

  const imageEl = (media: MediaAsset): HTMLImageElement => {
    let img = imageEls.current.get(media.id);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = window.taxicut.mediaUrl(media.path);
      img.onload = () => paintPreviewRef.current();
      imageEls.current.set(media.id, img);
    }
    return img;
  };

  const paintPreview = () => {
    const canvas = canvasRef.current;
    const st = useEditor.getState();
    const proj = st.project;
    if (!canvas || !proj || boxW <= 0 || boxH <= 0 || st.previewMode !== 'timeline') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(boxW * dpr));
    const ph = Math.max(1, Math.round(boxH * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, boxW, boxH);
    const head = st.playheadSec;
    const lt = liveTRef.current;
    const lc = liveCropRef.current;
    const cropOn = st.cropMode;
    const uiId = st.selectedClipId;
    for (const { clip, media } of visualLayersAt(proj, head)) {
      if (!media || (media.kind !== 'video' && media.kind !== 'image')) continue;
      let source: CanvasImageSource | null = null;
      if (media.kind === 'video') {
        const el = layerVideoRefs.current.get(clip.id);
        // HAVE_CURRENT_DATA (2)+ only — drawing an empty decoder paints an
        // opaque black rect and hides every layer underneath.
        if (!el || el.readyState < 2 || el.videoWidth < 2) continue;
        source = el;
      } else {
        const img = imageEl(media);
        if (!img.complete || img.naturalWidth < 2) continue;
        source = img;
      }
      const t = lt && lt.id === clip.id ? lt : clipTransform(clip);
      const cropTarget = cropOn && (uiId === clip.id || uiClip?.id === clip.id);
      const c = cropTarget
        ? { l: 0, t: 0, r: 0, b: 0 }
        : (lc && lc.id === clip.id ? { l: lc.l, t: lc.t, r: lc.r, b: lc.b } : clipCrop(clip));
      drawClipLayer(ctx, clip, media, source, boxW, boxH, t, c);
    }
  };
  paintPreviewRef.current = paintPreview;
  liveTRef.current = liveT;
  liveCropRef.current = liveCrop;

  // Decoder pool + extra audio tracks. Picture is composited on the canvas
  // from these elements (they stay off-screen, untransformed, so Chromium
  // can decode many at once). Unique per-clip URLs avoid a shared pipeline.
  const syncPoolAndAudio = (
    head: number,
    proj: Project,
    paused: boolean,
    heroTrackId?: string,
    heroClipId?: string,
    mainAudioId?: string,
  ) => {
    const pool = videoDecodeClips(proj, head);
    const thresh = paused ? 0.04 : 0.4;
    for (const l of pool) {
      if (l.media?.kind !== 'video') continue;
      const el = layerVideoRefs.current.get(l.clip.id);
      if (!el) continue;
      const token = `${l.media.id}:${l.clip.id}`;
      if (loadedLayerSrc.current.get(l.clip.id) !== token) {
        loadedLayerSrc.current.set(l.clip.id, token);
        el.src = clipMediaUrl(l.media.path, l.clip.id);
        el.load();
      }
      const live = clipActiveAt(l.clip, head);
      if (l.track.muted) {
        el.muted = true;
        if (!el.paused) el.pause();
        continue;
      }
      applyProps(el, l.clip);
      if (!live) {
        syncClock(el, l.clip.inSec, thresh);
        if (!el.paused) el.pause();
        continue;
      }
      const target = l.clip.inSec + (head - l.clip.startSec) * l.clip.speed;
      syncClock(el, target, thresh);
      if (paused) {
        if (!el.paused) el.pause();
      } else {
        playQuiet(el);
      }
    }
    const { audio } = findTimelineLayers(proj, head, heroTrackId, heroClipId);
    for (const t of proj.tracks ?? []) {
      if (t.kind !== 'audio') continue;
      const el = layerAudioRefs.current.get(t.id);
      if (!el) continue;
      const layer = audio.find((x) => x.track.id === t.id);
      if (!layer || !layer.media || layer.clip.id === mainAudioId) {
        if (!el.paused) el.pause();
        continue;
      }
      const key = `a:${t.id}`;
      if (loadedLayerSrc.current.get(key) !== layer.media.id) {
        loadedLayerSrc.current.set(key, layer.media.id);
        el.src = window.taxicut.mediaUrl(layer.media.path);
        el.load();
      }
      applyProps(el, layer.clip);
      if (!layer.live) {
        syncClock(el, layer.clip.inSec, thresh);
        if (!el.paused) el.pause();
        continue;
      }
      syncClock(el, layer.clip.inSec + (head - layer.clip.startSec) * layer.clip.speed, thresh);
      if (!paused) playQuiet(el);
    }
  };
  const pauseExtraLayers = () => {
    for (const el of layerVideoRefs.current.values()) {
      try {
        el.pause();
      } catch {
        /* noop */
      }
    }
    for (const el of layerAudioRefs.current.values()) {
      try {
        el.pause();
      } catch {
        /* noop */
      }
    }
  };

  // -------------------------------------------------------------
  // Canvas drag (move) + corner-drag (uniform scale), CapCut-style.
  // Live state only; committed to the clip on pointer-up (one undo step).
  // Window-level move/up listeners (like the timeline): element-local
  // onPointerMove loses the pointer on fast moves and the clip jumps/flashes.
  // -------------------------------------------------------------
  const dragRaf = useRef(0);
  const applyLiveT = (next: LiveTransform) => {
    liveTRef.current = next;
    if (dragRaf.current) cancelAnimationFrame(dragRaf.current);
    dragRaf.current = requestAnimationFrame(() => {
      dragRaf.current = 0;
      setLiveT(next);
      paintPreviewRef.current();
    });
  };

  const beginDrag = (e: React.PointerEvent, mode: 'move' | 'scale', target: Clip | undefined) => {
    e.preventDefault();
    e.stopPropagation();
    if (!target || boxW <= 0 || boxH <= 0 || cropMode) return;
    // Don't start a canvas drag from inside an active text edit.
    if ((e.target as HTMLElement | null)?.closest?.('.canvas-text-edit')) return;
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
    const startT = { id: target.id, ...t };
    liveTRef.current = startT;
    setLiveT(startT);
    select(target.id);

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || boxW <= 0 || boxH <= 0) return;
      d.lastX = ev.clientX;
      d.lastY = ev.clientY;
      if (d.mode === 'move') {
        applyLiveT({
          id: d.clipId,
          scale: d.orig.scale,
          posX: d.orig.posX + (ev.clientX - d.startX) / boxW,
          posY: d.orig.posY + (ev.clientY - d.startY) / boxH,
        });
      } else {
        const dist = Math.max(4, Math.hypot(ev.clientX - d.centerX, ev.clientY - d.centerY));
        const scale = Math.max(0.05, Math.min(8, d.orig.scale * (dist / d.startDist)));
        applyLiveT({ id: d.clipId, scale, posX: d.orig.posX, posY: d.orig.posY });
      }
    };

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onAbort);
      if (dragRaf.current) {
        cancelAnimationFrame(dragRaf.current);
        dragRaf.current = 0;
      }
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (!d) {
        setLiveT(null);
        return;
      }
      const moved = Math.hypot(d.lastX - d.startX, d.lastY - d.startY);
      setLiveT((prev) => {
        const latest = prev && prev.id === d.clipId ? prev : { id: d.clipId, ...d.orig } as LiveTransform;
        // Re-derive from the last pointer so a queued rAF can't drop the tail.
        let finalT = latest;
        if (commit && moved >= 4) {
          if (d.mode === 'move') {
            finalT = {
              id: d.clipId,
              scale: d.orig.scale,
              posX: d.orig.posX + (d.lastX - d.startX) / boxW,
              posY: d.orig.posY + (d.lastY - d.startY) / boxH,
            };
          } else {
            const dist = Math.max(4, Math.hypot(d.lastX - d.centerX, d.lastY - d.centerY));
            finalT = {
              id: d.clipId,
              scale: Math.max(0.05, Math.min(8, d.orig.scale * (dist / d.startDist))),
              posX: d.orig.posX,
              posY: d.orig.posY,
            };
          }
          const changed =
            Math.abs(finalT.scale - d.orig.scale) > 1e-4 ||
            Math.abs(finalT.posX - d.orig.posX) > 1e-4 ||
            Math.abs(finalT.posY - d.orig.posY) > 1e-4;
          if (changed) {
            op({
              op: 'clip:setProps',
              clipId: d.clipId,
              scale: round4(finalT.scale),
              posX: round4(finalT.posX),
              posY: round4(finalT.posY),
            });
          }
        } else if (moved < 4) {
          select(d.clipId);
        }
        return null;
      });
    };

    const onUp = () => finish(true);
    const onAbort = () => finish(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onAbort);
  };

  const handleCursor = (corner: 'nw' | 'ne' | 'sw' | 'se'): string =>
    corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';

  // Hover ref-count over the layer/handles (enter/leave pairs can't flicker).
  const hoverEnter = () => setHoverN((n) => n + 1);
  const hoverLeave = () => setHoverN((n) => Math.max(0, n - 1));

  // Transform chrome shows while interacting, hovering the video, or when the
  // active clip is selected. It hides when the pointer leaves the viewer.
  const isActiveSelected = !!uiClip && selectedClipId === uiClip.id;
  const showChrome =
    previewMode === 'timeline' && !cropMode && !!uiClip && (dragging || hoverN > 0 || isActiveSelected);

  const renderHandles = () => {
    if (!showChrome || boxW <= 0 || rectW <= 0) return null;
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
            onPointerDown={(e) => beginDrag(e, 'scale', uiClip)}
            onPointerEnter={() => { if (!dragRef.current) hoverEnter(); }}
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
    if (!uiClip || boxW <= 0 || uiFullW <= 0) return;
    const c = uiClip ? clipCrop(uiClip) : { l: 0, t: 0, r: 0, b: 0 };
    cropDragRef.current = {
      clipId: uiClip.id,
      edge,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      orig: liveCrop && liveCrop.id === uiClip.id
        ? { l: liveCrop.l, t: liveCrop.t, r: liveCrop.r, b: liveCrop.b }
        : c,
    };
    setDragging(true);
    setLiveCrop({ id: uiClip.id, ...cropDragRef.current.orig });
    try {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const moveCropDrag = (e: React.PointerEvent) => {
    const d = cropDragRef.current;
    if (!d || !uiClip || d.clipId !== uiClip.id || uiFullW <= 0 || uiFullH <= 0) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const fx = (e.clientX - box.left - uiFullL) / uiFullW;
    const fy = (e.clientY - box.top - uiFullT) / uiFullH;
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
    if (!cropMode || !uiClip || boxW <= 0 || uiFullW <= 0) return null;
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
        <div style={{ ...shade, left: uiFullL, top: uiFullT, width: uiFullW, height: uiEffC.t * uiFullH }} />
        <div style={{ ...shade, left: uiFullL, top: keepT + keepH, width: uiFullW, height: Math.max(0, uiFullT + uiFullH - keepT - keepH) }} />
        <div style={{ ...shade, left: uiFullL, top: keepT, width: uiEffC.l * uiFullW, height: keepH }} />
        <div style={{ ...shade, left: keepL + keepW, top: keepT, width: Math.max(0, uiFullL + uiFullW - keepL - keepW), height: keepH }} />
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

  // Text commit for inline canvas editing (one undo step per edit).
  const commitTextEdit = (clipId: string, v: string) => {
    const proj = useEditor.getState().project;
    const cur = proj ? findClipInProject(proj, clipId) : undefined;
    if (cur && v.trim().length > 0 && v !== (cur.text ?? '')) {
      op({ op: 'clip:setProps', clipId, text: v, name: v.slice(0, 40) });
    }
  };

  // -------------------------------------------------------------
  // 1) Timeline playback: wall-clock drives the playhead, media slaves to it.
  //    Effect depends only on [playing, previewMode] so crossing clip
  //    boundaries never tears down the RAF loop (the old freeze).
  // -------------------------------------------------------------
  useEffect(() => {
    if (previewMode !== 'timeline') {
      timelineAudioRef.current?.pause();
      pauseExtraLayers();
      return;
    }
    if (!playing) {
      timelineAudioRef.current?.pause();
      pauseExtraLayers();
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

      const a0 = audioClipsAt(proj, head)[0];
      const ac = a0?.clip;
      const am = a0?.media;
      const { track: ht, clip: hc } = baseClipAt(proj, head);

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

      // Every picture layer (hero + overlays) and extra audio tracks.
      // Do not stall the playhead if one overlay is still seeking — the
      // others keep playing, which is what split-screen / intro templates need.
      syncPoolAndAudio(head, proj, false, ht?.id, hc?.id, ac?.id);
      paintPreviewRef.current();

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
  //    Seeks fired before metadata arrives are dropped by the media
  //    element, so resyncPausedPreview is ALSO re-run on loadeddata —
  //    otherwise a src switch while paused (mute toggle, undo, clip add)
  //    can wedge the frame black until the user scrubs or plays.
  // -------------------------------------------------------------
  const resyncPausedPreview = () => {
    const st = useEditor.getState();
    const proj = st.project;
    if (!proj || st.previewMode !== 'timeline' || st.playing) return;
    const head = st.playheadSec;
    const { track: ht, clip: hc } = baseClipAt(proj, head);
    const a0 = audioClipsAt(proj, head)[0];
    const a = timelineAudioRef.current;
    if (a) {
      if (a0?.media && a0?.clip) {
        ensureSrc(a, loadedTimelineAudioId, a0.media);
        applyProps(a, a0.clip);
        if (!a.paused) a.pause();
        syncClock(a, a0.clip.inSec + (head - a0.clip.startSec) * a0.clip.speed, 0.04);
      } else if (!a.paused) {
        a.pause();
      }
    }
    syncPoolAndAudio(head, proj, true, ht?.id, hc?.id, a0?.clip?.id);
    paintPreviewRef.current();
  };

  useEffect(() => {
    resyncPausedPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, playing, playhead, project]);

  // Paint while paused / after layout (size, crop, transform). Playback rAF
  // owns the paint while playing so we don't draw twice per frame.
  useLayoutEffect(() => {
    if (playing && previewMode === 'timeline') return;
    paintPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, playing, playhead, project, boxW, boxH, liveT, liveCrop, cropMode, aspect, selectedClipId]);

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

  // Source scrub while paused (same dropped-seek hardening as the timeline).
  const resyncPausedSource = () => {
    const st = useEditor.getState();
    const media = st.previewMode === 'source' && !st.sourcePlaying
      ? st.project?.media.find((m) => m.id === st.selectedMediaId)
      : undefined;
    if (!media || media.kind === 'image') return;
    const el = media.kind === 'video' ? sourceVideoRef.current : sourceAudioRef.current;
    if (!el) return;
    ensureSrc(el, loadedSourceId, media);
    if (!el.paused) el.pause();
    syncClock(el, st.sourcePlayheadSec, 0.04);
  };

  // Source scrub while paused.
  useEffect(() => {
    resyncPausedSource();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, sourcePlaying, sourcePlayhead, sourceMedia]);

  // Keep the non-active engine parked when switching modes.
  useEffect(() => {
    if (previewMode === 'timeline') {
      sourceVideoRef.current?.pause();
      sourceAudioRef.current?.pause();
      setSourcePlaying(false);
    } else {
      pauseExtraLayers();
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

  const hitVisualAt = (clientX: number, clientY: number): Clip | undefined => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || !project || boxW <= 0 || boxH <= 0) return undefined;
    const x = clientX - box.left;
    const y = clientY - box.top;
    const lt = liveTRef.current;
    const lc = liveCropRef.current;
    const layers = visualLayersAt(project, playhead);
    for (let i = layers.length - 1; i >= 0; i--) {
      const { clip, media } = layers[i];
      if (!media || (media.kind !== 'video' && media.kind !== 'image')) continue;
      const t = lt && lt.id === clip.id ? lt : clipTransform(clip);
      const c = lc && lc.id === clip.id
        ? { l: lc.l, t: lc.t, r: lc.r, b: lc.b }
        : clipCrop(clip);
      const L = clipLayout(clip, media, boxW, boxH, t, c);
      const w = L.w * t.scale;
      const h = L.h * t.scale;
      if (x >= L.cx - w / 2 && x <= L.cx + w / 2 && y >= L.cy - h / 2 && y <= L.cy + h / 2) {
        return clip;
      }
    }
    return undefined;
  };

  const layerPointerHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (cropMode) return;
      if (e.target !== e.currentTarget && (e.target as HTMLElement).tagName !== 'CANVAS') return;
      const hit = hitVisualAt(e.clientX, e.clientY);
      if (hit) beginDrag(e, 'move', hit);
      else select(null);
    },
    onPointerEnter: () => { if (!dragRef.current) hoverEnter(); },
    onPointerLeave: hoverLeave,
  };

  const centerActiveClip = () => {
    if (uiClip) {
      op({ op: 'clip:setProps', clipId: uiClip.id, posX: 0, posY: 0 });
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
              disabled={!uiClip}
              onClick={centerActiveClip}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              <IconCenter size={13} />
            </button>
            <button
              className={`icon${cropMode ? ' accent' : ''}`}
              title={cropMode ? 'Exit crop mode (Esc)' : 'Crop mode'}
              disabled={!uiClip}
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
              {...layerPointerHandlers}
            >
              {/* All picture layers (video + image, any stack order) are drawn
                  here so Chromium never has to composite multiple transformed
                  <video> overlays — that path goes black past the first clip. */}
              <div className="video-pool" aria-hidden="true">
                {poolClips.map((l) => (
                  <video
                    key={l.clip.id}
                    ref={setLayerVideoRef(l.clip.id)}
                    playsInline
                    preload="auto"
                    onWaiting={onNeedBuffer}
                    onStalled={onNeedBuffer}
                    onPlaying={onCanPlay}
                    onCanPlay={onCanPlay}
                    onLoadedData={() => {
                      onCanPlay();
                      resyncPausedPreview();
                      paintPreviewRef.current();
                    }}
                    onSeeked={() => paintPreviewRef.current()}
                    onError={onMediaError}
                  />
                ))}
              </div>
              <canvas ref={canvasRef} className="preview-canvas" />

              {renderHandles()}
              {renderCropOverlay()}

              {/* Text overlay layers: every active text clip (bottom-first),
                  each draggable/resizable, double-click to edit. */}
              {previewMode === 'timeline' && !cropMode && textLayers.map((l) => (
                <CanvasTextClip
                  key={l.clip.id}
                  clip={l.clip}
                  boxW={boxW}
                  boxH={boxH}
                  boxRef={boxRef}
                  liveT={liveT}
                  selected={selectedClipId === l.clip.id}
                  onSelect={select}
                  onBeginDrag={beginDrag}
                  onCommitText={commitTextEdit}
                />
              ))}

              {/* Timeline audio-only indicator (no picture under playhead but audio is present). */}
              {!heroClip && !overlayVisualActive && activeAudioMedia && (
                <div className="preview-audio-indicator" style={{ position: 'absolute', inset: 0, justifyContent: 'center', zIndex: 2 }}>
                  <span className="audio-icon"><IconAudio size={42} /></span>
                  <span className="audio-title">{activeAudioMedia.name}</span>
                </div>
              )}

              {/* Timeline empty state */}
              {!heroClip && !overlayVisualActive && !activeAudioMedia && (
                <div className="preview-empty-stage" style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
                  {tracks.every((t) => t.clips.length === 0) ? (
                    <div className="preview-empty-hint">
                      Timeline is empty.
                      <br />
                      Drag media from Library or Desktop to add clips.
                    </div>
                  ) : null}
                </div>
              )}

              {/* Subtitle captions: every active subtitle clip, stacked. */}
              {subtitleLayers.length > 0 && (
                <div className="preview-subtitles">
                  {subtitleLayers.map((s) => (
                    <div key={s.clip.id} className="preview-subtitle" style={{ fontSize: subtitleSize }}>
                      {s.clip.text}
                    </div>
                  ))}
                </div>
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
                onLoadedData={() => {
                  onCanPlay();
                  resyncPausedSource();
                }}
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
            onLoadedData={() => resyncPausedPreview()}
            onError={onMediaError}
            style={{ display: 'none' }}
          />
          {/* One mixer element per audio track (2nd+ tracks join the mix). */}
          {tracks.filter((t) => t.kind === 'audio').map((t) => (
            <audio key={t.id} ref={setLayerAudioRef(t.id)} preload="auto" style={{ display: 'none' }} />
          ))}
          <audio
            ref={sourceAudioRef}
            preload="auto"
            onWaiting={onNeedBuffer}
            onPlaying={onCanPlay}
            onLoadedData={() => resyncPausedSource()}
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
