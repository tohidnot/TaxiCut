// MCP server: exposes TaxiCut editing tools over Streamable HTTP at /mcp.
// Electron-free so it can be smoke-tested in plain Node.
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ProjectStore } from './store';
import { probeMedia, mediaKind, makeThumbnail, exportProject } from './ffmpeg';
import { transcribe, toSrt } from './asr';
import { exportSize } from '../shared/types';
import type { Clip, ExportJob, TranscriptSegment } from '../shared/types';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

export interface McpDeps {
  store: ProjectStore;
  cacheDir: string;
}

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }],
});

function unwrap<T>(r: { ok: boolean; error?: string; data?: T }): T {
  if (!r.ok) throw new Error(r.error ?? 'operation failed');
  return r.data as T;
}

export function createMcpServer(deps: McpDeps, jobs: Map<string, ExportJob>): McpServer {
  const { store } = deps;
  const server = new McpServer({ name: 'taxicut', version: '0.1.0' });

  server.tool('project_info', 'Get project name, file path, canvas aspect, media count, tracks and total duration.', {},
    async () => {
      const p = store.project;
      const canvas = exportSize(p.aspect ?? '16:9', p.customW, p.customH);
      return ok({
        name: p.name, filePath: store.filePath, modified: p.modified,
        aspect: p.aspect ?? '16:9', canvasWidth: canvas.width, canvasHeight: canvas.height,
        mediaCount: p.media.length, tracks: p.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, clips: t.clips.length })),
        durationSec: store.timelineDuration(),
      });
    });

  server.tool('project_new', 'Start a new empty project.', { name: z.string().optional() },
    async ({ name }) => ok(unwrap(await store.dispatch({ op: 'project:new', name }))));

  server.tool('project_open', 'Open a .taxicut project file.', { path: z.string() },
    async ({ path }) => {
      const r = await store.dispatch({ op: 'project:open', path });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('project_save', 'Save the project. Defaults to its current path.',
    { path: z.string().optional() },
    async ({ path }) => {
      const r = await store.dispatch({ op: 'project:save', path });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('set_canvas_aspect', 'Set the canvas (output frame) aspect ratio used by preview and export. Use aspect "custom" with width/height for a custom size.',
    {
      aspect: z.enum(['16:9', '9:16', '1:1', '4:3', '4:5', 'custom']),
      width: z.number().int().min(16).max(8192).optional(),
      height: z.number().int().min(16).max(8192).optional(),
    },
    async ({ aspect, width, height }) => {
      const r = await store.dispatch({ op: 'project:setAspect', aspect, width, height });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('import_media', 'Import a video/audio/image file into the media pool.',
    { path: z.string() },
    async ({ path }) => {
      try {
        const probe = await probeMedia(path);
        const asset = store.addMedia({
          id: randomUUID(), path, name: basename(path), kind: mediaKind(path, probe),
          durationSec: probe.durationSec, width: probe.width, height: probe.height,
          fps: probe.fps, hasAudio: probe.hasAudio,
          thumbnailPath: await makeThumbnail(path, deps.cacheDir),
        });
        return ok(asset);
      } catch (e) {
        return fail(`Import failed: ${(e as Error).message}`);
      }
    });

  server.tool('list_media', 'List all imported media assets.', {},
    async () => ok(store.project.media));

  server.tool('delete_media', 'Delete a media asset and any timeline clips using it.',
    { mediaId: z.string() },
    async ({ mediaId }) => {
      const r = await store.dispatch({ op: 'media:delete', mediaId });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('get_timeline', 'Get the full timeline: tracks and clips with ids, positions, trims, and audio settings.',
    {}, async () => ok(store.project.tracks));

  server.tool('add_track', 'Add a video or audio track.',
    { kind: z.enum(['video', 'audio']) },
    async ({ kind }) => ok(unwrap(await store.dispatch({ op: 'track:add', kind }))));

  server.tool('delete_track', 'Delete a track and its clips from the timeline.',
    { trackId: z.string() },
    async ({ trackId }) => {
      const r = await store.dispatch({ op: 'track:delete', trackId });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('set_track_mute', 'Mute or unmute an audio or video track.',
    { trackId: z.string(), muted: z.boolean() },
    async ({ trackId, muted }) => {
      const r = await store.dispatch({ op: 'track:setMute', trackId, muted });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('set_track_lock', 'Lock or unlock a track against edits.',
    { trackId: z.string(), locked: z.boolean() },
    async ({ trackId, locked }) => {
      const r = await store.dispatch({ op: 'track:setLock', trackId, locked });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('add_clip',
    'Append (or place) a media item on the timeline. Defaults to the end of the first matching-kind track. Use mediaId "text" for a standalone text overlay (then text/template apply).',
    {
      mediaId: z.string(), trackId: z.string().optional(), startSec: z.number().min(0).optional(),
      inSec: z.number().min(0).optional(), durationSec: z.number().positive().optional(),
      text: z.string().optional(), template: z.string().optional(),
    },
    async (args) => {
      const r = await store.dispatch({ op: 'timeline:addClip', ...args });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('add_text',
    'Add a styled text overlay clip (title, subtitle, caption…). Templates: title, subtitle, caption, lower, pop, quote.',
    {
      text: z.string().optional(), template: z.string().optional(),
      trackId: z.string().optional(), startSec: z.number().min(0).optional(),
      durationSec: z.number().positive().optional(),
    },
    async (args) => {
      const r = await store.dispatch({ op: 'timeline:addClip', mediaId: 'text', ...args });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('move_clip', 'Move a clip to a new timeline position and/or track.',
    { clipId: z.string(), startSec: z.number().min(0).optional(), trackId: z.string().optional() },
    async ({ clipId, startSec, trackId }) => {
      const r = await store.dispatch({ op: 'timeline:moveClip', clipId, startSec, trackId });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('trim_clip',
    'Extend or shorten a clip edge by deltaSec (positive extends). Edge "in" also shifts the timeline position.',
    { clipId: z.string(), edge: z.enum(['in', 'out']), deltaSec: z.number() },
    async ({ clipId, edge, deltaSec }) => {
      const r = await store.dispatch({ op: 'timeline:trimClip', clipId, edge, deltaSec });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('split_clip', 'Split a clip into two at an absolute timeline time in seconds.',
    { clipId: z.string(), atSec: z.number() },
    async ({ clipId, atSec }) => {
      const r = await store.dispatch({ op: 'timeline:splitClip', clipId, atSec });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('delete_clip', 'Delete a clip. ripple=true closes the gap across all tracks.',
    { clipId: z.string(), ripple: z.boolean().optional() },
    async ({ clipId, ripple }) => {
      const r = await store.dispatch({ op: 'timeline:deleteClip', clipId, ripple });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('set_clip_properties', 'Set clip audio/playback/transform/crop/filter/text properties.',
    {
      clipId: z.string(),
      volumeDb: z.number().min(-60).max(12).optional(),
      speed: z.number().min(0.1).max(10).optional(),
      fadeInSec: z.number().min(0).optional(),
      fadeOutSec: z.number().min(0).optional(),
      scale: z.number().positive().optional(),
      posX: z.number().optional(),
      posY: z.number().optional(),
      cropL: z.number().min(0).max(0.9).optional(),
      cropT: z.number().min(0).max(0.9).optional(),
      cropR: z.number().min(0).max(0.9).optional(),
      cropB: z.number().min(0).max(0.9).optional(),
      filter: z.string().optional(),
      text: z.string().optional(),
      fontFamily: z.string().optional(),
      fontSize: z.number().min(8).max(500).optional(),
      textColor: z.string().optional(),
      textBg: z.string().optional(),
      bold: z.boolean().optional(),
      textAlign: z.enum(['left', 'center', 'right']).optional(),
    },
    async ({ clipId, ...props }) => {
      const r = await store.dispatch({ op: 'clip:setProps', clipId, ...props });
      return r.ok ? ok(r.data) : fail(r.error!);
    });

  server.tool('undo', 'Undo the last edit.', {}, async () => {
    const r = await store.dispatch({ op: 'history:undo' });
    return r.ok ? ok({ undone: true }) : fail(r.error!);
  });

  server.tool('redo', 'Redo the last undone edit.', {}, async () => {
    const r = await store.dispatch({ op: 'history:redo' });
    return r.ok ? ok({ redone: true }) : fail(r.error!);
  });

  server.tool('transcribe_media',
    'Transcribe a media asset locally with Parakeet TDT (no cloud). Returns timed segments and SRT.',
    { mediaId: z.string() },
    async ({ mediaId }) => {
      const media = store.media(mediaId);
      if (!media) return fail(`Unknown media ${mediaId}`);
      if (!media.hasAudio) return fail('Media has no audio stream');
      try {
        const segments = await transcribe(media.path);
        media.transcript = segments;
        return ok({ segments, srt: toSrt(segments) });
      } catch (e) {
        return fail((e as Error).message);
      }
    });

  server.tool('generate_subtitles',
    'Transcribe locally with Parakeet, then lay timed text clips onto a new subtitles video track.',
    { mediaId: z.string() },
    async ({ mediaId }) => {
      const media = store.media(mediaId);
      if (!media) return fail(`Unknown media ${mediaId}`);
      try {
        const segments: TranscriptSegment[] = media.transcript ?? (await transcribe(media.path));
        media.transcript = segments;
        const track = unwrap(await store.dispatch({ op: 'track:add', kind: 'video' })) as { id: string };
        const made: Clip[] = [];
        for (const seg of segments) {
          const r = await store.dispatch({
            op: 'timeline:addClip', mediaId, trackId: track.id,
            startSec: seg.startSec, inSec: 0, durationSec: Math.max(0.2, seg.endSec - seg.startSec),
          });
          if (r.ok && r.data) {
            const clip = r.data as Clip;
            await store.dispatch({ op: 'clip:setProps', clipId: clip.id, text: seg.text, name: seg.text.slice(0, 40) });
            made.push(clip);
          }
        }
        return ok({ track, clips: made.length, srt: toSrt(segments) });
      } catch (e) {
        return fail((e as Error).message);
      }
    });

  server.tool('export_timeline',
    'Render the timeline to an mp4 with ffmpeg. Returns a job id; poll export_status for progress.',
    { path: z.string().optional() },
    async ({ path }) => {
      const outPath = path ?? join(await mkdtemp(join(tmpdir(), 'taxicut-')), `${store.project.name || 'export'}.mp4`);
      const job: ExportJob = { id: randomUUID(), outPath, status: 'running', progress: 0 };
      jobs.set(job.id, job);
      exportProject(store.project, outPath, { onProgress: (f) => (job.progress = f) })
        .then(() => { job.status = 'done'; job.progress = 1; })
        .catch((e) => { job.status = 'error'; job.error = (e as Error).message; });
      return ok({ jobId: job.id, outPath });
    });

  server.tool('export_status', 'Check an export job started by export_timeline.',
    { jobId: z.string() },
    async ({ jobId }) => {
      const job = jobs.get(jobId);
      return job ? ok(job) : fail(`Unknown job ${jobId}`);
    });

  return server;
}

/** Start the HTTP listener. Returns the http.Server. Stateless per-request sessions. */
export async function startMcpHttpServer(deps: McpDeps, port = 19789): Promise<Server> {
  const jobs = new Map<string, ExportJob>();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('not found');
      return;
    }
    if (req.method === 'GET') {
      // SSE stream for server->client notifications; not used by our tools.
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    await new Promise<void>((resolve) => req.on('end', () => resolve()));
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const server = createMcpServer(deps, jobs);
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  return httpServer;
}
