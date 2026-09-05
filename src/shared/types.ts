// Shared domain types for TaxiCut. Used by main, preload, and renderer.

export type MediaKind = 'video' | 'audio' | 'image' | 'text';

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

/** Per-clip color grade. exposure/warmth are -1..1 (0 = neutral),
 *  contrast/saturation are multipliers (1 = neutral). */
export interface ClipColor {
  exposure: number;
  contrast: number;
  saturation: number;
  warmth: number;
}

export const DEFAULT_CLIP_COLOR: ClipColor = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };

/** Normalize a partial/stale color object to valid ranges. */
export function normClipColor(c: Partial<ClipColor> | undefined): ClipColor {
  const d = DEFAULT_CLIP_COLOR;
  const num = (v: unknown, fb: number): number => (Number.isFinite(v) ? Number(v) : fb);
  return {
    exposure: Math.max(-1, Math.min(1, num(c?.exposure, d.exposure))),
    contrast: Math.max(0, Math.min(2, num(c?.contrast, d.contrast))),
    saturation: Math.max(0, Math.min(2, num(c?.saturation, d.saturation))),
    warmth: Math.max(-1, Math.min(1, num(c?.warmth, d.warmth))),
  };
}

export function isDefaultColor(c: ClipColor | undefined): boolean {
  if (!c) return true;
  return c.exposure === 0 && c.contrast === 1 && c.saturation === 1 && c.warmth === 0;
}

/** CSS filter fragment for the live preview ('' when neutral). Approximate match of the ffmpeg chain. */
export function clipColorCss(c: ClipColor | undefined): string {
  if (!c || isDefaultColor(c)) return '';
  const parts = [
    `brightness(${(1 + c.exposure).toFixed(3)})`,
    `contrast(${c.contrast.toFixed(3)})`,
    `saturate(${c.saturation.toFixed(3)})`,
  ];
  if (c.warmth > 0.005) parts.push(`sepia(${(c.warmth * 0.35).toFixed(3)})`);
  else if (c.warmth < -0.005) parts.push(`hue-rotate(${(c.warmth * 12).toFixed(1)}deg)`);
  return parts.join(' ');
}

