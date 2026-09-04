import { create } from 'zustand';
import type { Project } from '../../shared/types';

interface EditorState {
  project: Project | null;
  filePath: string | null;
  selectedClipId: string | null;
  selectedMediaId: string | null;
  previewMode: 'timeline' | 'source';
  playheadSec: number;
  playing: boolean;
  sourcePlayheadSec: number;
  sourcePlaying: boolean;
  cropMode: boolean;
  pxPerSec: number;
  exportNote: string | null;
  setProject: (p: Project, filePath: string | null) => void;
  select: (clipId: string | null) => void;
  selectMedia: (mediaId: string | null) => void;
  setPreviewMode: (mode: 'timeline' | 'source') => void;
  setPlayhead: (sec: number) => void;
  setPlaying: (playing: boolean) => void;
  setSourcePlayhead: (sec: number) => void;
  setSourcePlaying: (playing: boolean) => void;
  setCropMode: (cropMode: boolean) => void;
  setZoom: (pxPerSec: number) => void;
  setExportNote: (note: string | null) => void;
}

export const useEditor = create<EditorState>((set) => ({
  project: null,
  filePath: null,
  selectedClipId: null,
  selectedMediaId: null,
  previewMode: 'timeline',
  playheadSec: 0,
  playing: false,
  sourcePlayheadSec: 0,
  sourcePlaying: false,
  cropMode: false,
  pxPerSec: 60,
  exportNote: null,
  setProject: (project, filePath) => set({ project, filePath }),
  select: (selectedClipId) =>
    // Keep playing when selecting mid-playback (CapCut-style); only stop
    // when switching back from source mode.
    set((s) => ({
      selectedClipId,
      selectedMediaId: null,
      previewMode: 'timeline',
      playing: s.previewMode === 'timeline' ? s.playing : false,
    })),
  selectMedia: (selectedMediaId) =>
    set({ selectedMediaId, selectedClipId: null, previewMode: selectedMediaId ? 'source' : 'timeline', playing: false, sourcePlaying: false, sourcePlayheadSec: 0 }),
  setPreviewMode: (previewMode) => set({ previewMode, playing: false, sourcePlaying: false }),
  setPlayhead: (playheadSec) => set({ playheadSec }),
  setPlaying: (playing) => set({ playing }),
  setSourcePlayhead: (sourcePlayheadSec) => set({ sourcePlayheadSec }),
  setSourcePlaying: (sourcePlaying) => set({ sourcePlaying }),
  setCropMode: (cropMode) => set({ cropMode }),
  setZoom: (pxPerSec) => set({ pxPerSec }),
  setExportNote: (exportNote) => set({ exportNote }),
}));

export const op = (o: Parameters<typeof window.taxicut.invoke>[0]) =>
  window.taxicut.invoke(o);
