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
  | { op: 'clip:setProps'; clipId: string; volumeDb?: number; speed?: number; fadeInSec?: number; fadeOutSec?: number; text?: string; name?: string }
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
