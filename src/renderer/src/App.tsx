import { useEffect } from 'react';
import TerminalPanel from './components/TerminalPanel';
import MediaPanel from './components/MediaPanel';
import PreviewPanel from './components/PreviewPanel';
import InspectorPanel from './components/InspectorPanel';
import TimelinePanel from './components/TimelinePanel';
import { useEditor, op } from './store';
import type { Project } from '../../shared/types';
import { IconFilePlus, IconFolderOpen, IconSave, IconExport } from './components/Icons';

export default function App() {
  const project = useEditor((s) => s.project);
  const setProject = useEditor((s) => s.setProject);
  const exportNote = useEditor((s) => s.exportNote);
  const setExportNote = useEditor((s) => s.setExportNote);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const playheadSec = useEditor((s) => s.playheadSec);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const select = useEditor((s) => s.select);

  useEffect(() => {
    const off = window.taxicut.onProjectState((state) => {
      setProject(state.project as Project, state.filePath);
    });
    window.taxicut.onExportProgress((job) => {
      const j = job as { status: string; progress: number; outPath: string; error?: string };
      if (j.status === 'running') setExportNote(`Exporting… ${Math.round(j.progress * 100)}%`);
      else if (j.status === 'done') setExportNote(`Exported to ${j.outPath}`);
      else setExportNote(`Export failed: ${j.error}`);
      if (j.status !== 'running') setTimeout(() => setExportNote(null), 5000);
    });
    op({ op: 'project:get' }).then((r) => {
      const d = r.data as { project: Project; filePath: string | null };
      if (d) setProject(d.project, d.filePath);
    });
    return off;
  }, [setProject, setExportNote]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.closest('.terminal-body') ||
          target.closest('.xterm'))
      ) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

      if (e.code === 'Space') {
        e.preventDefault();
        const st = useEditor.getState();
        if (st.previewMode === 'source') {
          st.setSourcePlaying(!st.sourcePlaying);
        } else {
          setPlaying(!useEditor.getState().playing);
        }
      } else if (cmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        op({ op: 'history:undo' });
      } else if ((cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 'z') || (cmdOrCtrl && e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        op({ op: 'history:redo' });
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        const id = useEditor.getState().selectedClipId;
        if (id) {
          e.preventDefault();
          op({ op: 'timeline:deleteClip', clipId: id, ripple: e.shiftKey });
          select(null);
        }
      } else if ((cmdOrCtrl && e.key.toLowerCase() === 'b') || (!cmdOrCtrl && e.key.toLowerCase() === 's')) {
        e.preventDefault();
        const p = useEditor.getState().project;
        const curPlayhead = useEditor.getState().playheadSec;
        const id = useEditor.getState().selectedClipId;
        let splitId = id;
        if (!splitId && p) {
          for (const t of p.tracks) {
            const found = t.clips.find((c) => curPlayhead > c.startSec && curPlayhead < c.startSec + c.durationSec);
            if (found) {
              splitId = found.id;
              break;
            }
          }
        }
        if (splitId) {
          op({ op: 'timeline:splitClip', clipId: splitId, atSec: curPlayhead });
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const st = useEditor.getState();
        if (st.previewMode === 'source') {
          st.setSourcePlaying(false);
          const delta = e.shiftKey ? 1.0 : 1 / 30;
          st.setSourcePlayhead(Math.max(0, st.sourcePlayheadSec - delta));
        } else {
          setPlaying(false);
          const delta = e.shiftKey ? 1.0 : 1 / 30;
          setPlayhead(Math.max(0, useEditor.getState().playheadSec - delta));
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const st = useEditor.getState();
        if (st.previewMode === 'source') {
          const media = st.project?.media.find((m) => m.id === st.selectedMediaId);
          st.setSourcePlaying(false);
          const delta = e.shiftKey ? 1.0 : 1 / 30;
          st.setSourcePlayhead(Math.min(media?.durationSec ?? Infinity, st.sourcePlayheadSec + delta));
        } else {
          setPlaying(false);
          const delta = e.shiftKey ? 1.0 : 1 / 30;
          setPlayhead(useEditor.getState().playheadSec + delta);
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        const st = useEditor.getState();
        if (st.previewMode === 'source') {
          st.setSourcePlaying(false);
          st.setSourcePlayhead(0);
        } else {
          setPlayhead(0);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setPlaying, setPlayhead, select]);

  const onNew = async () => {
    if (project?.modified && !confirm('Discard unsaved changes and start a new project?')) {
      return;
    }
    const r = await op({ op: 'project:new' });
    if (!r.ok) alert(r.error);
  };

  const onOpen = async () => {
    if (project?.modified && !confirm('Discard unsaved changes and open a project?')) {
      return;
    }
    const r = await op({ op: 'project:open' });
    if (!r.ok && r.error && !r.error.includes('cancelled')) alert(r.error);
  };

  const onSave = async () => {
    const r = await op({ op: 'project:save' });
    if (!r.ok && r.error && !r.error.includes('cancelled')) setExportNote(`Save failed: ${r.error}`);
    else if (r.ok) setExportNote('Project saved');
    setTimeout(() => setExportNote(null), 3000);
  };

  const onExport = async () => {
    const r = await op({ op: 'export:start' });
    if (!r.ok && r.error && !r.error.includes('cancelled')) setExportNote(`Export failed: ${r.error}`);
  };

  return (
    <div className="app">
      <div className="titlebar">
        <div className="wordmark">
          Taxi<span>Cut</span>
        </div>
        <div className="project-name">
          {project?.name ?? 'Untitled Project'}
          {project?.modified ? ' •' : ''}
        </div>
        <div className="actions">
          <button onClick={onNew} title="New Project" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <IconFilePlus size={12} /> New
          </button>
          <button onClick={onOpen} title="Open Project" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <IconFolderOpen size={12} /> Open…
          </button>
          <button onClick={onSave} title="Save Project (Cmd+S)" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <IconSave size={12} /> Save
          </button>
          <button className="accent" onClick={onExport} title="Export Timeline to MP4" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <IconExport size={12} /> Export
          </button>
        </div>
      </div>
      <div className="workspace">
        <TerminalPanel />
        <div className="main-col">
          <div className="main-top">
            <MediaPanel />
            <PreviewPanel />
            <InspectorPanel />
          </div>
          <TimelinePanel />
        </div>
      </div>
      {exportNote && <div className="flash-note">{exportNote}</div>}
    </div>
  );
}
