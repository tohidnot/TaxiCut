import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { extname, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { IPC, type MainOp, type OpResult } from '../shared/types';
import { ProjectStore } from './store';
import { startMcpHttpServer } from './mcp';
import { registerTerminalIpc } from './terminal';
import { probeMedia, mediaKind, makeThumbnail, exportProject } from './ffmpeg';
import { transcribe, toSrt } from './asr';
import { randomUUID } from 'node:crypto';
import type { ExportJob } from '../shared/types';

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const MCP_PORT = Number(process.env.TAXICUT_MCP_PORT ?? 19789);
const cacheDir = join(homedir(), '.taxicut', 'cache');

// Allow the custom media scheme to serve video streams and bypass CORS in the renderer.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'taxicut-file',
    privileges: {
      stream: true,
      bypassCSP: true,
      supportFetchAPI: true,
      standard: true,
      secure: true,
      corsEnabled: true,
    },
  },
]);

const store = new ProjectStore();
const exportJobs = new Map<string, ExportJob>();
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#101013',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

async function handleOp(op: MainOp): Promise<OpResult> {
  // store-level ops
  const storeOps = [
    'project:get', 'project:new',
    'timeline:addClip', 'timeline:moveClip', 'timeline:trimClip', 'timeline:splitClip',
    'timeline:deleteClip', 'clip:setProps', 'track:add', 'track:delete', 'track:setMute', 'track:setLock',
    'media:delete', 'history:undo', 'history:redo',
  ];
  if (storeOps.includes(op.op)) return store.dispatch(op);

  switch (op.op) {
    case 'project:open': {
      let p = op.path;
      if (!p) {
        const r = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [
            { name: 'TaxiCut Project', extensions: ['taxicut', 'json'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });
        if (r.canceled || r.filePaths.length === 0) return { ok: false, error: 'Open cancelled' };
        p = r.filePaths[0];
      }
      return store.dispatch({ op: 'project:open', path: p });
    }
    case 'project:save': {
      let p = op.path ?? store.filePath ?? undefined;
      if (!p) {
        const r = await dialog.showSaveDialog({
          defaultPath: `${store.project.name || 'project'}.taxicut`,
          filters: [
            { name: 'TaxiCut Project', extensions: ['taxicut', 'json'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });
        if (r.canceled || !r.filePath) return { ok: false, error: 'Save cancelled' };
        p = r.filePath;
      }
      return store.dispatch({ op: 'project:save', path: p });
    }
    case 'media:import': {
      let paths = op.paths;
      if (!paths || paths.length === 0) {
        const r = await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'png', 'jpg', 'jpeg', 'webp'] }],
        });
        if (r.canceled) return { ok: true, data: [] };
        paths = r.filePaths;
      }
      const imported = [];
      for (const p of paths) {
        try {
          const probe = await probeMedia(p);
          imported.push(store.addMedia({
            id: randomUUID(), path: p, name: p.split('/').pop() ?? p,
            kind: mediaKind(p, probe), durationSec: probe.durationSec,
            width: probe.width, height: probe.height, fps: probe.fps,
            hasAudio: probe.hasAudio, thumbnailPath: await makeThumbnail(p, cacheDir),
          }));
        } catch (e) {
          return { ok: false, error: `Import failed for ${p}: ${(e as Error).message}` };
        }
      }
      return { ok: true, data: imported };
    }
    case 'asr:transcribe': {
      const media = store.media(op.mediaId);
      if (!media) return { ok: false, error: 'Unknown media' };
      try {
        const segments = await transcribe(media.path);
        media.transcript = segments;
        return { ok: true, data: { segments, srt: toSrt(segments) } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    case 'asr:subtitles': {
      const media = store.media(op.mediaId);
      if (!media) return { ok: false, error: 'Unknown media' };
      try {
        const segments = media.transcript ?? (await transcribe(media.path));
        media.transcript = segments;
        const track = await store.dispatch({ op: 'track:add', kind: 'video' });
        if (!track.ok) return track;
        const trackId = (track.data as { id: string }).id;
        const clips = [];
        for (const seg of segments) {
          const r = await store.dispatch({
            op: 'timeline:addClip', mediaId: media.id, trackId,
            startSec: seg.startSec, inSec: 0,
            durationSec: Math.max(0.2, seg.endSec - seg.startSec),
          });
          if (r.ok && r.data) {
            store.setClipProps((r.data as { id: string }).id, { text: seg.text, name: seg.text.slice(0, 40) });
            clips.push(r.data);
          }
        }
        return { ok: true, data: { clips, srt: toSrt(segments) } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    case 'export:start': {
      let outPath = op.outPath;
      if (!outPath) {
        const r = await dialog.showSaveDialog({
          defaultPath: `${store.project.name || 'export'}.mp4`,
          filters: [{ name: 'Video', extensions: ['mp4'] }],
        });
        if (r.canceled || !r.filePath) return { ok: false, error: 'Export cancelled' };
        outPath = r.filePath;
      }
      const job: ExportJob = { id: randomUUID(), outPath, status: 'running', progress: 0 };
      exportJobs.set(job.id, job);
      exportProject(store.project, outPath, {
        onProgress: (f) => {
          job.progress = f;
          mainWindow?.webContents.send('taxicut:export-progress', job);
        },
      })
        .then(() => { job.status = 'done'; job.progress = 1; })
        .catch((e) => { job.status = 'error'; job.error = (e as Error).message; })
        .finally(() => mainWindow?.webContents.send('taxicut:export-progress', job));
      return { ok: true, data: job };
    }
    case 'export:status':
      return { ok: true, data: [...exportJobs.values()] };
    default:
      return { ok: false, error: `Unknown op: ${(op as MainOp).op}` };
  }
}

const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function mimeForPath(p: string): string {
  return MEDIA_MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';
}

app.whenReady().then(async () => {
  // Serve local media/thumbnail files to the renderer with HTTP Range support,
  // otherwise Chromium reports the resource as unseekable and every seek
  // (scrub, clip in-points, drift correction) snaps back to 0 and stalls.
  protocol.handle('taxicut-file', async (req) => {
    try {
      const url = new URL(req.url);
      let p = url.searchParams.get('path');
      if (!p) {
        const raw = decodeURIComponent(url.pathname);
        if (raw && raw !== '/') {
          p = raw;
        } else if (url.host && url.host !== 'local') {
          p = decodeURIComponent(url.host);
        }
      }
      if (!p) {
        return new Response('File path missing', { status: 400 });
      }
      if (process.platform !== 'win32' && !p.startsWith('/')) {
        p = '/' + p;
      }
      const st = await stat(p);
      if (!st.isFile()) return new Response('Not found', { status: 404 });
      const size = st.size;
      const type = mimeForPath(p);

      if (req.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(size),
            'Content-Type': type,
          },
        });
      }

      const range = req.headers.get('range');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!m) {
          return new Response('Bad range', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
        let start = m[1] === '' ? NaN : Number(m[1]);
        let end = m[2] === '' ? NaN : Number(m[2]);
        if (Number.isNaN(start) && Number.isNaN(end)) {
          return new Response('Bad range', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
        if (Number.isNaN(start)) {
          // Suffix range: last N bytes.
          const suffix = end === 0 ? 0 : end;
          start = Math.max(0, size - suffix);
          end = size - 1;
        } else if (Number.isNaN(end) || end >= size) {
          end = size - 1;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
          return new Response('Range unsatisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
        const body = Readable.toWeb(createReadStream(p, { start, end }));
        return new Response(body as ReadableStream, {
          status: 206,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Type': type,
          },
        });
      }

      const body = Readable.toWeb(createReadStream(p));
      return new Response(body as ReadableStream, {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(size),
          'Content-Type': type,
        },
      });
    } catch (err) {
      return new Response((err as Error).message, { status: 404 });
    }
  });

  store.onChange((project, filePath) => {
    mainWindow?.webContents.send(IPC.projectState, { project, filePath });
  });

  ipcMain.handle(IPC.invoke, (_e, op: MainOp) => handleOp(op));
  registerTerminalIpc();

  await startMcpHttpServer({ store, cacheDir }, MCP_PORT).catch((e) =>
    console.error(`MCP server failed on :${MCP_PORT}: ${e.message}`),
  );
  console.log(`TaxiCut MCP server: http://127.0.0.1:${MCP_PORT}/mcp`);

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
