import { useEditor, op } from '../store';
import { formatDuration } from '../time';
import type { Clip } from '../../../shared/types';

export default function InspectorPanel() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedClipId);

  let clip: Clip | undefined;
  for (const t of project?.tracks ?? []) {
    clip = t.clips.find((c) => c.id === selectedId) ?? clip;
  }

  const set = (props: Record<string, unknown>) =>
    clip && op({ op: 'clip:setProps', clipId: clip.id, ...props } as never);

  return (
    <div className="inspector">
      <div className="panel-header">Inspector</div>
      {!clip ? (
        <div className="insp-empty">Select a clip on the timeline to adjust its properties.</div>
      ) : (
        <div className="body">
          <div>
            <h3>CLIP</h3>
            <div className="insp-row">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{clip.name}</span>
            </div>
            <div className="insp-row">
              <span style={{ color: 'var(--text-dim)' }}>
                {formatDuration(clip.durationSec)} @ {clip.startSec.toFixed(2)}s
              </span>
            </div>
            {clip.text !== undefined && (
              <input
                type="text"
                value={clip.text}
                onChange={(e) => set({ text: e.target.value })}
              />
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
            <div className="insp-row">
              <button disabled title="Keyframe editing coming soon">
                ◇ Keyframes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
