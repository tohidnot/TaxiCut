import React, { useState } from 'react';
import { useEditor, op } from '../store';
import { formatDuration } from '../time';
import type { MediaAsset } from '../../../shared/types';
import {
  IconUpload,
  IconPlus,
  IconClose,
  IconTrash,
  IconPlay,
  IconVideo,
  IconAudio,
  IconImage,
} from './Icons';

export default function MediaPanel() {
  const project = useEditor((s) => s.project);
  const selectedMediaId = useEditor((s) => s.selectedMediaId);
  const selectMedia = useEditor((s) => s.selectMedia);
  const playheadSec = useEditor((s) => s.playheadSec);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);

  const [query, setQuery] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; media: MediaAsset } | null>(null);
  // Multi-select for batch timeline inserts (checkbox / Cmd-click / Shift-click).
  const [checked, setChecked] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);

  const media = (project?.media ?? []).filter((m) =>
    m.name.toLowerCase().includes(query.toLowerCase()),
  );
  const checkedSet = new Set(checked);

  const toggleCheck = (id: string, range: boolean) => {
    if (range && anchorId) {
      const ids = media.map((m) => m.id);
      const a = ids.indexOf(anchorId);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setChecked(ids.slice(lo, hi + 1));
        return;
      }
    }
    setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setAnchorId(id);
  };

  const importMedia = () => op({ op: 'media:import' });

  const deleteMedia = async (m: MediaAsset) => {
    if (confirm(`Remove "${m.name}" and any clips using it from the project?`)) {
      await op({ op: 'media:delete', mediaId: m.id });
      if (selectedMediaId === m.id) selectMedia(null);
    }
  };

  const addClipAtPlayhead = (mediaId: string) => {
    setPreviewMode('timeline');
    op({ op: 'timeline:addClip', mediaId, startSec: playheadSec });
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const paths: string[] = files
      .map((f) => window.taxicut.getPathForFile(f))
      .filter((p): p is string => Boolean(p && p.length > 0));

    if (paths.length > 0) {
      await op({ op: 'media:import', paths });
    }
  };

  return (
    <div
      className={`media-panel ${isDragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleFileDrop}
      onClick={() => setContextMenu(null)}
    >
      <div className="panel-header">
        <span>Media Library</span>
        <span className="spacer" />
        <button onClick={importMedia} title="Import video, audio, or images" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <IconUpload size={12} /> Import…
        </button>
      </div>

      <div className="media-search">
        <input
          type="text"
          placeholder="Filter media…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="media-grid">
        {media.length === 0 && (
          <div className="media-empty">
            {query ? (
              'No media matches your search.'
            ) : (
              <>
                No media yet.
                <br />
                Click <b>Import</b> or drag files from Finder/Desktop here.
              </>
            )}
          </div>
        )}

        {media.map((m) => (
          <div
            key={m.id}
            className={`media-card ${selectedMediaId === m.id ? 'selected' : ''} ${checkedSet.has(m.id) ? 'checked' : ''}`}
            draggable
            title={`${m.name} (${m.path})`}
            onDragStart={(e) => {
              const ids = checkedSet.has(m.id) && checked.length > 0 ? checked : [m.id];
              e.dataTransfer.setData('application/x-taxicut-media', JSON.stringify(ids));
            }}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) toggleCheck(m.id, e.shiftKey);
              else {
                selectMedia(m.id);
                setChecked([m.id]);
                setAnchorId(m.id);
              }
            }}
            onDoubleClick={() => addClipAtPlayhead(m.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, media: m });
            }}
          >
            <input
              type="checkbox"
              className="media-check"
              checked={checkedSet.has(m.id)}
              title="Select for batch add (Cmd-click / Shift-click works too)"
              onChange={() => toggleCheck(m.id, false)}
              onClick={(e) => e.stopPropagation()}
            />
            <div className="media-actions">
              <button
                className="media-action-btn"
                title="Add to timeline at playhead"
                onClick={(e) => {
                  e.stopPropagation();
                  addClipAtPlayhead(m.id);
                }}
              >
                <IconPlus size={11} />
              </button>
              <button
                className="media-action-btn"
                title="Remove from project"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteMedia(m);
                }}
              >
                <IconClose size={11} />
              </button>
            </div>

            <div className="media-thumb">
              {m.thumbnailPath ? (
                <img src={window.taxicut.mediaUrl(m.thumbnailPath)} alt="" />
              ) : (
                <span>
                  {m.kind === 'audio' ? <IconAudio size={24} /> : m.kind === 'image' ? <IconImage size={24} /> : <IconVideo size={24} />}
                </span>
              )}
              <span className="media-dur">{formatDuration(m.durationSec)}</span>
            </div>
            <div className="media-name">{m.name}</div>
          </div>
        ))}
      </div>

      {/* Media Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              selectMedia(contextMenu.media.id);
              setContextMenu(null);
            }}
          >
            <IconPlay size={12} /> Preview in Viewer
          </div>
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              addClipAtPlayhead(contextMenu.media.id);
              setContextMenu(null);
            }}
          >
            <IconPlus size={12} /> Add to Timeline at Playhead
          </div>
          <div className="context-menu-divider" />
          <div
            className="context-menu-item"
            style={{ color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              const target = contextMenu.media;
              setContextMenu(null);
              deleteMedia(target);
            }}
          >
            <IconTrash size={12} /> Delete Media Asset
          </div>
        </div>
      )}
    </div>
  );
}
