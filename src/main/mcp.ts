// MCP server for TaxiCut: editing tools + resources + prompts.
//
// Transports:
// - Streamable HTTP (stateless) at POST /mcp — the live Electron app shares its
//   ProjectStore here so external agents edit the open project.
// - stdio via startMcpStdioServer() — headless use (CI, agents without the GUI).
//
// Electron-free so it can be smoke-tested in plain Node.
// Standard practices followed: registerTool with title/description/annotations,
// Zod strict input schemas, outputSchema + structuredContent on reads,
// pagination + CHARACTER_LIMIT truncation, actionable errors, Origin checks.
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ProjectStore } from './store';
import { probeMedia, mediaKind, makeThumbnail, exportProject, FFMPEG, FFPROBE } from './ffmpeg';
import { transcribe, toSrt, asrAvailable } from './asr';
import { exportSize } from '../shared/types';
import type { Clip, ExportJob, Track, TranscriptSegment } from '../shared/types';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

export const MCP_SERVER_NAME = 'taxicut-mcp-server';
export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_DEFAULT_PORT = 19789;
/** Hard counts surfaced by server_info (asserted in the smoke test so they stay honest). */
export const MCP_TOOL_COUNT = 32;
export const MCP_RESOURCE_COUNT = 3;
export const MCP_PROMPT_COUNT = 3;
/** Max JSON text per tool response; larger payloads are truncated with a hint. */
export const CHARACTER_LIMIT = 25000;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
/** Max MCP HTTP request body (exports reference paths, never file bytes). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpDeps {
  store: ProjectStore;
  cacheDir: string;
}

// ---------- response helpers ----------

/** JSON text, truncated at CHARACTER_LIMIT with recovery guidance. */
function toText(data: unknown): string {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= CHARACTER_LIMIT) return text;
  return JSON.stringify(
    {
      truncated: true,
      preview: text.slice(0, CHARACTER_LIMIT),
      hint: 'Response truncated. Use limit/offset (list_media), summary mode (get_timeline), or the focused find_clips / get_clip tools.',
    },
    null,
    2,
  );
}

const ok = (data: unknown, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: toText(data) }],
  ...(structured ? { structuredContent: structured } : {}),
});

const fail = (message: string, hint?: string) => ({
  isError: true as const,
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({ ok: false, error: hint ? `${message} ${hint}` : message }),
    },
  ],
});

const ID_HINTS: Record<string, string> = {
  clip: 'Call find_clips (or get_timeline) to list valid clip ids.',
  track: 'Call get_timeline to list valid track ids.',
  media: 'Call list_media to list valid media ids.',
  job: 'Call export_timeline to start a job first.',
};

/** Append a recovery hint when the store reports an unknown id. */
function storeFail(error: string, kind?: keyof typeof ID_HINTS): ReturnType<typeof fail> {
  const hint = /^Unknown (clip|track|media|job)\b/.test(error) && kind ? ID_HINTS[kind] : undefined;
  return fail(error, hint);
}

function unwrap<T>(r: { ok: boolean; error?: string; data?: T }): T {
  if (!r.ok) throw new Error(r.error ?? 'operation failed');
  return r.data as T;
}

/** Paginate an array; always returns { total, count, offset, items, has_more, next_offset? }. */
function paginate<T>(all: T[], limit: number, offset: number): {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
} {
  const total = all.length;
  const items = all.slice(offset, offset + limit);
  const has_more = offset + items.length < total;
  return {
    total,
    count: items.length,
    offset,
    items,
    has_more,
    ...(has_more ? { next_offset: offset + items.length } : {}),
  };
}

function checkLimit(n: number): number {
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(n)));
}

/** Reject empty/overlong paths before they reach ffprobe/ffmpeg. */
function checkPath(p: string, what = 'path'): string | null {
  if (typeof p !== 'string' || p.trim().length === 0) return `${what} must be a non-empty string`;
  if (p.length > 4096) return `${what} is too long`;
  if (!isAbsolute(p)) return `${what} must be an absolute file path (got ${JSON.stringify(p)})`;
  return null;
}

// ---------- shared Zod schemas ----------

const responseFormat = z
  .enum(['json', 'markdown'])
  .default('json')
  .describe("Output format: 'json' (ids included, for chaining calls) or 'markdown' (compact, human-readable)");

const pageSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe(`Max items to return (1-${MAX_PAGE_LIMIT}, default ${DEFAULT_PAGE_LIMIT})`),
  offset: z.number().int().min(0).default(0).describe('Items to skip for pagination'),
};

/** Loose envelope for mutation results (text JSON stays the versioned contract). */
const MutationOutput = z.object({ ok: z.boolean() }).passthrough();
const mutationOut = () => ({ outputSchema: MutationOutput });

