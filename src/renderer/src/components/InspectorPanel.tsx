import { useState } from 'react';
import { useEditor, op } from '../store';
import { formatDuration } from '../time';
import type { Clip } from '../../../shared/types';
import { IconPlus, IconSubtitles } from './Icons';

export default function InspectorPanel() {
  const project = useEditor((s) => s.project);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const selectedMediaId = useEditor((s) => s.selectedMediaId);
  const playheadSec = useEditor((s) => s.playheadSec);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);
  const [busy, setBusy] = useState(false);

  let clip: Clip | undefined;
  for (const t of project?.tracks ?? []) {
    clip = t.clips.find((c) => c.id === selectedClipId) ?? clip;
  }

  const selectedMedia = selectedMediaId
    ? project?.media.find((m) => m.id === selectedMediaId)
    : undefined;

  const set = (props: Record<string, unknown>) =>
    clip && op({ op: 'clip:setProps', clipId: clip.id, ...props } as never);

  const transcribe = async () => {
    if (!selectedMedia) return;
    setBusy(true);
    const r = await op({ op: 'asr:subtitles', mediaId: selectedMedia.id });
    setBusy(false);
    if (!r.ok) alert(r.error);
  };

  return (
    <div className="inspector">
      <div className="panel-header">Inspector</div>
      {!clip && !selectedMedia ? (
        <div className="insp-empty">
          Select a clip on the timeline or a media item in the library to inspect its properties.
        </div>
      ) : clip ? (
        <div className="body">
          <div>
            <h3>CLIP</h3>
            <div className="insp-row">
              <span>Name</span>
              <input
                type="text"
                value={clip.name}
                onChange={(e) => set({ name: e.target.value })}
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
            <div className="insp-row">
              <span style={{ color: 'var(--text-dim)' }}>
                {formatDuration(clip.durationSec)} @ {clip.startSec.toFixed(2)}s (in: {clip.inSec.toFixed(2)}s)
              </span>
            </div>
            {clip.text !== undefined && (
              <div style={{ marginTop: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Subtitle Text:</span>
                <input
                  type="text"
                  value={clip.text}
                  onChange={(e) => set({ text: e.target.value })}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </div>
            )}
          </div>
          <div>
            <h3>LEVELS</h3>
            <div className="insp-row">
              <span>Volume</span>
              <input
                type="range"
                min={-60}
                max={12}
                step={0.5}
                value={clip.volumeDb}
                onChange={(e) => set({ volumeDb: Number(e.target.value) })}
              />
              <span>{clip.volumeDb.toFixed(1)} dB</span>
            </div>
            <div className="insp-row">
              <span>Fade In</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={clip.fadeInSec}
                onChange={(e) => set({ fadeInSec: Number(e.target.value) })}
              />
              <span>s</span>
            </div>
            <div className="insp-row">
              <span>Fade Out</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={clip.fadeOutSec}
                onChange={(e) => set({ fadeOutSec: Number(e.target.value) })}
              />
              <span>s</span>
            </div>
          </div>
          <div>
            <h3>PLAYBACK</h3>
            <div className="insp-row">
              <span>Speed</span>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={clip.speed}
                onChange={(e) => set({ speed: Number(e.target.value) })}
              />
              <span>x</span>
            </div>
          </div>
        </div>
      ) : selectedMedia ? (
        <div className="body">
          <div>
            <h3>MEDIA ASSET</h3>
            <div className="insp-row">
              <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{selectedMedia.name}</span>
            </div>
            <div className="insp-row">
              <span>Type</span>
              <span style={{ color: 'var(--text-dim)' }}>{selectedMedia.kind.toUpperCase()}</span>
            </div>
            <div className="insp-row">
              <span>Duration</span>
              <span style={{ color: 'var(--text-dim)' }}>{formatDuration(selectedMedia.durationSec)}</span>
            </div>
            {selectedMedia.width > 0 && (
              <div className="insp-row">
                <span>Resolution</span>
                <span style={{ color: 'var(--text-dim)' }}>
                  {selectedMedia.width} × {selectedMedia.height}
                </span>
              </div>
            )}
            {selectedMedia.fps > 0 && (
              <div className="insp-row">
                <span>Framerate</span>
                <span style={{ color: 'var(--text-dim)' }}>{selectedMedia.fps.toFixed(2)} fps</span>
              </div>
            )}
            <div className="insp-row">
              <span>Audio</span>
              <span style={{ color: 'var(--text-dim)' }}>{selectedMedia.hasAudio ? 'Yes' : 'No'}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="accent"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              onClick={() => {
                setPreviewMode('timeline');
                op({ op: 'timeline:addClip', mediaId: selectedMedia.id, startSec: playheadSec });
              }}
            >
              <IconPlus size={12} /> Add to Timeline
            </button>
            {selectedMedia.hasAudio && (
              <button
                disabled={busy}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={transcribe}
              >
                <IconSubtitles size={12} /> {busy ? 'Transcribing…' : 'Generate Subtitles'}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
