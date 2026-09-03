import { useState } from 'react';
import { useEditor, op } from '../store';
import { formatDuration } from '../time';
import { canvasSize, CLIP_FILTERS, FONT_FAMILIES, TEXT_TEMPLATES } from '../../../shared/types';
import type { Clip } from '../../../shared/types';
import { IconPlus, IconSubtitles } from './Icons';

const ALIGN_SPOTS = [
  { id: 'tl', x: -1, y: -1 }, { id: 'tc', x: 0, y: -1 }, { id: 'tr', x: 1, y: -1 },
  { id: 'ml', x: -1, y: 0 }, { id: 'c', x: 0, y: 0 }, { id: 'mr', x: 1, y: 0 },
  { id: 'bl', x: -1, y: 1 }, { id: 'bc', x: 0, y: 1 }, { id: 'br', x: 1, y: 1 },
] as const;

export default function InspectorPanel() {
  const project = useEditor((s) => s.project);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const selectedMediaId = useEditor((s) => s.selectedMediaId);
  const playheadSec = useEditor((s) => s.playheadSec);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);
  const setCropMode = useEditor((s) => s.setCropMode);
  const cropMode = useEditor((s) => s.cropMode);
  const [busy, setBusy] = useState(false);

  let clip: Clip | undefined;
  for (const t of project?.tracks ?? []) {
    clip = t.clips.find((c) => c.id === selectedClipId) ?? clip;
  }

  const clipMedia = clip ? project?.media.find((m) => m.id === clip.mediaId) : undefined;
  const canvas = canvasSize(project?.aspect ?? '16:9', project?.customW, project?.customH);
  const mw = clipMedia?.width || 0;
  const mh = clipMedia?.height || 0;
  const fit0 = mw > 0 && mh > 0 ? Math.min(canvas.width / mw, canvas.height / mh) : 1;
  const curScale = clip && Number.isFinite(clip.scale) && clip.scale > 0 ? clip.scale : 1;
  // Displayed-size fractions at the current scale (for edge alignment).
  const fw = mw > 0 ? (mw * fit0 * curScale) / canvas.width : 1;
  const fh = mh > 0 ? (mh * fit0 * curScale) / canvas.height : 1;
  const alignPos = (v: -1 | 0 | 1, f: number): number => (v === 0 ? 0 : (v * (1 - f)) / 2);
  const fillScale = mw > 0 && mh > 0
    ? Math.max(canvas.width / (mw * fit0), canvas.height / (mh * fit0))
    : 1;

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
          {(clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'text') && (
            <div>
              <h3>TRANSFORM</h3>
              <div className="insp-row">
                <span>Scale</span>
                <input
                  type="range"
                  min={0.1}
                  max={4}
                  step={0.05}
                  value={clip.scale ?? 1}
                  onChange={(e) => set({ scale: Number(e.target.value) })}
                />
                <span>{(clip.scale ?? 1).toFixed(2)}x</span>
              </div>
              <div className="insp-row">
                <span>X</span>
                <input
                  type="number"
                  step={0.05}
                  value={clip.posX ?? 0}
                  onChange={(e) => set({ posX: Number(e.target.value) })}
                />
                <span>Y</span>
                <input
                  type="number"
                  step={0.05}
                  value={clip.posY ?? 0}
                  onChange={(e) => set({ posY: Number(e.target.value) })}
                />
              </div>
              {(clip.kind === 'video' || clip.kind === 'image') && (
                <>
                  <div className="insp-row">
                    <button
                      title="Fit whole video in canvas"
                      style={{ flex: 1 }}
                      onClick={() => set({ scale: 1, posX: 0, posY: 0 })}
                    >
                      Fit
                    </button>
                    <button
                      title="Fill the whole canvas (crops overflow)"
                      style={{ flex: 1 }}
                      onClick={() => set({ scale: Math.round(fillScale * 100) / 100, posX: 0, posY: 0 })}
                    >
                      Fill
                    </button>
                    <button
                      title="Center video on canvas"
                      style={{ flex: 1 }}
                      onClick={() => set({ posX: 0, posY: 0 })}
                    >
                      Center
                    </button>
                  </div>
                  <div className="insp-row" style={{ alignItems: 'center' }}>
                    <span>Align</span>
                    <div className="align-grid">
                      {ALIGN_SPOTS.map((a) => (
                        <button
                          key={a.id}
                          className="align-btn"
                          title={`Align ${a.id === 'c' ? 'center' : a.id}`}
                          onClick={() => set({ posX: alignPos(a.x, fw), posY: alignPos(a.y, fh) })}
                        >
                          <span
                            className="align-dot"
                            style={{
                              left: a.x === -1 ? 3 : a.x === 1 ? undefined : '50%',
                              right: a.x === 1 ? 3 : undefined,
                              top: a.y === -1 ? 3 : a.y === 1 ? undefined : '50%',
                              bottom: a.y === 1 ? 3 : undefined,
                              transform:
                                a.x === 0 && a.y === 0
                                  ? 'translate(-50%,-50%)'
                                  : a.x === 0
                                    ? 'translateX(-50%)'
                                    : a.y === 0
                                      ? 'translateY(-50%)'
                                      : undefined,
                            }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {clip.kind === 'text' && (
                <div className="insp-row">
                  <button
                    title="Center text on canvas"
                    style={{ flex: 1 }}
                    onClick={() => set({ posX: 0, posY: 0 })}
                  >
                    Center
                  </button>
                </div>
              )}
              <div className="insp-row">
                <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                  Tip: drag the video in the viewer to move it, drag a corner to resize.
                </span>
              </div>
              <button
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={() => set({ scale: 1, posX: 0, posY: 0 })}
              >
                Reset transform
              </button>
            </div>
          )}
          {(clip.kind === 'video' || clip.kind === 'image') && (
            <div>
              <h3>CROP (%)</h3>
              <div className="insp-row">
                <span>Left</span>
                <input
                  type="number"
                  min={0}
                  max={90}
                  step={1}
                  value={Math.round((clip.cropL ?? 0) * 100)}
                  onChange={(e) => set({ cropL: Number(e.target.value) / 100 })}
                />
                <span>Right</span>
                <input
                  type="number"
                  min={0}
                  max={90}
                  step={1}
                  value={Math.round((clip.cropR ?? 0) * 100)}
                  onChange={(e) => set({ cropR: Number(e.target.value) / 100 })}
                />
              </div>
              <div className="insp-row">
                <span>Top</span>
                <input
                  type="number"
                  min={0}
                  max={90}
                  step={1}
                  value={Math.round((clip.cropT ?? 0) * 100)}
                  onChange={(e) => set({ cropT: Number(e.target.value) / 100 })}
                />
                <span>Bottom</span>
                <input
                  type="number"
                  min={0}
                  max={90}
                  step={1}
                  value={Math.round((clip.cropB ?? 0) * 100)}
                  onChange={(e) => set({ cropB: Number(e.target.value) / 100 })}
                />
              </div>
              <div className="insp-row">
                <button
                  title="Edit crop by dragging in the viewer"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setPreviewMode('timeline');
                    setCropMode(!cropMode);
                  }}
                >
                  {cropMode ? 'Exit viewer crop' : 'Crop in viewer'}
                </button>
                <button
                  title="Remove crop"
                  style={{ flex: 1 }}
                  onClick={() => set({ cropL: 0, cropT: 0, cropR: 0, cropB: 0 })}
                >
                  Reset crop
                </button>
              </div>
            </div>
          )}
          {clip.kind === 'text' && (
            <div>
              <h3>TEXT</h3>
              <div className="tpl-grid">
                {TEXT_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    className="tpl-btn"
                    title={`${t.name} template`}
                    style={{
                      fontFamily: t.fontFamily,
                      color: t.textColor,
                      background: t.textBg || 'var(--bg2)',
                      fontWeight: t.bold ? 700 : 400,
                    }}
                    onClick={() =>
                      set({
                        fontFamily: t.fontFamily,
                        fontSize: t.fontSize,
                        textColor: t.textColor,
                        textBg: t.textBg,
                        bold: t.bold,
                        textAlign: t.textAlign,
                        scale: t.scale,
                        posX: t.posX,
                        posY: t.posY,
                      })
                    }
                  >
                    Ag
                    <small>{t.name}</small>
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 8 }}>
                <textarea
                  rows={3}
                  value={clip.text ?? ''}
                  onChange={(e) => set({ text: e.target.value })}
                  placeholder="Text overlay…"
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>
              <div className="insp-row" style={{ marginTop: 8 }}>
                <span>Font</span>
                <select
                  value={clip.fontFamily || 'Arial'}
                  onChange={(e) => set({ fontFamily: e.target.value })}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {FONT_FAMILIES.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
              <div className="insp-row">
                <span>Size</span>
                <input
                  type="range"
                  min={16}
                  max={240}
                  step={2}
                  value={clip.fontSize ?? 72}
                  onChange={(e) => set({ fontSize: Number(e.target.value) })}
                />
                <span>{clip.fontSize ?? 72}px</span>
              </div>
              <div className="insp-row">
                <span>Color</span>
                <input
                  type="color"
                  value={clip.textColor || '#ffffff'}
                  onChange={(e) => set({ textColor: e.target.value })}
                />
                <span>BG</span>
                <input
                  type="color"
                  value={clip.textBg || '#000000'}
                  onChange={(e) => set({ textBg: e.target.value })}
                />
                <button
                  title="Transparent background"
                  disabled={!clip.textBg}
                  onClick={() => set({ textBg: '' })}
                >
                  Clear
                </button>
              </div>
              <div className="insp-row">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={!!clip.bold}
                    onChange={(e) => set({ bold: e.target.checked })}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  Bold
                </label>
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  {(['left', 'center', 'right'] as const).map((a) => (
                    <button
                      key={a}
                      title={`Align ${a}`}
                      onClick={() => set({ textAlign: a })}
                      style={{
                        fontWeight: (clip.textAlign || 'center') === a ? 700 : 400,
                        borderColor: (clip.textAlign || 'center') === a ? 'var(--accent)' : undefined,
                        textTransform: 'capitalize',
                      }}
                    >
                      {a[0].toUpperCase()}
                    </button>
                  ))}
                </span>
              </div>
              <div className="insp-row">
                <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                  Tip: double-click the text in the viewer to edit it there.
                </span>
              </div>
            </div>
          )}
          {(clip.kind === 'video' || clip.kind === 'image') && (
            <div>
              <h3>FILTER</h3>
              <div className="filter-grid">
                {CLIP_FILTERS.map((f) => (
                  <button
                    key={f.id || 'none'}
                    className={`filter-btn${(clip.filter || '') === f.id ? ' active' : ''}`}
                    title={f.id ? `${f.name} look` : 'No filter'}
                    onClick={() => set({ filter: f.id })}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
          )}
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
