import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { op } from '../store';

interface AgentGuide {
  id: string;
  label: string;
  installed: boolean;
  bin: string | null;
  configured: boolean;
  currentUrl?: string;
  /** Terminal command for Run (null = guide-only, no runnable command). */
  command: string | null;
  configPath: string;
  verify: string | null;
  steps: string[];
}

interface AgentsStatus {
  mcpUrl: string;
  agents: AgentGuide[];
}

export default function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [guides, setGuides] = useState<AgentsStatus | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typedNote, setTypedNote] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: 'Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: '#141417',
        foreground: '#e8e8ec',
        cursor: '#7c5cff',
        selectionBackground: '#3a3560',
      },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let id: string | null = null;
    const offData = window.taxicut.term.onData((sid2, data) => {
      if (sid2 === id) term.write(data);
    });
    const offExit = window.taxicut.term.onExit((sid2) => {
      if (sid2 === id) term.write('\r\n[session ended]\r\n');
    });

    window.taxicut.term.create({ cols: term.cols, rows: term.rows }).then((newId) => {
      id = newId;
      setSid(newId);
    });
    term.onData((data) => {
      if (id) window.taxicut.term.write(id, data);
    });

    const ro = new ResizeObserver(() => {
      if (host.clientWidth === 0) return;
      fit.fit();
      if (id) window.taxicut.term.resize(id, term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      offData();
      offExit();
      term.dispose();
      fitRef.current = null;
    };
  }, []);

  // Refit after un-collapsing (xterm can't measure while display:none).
  useEffect(() => {
    if (!collapsed) requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* session may be gone */
      }
    });
  }, [collapsed]);

  const refreshGuides = async (): Promise<void> => {
    const r = await op({ op: 'agents:status' });
    if (r.ok) setGuides(r.data as AgentsStatus);
  };

  useEffect(() => {
    if (setupOpen) void refreshGuides();
  }, [setupOpen]);

  const runInTerminal = (g: AgentGuide): void => {
    if (!g.command) return;
    if (!sid) {
      setTypedNote('Terminal session is not ready yet — wait a second and retry.');
      return;
    }
    // Typed, NOT executed: the user reviews and presses Enter themselves.
    window.taxicut.term.write(sid, g.command);
    setTypedNote(`Typed for ${g.label} — review and press Enter in the terminal to run it.`);
  };

  return (
    <div className="terminal-panel">
      <div className="panel-header">
        Terminal
        <span className="spacer" />
        <button
          className={setupOpen ? 'mini-btn active' : 'mini-btn'}
          title="Per-agent MCP setup guides"
          onClick={() => setSetupOpen((v) => !v)}
        >
          MCP Setup
        </button>
        <button
          className="mini-btn"
          title={collapsed ? 'Show terminal' : 'Hide terminal'}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {setupOpen && (
        <div className="mcp-setup">
          <div className="mcp-setup-head">
            <span>Connect an agent to this app&apos;s MCP server.</span>
            <button className="mini-btn" title="Refresh detection" onClick={() => void refreshGuides()}>↻</button>
          </div>
          {!guides && <div className="mcp-setup-note">Loading…</div>}
          {guides?.agents.map((g) => (
            <div className="agent-row" key={g.id}>
              <div className="agent-row-main">
                <span
                  className={g.configured ? 'agent-dot ok' : g.installed ? 'agent-dot warn' : 'agent-dot missing'}
                  title={g.configured ? 'MCP registered' : g.installed ? 'Installed, not connected' : 'Not installed'}
                />
                <span className="agent-name">{g.label}</span>
                <span className="spacer" />
                <button
                  className="mini-btn"
                  title={`Setup guide for ${g.label}`}
                  onClick={() => setExpandedId((cur) => (cur === g.id ? null : g.id))}
                >
                  {expandedId === g.id ? 'Hide' : 'Guide'}
                </button>
                {g.command && (
                  <button
                    className="mini-btn accent"
                    title={`Type the setup command into the terminal (you press Enter).${g.installed ? '' : ` ${g.label} is not installed — the command will fail until you install it.`}`}
                    onClick={() => runInTerminal(g)}
                  >
                    Run
                  </button>
                )}
              </div>
              {expandedId === g.id && (
                <div className="agent-guide">
                  <ol>
                    {g.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                  <div className="agent-meta">Config: <code>{g.configPath}</code></div>
                  {g.verify && <div className="agent-meta">Verify: <code>{g.verify}</code></div>}
                  {g.configured && g.currentUrl && (
                    <div className="agent-meta">Registered: <code>{g.currentUrl}</code></div>
                  )}
                </div>
              )}
            </div>
          ))}
          {typedNote && <div className="mcp-setup-note">{typedNote}</div>}
        </div>
      )}
      {!collapsed && (
        <div className="terminal-hint">
          Run your agent here, e.g. <code>claude</code>, or open <b>MCP Setup</b> above
          for per-agent guides with a Run button.
        </div>
      )}
      <div className="terminal-body" ref={hostRef} style={collapsed ? { display: 'none' } : undefined} />
    </div>
  );
}
