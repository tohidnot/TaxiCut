import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement>(null);

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
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let id: string | null = null;
    const offData = window.taxicut.term.onData((sid, data) => {
      if (sid === id) term.write(data);
    });
    const offExit = window.taxicut.term.onExit((sid) => {
      if (sid === id) term.write('\r\n[session ended]\r\n');
    });

    window.taxicut.term.create({ cols: term.cols, rows: term.rows }).then((sid) => {
      id = sid;
    });
    term.onData((data) => {
      if (id) window.taxicut.term.write(id, data);
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      if (id) window.taxicut.term.resize(id, term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      offData();
      offExit();
      term.dispose();
    };
  }, []);

  return (
    <div className="terminal-panel">
      <div className="panel-header">
        Terminal
        <span className="spacer" />
      </div>
      <div className="terminal-hint">
        Run your agent here, e.g. <code>claude</code>, then:<br />
        <code>claude mcp add --transport http taxicut http://127.0.0.1:19789/mcp</code>
      </div>
      <div className="terminal-body" ref={hostRef} />
    </div>
  );
}
