import { useState } from 'react';
import { useEditor, op } from '../store';
import { formatDuration } from '../time';
import type { MediaAsset } from '../../../shared/types';

export default function MediaPanel() {
  const project = useEditor((s) => s.project);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const media = (project?.media ?? []).filter((m) =>
    m.name.toLowerCase().includes(query.toLowerCase()),
  );

  const importMedia = () => op({ op: 'media:import' });

  const transcribe = async (m: MediaAsset) => {
    setBusy(true);
    const r = await op({ op: 'asr:subtitles', mediaId: m.id });
    setBusy(false);
    if (!r.ok) alert(r.error);
  };

  return (
    <div className="media-panel">
      <div className="panel-header">
        <button className="accent" onClick={importMedia}>
          + Import
        </button>
        <input
          type="text"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
      <div className="panel-header">
        Library {media.length > 0 && <span style={{ marginLeft: 'auto' }}>{media.length} items</span>}
      </div>
      <div className="media-grid">
        {media.length === 0 && (
          <div className="media-empty">
            No media yet.
            <br />
            Click Import to add video, audio, or images.
          </div>
        )}
        {media.map((m) => (
          <div
            key={m.id}
            className="media-card"
            draggable
            title={m.path}
            onDragStart={(e) => e.dataTransfer.setData('application/x-taxicut-media', m.id)}
            onDoubleClick={() => op({ op: 'timeline:addClip', mediaId: m.id })}
            onContextMenu={(e) => {
              e.preventDefault();
              if (m.hasAudio && !busy) transcribe(m);
            }}
          >
            <div className="media-thumb">
              {m.thumbnailPath ? (
                <img src={window.taxicut.mediaUrl(m.thumbnailPath)} alt="" />
              ) : (
                <span>{m.kind === 'audio' ? '♪' : '▢'}</span>
              )}
              <span className="media-dur">{formatDuration(m.durationSec)}</span>
            </div>
            <div className="media-name">{m.name}</div>
          </div>
        ))}
      </div>
      {busy && <div className="panel-header">Transcribing with Parakeet…</div>}
    </div>
  );
}
