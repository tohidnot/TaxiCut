import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
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
  { scheme: 'taxicut-file', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true } },
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
    'project:get', 'project:new', 'project:open', 'project:save',
    'timeline:addClip', 'timeline:moveClip', 'timeline:trimClip', 'timeline:splitClip',
    'timeline:deleteClip', 'clip:setProps', 'track:add', 'track:setMute',
    'history:undo', 'history:redo',
  ];
  if (storeOps.includes(op.op)) return store.dispatch(op);

  switch (op.op) {
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

app.whenReady().then(async () => {
  // Serve local media/thumbnail files to the renderer.
  protocol.handle('taxicut-file', (req) =>
    net.fetch(pathToFileURL(decodeURIComponent(new URL(req.url).pathname)).toString()),
  );

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
