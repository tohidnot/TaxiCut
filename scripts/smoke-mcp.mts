// End-to-end smoke test: MCP server + ffmpeg export, no Electron GUI.
// Run: npm run smoke
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/main/store';
import { startMcpHttpServer } from '../src/main/mcp';

const PORT = 19811;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

async function rpc(method: string, params: unknown = {}): Promise<unknown> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const text = await res.text();
  // Streamable HTTP may answer as SSE `data:` lines or plain JSON.
  const jsonLine = text.startsWith('event:')
    ? text.split('\n').find((l) => l.startsWith('data:'))
    : text;
  const msg = JSON.parse(jsonLine ? String(jsonLine).replace(/^data:\s*/, '') : 'null');
  if (!msg) throw new Error(`Empty response for ${method}: ${text.slice(0, 200)}`);
  if (msg.error) throw new Error(`${method} failed: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{
  ok: boolean;
  payload: unknown;
}> {
  const result = (await rpc('tools/call', { name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  const payload = JSON.parse(result.content?.[0]?.text ?? 'null');
  return { ok: !result.isError && payload?.ok !== false, payload };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const work = mkdtempSync(join(tmpdir(), 'taxicut-smoke-'));
const testVideo = join(work, 'clip.mp4');
execFileSync('/opt/homebrew/bin/ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', testVideo,
]);

const store = new ProjectStore();
const server = await startMcpHttpServer({ store, cacheDir: work }, PORT);
console.log('MCP server up on', BASE);

try {
  const tools = (await rpc('tools/list')) as { tools: { name: string }[] };
  console.log('tools:', tools.tools.map((t) => t.name).join(', '));
  assert(tools.tools.some((t) => t.name === 'export_timeline'), 'export_timeline missing');

  let r = await callTool('project_new', { name: 'Smoke' });
  assert(r.ok, 'project_new failed');

  r = await callTool('import_media', { path: testVideo });
  assert(r.ok, 'import_media failed');
  const mediaId = (r.payload as { id: string }).id;

  r = await callTool('add_clip', { mediaId });
  assert(r.ok, 'add_clip failed');
  const clipId = (r.payload as { id: string }).id;

  r = await callTool('split_clip', { clipId, atSec: 1.5 });
  assert(r.ok, `split_clip failed: ${JSON.stringify(r.payload)}`);

  r = await callTool('get_timeline');
  const tracks = r.payload as { clips: { id: string }[] }[];
  const totalClips = tracks.reduce((n, t) => n + t.clips.length, 0);
  assert(totalClips === 2, `expected 2 clips after split, got ${totalClips}`);

  r = await callTool('undo');
  assert(r.ok, 'undo failed');
  r = await callTool('redo');
  assert(r.ok, 'redo failed');

  r = await callTool('set_clip_properties', { clipId, volumeDb: -6, fadeOutSec: 0.3 });
  assert(r.ok, 'set_clip_properties failed');

  const out = join(work, 'export.mp4');
  r = await callTool('export_timeline', { path: out });
  assert(r.ok, 'export_timeline failed');
  const jobId = (r.payload as { jobId: string }).jobId;

  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    r = await callTool('export_status', { jobId });
    const job = r.payload as { status: string; error?: string };
    if (job.status === 'done') break;
    if (job.status === 'error') throw new Error(`export failed: ${job.error}`);
  }
  assert(existsSync(out), 'export file missing');
  const probe = execFileSync('/opt/homebrew/bin/ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out,
  ]).toString().trim();
  const dur = parseFloat(probe);
  console.log('export duration:', dur);
  assert(dur > 1.5 && dur < 3.5, `unexpected export duration ${dur}`);

  console.log('\nSMOKE TEST PASSED');
} finally {
  server.close();
}
