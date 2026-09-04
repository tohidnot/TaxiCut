// Per-agent MCP setup guides for TaxiCut.
//
// READ-ONLY by design: this module never writes user configs. It detects which
// agent CLIs are installed, checks whether the live TaxiCut MCP server is
// already registered (via each agent's own `mcp list` or its config file), and
// returns copy-paste setup guides. The UI's Run button types the guide command
// into the built-in terminal — the user presses Enter themselves.
//
// Command syntax verified against real CLIs (claude/codex/opencode/grok) and
// official docs (gemini/antigravity/cursor/vscode).
//
// Electron-free (node builtins only) so the smoke test can exercise it with a
// fake HOME and fake agent binaries.
import { execFileSync } from 'node:child_process';
import { constants as fsConstants, accessSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

export interface SetupOpts {
  /** Override home dir (tests). Defaults to TAXICUT_HOME_OVERRIDE ?? os.homedir(). */
  home?: string;
  /** Override PATH for binary lookup and child env (tests). */
  path?: string;
}

export function homeDir(opts?: SetupOpts): string {
  return opts?.home ?? process.env.TAXICUT_HOME_OVERRIDE ?? homedir();
}

/** PATH with entries GUI-launched apps typically miss (Homebrew, ~/.local/bin). */
export function augmentedPath(pathEnv?: string): string {
  const base = (pathEnv ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const home = process.env.TAXICUT_HOME_OVERRIDE ?? homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), '/usr/bin', '/bin'];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...extra, ...base]) {
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(delimiter);
}

