// End-to-end smoke test: MCP server + ffmpeg export, no Electron GUI.
// Run: npm run smoke
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/main/store';
import { startMcpHttpServer } from '../src/main/mcp';
import { agentsGuide, agentIds } from '../src/main/mcp-setup';

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

function assert(cond: unknown, msg: string): asserts cond {
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
  const tools = (await rpc('tools/list')) as {
    tools: { name: string; title?: string; annotations?: Record<string, boolean>; inputSchema: unknown; outputSchema?: unknown }[];
  };
  console.log('tools:', tools.tools.map((t) => t.name).join(', '));
  assert(tools.tools.some((t) => t.name === 'export_timeline'), 'export_timeline missing');
  assert(tools.tools.some((t) => t.name === 'reorder_clip'), 'reorder_clip missing');
  // Standard-practice surface: new query tools, counts, titles, annotations.
  for (const n of ['server_info', 'find_clips', 'get_clip', 'project_info', 'list_media', 'get_timeline']) {
    assert(tools.tools.some((t) => t.name === n), `${n} missing`);
  }
  assert(tools.tools.length === 32, `expected 32 tools, got ${tools.tools.length}`);
  for (const t of tools.tools) {
    assert(t.title && t.title.length > 0, `tool ${t.name} missing title`);
    assert(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', `tool ${t.name} missing annotations`);
    assert(t.inputSchema, `tool ${t.name} missing inputSchema`);
  }
  const projTool = tools.tools.find((t) => t.name === 'project_info');
  assert(projTool?.annotations?.readOnlyHint === true, 'project_info should be readOnly');
  assert(projTool?.outputSchema, 'project_info should declare outputSchema');
  const delTool = tools.tools.find((t) => t.name === 'delete_clip');
  assert(delTool?.annotations?.destructiveHint === true, 'delete_clip should be destructive');

  const resources = (await rpc('resources/list')) as { resources: { uri: string }[] };
  console.log('resources:', resources.resources.map((r) => r.uri).join(', '));
  assert(resources.resources.length === 3, `expected 3 resources, got ${resources.resources.length}`);

  const prompts = (await rpc('prompts/list')) as { prompts: { name: string }[] };
  console.log('prompts:', prompts.prompts.map((p) => p.name).join(', '));
  assert(prompts.prompts.length === 3, `expected 3 prompts, got ${prompts.prompts.length}`);

  // Discovery endpoints.
  const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { ok: boolean; name: string };
  assert(health.ok === true && health.name === 'taxicut-mcp-server', `bad /health: ${JSON.stringify(health)}`);
  const doc = (await (await fetch(`http://127.0.0.1:${PORT}/mcp.json`)).json()) as { url: string };
  assert(doc.url?.includes('/mcp'), `bad /mcp.json: ${JSON.stringify(doc)}`);
  console.log('discovery endpoints: ok');

  // Agent guides: read-only (fake HOME + fake `claude`), never touch real configs.
  {
    const ids = agentIds();
    for (const want of ['claudecode', 'codex', 'opencode', 'grok', 'gemini', 'cursor', 'antigravity', 'vscode']) {
      assert(ids.includes(want), `agent guide missing: ${want}`);
    }
    const fakeHome = join(work, 'fakehome');
    const fakeBin = join(fakeHome, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const testUrl = `http://127.0.0.1:${PORT}/mcp`;
    writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo "taxicut: ${testUrl} (HTTP)"; fi\nexit 0\n`);
    chmodSync(join(fakeBin, 'claude'), 0o755);
    const opts = { home: fakeHome, path: fakeBin };
    const { mcpUrl: guideUrl, agents } = agentsGuide(testUrl, undefined, opts);
    assert(guideUrl === testUrl, 'guide url mismatch');
    const byId = new Map(agents.map((a) => [a.id, a]));
    const cc = byId.get('claudecode')!;
    assert(cc.installed && cc.configured, 'fake claude should be installed+configured');
    assert(cc.command === `claude mcp add --transport http -s user taxicut ${testUrl}`, `bad claude command: ${cc.command}`);
    assert(cc.steps.length >= 3, 'claude guide needs steps');
    for (const runnable of ['codex', 'opencode', 'grok', 'gemini']) {
      const g = byId.get(runnable)!;
      assert(typeof g.command === 'string' && g.command.includes(testUrl), `${runnable} needs a runnable command`);
      assert(g.steps.length >= 2, `${runnable} guide needs steps`);
    }
    for (const manual of ['cursor', 'antigravity', 'vscode']) {
      const g = byId.get(manual)!;
      assert(g.command === null, `${manual} must be guide-only (no runnable command)`);
      assert(g.steps.length >= 2, `${manual} guide needs steps`);
      assert(!g.configured, `${manual} should be unconfigured in empty fake home`);
    }
    // Nothing but our fake bin may exist in the fake home — guides must not write.
    assert(JSON.stringify(readdirSync(fakeHome).sort()) === JSON.stringify(['bin']), 'guides wrote into HOME!');
    console.log('agent guides (read-only): ok');
  }

  // Store-level layer reshuffle: overlapping video / image / text can move
  // top ↔ bottom ↔ middle (swap or insert; never bounce off an occupied lane).
  {
    const s = new ProjectStore();
    s.newProject('shuffle');
    const mk = (id: string, kind: 'video' | 'image' = 'video') =>
      s.addMedia({
        id, path: testVideo, name: id, kind, durationSec: 3, width: 640, height: 360,
        fps: 30, hasAudio: false, thumbnailPath: null,
      });
    mk('mv');
    mk('mi', 'image');
    const a = s.addClip({ mediaId: 'mv', startSec: 0, durationSec: 2 });
    const b = s.addClip({ mediaId: 'mi', startSec: 0, durationSec: 2 });
    const t = s.addClip({ mediaId: 'text', startSec: 0, durationSec: 2, text: 'Hi' });
    const clipA = a.data;
    const clipB = b.data;
    const clipT = t.data;
    assert(a.ok && clipA && b.ok && clipB && t.ok && clipT, 'shuffle addClip failed');
    const vids = () => s.project.tracks.filter((x) => x.kind === 'video');
    assert(vids().length >= 3, `expected ≥3 video layers, got ${vids().length}`);
    const layerOf = (id: string): number => {
      const f = s.findClip(id);
      assert(f, `missing clip ${id}`);
      return vids().findIndex((x) => x.id === f!.track.id);
    };
    assert(layerOf(clipA.id) === 0, 'video should start on the bottom layer');
    assert(layerOf(clipT.id) === vids().length - 1, 'text should start on the top layer');

    const rBack = s.reorderClip(clipT.id, { position: 'back' });
    assert(rBack.ok, `send to back failed: ${rBack.error}`);
    assert(layerOf(clipT.id) === 0, `text back expected 0, got ${layerOf(clipT.id)}`);

    const rFront = s.reorderClip(clipT.id, { position: 'front' });
    assert(rFront.ok, `bring to front failed: ${rFront.error}`);
    assert(layerOf(clipT.id) === vids().length - 1, 'text should be front again');

    const imgLayer = layerOf(clipB.id);
    const rUp = s.reorderClip(clipB.id, { direction: 1 });
    assert(rUp.ok, `move up failed: ${rUp.error}`);
    assert(layerOf(clipB.id) > imgLayer, `image should move toward front (${imgLayer} → ${layerOf(clipB.id)})`);

    const rDown = s.reorderClip(clipB.id, { direction: -1 });
    assert(rDown.ok, `move down failed: ${rDown.error}`);

    const baseId = vids()[0].id;
    const mv = s.moveClip(clipB.id, 0, baseId, 'layer');
    assert(mv.ok, `place=layer failed: ${mv.error}`);
    assert(layerOf(clipB.id) === 0, `image should land on the bottom layer, got ${layerOf(clipB.id)}`);

    const rMid = s.reorderClip(clipT.id, { toIndex: 1 });
    assert(rMid.ok, `toIndex middle failed: ${rMid.error}`);
    assert(layerOf(clipT.id) === 1, `text should land in the middle, got ${layerOf(clipT.id)}`);
    console.log('layer reshuffle: ok');
  }

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

  // New query surface: server_info (structured), pagination, find/get clip.
  r = await callTool('server_info');
  assert(r.ok, 'server_info failed');
  assert((r.payload as { name: string }).name === 'taxicut-mcp-server', 'server_info name mismatch');
  assert((r.payload as { toolCount: number }).toolCount === 32, 'server_info toolCount mismatch');

  r = await callTool('list_media', { limit: 1, offset: 0 });
  const page = r.payload as { total: number; count: number; has_more: boolean; items: unknown[] };
  assert(page.total === 1 && page.count === 1 && page.has_more === false, `bad media page: ${JSON.stringify(page)}`);

  r = await callTool('get_timeline', { summary: true });
  assert(Array.isArray((r.payload as { tracks: unknown[] }).tracks), 'timeline summary missing tracks');

  r = await callTool('find_clips', { query: 'clip', limit: 10 });
  const hits = r.payload as { total: number; items: { clip: { id: string } }[] };
  assert(hits.total === 2, `expected 2 find_clips hits, got ${hits.total}`);

  r = await callTool('get_clip', { clipId });
  assert((r.payload as { clip: { id: string } }).clip.id === clipId, 'get_clip returned wrong clip');

  r = await callTool('get_clip', { clipId: 'nope' });
  assert(!r.ok, 'get_clip should fail on unknown id');

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

  // Multi-layer: overlap auto-layers onto V2, export composites both.
  r = await callTool('add_track', { kind: 'video' });
  assert(r.ok, 'add_track failed');
  const v2 = (r.payload as { id: string }).id;
  r = await callTool('add_clip', { mediaId, trackId: v2, startSec: 1, durationSec: 2 });
  assert(r.ok, `overlay add_clip failed: ${JSON.stringify(r.payload)}`);

  r = await callTool('get_timeline');
  const tl = r.payload as { id: string; kind: string; clips: { id: string; startSec: number; durationSec: number }[] }[];
  const vids = tl.filter((t) => t.kind === 'video');
  assert(vids.length === 2, `expected 2 video tracks, got ${vids.length}`);
  for (const t of vids) {
    const cs = [...t.clips].sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < cs.length; i++) {
      assert(cs[i].startSec >= cs[i - 1].startSec + cs[i - 1].durationSec - 1e-6, 'same-track overlap after auto-layer');
    }
  }

  const out2 = join(work, 'export-layered.mp4');
  r = await callTool('export_timeline', { path: out2 });
  assert(r.ok, 'layered export_timeline failed');
  const jobId2 = (r.payload as { jobId: string }).jobId;
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    r = await callTool('export_status', { jobId: jobId2 });
    const job = r.payload as { status: string; error?: string };
    if (job.status === 'done') break;
    if (job.status === 'error') throw new Error(`layered export failed: ${job.error}`);
  }
  assert(existsSync(out2), 'layered export file missing');
  const probe2 = execFileSync('/opt/homebrew/bin/ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out2,
  ]).toString().trim();
  const dur2 = parseFloat(probe2);
  console.log('layered export duration:', dur2);
  assert(dur2 > 2 && dur2 < 4, `unexpected layered export duration ${dur2}`);

  console.log('\nSMOKE TEST PASSED');
} finally {
  server.close();
}
