import React, { useRef, useState } from 'react';
import { useEditor, op } from '../store';
import { formatTimecode } from '../time';
import type { Clip, MediaKind, Track } from '../../../shared/types';
import {
  IconUndo,
  IconRedo,
  IconSplit,
  IconTrash,
  IconRipple,
  IconPlus,
  IconMinus,
  IconVideo,
  IconAudio,
  IconImage,
  IconSubtitles,
  IconEye,
  IconEyeOff,
  IconSpeaker,
  IconSpeakerOff,
  IconLock,
  IconUnlock,
  IconClose,
} from './Icons';

interface DragState {
  clipId: string;
  mode: 'move' | 'l' | 'r';
  deltaSec: number;
  originalStartSec: number;
  originalDurationSec: number;
  targetTrackId: string;
  isNewUpperLayer?: boolean;
}

export default function TimelinePanel() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playheadSec);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const setZoom = useEditor((s) => s.setZoom);
  const selectedId = useEditor((s) => s.selectedClipId);
  const select = useEditor((s) => s.select);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);

  const [activeDrag, setActiveDrag] = useState<DragState | null>(null);
  const [snapTime, setSnapTime] = useState<number | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [isHoveringNewLayer, setIsHoveringNewLayer] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clip: Clip; track: Track } | null>(null);

  const tracks = project?.tracks ?? [];
  const duration = Math.max(
    30,
    ...tracks.flatMap((t) => t.clips.map((c) => c.startSec + c.durationSec + 10)),
  );
  const width = duration * pxPerSec;

  const secFromEvent = (e: React.MouseEvent | React.DragEvent): number => {
    const scroller = scrollRef.current;
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left + scroller.scrollLeft) / pxPerSec);
  };

  const getSnapTargets = (excludeClipId?: string): number[] => {
    const targets = new Set<number>([0, playhead]);
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.id === excludeClipId) continue;
        targets.add(c.startSec);
        targets.add(c.startSec + c.durationSec);
      }
    }
    return Array.from(targets);
  };

  const splitAtPlayhead = () => {
    let targetClipId = selectedId;
    if (!targetClipId) {
      for (const t of tracks) {
        const found = t.clips.find((c) => playhead > c.startSec && playhead < c.startSec + c.durationSec);
        if (found) {
          targetClipId = found.id;
          break;
        }
      }
    }
    if (targetClipId) {
      op({ op: 'timeline:splitClip', clipId: targetClipId, atSec: playhead });
    }
  };

  const deleteSelected = (ripple = false) => {
    if (selectedId) {
      op({ op: 'timeline:deleteClip', clipId: selectedId, ripple });
      select(null);
    }
  };

  const onClipPointerDown = (
    e: React.PointerEvent,
    clip: Clip,
    sourceTrack: Track,
    mode: 'move' | 'l' | 'r',
  ) => {
    if (sourceTrack.locked) return;
    e.stopPropagation();
    select(clip.id);

    const startX = e.clientX;
    let currentDelta = 0;
    let currentTargetTrackId = sourceTrack.id;
    let isNewLayer = false;

    setActiveDrag({
      clipId: clip.id,
      mode,
      deltaSec: 0,
      originalStartSec: clip.startSec,
      originalDurationSec: clip.durationSec,
      targetTrackId: sourceTrack.id,
      isNewUpperLayer: false,
    });

    const snapTargets = getSnapTargets(clip.id);
    const snapDist = 8 / pxPerSec;

    const onMove = (ev: PointerEvent) => {
      const rawDelta = (ev.clientX - startX) / pxPerSec;
      let effectiveDelta = rawDelta;
      let matchedSnap: number | null = null;

      if (mode === 'move') {
        const candidateStart = Math.max(0, clip.startSec + rawDelta);
        const candidateEnd = candidateStart + clip.durationSec;
        for (const target of snapTargets) {
          if (Math.abs(candidateStart - target) < snapDist) {
            effectiveDelta = target - clip.startSec;
            matchedSnap = target;
            break;
          }
          if (Math.abs(candidateEnd - target) < snapDist) {
            effectiveDelta = target - clip.durationSec - clip.startSec;
            matchedSnap = target;
            break;
          }
        }

        // Determine if hovering over an existing track or dragging above for a new upper layer
        if (lanesRef.current) {
          const lanes = Array.from(lanesRef.current.children) as HTMLElement[];
          const lanesContainerRect = lanesRef.current.getBoundingClientRect();

          // If dragging upward above the top video track:
          if (sourceTrack.kind === 'video' && ev.clientY < lanesContainerRect.top) {
            isNewLayer = true;
          } else {
            isNewLayer = false;
            for (let i = 0; i < lanes.length; i++) {
              const laneRect = lanes[i].getBoundingClientRect();
              if (ev.clientY >= laneRect.top && ev.clientY <= laneRect.bottom) {
                const t = tracks[i];
                if (t && t.kind === sourceTrack.kind && !t.locked) {
                  currentTargetTrackId = t.id;
                }
                break;
              }
            }
          }
        }
      } else if (mode === 'l') {
        const candidateStart = clip.startSec + rawDelta;
        for (const target of snapTargets) {
          if (Math.abs(candidateStart - target) < snapDist) {
            effectiveDelta = target - clip.startSec;
            matchedSnap = target;
            break;
          }
        }
      } else if (mode === 'r') {
        const candidateEnd = clip.startSec + clip.durationSec + rawDelta;
        for (const target of snapTargets) {
          if (Math.abs(candidateEnd - target) < snapDist) {
            effectiveDelta = target - (clip.startSec + clip.durationSec);
            matchedSnap = target;
            break;
          }
        }
      }

      setSnapTime(matchedSnap);
      currentDelta = effectiveDelta;
      setActiveDrag({
        clipId: clip.id,
        mode,
        deltaSec: effectiveDelta,
        originalStartSec: clip.startSec,
        originalDurationSec: clip.durationSec,
        targetTrackId: currentTargetTrackId,
        isNewUpperLayer: isNewLayer,
      });
    };

    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setActiveDrag(null);
      setSnapTime(null);

      if (mode === 'move') {
        const newStart = Math.max(0, clip.startSec + currentDelta);

        if (isNewLayer && sourceTrack.kind === 'video') {
          // Auto-create a new upper layer track and move clip onto it
          const r = await op({ op: 'track:add', kind: 'video' });
          if (r.ok && r.data) {
            const newTrack = r.data as Track;
            await op({
              op: 'timeline:moveClip',
              clipId: clip.id,
              startSec: newStart,
              trackId: newTrack.id,
            });
          }
        } else if (Math.abs(newStart - clip.startSec) > 0.01 || currentTargetTrackId !== sourceTrack.id) {
          await op({
            op: 'timeline:moveClip',
            clipId: clip.id,
            startSec: newStart,
            trackId: currentTargetTrackId,
          });
        }
      } else {
        if (Math.abs(currentDelta) > 0.01) {
          await op({
            op: 'timeline:trimClip',
            clipId: clip.id,
            edge: mode === 'l' ? 'in' : 'out',
            deltaSec: currentDelta,
          });
        }
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Helper to resolve the best track for any imported media item
  const findOrCreateTrack = async (mediaKind: MediaKind, preferredTrack?: Track): Promise<string> => {
    const kind = mediaKind === 'audio' ? 'audio' : 'video';
    if (preferredTrack && preferredTrack.kind === kind && !preferredTrack.locked) {
      return preferredTrack.id;
    }
    // Find first unlocked matching track
    const found = tracks.find((t) => t.kind === kind && !t.locked);
    if (found) return found.id;
    // Otherwise create one
    const r = await op({ op: 'track:add', kind });
    if (r.ok && r.data) {
      return (r.data as Track).id;
    }
    return tracks[0]?.id ?? '';
  };

  const handleTrackDrop = async (e: React.DragEvent, targetTrack?: Track, forceNewLayer = false) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTrackId(null);
    setIsHoveringNewLayer(false);
    setPreviewMode('timeline');

    const startSec = secFromEvent(e);

    // 1) From Library
    const mediaId = e.dataTransfer.getData('application/x-taxicut-media');
    if (mediaId) {
      const asset = project?.media.find((m) => m.id === mediaId);
      if (asset) {
        let destTrackId = targetTrack?.id;
        if (forceNewLayer) {
          const r = await op({ op: 'track:add', kind: asset.kind === 'audio' ? 'audio' : 'video' });
          if (r.ok && r.data) destTrackId = (r.data as Track).id;
        } else {
          destTrackId = await findOrCreateTrack(asset.kind, targetTrack);
        }
        await op({ op: 'timeline:addClip', mediaId, trackId: destTrackId, startSec });
      }
      return;
    }

    // 2) From OS file drop (Finder / Desktop)
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const paths = files
        .map((f) => window.taxicut.getPathForFile(f))
        .filter((p): p is string => Boolean(p && p.length > 0));

      if (paths.length > 0) {
        const r = await op({ op: 'media:import', paths });
        if (r.ok && Array.isArray(r.data)) {
          let curStart = startSec;
          for (const asset of r.data as { id: string; kind: 'video' | 'audio' | 'image'; durationSec: number }[]) {
            let destTrackId: string;
            if (forceNewLayer) {
              const tr = await op({ op: 'track:add', kind: asset.kind === 'audio' ? 'audio' : 'video' });
              destTrackId = tr.ok && tr.data ? (tr.data as Track).id : await findOrCreateTrack(asset.kind, targetTrack);
            } else {
              destTrackId = await findOrCreateTrack(asset.kind, targetTrack);
            }
            await op({ op: 'timeline:addClip', mediaId: asset.id, trackId: destTrackId, startSec: curStart });
            curStart += asset.durationSec || 5;
          }
        }
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
      deleteSelected(e.shiftKey);
    }
  };

  const rulerTicks: number[] = [];
  const step = pxPerSec > 90 ? 1 : pxPerSec > 45 ? 2 : pxPerSec > 20 ? 5 : 10;
  for (let t = 0; t <= duration; t += step) rulerTicks.push(t);

  return (
    <div
      className="timeline"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={() => setContextMenu(null)}
    >
      <div className="timeline-toolbar">
        <button className="icon" onClick={() => op({ op: 'history:undo' })} title="Undo (Cmd+Z)">
          <IconUndo size={13} />
        </button>
        <button className="icon" onClick={() => op({ op: 'history:redo' })} title="Redo (Cmd+Shift+Z)">
          <IconRedo size={13} />
        </button>
        <span style={{ width: 8 }} />
        <button
          className="icon"
          onClick={splitAtPlayhead}
          title="Split clip at playhead (Cmd+B / S)"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconSplit size={13} /> Split
        </button>
        <button
          className="icon"
          onClick={() => deleteSelected(false)}
          disabled={!selectedId}
          title="Delete selected clip (Backspace)"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconTrash size={13} /> Delete
        </button>
        <button
          className="icon"
          onClick={() => deleteSelected(true)}
          disabled={!selectedId}
          title="Ripple delete selected clip (Shift+Backspace)"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconRipple size={13} /> Ripple
        </button>
        <span style={{ width: 8 }} />
        <button
          className="icon"
          onClick={() => op({ op: 'track:add', kind: 'video' })}
          title="Add video layer track"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconPlus size={11} /> <IconVideo size={12} /> Video
        </button>
        <button
          className="icon"
          onClick={() => op({ op: 'track:add', kind: 'audio' })}
          title="Add audio track"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconPlus size={11} /> <IconAudio size={12} /> Audio
        </button>
        <button
          className="icon"
          onClick={async () => {
            const r = await op({ op: 'timeline:addClip', mediaId: 'text', startSec: playhead });
            if (r.ok && r.data) select((r.data as Clip).id);
            else if (!r.ok) alert(r.error);
          }}
          title="Add text overlay at playhead"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconPlus size={11} /> <IconSubtitles size={12} /> Text
        </button>
        <div className="right">
          <button className="icon" onClick={() => setZoom(Math.max(10, pxPerSec - 15))} title="Zoom out">
            <IconMinus size={13} />
          </button>
          <input
            type="range"
            min={10}
            max={200}
            value={pxPerSec}
            onChange={(e) => setZoom(Number(e.target.value))}
            title="Timeline Zoom"
            style={{ accentColor: 'var(--accent)', width: 100 }}
          />
          <button className="icon" onClick={() => setZoom(Math.min(200, pxPerSec + 15))} title="Zoom in">
            <IconPlus size={13} />
          </button>
        </div>
      </div>

      <div className="timeline-body">
        <div className="track-headers">
          <div style={{ height: 22, borderBottom: '1px solid var(--border)' }} />
          {/* Header row for upper new layer indicator if dragging */}
          {(activeDrag?.isNewUpperLayer || isHoveringNewLayer) && (
            <div className="track-header" style={{ height: 36, color: 'var(--accent)', justifyContent: 'center' }}>
              + New Layer
            </div>
          )}
          {tracks.map((t) => (
            <div className="track-header" key={t.id}>
              <b>{t.name}</b>
              <div className="track-actions">
                <button
                  className={`track-action-btn ${t.muted ? 'active' : ''}`}
                  onClick={() => op({ op: 'track:setMute', trackId: t.id, muted: !t.muted })}
                  title={t.muted ? 'Unmute' : 'Mute'}
                >
                  {t.kind === 'audio' ? (
                    t.muted ? <IconSpeakerOff size={12} /> : <IconSpeaker size={12} />
                  ) : (
                    t.muted ? <IconEyeOff size={12} /> : <IconEye size={12} />
                  )}
                </button>
                <button
                  className={`track-action-btn ${t.locked ? 'active' : ''}`}
                  onClick={() => op({ op: 'track:setLock', trackId: t.id, locked: !t.locked })}
                  title={t.locked ? 'Unlock track' : 'Lock track'}
                >
                  {t.locked ? <IconLock size={12} /> : <IconUnlock size={12} />}
                </button>
                {tracks.length > 1 && (
                  <button
                    className="track-action-btn delete"
                    onClick={() => {
                      if (t.clips.length === 0 || confirm(`Delete track ${t.name} and its clips?`)) {
                        op({ op: 'track:delete', trackId: t.id });
                      }
                    }}
                    title={`Delete track ${t.name}`}
                  >
                    <IconClose size={11} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div
          className="tracks-scroll"
          ref={scrollRef}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => handleTrackDrop(e)}
        >
          <div className="tracks-inner" style={{ width, minWidth: '100%' }}>
            <div
              className="ruler"
              onMouseDown={(e) => {
                setPreviewMode('timeline');
                setPlayhead(secFromEvent(e));
                const onMove = (ev: MouseEvent) => {
                  const scroller = scrollRef.current;
                  if (!scroller) return;
                  const rect = scroller.getBoundingClientRect();
                  setPlayhead(Math.max(0, (ev.clientX - rect.left + scroller.scrollLeft) / pxPerSec));
                };
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

            {/* Drop zone above tracks to auto-create a new layer */}
            {(activeDrag?.isNewUpperLayer || isHoveringNewLayer) && (
              <div
                className={`new-layer-drop-zone ${activeDrag?.isNewUpperLayer || isHoveringNewLayer ? 'active' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsHoveringNewLayer(true);
                }}
                onDragLeave={() => setIsHoveringNewLayer(false)}
                onDrop={(e) => handleTrackDrop(e, undefined, true)}
              >
                + Drop to create new upper layer
              </div>
            )}

            <div ref={lanesRef}>
              {tracks.map((t) => {
                const isDragTarget = activeDrag?.targetTrackId === t.id;

                return (
                  <div
                    className={`track-lane ${dragOverTrackId === t.id ? 'drag-over' : ''}`}
                    key={t.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverTrackId(t.id);
                    }}
                    onDragLeave={() => setDragOverTrackId(null)}
                    onDrop={(e) => handleTrackDrop(e, t)}
                  >
                    {t.clips.map((c) => {
                      const media = project?.media.find((m) => m.id === c.mediaId);
                      const thumbUrl = media?.thumbnailPath ? window.taxicut.mediaUrl(media.thumbnailPath) : null;
                      const imageUrl = media?.kind === 'image' ? window.taxicut.mediaUrl(media.path) : null;
                      const previewUrl = thumbUrl || imageUrl;

                      // Compute live coordinates if clip is currently being dragged/trimmed
                      let liveStart = c.startSec;
                      let liveDur = c.durationSec;
                      if (activeDrag && activeDrag.clipId === c.id) {
                        if (activeDrag.mode === 'move') {
                          liveStart = Math.max(0, c.startSec + activeDrag.deltaSec);
                        } else if (activeDrag.mode === 'l') {
                          liveStart = Math.max(0, c.startSec + activeDrag.deltaSec);
                          liveDur = Math.max(0.1, c.durationSec - activeDrag.deltaSec);
                        } else if (activeDrag.mode === 'r') {
                          liveDur = Math.max(0.1, c.durationSec + activeDrag.deltaSec);
                        }
                      }

                      const clipWidth = Math.max(6, liveDur * pxPerSec);
                      const frameCount = Math.min(30, Math.max(1, Math.floor(clipWidth / 75)));

                      return (
                        <div
                          key={c.id}
                          className={`clip ${t.kind} ${c.kind === 'text' ? 'text' : ''} ${c.id === selectedId ? 'selected' : ''}`}
                          style={{
                            left: liveStart * pxPerSec,
                            width: clipWidth,
                            opacity: t.locked ? 0.6 : 1,
                          }}
                          title={`${c.name} (${formatTimecode(c.durationSec).slice(3)})`}
                          onPointerDown={(e) => onClipPointerDown(e, c, t, 'move')}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            select(c.id);
                            setContextMenu({ x: e.clientX, y: e.clientY, clip: c, track: t });
                          }}
                        >
                          {/* Video/Image Filmstrip Frame Previews */}
                          {previewUrl && (
                            <div className="clip-filmstrip">
                              {Array.from({ length: frameCount }).map((_, idx) => (
                                <div
                                  key={idx}
                                  className="clip-frame"
                                  style={{
                                    backgroundImage: `url("${previewUrl}")`,
                                  }}
                                />
                              ))}
                            </div>
                          )}

                          {/* Audio Waveform Effect */}
                          {t.kind === 'audio' && (
                            <div className="clip-waveform">
                              {Array.from({ length: Math.min(50, Math.max(4, Math.floor(clipWidth / 10))) }).map((_, idx) => {
                                const h = 25 + ((idx * 37 + 19) % 60);
                                return <div key={idx} className="wave-bar" style={{ height: `${h}%` }} />;
                              })}
                            </div>
                          )}

                          {!t.locked && (
                            <div
                              className="handle l"
                              onPointerDown={(e) => onClipPointerDown(e, c, t, 'l')}
                              title="Trim Start"
                            />
                          )}

                          {/* Clip Header Badge */}
                          <div className="clip-badge">
                            {c.text ? (
                              <IconSubtitles size={10} />
                            ) : t.kind === 'audio' ? (
                              <IconAudio size={10} />
                            ) : media?.kind === 'image' ? (
                              <IconImage size={10} />
                            ) : (
                              <IconVideo size={10} />
                            )}
                            <span className="clip-title">{c.text ?? c.name}</span>
                            <span className="clip-dur">{formatTimecode(c.durationSec).slice(3)}</span>
                          </div>

                          {!t.locked && (
                            <div
                              className="handle r"
                              onPointerDown={(e) => onClipPointerDown(e, c, t, 'r')}
                              title="Trim End"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* Snap visual guide line */}
            {snapTime !== null && (
              <div className="snap-line" style={{ left: snapTime * pxPerSec }} />
            )}

            {/* Playhead */}
            <div className="playhead" style={{ left: playhead * pxPerSec }}>
              <div className="playhead-label">{formatTimecode(playhead).slice(3, 11)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Clip Context Menu */}
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
              splitAtPlayhead();
              setContextMenu(null);
            }}
          >
            <IconSplit size={12} /> Split at Playhead
          </div>
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              op({ op: 'timeline:deleteClip', clipId: contextMenu.clip.id, ripple: false });
              select(null);
              setContextMenu(null);
            }}
          >
            <IconTrash size={12} /> Delete Clip
          </div>
          <div
            className="context-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              op({ op: 'timeline:deleteClip', clipId: contextMenu.clip.id, ripple: true });
              select(null);
              setContextMenu(null);
            }}
          >
            <IconRipple size={12} /> Ripple Delete
          </div>
        </div>
      )}
    </div>
  );
}
