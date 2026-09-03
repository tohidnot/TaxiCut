// node-pty terminal sessions behind IPC.
import { ipcMain, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { IPC } from '../shared/types';

interface Session {
  id: string;
  pty: import('node-pty').IPty;
  sender: WebContents;
}

export function registerTerminalIpc(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty');
  const sessions = new Map<string, Session>();

  ipcMain.handle(IPC.termCreate, (event, opts?: { cols?: number; rows?: number }) => {
    const sender = event.sender;
    const shell = process.env.SHELL || '/bin/zsh';
    const proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: opts?.cols ?? 100,
      rows: opts?.rows ?? 30,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>,
    });
    const session: Session = { id: randomUUID(), pty: proc, sender };
    sessions.set(session.id, session);
    proc.onData((data) => {
      if (!sender.isDestroyed()) sender.send(IPC.termData, session.id, data);
    });
    proc.onExit(({ exitCode }) => {
      sessions.delete(session.id);
      if (!sender.isDestroyed()) sender.send(IPC.termExit, session.id, exitCode);
    });
    return session.id;
  });

  ipcMain.on(IPC.termWrite, (_e, id: string, data: string) => {
    sessions.get(id)?.pty.write(data);
  });

  ipcMain.on(IPC.termResize, (_e, id: string, cols: number, rows: number) => {
    try {
      sessions.get(id)?.pty.resize(cols, rows);
    } catch {
      /* session may be gone */
    }
  });
}
