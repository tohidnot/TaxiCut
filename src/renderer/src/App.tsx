import { useEffect } from 'react';
import TerminalPanel from './components/TerminalPanel';
import MediaPanel from './components/MediaPanel';
import PreviewPanel from './components/PreviewPanel';
import InspectorPanel from './components/InspectorPanel';
import TimelinePanel from './components/TimelinePanel';
import { useEditor, op } from './store';
import type { Project } from '../../shared/types';

export default function App() {
  const project = useEditor((s) => s.project);
  const setProject = useEditor((s) => s.setProject);
  const exportNote = useEditor((s) => s.exportNote);
  const setExportNote = useEditor((s) => s.setExportNote);

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

  const onExport = async () => {
    const r = await op({ op: 'export:start' });
    if (!r.ok) setExportNote(`Export failed: ${r.error}`);
  };

  return (
    <div className="app">
      <div className="titlebar">
        <div className="wordmark">
          Taxi<span>Cut</span>
        </div>
        <div className="project-name">{project?.name ?? 'Untitled Project'}</div>
        <div className="actions">
          <button onClick={() => op({ op: 'project:save' })}>Save</button>
          <button className="accent" onClick={onExport}>
            Export
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
