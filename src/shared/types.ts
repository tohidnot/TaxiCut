// Shared domain types for TaxiCut. Used by main, preload, and renderer.

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  thumbnailPath: string | null;
  transcript?: TranscriptSegment[];
}

export type TrackKind = 'video' | 'audio';

export interface Clip {
  id: string;
  mediaId: string;
  name: string;
  /** Timeline position in seconds. */
  startSec: number;
  /** Duration on the timeline in seconds. */
  durationSec: number;
  /** Source in-point in seconds. */
  inSec: number;
  speed: number;
  volumeDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  kind: MediaKind;
  /** Present on text/subtitle clips (mediaId === 'text'). */
  text?: string;
  /** Canvas transform: scale multiplier (1 = contain-fit) and x/y offset
   *  in fractions of the canvas width/height (0 = centered). */
  scale: number;
  posX: number;
  posY: number;
  /** Crop insets as fractions of the source dimensions (0 = no crop). */
  cropL: number;
  cropT: number;
  cropR: number;
  cropB: number;
}

/** Canvas (output frame) aspect ratio. */
export type CanvasAspect = '16:9' | '9:16' | '1:1' | '4:3' | '4:5' | 'custom';

export const CANVAS_ASPECTS: CanvasAspect[] = ['16:9', '9:16', '1:1', '4:3', '4:5'];

export function isPresetAspect(a: string): a is Exclude<CanvasAspect, 'custom'> {
  return (CANVAS_ASPECTS as string[]).includes(a);
}

/** Preview canvas dimensions for an aspect (pixel values only define the ratio). */
export function canvasSize(aspect: CanvasAspect, customW = 0, customH = 0): { width: number; height: number } {
  if (aspect === 'custom') {
    const w = Number.isFinite(customW) && customW >= 16 ? Math.round(customW) : 1920;
    const h = Number.isFinite(customH) && customH >= 16 ? Math.round(customH) : 1080;
    return { width: w, height: h };
  }
  switch (aspect) {
    case '9:16': return { width: 1080, height: 1920 };
    case '1:1': return { width: 1080, height: 1080 };
    case '4:3': return { width: 1440, height: 1080 };
    case '4:5': return { width: 1080, height: 1350 };
    case '16:9':
    default: return { width: 1920, height: 1080 };
  }
}

/** Export pixel dimensions: presets map to fixed sizes, custom fits in 1920px. */
export function exportSize(aspect: CanvasAspect, customW = 0, customH = 0): { width: number; height: number } {
  if (aspect !== 'custom' || !Number.isFinite(customW) || !Number.isFinite(customH) || customW < 16 || customH < 16) {
    return canvasSize(isPresetAspect(aspect) ? aspect : '16:9');
  }
  const f = Math.min(1920 / customW, 1920 / customH, 1);
  const w = Math.max(2, Math.round((customW * f) / 2) * 2);
  const h = Math.max(2, Math.round((customH * f) / 2) * 2);
  return { width: w, height: h };
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  clips: Clip[];
}

export interface Project {
  version: 1;
  name: string;
  /** Canvas aspect ratio for preview and export. Defaults to '16:9'. */
  aspect: CanvasAspect;
  /** Custom canvas pixel size (used when aspect === 'custom'). */
  customW: number;
  customH: number;
  media: MediaAsset[];
  tracks: Track[];
  modified: boolean;
}

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ExportJob {
  id: string;
  outPath: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress: number; // 0..1
  error?: string;
}

export interface ProjectMeta {
  name: string;
  mediaCount: number;
  trackCount: number;
  durationSec: number;
  modified: boolean;
  filePath: string | null;
}

// IPC channel names
export const IPC = {
  projectState: 'taxicut:project-state',
  invoke: 'taxicut:invoke',
  termCreate: 'taxicut:term:create',
  termWrite: 'taxicut:term:write',
  termResize: 'taxicut:term:resize',
  termData: 'taxicut:term:data',
  termExit: 'taxicut:term:exit',
  openFileDialog: 'taxicut:dialog:open',
  saveFileDialog: 'taxicut:dialog:save',
} as const;

/** Operations the renderer can invoke in the main process (also used by MCP). */
export type MainOp =
  | { op: 'project:get' }
  | { op: 'project:new'; name?: string }
  | { op: 'project:open'; path?: string }
  | { op: 'project:save'; path?: string }
  | { op: 'media:import'; paths?: string[] }
  | { op: 'media:delete'; mediaId: string }
  | { op: 'timeline:addClip'; mediaId: string; trackId?: string; startSec?: number; inSec?: number; durationSec?: number }
  | { op: 'timeline:moveClip'; clipId: string; startSec?: number; trackId?: string }
  | { op: 'timeline:trimClip'; clipId: string; edge: 'in' | 'out'; deltaSec: number }
  | { op: 'timeline:splitClip'; clipId: string; atSec: number }
  | { op: 'timeline:deleteClip'; clipId: string; ripple?: boolean }
  | { op: 'clip:setProps'; clipId: string; volumeDb?: number; speed?: number; fadeInSec?: number; fadeOutSec?: number; text?: string; name?: string; scale?: number; posX?: number; posY?: number; cropL?: number; cropT?: number; cropR?: number; cropB?: number }
  | { op: 'project:setAspect'; aspect: string; width?: number; height?: number }
  | { op: 'track:add'; kind: TrackKind }
  | { op: 'track:delete'; trackId: string }
  | { op: 'track:setMute'; trackId: string; muted: boolean }
  | { op: 'track:setLock'; trackId: string; locked: boolean }
  | { op: 'history:undo' }
  | { op: 'history:redo' }
  | { op: 'asr:transcribe'; mediaId: string }
  | { op: 'asr:subtitles'; mediaId: string }
  | { op: 'export:start'; outPath?: string }
  | { op: 'export:status' };

export interface OpResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}