/** Normalize opacity to 0..1 (1 = opaque). */
export function normOpacity(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

/** ffmpeg filter chain fragment for export ('' when neutral). */
export function clipColorFf(c: ClipColor | undefined): string {
  if (!c || isDefaultColor(c)) return '';
  const parts: string[] = [];
  if (c.exposure !== 0 || c.contrast !== 1 || c.saturation !== 1) {
    parts.push(`eq=brightness=${c.exposure.toFixed(3)}:contrast=${c.contrast.toFixed(3)}:saturation=${c.saturation.toFixed(3)}`);
  }
  if (Math.abs(c.warmth) >= 0.005) {
    const w = c.warmth;
    parts.push(
      `colorbalance=rs=${(w * 0.3).toFixed(3)}:gs=0.000:bs=${(-w * 0.3).toFixed(3)}` +
      `:rm=${(w * 0.18).toFixed(3)}:gm=0.000:bm=${(-w * 0.18).toFixed(3)}`,
    );
  }
  return parts.join(',');
}

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
  /** True = this clip's audio is silent (the picture still shows). */
  audioMuted: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  kind: MediaKind;
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
  /** Color filter preset id ('' = none). Applies to video/image clips. */
  filter: string;
  /** Manual color grade (grading sliders). Combined with `filter` on export/preview. */
  color: ClipColor;
  /** Text overlay content (kind === 'text', or subtitle text on media clips). */
  text?: string;
  /** Layer opacity 0..1 (1 = opaque). Upper video layers blend over lower ones. */
  opacity: number;
  /** Text styling (kind === 'text'). fontSize is px at 1080p canvas height. */
  fontFamily: string;
  fontSize: number;
  textColor: string;
  /** Background fill hex ('' = transparent). */
  textBg: string;
  bold: boolean;
  textAlign: 'left' | 'center' | 'right';
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

export type TextAlign = 'left' | 'center' | 'right';

export interface TextTemplate {
  id: string;
  name: string;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  textBg: string;
  bold: boolean;
  textAlign: TextAlign;
  posX: number;
  posY: number;
  scale: number;
  sample: string;
}

export const FONT_FAMILIES = [
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Courier New',
  'Georgia',
  'Verdana',
  'Impact',
];

/** Baked-in text styles. Export uses the baked clip values, so templates are UI sugar. */
export const TEXT_TEMPLATES: TextTemplate[] = [
  { id: 'title', name: 'Title', fontFamily: 'Arial', fontSize: 120, textColor: '#ffffff', textBg: '', bold: true, textAlign: 'center', posX: 0, posY: -0.05, scale: 1, sample: 'Your Title' },
  { id: 'subtitle', name: 'Subtitle', fontFamily: 'Arial', fontSize: 64, textColor: '#ffffff', textBg: '', bold: false, textAlign: 'center', posX: 0, posY: 0.32, scale: 1, sample: 'Subtitle text' },
  { id: 'lower', name: 'Lower Third', fontFamily: 'Arial', fontSize: 56, textColor: '#ffffff', textBg: '', bold: true, textAlign: 'left', posX: -0.25, posY: 0.3, scale: 1, sample: 'Name Here' },
  { id: 'pop', name: 'Pop', fontFamily: 'Impact', fontSize: 150, textColor: '#FFD23F', textBg: '', bold: true, textAlign: 'center', posX: 0, posY: 0, scale: 1, sample: 'WOW!' },
  { id: 'quote', name: 'Quote', fontFamily: 'Georgia', fontSize: 72, textColor: '#ffffff', textBg: '', bold: false, textAlign: 'center', posX: 0, posY: 0, scale: 1, sample: '“Great quote”' },
];

export function textTemplateById(id: string | undefined): TextTemplate {
  return TEXT_TEMPLATES.find((t) => t.id === id) ?? TEXT_TEMPLATES[0];
}

export interface ClipFilter {
  id: string;
  name: string;
  /** CSS filter for the live preview. */
  css: string;
  /** ffmpeg filter chain fragment for export ('' = none). */
  ff: string;
}

/** Color looks. css/ffmpeg pairs are matched approximately (same intent). */
export const CLIP_FILTERS: ClipFilter[] = [
  { id: '', name: 'None', css: 'none', ff: '' },
  { id: 'vivid', name: 'Vivid', css: 'contrast(1.1) saturate(1.4)', ff: 'eq=contrast=1.1:saturation=1.4' },
  { id: 'warm', name: 'Warm', css: 'sepia(0.28) saturate(1.25) contrast(1.02)', ff: 'colorbalance=rs=0.25:gs=0.1:bs=-0.2:rm=0.12:bm=-0.1,eq=saturation=1.12:contrast=1.02' },
  { id: 'cool', name: 'Cool', css: 'saturate(1.1) hue-rotate(15deg)', ff: 'colorbalance=rs=-0.2:bs=0.25:rm=-0.1:bm=0.12,eq=saturation=1.05' },
  { id: 'mono', name: 'Mono', css: 'grayscale(1) contrast(1.05)', ff: 'colorchannelmixer=.299:.587:.114:0:.299:.587:.114:0:.299:.587:.114,eq=contrast=1.05' },
  { id: 'noir', name: 'Noir', css: 'grayscale(1) contrast(1.4) brightness(0.95)', ff: 'colorchannelmixer=.299:.587:.114:0:.299:.587:.114:0:.299:.587:.114,eq=contrast=1.4:brightness=-0.03' },
  { id: 'vintage', name: 'Vintage', css: 'sepia(0.5) contrast(0.95) brightness(1.03) saturate(0.9)', ff: 'colorbalance=rs=0.2:gs=0.05:bs=-0.2:rm=0.1:bm=-0.1,eq=contrast=0.92:saturation=0.85:brightness=0.03' },
  { id: 'fade', name: 'Fade', css: 'contrast(0.85) brightness(1.06) saturate(0.8)', ff: 'eq=contrast=0.85:brightness=0.04:saturation=0.8' },
];

export function clipFilterById(id: string | undefined): ClipFilter {
  return CLIP_FILTERS.find((f) => f.id === (id ?? '')) ?? CLIP_FILTERS[0];
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
  | { op: 'timeline:addClip'; mediaId: string; trackId?: string; startSec?: number; inSec?: number; durationSec?: number; text?: string; template?: string }
  | { op: 'timeline:moveClip'; clipId: string; startSec?: number; trackId?: string; place?: 'auto' | 'layer' }
  | { op: 'timeline:reorderClip'; clipId: string; direction?: 1 | -1; toIndex?: number; position?: 'front' | 'back' }
  | { op: 'timeline:trimClip'; clipId: string; edge: 'in' | 'out'; deltaSec: number }
  | { op: 'timeline:splitClip'; clipId: string; atSec: number }
  | { op: 'timeline:deleteClip'; clipId: string; ripple?: boolean }
  | { op: 'timeline:duplicateClip'; clipId: string; startSec?: number; trackId?: string }
  | { op: 'clip:setProps'; clipId: string; volumeDb?: number; speed?: number; audioMuted?: boolean; fadeInSec?: number; fadeOutSec?: number; text?: string; name?: string; scale?: number; posX?: number; posY?: number; cropL?: number; cropT?: number; cropR?: number; cropB?: number; filter?: string; color?: Partial<ClipColor>; fontFamily?: string; fontSize?: number; textColor?: string; textBg?: string; bold?: boolean; textAlign?: TextAlign; opacity?: number }
  | { op: 'project:setAspect'; aspect: string; width?: number; height?: number }
  | { op: 'track:add'; kind: TrackKind; atIndex?: number }
  | { op: 'track:delete'; trackId: string }
  | { op: 'track:move'; trackId: string; toIndex?: number; direction?: 1 | -1 }
  | { op: 'track:setMute'; trackId: string; muted: boolean }
  | { op: 'track:setAudioMute'; trackId: string; muted: boolean }
  | { op: 'track:setLock'; trackId: string; locked: boolean }
  | { op: 'history:undo' }
  | { op: 'history:redo' }
  | { op: 'asr:transcribe'; mediaId: string }
  | { op: 'asr:subtitles'; mediaId: string }
  | { op: 'export:start'; outPath?: string }
  | { op: 'export:status' }
  | { op: 'agents:status' };

export interface OpResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}
