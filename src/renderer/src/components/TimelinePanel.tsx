import React, { useRef } from 'react';
import { useEditor, op } from '../store';
import { formatTimecode } from '../time';

export default function TimelinePanel() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playheadSec);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const setZoom = useEditor((s) => s.setZoom);
  const selectedId = useEditor((s) => s.selectedClipId);
  const select = useEditor((s) => s.select);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tracks = project?.tracks ?? [];
  const duration = Math.max(
    30,
    ...tracks.flatMap((t) => t.clips.map((c) => c.startSec + c.durationSec + 10)),
  );
  const width = duration * pxPerSec;

  const secFromEvent = (e: React.MouseEvent | React.DragEvent): number => {
    const scroller = scrollRef.current!;
    const rect = scroller.getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left + scroller.scrollLeft) / pxPerSec);
  };

  const splitAtPlayhead = () => {
    if (!selectedId) return;
    op({ op: 'timeline:splitClip', clipId: selectedId, atSec: playhead });
  };

  const onClipPointerDown = (e: React.PointerEvent, clipId: string, mode: 'move' | 'l' | 'r') => {
    e.stopPropagation();
    select(clipId);
    const startX = e.clientX;
    let lastDelta = 0;
    const onMove = (ev: PointerEvent) => {
      lastDelta = (ev.clientX - startX) / pxPerSec;
    };
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (Math.abs(lastDelta) < 0.02) return;
      if (mode === 'move') {
        const track = tracks.find((t) => t.clips.some((c) => c.id === clipId));
        const clip = track?.clips.find((c) => c.id === clipId);
        if (clip)
          await op({
            op: 'timeline:moveClip',
            clipId,
            startSec: Math.max(0, clip.startSec + lastDelta),
          });
      } else {
        await op({
          op: 'timeline:trimClip',
          clipId,
          edge: mode === 'l' ? 'in' : 'out',
          deltaSec: lastDelta,
        });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
      op({ op: 'timeline:deleteClip', clipId: selectedId, ripple: e.shiftKey });
      select(null);
    }
  };

  const rulerTicks: number[] = [];
  const step = pxPerSec > 90 ? 1 : pxPerSec > 45 ? 2 : pxPerSec > 20 ? 5 : 10;
  for (let t = 0; t <= duration; t += step) rulerTicks.push(t);

  return (
    <div className="timeline" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="timeline-toolbar">
        <button className="icon" onClick={() => op({ op: 'history:undo' })} title="Undo">
          ↩
        </button>
        <button className="icon" onClick={() => op({ op: 'history:redo' })} title="Redo">
          ↪
        </button>
        <span style={{ width: 8 }} />
        <button
          className="icon"
          onClick={splitAtPlayhead}
          disabled={!selectedId}
          title="Split selected clip at playhead"
        >
          ✂ Split
        </button>
        <button className="icon" onClick={() => op({ op: 'track:add', kind: 'video' })} title="Add video track">
          + V
        </button>
        <button className="icon" onClick={() => op({ op: 'track:add', kind: 'audio' })} title="Add audio track">
          + A
        </button>
        <div className="right">
          <input
            type="range"
            min={10}
            max={200}
            value={pxPerSec}
            onChange={(e) => setZoom(Number(e.target.value))}
            title="Zoom"
            style={{ accentColor: 'var(--accent)' }}
          />
        </div>
      </div>
      <div className="timeline-body">
        <div className="track-headers">
          <div style={{ height: 22, borderBottom: '1px solid var(--border)' }} />
          {tracks.map((t) => (
            <div className="track-header" key={t.id}>
              <b>{t.name}</b>
              <span
                style={{ cursor: 'pointer', opacity: t.muted ? 1 : 0.35 }}
                onClick={() => op({ op: 'track:setMute', trackId: t.id, muted: !t.muted })}
                title={t.muted ? 'Unmute' : 'Mute'}
              >
                {t.kind === 'audio' ? '🔊' : '👁'}
              </span>
            </div>
          ))}
        </div>
        <div
          className="tracks-scroll"
          ref={scrollRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const mediaId = e.dataTransfer.getData('application/x-taxicut-media');
            if (mediaId) op({ op: 'timeline:addClip', mediaId, startSec: secFromEvent(e) });
          }}
        >
          <div className="tracks-inner" style={{ width, minWidth: '100%' }}>
            <div
              className="ruler"
              onMouseDown={(e) => {
                setPlayhead(secFromEvent(e));
                const onMove = (ev: MouseEvent) =>
                  setPlayhead(
                    Math.max(
                      0,
                      (ev.clientX -
                        scrollRef.current!.getBoundingClientRect().left +
                        scrollRef.current!.scrollLeft) /
                        pxPerSec,
                    ),
                  );
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            >
              {rulerTicks.map((t) => (
                <div key={t} className="ruler-tick" style={{ left: t * pxPerSec }}>
                  {t % (step * 2) === 0 ? formatTimecode(t).slice(3) : ''}
                </div>
              ))}
            </div>
            {tracks.map((t) => (
              <div className="track-lane" key={t.id}>
                {t.clips.map((c) => (
                  <div
                    key={c.id}
                    className={`clip ${t.kind} ${c.id === selectedId ? 'selected' : ''}`}
                    style={{
                      left: c.startSec * pxPerSec,
                      width: Math.max(6, c.durationSec * pxPerSec),
                    }}
                    title={c.name}
                    onPointerDown={(e) => onClipPointerDown(e, c.id, 'move')}
                  >
                    <div className="handle l" onPointerDown={(e) => onClipPointerDown(e, c.id, 'l')} />
                    {c.text ?? c.name}
                    <div className="handle r" onPointerDown={(e) => onClipPointerDown(e, c.id, 'r')} />
                  </div>
                ))}
              </div>
            ))}
            <div className="playhead" style={{ left: playhead * pxPerSec }}>
              <div className="playhead-label">{formatTimecode(playhead).slice(3, 11)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
