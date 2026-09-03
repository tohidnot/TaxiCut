import { create } from 'zustand';
import type { Project } from '../../shared/types';

interface EditorState {
  project: Project | null;
  filePath: string | null;
  selectedClipId: string | null;
  playheadSec: number;
  playing: boolean;
  pxPerSec: number;
  exportNote: string | null;
  setProject: (p: Project, filePath: string | null) => void;
  select: (clipId: string | null) => void;
  setPlayhead: (sec: number) => void;
  setPlaying: (playing: boolean) => void;
  setZoom: (pxPerSec: number) => void;
  setExportNote: (note: string | null) => void;
}

export const useEditor = create<EditorState>((set) => ({
  project: null,
  filePath: null,
  selectedClipId: null,
  playheadSec: 0,
  playing: false,
  pxPerSec: 60,
  exportNote: null,
  setProject: (project, filePath) => set({ project, filePath }),
  select: (selectedClipId) => set({ selectedClipId }),
  setPlayhead: (playheadSec) => set({ playheadSec }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (pxPerSec) => set({ pxPerSec }),
  setExportNote: (exportNote) => set({ exportNote }),
}));

export const op = (o: Parameters<typeof window.taxicut.invoke>[0]) =>
  window.taxicut.invoke(o);