const ProjectInfoOutput = z
  .object({
    name: z.string(),
    filePath: z.string().nullable(),
    modified: z.boolean(),
    aspect: z.string(),
    canvasWidth: z.number(),
    canvasHeight: z.number(),
    mediaCount: z.number(),
    durationSec: z.number(),
  })
  .passthrough();

const MediaPageOutput = z
  .object({
    total: z.number(),
    count: z.number(),
    offset: z.number(),
    has_more: z.boolean(),
    next_offset: z.number().optional(),
  })
  .passthrough();

const TimelineOutput = z.object({ tracks: z.array(z.unknown()).optional(), summary: z.unknown().optional() }).passthrough();
const ClipResultOutput = z.object({ track: z.unknown(), clip: z.unknown() }).passthrough();
const ClipPageOutput = z
  .object({ total: z.number(), count: z.number(), offset: z.number(), has_more: z.boolean(), next_offset: z.number().optional() })
  .passthrough();
const ExportJobOutput = z.object({ id: z.string(), outPath: z.string(), status: z.string(), progress: z.number() }).passthrough();
const ServerInfoOutput = z
  .object({ name: z.string(), version: z.string(), transports: z.array(z.string()), toolCount: z.number() })
  .passthrough();

// ---------- markdown formatters ----------

function fmtMediaMarkdown(items: { id: string; name: string; kind: string; durationSec: number }[]): string {
  if (items.length === 0) return 'No media imported. Use import_media with an absolute file path.';
  return ['# Media pool', ...items.map((m) => `- **${m.name}** (${m.id}) — ${m.kind}, ${m.durationSec.toFixed(1)}s`)].join('\n');
}

function fmtTimelineMarkdown(tracks: Track[]): string {
  if (tracks.length === 0) return 'Empty timeline.';
  const lines = ['# Timeline'];
  for (const t of tracks) {
    lines.push(`## ${t.name} (${t.id}, ${t.kind}${t.muted ? ', muted' : ''}${t.locked ? ', locked' : ''}) — ${t.clips.length} clips`);
    for (const c of t.clips.slice(0, 100)) {
      lines.push(`- **${c.name}** (${c.id}) @ ${c.startSec.toFixed(2)}s for ${c.durationSec.toFixed(2)}s`);
    }
    if (t.clips.length > 100) lines.push(`- … ${t.clips.length - 100} more clips (use summary mode or find_clips)`);
  }
  return lines.join('\n');
}

// ---------- project summary (shared by tool + resources) ----------

export interface ProjectSummary {
  name: string;
  filePath: string | null;
  modified: boolean;
  aspect: string;
  canvasWidth: number;
  canvasHeight: number;
  mediaCount: number;
  tracks: { id: string; kind: string; name: string; clips: number }[];
  durationSec: number;
}

function projectSummary(store: ProjectStore): ProjectSummary {
  const p = store.project;
  const canvas = exportSize(p.aspect ?? '16:9', p.customW, p.customH);
  return {
    name: p.name,
    filePath: store.filePath,
    modified: p.modified,
    aspect: p.aspect ?? '16:9',
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    mediaCount: p.media.length,
    tracks: p.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, clips: t.clips.length })),
    durationSec: store.timelineDuration(),
  };
}

function timelineSummary(store: ProjectStore): Record<string, unknown> {
  return {
    durationSec: store.timelineDuration(),
    tracks: store.project.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      muted: t.muted,
      locked: t.locked,
      clipCount: t.clips.length,
      clips: t.clips.slice(0, 50).map((c) => ({ id: c.id, name: c.name, kind: c.kind, startSec: c.startSec, durationSec: c.durationSec })),
      truncatedClips: t.clips.length > 50,
    })),
  };
}

// ---------- server ----------

