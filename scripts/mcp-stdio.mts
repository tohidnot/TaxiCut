#!/usr/bin/env tsx
// Headless TaxiCut MCP server over stdio (no Electron GUI).
// Usage:
//   npm run mcp:stdio [-- --project /abs/path/project.taxicut]
// Agents can also use it directly (stdio transport, universal config):
//   { "command": ["npx", "tsx", "scripts/mcp-stdio.mts"] }
// NOTE: stdio mode owns its own ProjectStore. To drive the open GUI project,
// use the live HTTP server at http://127.0.0.1:19789/mcp instead.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/main/store';
import { startMcpStdioServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../src/main/mcp';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.error(`Usage: mcp-stdio.mts [--project /abs/path/project.taxicut]`);
  process.exit(0);
}

const store = new ProjectStore();
const pi = args.findIndex((a) => a === '--project' || a === '-p');
if (pi >= 0) {
  const p = args[pi + 1];
  if (!p) {
    console.error(`[${MCP_SERVER_NAME}] --project needs a path`);
    process.exit(1);
  }
  const r = await store.dispatch({ op: 'project:open', path: p });
  if (!r.ok) {
    console.error(`[${MCP_SERVER_NAME}] open failed: ${r.error}`);
    process.exit(1);
  }
}

const cacheDir = join(homedir(), '.taxicut', 'cache');
await startMcpStdioServer({ store, cacheDir });
// NEVER log to stdout in stdio mode (it carries the protocol); stderr only.
console.error(`[${MCP_SERVER_NAME} v${MCP_SERVER_VERSION}] listening on stdio`);