export function findBin(name: string, pathEnv?: string): string | null {
  // NOTE: an explicitly passed PATH is used verbatim (tests); otherwise augment.
  for (const dir of (pathEnv ?? augmentedPath()).split(delimiter)) {
    const p = join(dir, name);
    try {
      accessSync(p, fsConstants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Run an agent CLI read-only (`mcp list`). Never mutates anything. */
function runList(bin: string, args: string[], opts?: SetupOpts): string | null {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, HOME: homeDir(opts), PATH: opts?.path ?? augmentedPath() },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(out);
  } catch {
    return null;
  }
}

function readJsonFile(path: string): unknown | null {
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null; // missing, commented (jsonc), or invalid — guide covers manual setup
  }
}

function asObject(doc: unknown): Record<string, unknown> | null {
  return typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
}

function strField(obj: Record<string, unknown> | null, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ---------- guide registry ----------

export interface AgentGuide {
  id: string;
  label: string;
  installed: boolean;
  bin: string | null;
  configured: boolean;
  /** URL currently registered for taxicut, when detectable. */
  currentUrl?: string;
  /** Terminal command for the Run button (null = guide-only, no runnable command). */
  command: string | null;
  /** Where the agent keeps this registration (display string). */
  configPath: string;
  /** How to verify (display string). */
  verify: string | null;
  /** Ordered manual steps (command embedded where relevant). */
  steps: string[];
}

interface AgentDef {
  id: string;
  label: string;
  /** CLI binary used for install detection (best effort for file-based agents). */
  bin: string;
  /** Extra install signals: paths under home whose existence implies installation. */
  alsoInstalledIf?: string[];
  /** Terminal command template ((url) => command) or null when guide-only. */
  command: ((url: string) => string) | null;
  configPath: string;
  verify: string | null;
  steps: (url: string) => string[];
  /** Read-only configured check. */
  check: (binPath: string | null, opts?: SetupOpts) => { configured: boolean; url?: string };
}

const cliListUrl = (re: RegExp, bin: string, args: string[]) => (binPath: string | null, opts?: SetupOpts) => {
  if (!binPath) return { configured: false };
  const out = runList(binPath, args, opts);
  void bin;
  if (out == null) return { configured: false };
  const m = re.exec(out);
  return m ? { configured: true, url: m[1] } : { configured: false };
};

const cliListHas = (bin: string, args: string[]) => (binPath: string | null, opts?: SetupOpts) => {
  if (!binPath) return { configured: false };
  const out = runList(binPath, args, opts);
  void bin;
  return { configured: out != null && out.includes('taxicut') };
};

const jsonEntryUrl = (rel: string[], keys: string[]) => (_bin: string | null, opts?: SetupOpts) => {
  const doc = asObject(readJsonFile(join(homeDir(opts), ...rel)));
  let cur: Record<string, unknown> | null = doc;
  for (const k of keys) cur = cur ? asObject(cur[k]) : null;
  const url = strField(cur, keys[keys.length - 1] === 'taxicut' ? 'url' : keys[keys.length - 1]);
  void _bin;
  return url ? { configured: true, url } : { configured: false };
};

const AGENTS: AgentDef[] = [
  {
    id: 'claudecode', label: 'Claude Code', bin: 'claude',
    command: (url) => `claude mcp add --transport http -s user taxicut ${url}`,
    configPath: '~/.claude.json (user scope)',
    verify: 'claude mcp list, then /mcp inside a session',
    steps: (url) => [
      `Register TaxiCut user-wide (works in every project): \u201c${`claude mcp add --transport http -s user taxicut ${url}`}\u201d — or press Run below and hit Enter.`,
      'Run `claude mcp list` — taxicut should be listed.',
      'Start `claude` and run `/mcp` to confirm the connection.',
      'Tip: opening Claude Code in a folder containing a `.mcp.json` also offers project-scoped servers.',
    ],
    check: cliListUrl(/^taxicut:\s*(\S+)/m, 'claude', ['mcp', 'list']),
  },
  {
    id: 'codex', label: 'Codex', bin: 'codex',
    command: (url) => `codex mcp add taxicut --url ${url}`,
    configPath: '~/.codex/config.toml ([mcp_servers.taxicut])',
    verify: 'codex mcp list',
    steps: (url) => [
      `Register TaxiCut: \u201c${`codex mcp add taxicut --url ${url}`}\u201d — or press Run below and hit Enter.`,
      'Run `codex mcp list` — taxicut should show as enabled.',
      'Restart any running Codex session so it picks up the new tools.',
    ],
    check: cliListUrl(/^taxicut\s+(\S+)/m, 'codex', ['mcp', 'list']),
  },
  {
    id: 'opencode', label: 'OpenCode', bin: 'opencode',
    command: (url) => `opencode mcp add taxicut --url ${url}`,
    configPath: '~/.config/opencode/opencode.jsonc (global)',
    verify: 'opencode mcp list',
    steps: (url) => [
      `Register TaxiCut globally: \u201c${`opencode mcp add taxicut --url ${url}`}\u201d — or press Run below and hit Enter.`,
      'Run `opencode mcp list` — taxicut should be listed.',
      'Equivalent manual entry: `"mcp": {"taxicut": {"type": "remote", "url": "<url>"}}`.',
    ],
    check: cliListHas('opencode', ['mcp', 'list']),
  },
  {
    id: 'grok', label: 'Grok Build', bin: 'grok',
    command: (url) => `grok mcp add -s user -t http taxicut ${url}`,
    configPath: '~/.grok/config.toml ([mcp_servers.taxicut])',
    verify: 'grok mcp list (grok mcp doctor if issues)',
    steps: (url) => [
      `Register TaxiCut user-wide: \u201c${`grok mcp add -s user -t http taxicut ${url}`}\u201d — or press Run below and hit Enter.`,
      'Run `grok mcp list` — taxicut should be listed.',
      'If tools do not appear, run `grok mcp doctor` and `grok inspect`.',
    ],
    check: cliListUrl(/^taxicut:\s*(\S+)/m, 'grok', ['mcp', 'list']),
  },
  {
    id: 'gemini', label: 'Gemini CLI', bin: 'gemini',
    command: (url) => `gemini mcp add -s user -t http taxicut ${url}`,
    configPath: '~/.gemini/settings.json (mcpServers)',
    verify: 'gemini mcp list, or /mcp inside the CLI',
    steps: (url) => [
      `Register TaxiCut user-wide: \u201c${`gemini mcp add -s user -t http taxicut ${url}`}\u201d — or press Run below and hit Enter.`,
      'Manual alternative in ~/.gemini/settings.json: `"mcpServers": {"taxicut": {"httpUrl": "<url>"}}`.',
      'Run `/mcp` inside Gemini CLI to confirm the connection.',
    ],
    check: (binPath, opts) => {
      if (binPath) {
        const out = runList(binPath, ['mcp', 'list'], opts);
        if (out != null) return { configured: out.includes('taxicut') };
      }
      return jsonEntryUrl(['.gemini', 'settings.json'], ['mcpServers', 'taxicut'])(null, opts);
    },
  },
  {
    id: 'cursor', label: 'Cursor', bin: 'cursor',
    alsoInstalledIf: ['.cursor'],
    command: null,
    configPath: '~/.cursor/mcp.json',
    verify: 'Restart Cursor, check Settings → MCP',
    steps: (url) => [
      'Cursor has no terminal setup command — edit ~/.cursor/mcp.json and merge:',
      `{ "mcpServers": { "taxicut": { "url": "${url}" } } }`,
      'Restart Cursor and check Settings → MCP for the taxicut server.',
    ],
    check: jsonEntryUrl(['.cursor', 'mcp.json'], ['mcpServers', 'taxicut']),
  },
  {
    id: 'antigravity', label: 'Antigravity', bin: 'agy',
    alsoInstalledIf: ['.gemini'],
    command: null,
    configPath: '~/.gemini/config/mcp_config.json',
    verify: 'Agent panel → … → MCP Servers',
    steps: (url) => [
      'Antigravity has no terminal setup command — edit ~/.gemini/config/mcp_config.json and merge (note the `serverUrl` key):',
      `{ "mcpServers": { "taxicut": { "serverUrl": "${url}" } } }`,
      'Restart Antigravity (or run as CLI: same file is shared).',
    ],
    check: (_bin, opts) => {
      const doc = asObject(readJsonFile(join(homeDir(opts), '.gemini', 'config', 'mcp_config.json')));
      const servers = doc ? asObject(doc.mcpServers) : null;
      const url = strField(servers ? asObject(servers.taxicut) : null, 'serverUrl');
      void _bin;
      return url ? { configured: true, url } : { configured: false };
    },
  },
  {
    id: 'vscode', label: 'VS Code', bin: 'code',
    alsoInstalledIf: ['Library/Application Support/Code', '.config/Code'],
    command: null,
    configPath: '.vscode/mcp.json (project) or settings.json → mcp.servers',
    verify: 'Copilot Agent mode → MCP tools',
    steps: (url) => [
      'VS Code has no terminal setup command — add a project file `.vscode/mcp.json`:',
      `{ "servers": { "taxicut": { "type": "http", "url": "${url}" } } }`,
      'Global alternative: User settings.json → `"mcp": {"servers": {"taxicut": {"type": "http", "url": "<url>"}}}`.',
    ],
    check: (_bin, opts) => {
      void _bin;
      void opts;
      return { configured: false };
    },
  },
];

export function agentIds(): string[] {
  return AGENTS.map((a) => a.id);
}

function isInstalled(home: string, def: AgentDef, pathEnv?: string): boolean {
  if (findBin(def.bin, pathEnv)) return true;
  for (const rel of def.alsoInstalledIf ?? []) {
    try {
      accessSync(join(home, rel));
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

export interface AgentsStatus {
  mcpUrl: string;
  agents: AgentGuide[];
}

/** Read-only status + guides for the requested agents (all when ids omitted). Never writes. */
export function agentsGuide(url: string, ids?: string[], opts?: SetupOpts): AgentsStatus {
  const home = homeDir(opts);
  const wanted = ids && ids.length > 0 ? new Set(ids) : null;
  const agents = AGENTS.filter((d) => !wanted || wanted.has(d.id)).map((d): AgentGuide => {
    const binPath = findBin(d.bin, opts?.path);
    const st = d.check(binPath, opts);
    return {
      id: d.id,
      label: d.label,
      installed: binPath != null || isInstalled(home, d, opts?.path),
      bin: binPath,
      configured: st.configured,
      ...(st.url ? { currentUrl: st.url } : {}),
      command: d.command ? d.command(url) : null,
      configPath: d.configPath,
      verify: d.verify,
      steps: d.steps(url),
    };
  });
  return { mcpUrl: url, agents };
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}
