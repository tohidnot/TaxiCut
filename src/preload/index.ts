import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type MainOp, type OpResult } from '../shared/types';

export const api = {
  invoke: (op: MainOp): Promise<OpResult> => ipcRenderer.invoke(IPC.invoke, op),
  onProjectState: (cb: (state: { project: unknown; filePath: string | null }) => void) => {
    const fn = (_e: unknown, state: { project: unknown; filePath: string | null }) => cb(state);
    ipcRenderer.on(IPC.projectState, fn);
    return () => { ipcRenderer.removeListener(IPC.projectState, fn); };
  },
  onExportProgress: (cb: (job: unknown) => void) => {
    const fn = (_e: unknown, job: unknown) => cb(job);
    ipcRenderer.on('taxicut:export-progress', fn);
    return () => { ipcRenderer.removeListener('taxicut:export-progress', fn); };
  },
  term: {
    create: (opts?: { cols?: number; rows?: number }): Promise<string> =>
      ipcRenderer.invoke(IPC.termCreate, opts),
    write: (id: string, data: string) => ipcRenderer.send(IPC.termWrite, id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send(IPC.termResize, id, cols, rows),
    onData: (cb: (id: string, data: string) => void) => {
      const fn = (_e: unknown, id: string, data: string) => cb(id, data);
      ipcRenderer.on(IPC.termData, fn);
      return () => { ipcRenderer.removeListener(IPC.termData, fn); };
    },
    onExit: (cb: (id: string, code: number) => void) => {
      const fn = (_e: unknown, id: string, code: number) => cb(id, code);
      ipcRenderer.on(IPC.termExit, fn);
      return () => { ipcRenderer.removeListener(IPC.termExit, fn); };
    },
  },
  mediaUrl: (filePath: string) => `taxicut-file://${encodeURIComponent(filePath)}`,
};

export type TaxiCutApi = typeof api;

contextBridge.exposeInMainWorld('taxicut', api);