export function createMcpServer(deps: McpDeps, jobs: Map<string, ExportJob> = new Map()): McpServer {
  const { store } = deps;
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  // ----- meta -----
  server.registerTool(
    'server_info',
    {
      title: 'Server Info',
      description:
        'TaxiCut server capabilities: version, transports, tool/resource/prompt counts, ffmpeg and local speech-to-text availability. Call first to check the environment.',
      inputSchema: z.object({}).strict(),
      outputSchema: ServerInfoOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const summary = projectSummary(store);
      const info = {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        transports: ['streamable-http', 'stdio'],
        toolCount: MCP_TOOL_COUNT,
        resourceCount: MCP_RESOURCE_COUNT,
        promptCount: MCP_PROMPT_COUNT,
        ffmpeg: FFMPEG,
        ffprobe: FFPROBE,
        asrAvailable: asrAvailable(),
        project: summary,
      };
      return ok(info, { ...info });
    },
  );

  // ----- project -----
  server.registerTool(
    'project_info',
    {
      title: 'Project Info',
      description: 'Compact project overview: name, canvas size, media/track counts, total duration. Cheaper than get_timeline.',
      inputSchema: z.object({}).strict(),
      outputSchema: ProjectInfoOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const summary = projectSummary(store);
      return ok(summary, { ...summary, filePath: (summary.filePath as string | null) ?? undefined });
    },
  );

  server.registerTool(
    'project_new',
    {
      title: 'New Project',
      description: 'Start an empty project, discarding unsaved changes. Example: {"name": "My Video"}.',
      inputSchema: z.object({ name: z.string().max(200).optional().describe('Project name') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        return ok(unwrap(await store.dispatch({ op: 'project:new', name })), { ok: true });
      } catch (e) {
        return storeFail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'project_open',
    {
      title: 'Open Project',
      description: 'Open a .taxicut file (absolute path), replacing the current project. Unsaved changes are lost.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to a .taxicut project file') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path }) => {
      const bad = checkPath(path);
      if (bad) return fail(bad, 'Use an absolute path, e.g. /Users/me/Videos/project.taxicut.');
      const r = await store.dispatch({ op: 'project:open', path });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!);
    },
  );

  server.registerTool(
    'project_save',
    {
      title: 'Save Project',
      description: 'Save the project (defaults to its current path). Returns the saved path.',
      inputSchema: z.object({ path: z.string().optional().describe('Absolute path; omit to save in place') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path }) => {
      if (path) {
        const bad = checkPath(path);
        if (bad) return fail(bad);
      }
      const r = await store.dispatch({ op: 'project:save', path });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!);
    },
  );

  server.registerTool(
    'set_canvas_aspect',
    {
      title: 'Set Canvas Aspect',
      description: 'Canvas (output frame) aspect for preview and export. aspect "custom" needs width/height.',
      inputSchema: z
        .object({
          aspect: z.enum(['16:9', '9:16', '1:1', '4:3', '4:5', 'custom']).describe('Preset or "custom"'),
          width: z.number().int().min(16).max(8192).optional().describe('Custom width (aspect "custom" only)'),
          height: z.number().int().min(16).max(8192).optional().describe('Custom height (aspect "custom" only)'),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ aspect, width, height }) => {
      const r = await store.dispatch({ op: 'project:setAspect', aspect, width, height });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!);
    },
  );

  // ----- media -----
  server.registerTool(
    'import_media',
    {
      title: 'Import Media',
      description:
        'Probe and import a video/audio/image file (absolute path) into the media pool. Returns the asset with its mediaId. Errors: file missing/unreadable (check the path), no streams (not a media file).',
      inputSchema: z.object({ path: z.string().describe('Absolute path to a video, audio, or image file') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path }) => {
      const bad = checkPath(path);
      if (bad) return fail(bad, 'Example: /Users/me/Videos/clip.mp4. Then pass the returned id to add_clip.');
      try {
        const probe = await probeMedia(path);
        const asset = store.addMedia({
          id: randomUUID(),
          path,
          name: basename(path),
          kind: mediaKind(path, probe),
          durationSec: probe.durationSec,
          width: probe.width,
          height: probe.height,
          fps: probe.fps,
          hasAudio: probe.hasAudio,
          thumbnailPath: await makeThumbnail(path, deps.cacheDir),
        });
        return ok(asset, { ok: true, result: asset });
      } catch (e) {
        return fail(`Import failed: ${(e as Error).message}`, 'Verify the file exists and ffmpeg can read it.');
      }
    },
  );

  server.registerTool(
    'list_media',
    {
      title: 'List Media',
      description: 'Paginated media-pool listing. Use limit/offset for large pools; markdown is compact.',
      inputSchema: z.object({ ...pageSchema, response_format: responseFormat }).strict(),
      outputSchema: MediaPageOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, offset, response_format: fmt }) => {
      const page = paginate(store.project.media, checkLimit(limit), Math.max(0, offset));
      const text = fmt === 'markdown' ? fmtMediaMarkdown(page.items.map((m) => ({ id: m.id, name: m.name, kind: m.kind, durationSec: m.durationSec }))) : page;
      return ok(text, { ...page, items: page.items });
    },
  );

  server.registerTool(
    'delete_media',
    {
      title: 'Delete Media',
      description: 'Delete a media asset and every timeline clip using it. Undoable.',
      inputSchema: z.object({ mediaId: z.string().describe('Asset id from list_media') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ mediaId }) => {
      const r = await store.dispatch({ op: 'media:delete', mediaId });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!, 'media');
    },
  );

  // ----- timeline reads -----
  server.registerTool(
    'get_timeline',
    {
      title: 'Get Timeline',
      description:
        'Tracks and clips with ids, positions, trims, audio settings. summary=true returns a compact per-track overview (prefer for large timelines). Full JSON truncates past 25k chars — then use find_clips/get_clip.',
      inputSchema: z
        .object({
          summary: z.boolean().default(false).describe('Compact per-track overview instead of full clip objects'),
          response_format: responseFormat,
        })
        .strict(),
      outputSchema: TimelineOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ summary, response_format: fmt }) => {
      if (summary) {
        const s = timelineSummary(store);
        return ok(fmt === 'markdown' ? fmtTimelineMarkdown(store.project.tracks) : s, { summary: s });
      }
      const tracks = store.project.tracks;
      return ok(fmt === 'markdown' ? fmtTimelineMarkdown(tracks) : tracks, { tracks });
    },
  );

  server.registerTool(
    'find_clips',
    {
      title: 'Find Clips',
      description:
        'Search clips by name/text substring (case-insensitive), with kind and track filters. Returns track + clip stubs. Use instead of scanning get_timeline.',
      inputSchema: z
        .object({
          query: z.string().max(200).default('').describe('Substring to match against clip name/text (empty = all)'),
          kind: z.enum(['video', 'audio', 'image', 'text']).optional().describe('Filter by clip kind'),
          trackId: z.string().optional().describe('Restrict to one track'),
          ...pageSchema,
        })
        .strict(),
      outputSchema: ClipPageOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, kind, trackId, limit, offset }) => {
      const q = query.trim().toLowerCase();
      const hits: { trackId: string; trackName: string; clip: Clip }[] = [];
      for (const t of store.project.tracks) {
        if (trackId && t.id !== trackId) continue;
        for (const c of t.clips) {
          if (kind && c.kind !== kind) continue;
          if (q && !(c.name ?? '').toLowerCase().includes(q) && !(c.text ?? '').toLowerCase().includes(q)) continue;
          hits.push({ trackId: t.id, trackName: t.name, clip: c });
        }
      }
      const page = paginate(hits, checkLimit(limit), Math.max(0, offset));
      return ok(page, page);
    },
  );

  server.registerTool(
    'get_clip',
    {
      title: 'Get Clip',
      description: 'One clip by id with its track. Errors: unknown id — call find_clips for valid ids.',
      inputSchema: z.object({ clipId: z.string().describe('Clip id from get_timeline or find_clips') }).strict(),
      outputSchema: ClipResultOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ clipId }) => {
      const found = store.findClip(clipId);
      if (!found) return fail(`Unknown clip ${clipId}.`, ID_HINTS.clip);
      return ok({ track: found.track, clip: found.clip }, { track: found.track, clip: found.clip });
    },
  );

  // ----- tracks -----
  server.registerTool(
    'add_track',
    {
      title: 'Add Track',
      description: 'Add a video or audio track. atIndex positions within the same-kind group (video 0 = background V1).',
      inputSchema: z
        .object({
          kind: z.enum(['video', 'audio']).describe('Track kind'),
          atIndex: z.number().int().min(0).optional().describe('Position within the same-kind group'),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ kind, atIndex }) => {
      try {
        return ok(unwrap(await store.dispatch({ op: 'track:add', kind, atIndex })), { ok: true });
      } catch (e) {
        return storeFail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'delete_track',
    {
      title: 'Delete Track',
      description: 'Delete a track and its clips. Fails on the last remaining track. Undoable.',
      inputSchema: z.object({ trackId: z.string().describe('Track id from get_timeline') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ trackId }) => {
      const r = await store.dispatch({ op: 'track:delete', trackId });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!, 'track');
    },
  );

  server.registerTool(
    'move_track',
    {
      title: 'Move Track',
      description: 'Restack a track within its kind (video array order = bottom-to-top). Give toIndex (0 = bottom V1) or direction (+1 foreground).',
      inputSchema: z
        .object({
          trackId: z.string().describe('Track id from get_timeline'),
          toIndex: z.number().int().min(0).optional().describe('Target position within the same-kind group'),
          direction: z.union([z.literal(1), z.literal(-1)]).optional().describe('One step toward/away from foreground'),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ trackId, toIndex, direction }) => {
      const r = await store.dispatch({ op: 'track:move', trackId, toIndex, direction });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!, 'track');
    },
  );

  server.registerTool(
    'set_track_mute',
    {
      title: 'Mute Track',
      description: 'Mute/unmute a track (video hidden, audio silent).',
      inputSchema: z
        .object({ trackId: z.string().describe('Track id from get_timeline'), muted: z.boolean().describe('true = muted') })
        .strict(),
      outputSchema: MutationOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ trackId, muted }) => {
      const r = await store.dispatch({ op: 'track:setMute', trackId, muted });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!, 'track');
    },
  );

  server.registerTool(
    'set_track_audio_mute',
    {
      title: 'Mute Track Audio',
      description:
        'Silence every clip audio on a track; picture untouched (use for video tracks whose embedded audio should be silent).',
      inputSchema: z
        .object({ trackId: z.string().describe('Track id from get_timeline'), muted: z.boolean().describe('true = muted') })
        .strict(),
      outputSchema: MutationOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ trackId, muted }) => {
      const r = await store.dispatch({ op: 'track:setAudioMute', trackId, muted });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!, 'track');
    },
  );

  server.registerTool(
    'set_track_lock',
    {
      title: 'Lock Track',
      description: 'Lock/unlock a track against edits.',
      inputSchema: z
        .object({ trackId: z.string().describe('Track id from get_timeline'), locked: z.boolean().describe('true = locked') })
        .strict(),
      outputSchema: MutationOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ trackId, locked }) => {
      const r = await store.dispatch({ op: 'track:setLock', trackId, locked });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!, 'track');
    },
  );

  // ----- clips -----
  server.registerTool(
    'add_clip',
    {
      title: 'Add Clip',
      description:
        'Place media on the timeline (default: end of first matching-kind track). Same-track overlaps never stack: the clip auto-layers onto a free track, creating one if needed. mediaId "text" makes a standalone text overlay. Example: {"mediaId": "<id>", "startSec": 0}.',
      inputSchema: z
        .object({
          mediaId: z.string().describe('Asset id from list_media, or "text" for a text overlay'),
          trackId: z.string().optional().describe('Preferred track id'),
          startSec: z.number().min(0).optional().describe('Timeline position in seconds (default: end)'),
          inSec: z.number().min(0).optional().describe('Source in-point in seconds'),
          durationSec: z.number().positive().optional().describe('Timeline duration in seconds'),
          text: z.string().max(2000).optional().describe('Subtitle/overlay text (mediaId "text" or caption clips)'),
          template: z.string().optional().describe('Text template: title, subtitle, lower, pop, quote'),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const r = await store.dispatch({ op: 'timeline:addClip', ...args });
      return r.ok ? ok(r.data, { ok: true, result: r.data }) : storeFail(r.error!, 'media');
    },
  );

  server.registerTool(
    'add_text',
    {
      title: 'Add Text',
      description: 'Styled text overlay (title, subtitle, lower third…). Templates: title, subtitle, lower, pop, quote.',
      inputSchema: z
        .object({
          text: z.string().max(2000).optional().describe('Overlay text'),
          template: z.string().optional().describe('title | subtitle | lower | pop | quote'),
          trackId: z.string().optional().describe('Preferred video track id'),
          startSec: z.number().min(0).optional().describe('Timeline position in seconds'),
          durationSec: z.number().positive().optional().describe('Duration in seconds'),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const r = await store.dispatch({ op: 'timeline:addClip', mediaId: 'text', ...args });
      return r.ok ? ok(r.data, { ok: true, result: r.data }) : storeFail(r.error!, 'track');
    },
  );

  server.registerTool(
    'move_clip',
    {
      title: 'Move Clip',
      description:
        'Move a clip to a time and/or track. place=auto (default) bounces occupied ranges to a free layer; place=layer forces the given track (swaps or inserts a layer when busy).',
      inputSchema: z
        .object({
          clipId: z.string().describe('Clip id'),
          startSec: z.number().min(0).optional().describe('New timeline position in seconds'),
          trackId: z.string().optional().describe('Destination track id (same kind only)'),
          place: z.enum(['auto', 'layer']).optional().describe('Overlap policy (default auto)'),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ clipId, startSec, trackId, place }) => {
      const r = await store.dispatch({ op: 'timeline:moveClip', clipId, startSec, trackId, place });
      return r.ok ? ok(r.data, { ok: true, result: r.data }) : storeFail(r.error!, 'clip');
    },
  );

  server.registerTool(
    'reorder_clip',
    {
      title: 'Reorder Clip',
      description:
        'Change stacking order without moving in time. direction +1 = toward timeline top (video foreground); position front/back jumps to the edge; toIndex is the same-kind index (video 0 = background). Occupied layers swap or insert — never no-ops.',
      inputSchema: z
        .object({
          clipId: z.string().describe('Clip id'),
          direction: z.union([z.literal(1), z.literal(-1)]).optional().describe('One step toward (+1) or away (-1) from the top'),
          toIndex: z.number().int().min(0).optional().describe('Target same-kind index'),
          position: z.enum(['front', 'back']).optional().describe('Jump to stack edge'),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ clipId, direction, toIndex, position }) => {
      const r = await store.dispatch({ op: 'timeline:reorderClip', clipId, direction, toIndex, position });
      return r.ok ? ok(r.data, { ok: true, result: r.data }) : storeFail(r.error!, 'clip');
    },
  );

  server.registerTool(
    'trim_clip',
    {
      title: 'Trim Clip',
      description:
        'Extend/shorten an edge by deltaSec (positive extends; negative shortens). edge "in" also shifts the timeline position. Clamped at neighbors and source bounds — never overlaps.',
      inputSchema: z
        .object({
          clipId: z.string().describe('Clip id'),
          edge: z.enum(['in', 'out']).describe('Which edge to move'),
          deltaSec: z.number().min(-3600).max(3600).describe('Seconds to move the edge (positive extends)'),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ clipId, edge, deltaSec }) => {
      const r = await store.dispatch({ op: 'timeline:trimClip', clipId, edge, deltaSec });
      return r.ok ? ok(r.data, { ok: true, result: r.data }) : storeFail(r.error!, 'clip');
    },
  );

  server.registerTool(
    'split_clip',
    {
      title: 'Split Clip',
      description: 'Split a clip into two at an absolute timeline time. The point must be >0.05s inside both edges.',
      inputSchema: z
        .object({ clipId: z.string().describe('Clip id'), atSec: z.number().min(0).describe('Absolute timeline time in seconds') })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ clipId, atSec }) => {
      const r = await store.dispatch({ op: 'timeline:splitClip', clipId, atSec });
      return r.ok ? ok(r.data, { ok: true, result: r.data }) : storeFail(r.error!, 'clip');
    },
  );

  server.registerTool(
    'delete_clip',
    {
      title: 'Delete Clip',
      description: 'Delete a clip. ripple=true closes the gap across all tracks. Undoable.',
      inputSchema: z
        .object({ clipId: z.string().describe('Clip id'), ripple: z.boolean().optional().describe('Close the gap across all tracks') })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ clipId, ripple }) => {
      const r = await store.dispatch({ op: 'timeline:deleteClip', clipId, ripple });
      return r.ok ? ok(r.data, { ok: true }) : storeFail(r.error!, 'clip');
    },
  );

  server.registerTool(
    'set_clip_properties',
    {
      title: 'Set Clip Properties',
      description:
        'Audio (volumeDb, audioMuted, fades), playback speed (0.1-10, retimes duration), transform (scale, posX/posY, cropL/T/R/B, opacity), look (filter preset, color grade), text styling. Only sent fields change.',
      inputSchema: z
        .object({
          clipId: z.string().describe('Clip id'),
          volumeDb: z.number().min(-60).max(12).optional().describe('Volume in dB'),
          speed: z.number().min(0.1).max(10).optional().describe('Playback speed; duration scales inversely'),
          audioMuted: z.boolean().optional().describe('Silence this clip (picture untouched)'),
          fadeInSec: z.number().min(0).max(3600).optional(),
          fadeOutSec: z.number().min(0).max(3600).optional(),
          scale: z.number().positive().max(100).optional().describe('Size multiplier (1 = contain-fit)'),
          posX: z.number().min(-5).max(5).optional().describe('X offset, canvas fractions (0 = centered)'),
          posY: z.number().min(-5).max(5).optional().describe('Y offset, canvas fractions (0 = centered)'),
          opacity: z.number().min(0).max(1).optional(),
          cropL: z.number().min(0).max(0.9).optional(),
          cropT: z.number().min(0).max(0.9).optional(),
          cropR: z.number().min(0).max(0.9).optional(),
          cropB: z.number().min(0).max(0.9).optional(),
          filter: z.string().optional().describe('Preset id ("", vivid, warm, cool, mono, noir, vintage, fade)'),
          color: z
            .object({
              exposure: z.number().min(-1).max(1).optional(),
              contrast: z.number().min(0).max(2).optional(),
              saturation: z.number().min(0).max(2).optional(),
              warmth: z.number().min(-1).max(1).optional(),
            })
            .strict()
            .optional(),
          text: z.string().max(5000).optional(),
          fontFamily: z.string().max(100).optional(),
          fontSize: z.number().min(8).max(500).optional(),
          textColor: z.string().max(32).optional().describe('Hex, e.g. #ffffff'),
          textBg: z.string().max(32).optional().describe('Hex or "" for transparent'),
          bold: z.boolean().optional(),
          textAlign: z.enum(['left', 'center', 'right']).optional(),
        })
        .strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ clipId, ...props }) => {
      const r = await store.dispatch({ op: 'clip:setProps', clipId, ...props });
      return r.ok ? ok(r.data, { ok: true, result: r.data }) : storeFail(r.error!, 'clip');
    },
  );

  // ----- history -----
  for (const [name, title, op] of [
    ['undo', 'Undo', 'history:undo'],
    ['redo', 'Redo', 'history:redo'],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: `${title} the last timeline edit. Errors when the stack is empty.`,
        inputSchema: z.object({}).strict(),
        outputSchema: MutationOutput,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async () => {
        const r = await store.dispatch({ op });
        return r.ok ? ok({ undone: op === 'history:undo', redone: op === 'history:redo' }, { ok: true }) : storeFail(r.error!);
      },
    );
  }

  // ----- speech -----
  server.registerTool(
    'transcribe_media',
    {
      title: 'Transcribe Media',
      description:
        'Local Parakeet TDT transcription (no cloud). Needs audio; fails when the ASR model is missing — then server_info.asrAvailable is false. Returns segments + SRT; result is cached on the asset.',
      inputSchema: z.object({ mediaId: z.string().describe('Asset id from list_media (must have audio)') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ mediaId }) => {
      const media = store.media(mediaId);
      if (!media) return fail(`Unknown media ${mediaId}.`, ID_HINTS.media);
      if (!media.hasAudio) return fail(`Media ${media.name} has no audio stream.`, 'Pick an asset with hasAudio=true from list_media.');
      try {
        const segments = await transcribe(media.path);
        media.transcript = segments;
        return ok({ segments, srt: toSrt(segments) }, { ok: true });
      } catch (e) {
        return fail((e as Error).message, 'Check server_info.asrAvailable and TAXICUT_PARAKEET_CLI / TAXICUT_PARAKEET_MODEL.');
      }
    },
  );

  server.registerTool(
    'generate_subtitles',
    {
      title: 'Generate Subtitles',
      description: 'Transcribe locally, then lay timed caption clips onto a new video track. Returns track, clip count, and SRT.',
      inputSchema: z.object({ mediaId: z.string().describe('Asset id from list_media') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ mediaId }) => {
      const media = store.media(mediaId);
      if (!media) return fail(`Unknown media ${mediaId}.`, ID_HINTS.media);
      try {
        const segments: TranscriptSegment[] = media.transcript ?? (await transcribe(media.path));
        media.transcript = segments;
        const track = unwrap(await store.dispatch({ op: 'track:add', kind: 'video' })) as { id: string };
        const made: Clip[] = [];
        for (const seg of segments) {
          const r = await store.dispatch({
            op: 'timeline:addClip',
            mediaId,
            trackId: track.id,
            startSec: seg.startSec,
            inSec: 0,
            durationSec: Math.max(0.2, seg.endSec - seg.startSec),
          });
          if (r.ok && r.data) {
            const clip = r.data as Clip;
            await store.dispatch({ op: 'clip:setProps', clipId: clip.id, text: seg.text, name: seg.text.slice(0, 40) });
            made.push(clip);
          }
        }
        return ok({ track, clips: made.length, srt: toSrt(segments) }, { ok: true });
      } catch (e) {
        return fail((e as Error).message, 'Check server_info.asrAvailable and TAXICUT_PARAKEET_CLI / TAXICUT_PARAKEET_MODEL.');
      }
    },
  );

  // ----- export -----
  server.registerTool(
    'export_timeline',
    {
      title: 'Export Timeline',
      description:
        'Render the timeline to mp4 with ffmpeg (async). Returns { jobId, outPath }; poll export_status until done/error. Omit path for a temp file.',
      inputSchema: z.object({ path: z.string().optional().describe('Absolute output .mp4 path') }).strict(),
      ...mutationOut(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path }) => {
      if (path) {
        const bad = checkPath(path);
        if (bad) return fail(bad);
      }
      const outPath = path ?? join(await mkdtemp(join(tmpdir(), 'taxicut-')), `${store.project.name || 'export'}.mp4`);
      const job: ExportJob = { id: randomUUID(), outPath, status: 'running', progress: 0 };
      jobs.set(job.id, job);
      exportProject(store.project, outPath, { onProgress: (f) => (job.progress = f) })
        .then(() => {
          job.status = 'done';
          job.progress = 1;
        })
        .catch((e) => {
          job.status = 'error';
          job.error = (e as Error).message;
        });
      return ok({ jobId: job.id, outPath }, { ok: true, result: { jobId: job.id, outPath } });
    },
  );

  server.registerTool(
    'export_status',
    {
      title: 'Export Status',
      description: 'Poll a job from export_timeline: running (progress 0..1), done, or error. Errors: unknown job id.',
      inputSchema: z.object({ jobId: z.string().describe('Job id from export_timeline') }).strict(),
      outputSchema: ExportJobOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId }) => {
      const job = jobs.get(jobId);
      if (!job) return fail(`Unknown job ${jobId}.`, ID_HINTS.job);
      return ok(job, { ...job });
    },
  );

  // ----- resources (URI reads for clients that prefer resources over tools) -----
  const resourceContents = (uri: URL, data: unknown) => ({
    contents: [{ uri: uri.toString(), mimeType: 'application/json', text: toText(data) }],
  });

  server.registerResource(
    'taxicut-project',
    'taxicut://project/info',
    { title: 'Project Info', description: 'Current project overview (same as project_info).', mimeType: 'application/json' },
    async (uri) => resourceContents(uri, projectSummary(store)),
  );

  server.registerResource(
    'taxicut-timeline',
    'taxicut://timeline/summary',
    { title: 'Timeline Summary', description: 'Compact per-track timeline overview.', mimeType: 'application/json' },
    async (uri) => resourceContents(uri, timelineSummary(store)),
  );

  server.registerResource(
    'taxicut-media',
    'taxicut://media/list',
    { title: 'Media List', description: 'Media pool (first 100 assets).', mimeType: 'application/json' },
    async (uri) =>
      resourceContents(uri, {
        total: store.project.media.length,
        items: store.project.media.slice(0, 100),
        truncated: store.project.media.length > 100,
      }),
  );

  // ----- prompts (canned workflows) -----
  server.registerPrompt(
    'edit-video',
    {
      title: 'Edit Video',
      description: 'Standard TaxiCut editing workflow: import → place → trim → polish → export.',
      argsSchema: { goal: z.string().describe('What the video should become') },
    },
    async ({ goal }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Edit the TaxiCut project to achieve: ${goal ?? '(goal)'}`,
              '',
              'Workflow:',
              '1. project_info — see canvas, tracks, duration.',
              '2. list_media (import_media first if assets are missing).',
              '3. get_timeline with summary=true, find_clips to locate clips.',
              '4. Edit with add_clip / move_clip / trim_clip / split_clip / set_clip_properties.',
              '   Same-track ranges never overlap — clips auto-layer; use reorder_clip to restack.',
              '5. project_save, then export_timeline and poll export_status.',
              'Recover from "Unknown X" errors with find_clips / get_timeline / list_media.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'make-subtitles',
    {
      title: 'Make Subtitles',
      description: 'Transcribe an asset locally and lay caption clips on the timeline.',
      argsSchema: { media_id: z.string().optional().describe('Asset id (omit to pick from list_media first)') },
    },
    async ({ media_id }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Generate subtitles${media_id ? ` for media ${media_id}` : ''} with local Parakeet STT.`,
              '',
              'Workflow:',
              '1. server_info — confirm asrAvailable (needs the local Parakeet model).',
              `2. ${media_id ? `transcribe_media with mediaId ${media_id}` : 'list_media — pick an asset with audio, then transcribe_media.'}`,
              '3. generate_subtitles with the same mediaId to lay caption clips on a new track.',
              '4. find_clips with kind "text" to review; set_clip_properties to restyle.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'export-video',
    {
      title: 'Export Video',
      description: 'Save and render the timeline to mp4.',
      argsSchema: { output_path: z.string().optional().describe('Absolute .mp4 path (omit for a temp file)') },
    },
    async ({ output_path }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Export the timeline to mp4${output_path ? ` at ${output_path}` : ''}.`,
              '',
              'Workflow:',
              '1. project_info — confirm duration and canvas.',
              '2. project_save.',
              `3. export_timeline${output_path ? ` with path ${output_path}` : ''} → poll export_status until done.`,
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

// ---------- discovery ----------

export function buildDiscoveryDocument(port: number): Record<string, unknown> {
  return {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    transports: ['streamable-http', 'stdio'],
    url: `http://127.0.0.1:${port}/mcp`,
    health: `http://127.0.0.1:${port}/health`,
    description: 'TaxiCut video-editor MCP server: timeline editing, local transcription, ffmpeg export.',
  };
}

/** Write ~/.taxicut/mcp.json so CLIs and setup scripts can find the live server. Best-effort. */
export async function writeDiscoveryFile(port: number): Promise<string | null> {
  try {
    const dir = join(homedir(), '.taxicut');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'mcp.json');
    await writeFile(file, JSON.stringify({ ...buildDiscoveryDocument(port), pid: process.pid }, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

// ---------- HTTP transport ----------

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** DNS-rebinding guard: allow missing Origin (native MCP clients) and local origins only. */
function originAllowed(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/** Start the HTTP listener. Returns the http.Server. Stateless per-request sessions. */
export async function startMcpHttpServer(deps: McpDeps, port = MCP_DEFAULT_PORT): Promise<Server> {
  const jobs = new Map<string, ExportJob>();
  const httpServer = createServer(async (req, res) => {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const originRaw = headers.origin;
    const origin = Array.isArray(originRaw) ? originRaw[0] : (originRaw ?? null);
    const cors = corsHeaders(origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (!originAllowed(req)) {
      res.writeHead(403, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'Origin not allowed' }));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(
        JSON.stringify({ ok: true, ...buildDiscoveryDocument(port) }),
      );
      return;
    }
    if (url.pathname === '/mcp.json' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(buildDiscoveryDocument(port), null, 2));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, cors).end('not found');
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(405, { ...cors, Allow: 'POST' }).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, Allow: 'POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    await new Promise<void>((resolve) => req.on('end', () => resolve()));
    if (tooLarge) {
      res.writeHead(413, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'Request body too large' }));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, cors).end('bad json');
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    const server = createMcpServer(deps, jobs);
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: (e as Error).message }),
        );
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  return httpServer;
}

// ---------- stdio transport (headless: CI, agents without the GUI) ----------

export async function startMcpStdioServer(deps: McpDeps, jobs: Map<string, ExportJob> = new Map()): Promise<void> {
  const server = createMcpServer(deps, jobs);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
