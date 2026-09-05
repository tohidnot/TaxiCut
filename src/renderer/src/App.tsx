import { useEffect, useState } from 'react';
import TerminalPanel from './components/TerminalPanel';
import MediaPanel from './components/MediaPanel';
import PreviewPanel from './components/PreviewPanel';
import InspectorPanel from './components/InspectorPanel';
import TimelinePanel from './components/TimelinePanel';
import { useEditor, op } from './store';
import type { Project } from '../../shared/types';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';

export default function App() {
  const project = useEditor((s) => s.project);
  const setProject = useEditor((s) => s.setProject);
  const [confirmNewOpen, setConfirmNewOpen] = useState(false);
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
      if (j.status === 'running') toast.loading(`Exporting… ${Math.round(j.progress * 100)}%`, { id: 'export' });
      else if (j.status === 'done') toast.success(`Exported to ${j.outPath}`, { id: 'export' });
      else toast.error(`Export failed: ${j.error}`, { id: 'export' });
    });
    op({ op: 'project:get' }).then((r) => {
      const d = r.data as { project: Project; filePath: string | null };
      if (d) setProject(d.project, d.filePath);
    });
    return off;
  }, [setProject]);

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
      } else if (cmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'c') {
        const id = useEditor.getState().selectedClipId;
        if (id) {
          e.preventDefault();
          useEditor.getState().setCopiedClip(id);
        }
      } else if (cmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'v') {
        const st = useEditor.getState();
        const src = st.copiedClipId ?? st.selectedClipId;
        if (src) {
          e.preventDefault();
          op({ op: 'timeline:duplicateClip', clipId: src, startSec: st.playheadSec }).then((r) => {
            if (r.ok && r.data) st.select((r.data as { id: string }).id);
            else if (!r.ok) alert(r.error);
          });
        }
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
      } else if (cmdOrCtrl && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        const id = useEditor.getState().selectedClipId;
        if (!id) return;
        e.preventDefault();
        const forward = e.code === 'BracketRight';
        if (e.shiftKey) {
          op({ op: 'timeline:reorderClip', clipId: id, position: forward ? 'front' : 'back' });
        } else {
          op({ op: 'timeline:reorderClip', clipId: id, direction: forward ? 1 : -1 });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setPlaying, setPlayhead, select]);

  const doNew = async () => {
    const r = await op({ op: 'project:new' });
    if (!r.ok) toast.error(r.error);
  };

  const onNew = () => {
    if (project?.modified) {
      setConfirmNewOpen(true);
      return;
    }
    void doNew();
  };

  const onExport = async () => {
    const r = await op({ op: 'export:start' });
    if (!r.ok && r.error && !r.error.includes('cancelled')) toast.error(`Export failed: ${r.error}`);
  };

  return (
    <TooltipProvider>
      <div className="app dark">
        <div className="titlebar">
          <div className="wordmark">
            Taxi<span>Cut</span>
          </div>
          <div className="project-name">
            {project?.name ?? 'Untitled Project'}
            {project?.modified ? ' •' : ''}
          </div>
          <div className="actions">
            <Button variant="outline" size="sm" onClick={onNew} title="New Project">
              <Plus data-icon="inline-start" /> New
            </Button>
            <Button variant="default" size="sm" onClick={onExport} title="Export Timeline to MP4">
              <Download data-icon="inline-start" /> Export
            </Button>
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
        <AlertDialog open={confirmNewOpen} onOpenChange={setConfirmNewOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Start a new project?</AlertDialogTitle>
              <AlertDialogDescription>
                Unsaved changes to “{project?.name ?? 'Untitled Project'}” will be discarded.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  void doNew();
                }}
              >
                Discard &amp; New
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Toaster position="bottom-center" />
      </div>
    </TooltipProvider>
  );
}
