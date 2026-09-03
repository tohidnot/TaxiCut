import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { formatTimecode } from '../time';
import type { Clip, MediaAsset, Project } from '../../../shared/types';
import {
  IconPlay,
  IconPause,
  IconStepBack,
  IconStepForward,
  IconJumpStart,
  IconAudio,
} from './Icons';

/** Convert clip volume dB to a <media> volume gain (0..1). */
function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)));
}

function timelineDuration(tracks: Project['tracks']): number {
  let max = 0;
  for (const t of tracks) {
    for (const c of t.clips) max = Math.max(max, c.startSec + c.durationSec);
  }
  return max;
}

interface ActiveTimelineClips {
  visualClip?: Clip;
  visualMedia?: MediaAsset;
  audioClip?: Clip;
  audioMedia?: MediaAsset;
}

/** Topmost unmuted video-track clip wins the picture; first unmuted audio clip wins the extra audio element. */
function findTimelineClips(project: Project, head: number): ActiveTimelineClips {
  const tracks = project.tracks ?? [];
  let visualClip: Clip | undefined;
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    if (t.kind !== 'video' || t.muted) continue;
    const found = t.clips.find((c) => head >= c.startSec && head < c.startSec + c.durationSec);
    if (found) {
      visualClip = found;
      break;
    }
  }
  let audioClip: Clip | undefined;
  for (const t of tracks) {
    if (t.kind !== 'audio' || t.muted) continue;
    const found = t.clips.find((c) => head >= c.startSec && head < c.startSec + c.durationSec);
    if (found) {
      audioClip = found;
      break;
    }
  }
  const visualMedia = visualClip ? project.media.find((m) => m.id === visualClip.mediaId) : undefined;
  const audioMedia = audioClip ? project.media.find((m) => m.id === audioClip.mediaId) : undefined;
  return { visualClip, visualMedia, audioClip, audioMedia };
}

/** Point the element at this media if it isn't already. Keeps the decoder warm across gaps. */
function ensureSrc(
  el: HTMLMediaElement,
  loadedRef: React.MutableRefObject<string | null>,
  media: MediaAsset,
): void {
  if (loadedRef.current !== media.id) {
    loadedRef.current = media.id;
    el.src = window.taxicut.mediaUrl(media.path);
    el.load();
  }
}

/** Seek when drift exceeds threshold. Never piles a new seek onto one already
 *  in flight — returns true while a seek is outstanding. Retried every frame
 *  so pre-metadata seeks converge once data arrives. */
function syncClock(el: HTMLMediaElement, targetSec: number, thresholdSec: number): boolean {
  const target = Math.max(0, targetSec);
  if (!Number.isFinite(target)) return false;
  if (el.seeking) return true;
  try {
    if (Math.abs(el.currentTime - target) > thresholdSec) {
      el.currentTime = target;
      return true;
    }
  } catch {
    /* seek while loading — retried next frame */
  }
  return el.seeking;
}

function applyProps(el: HTMLMediaElement, clip: Clip): void {
  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
  if (el.playbackRate !== speed) {
    try {
      el.playbackRate = speed;
    } catch {
      /* not ready yet */
    }
  }
  const vol = dbToGain(clip.volumeDb);
  if (Math.abs(el.volume - vol) > 0.005) el.volume = vol;
}

function playQuiet(el: HTMLMediaElement): void {
  if (!el.paused) return;
  const p = el.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

export default function PreviewPanel() {
  const timelineVideoRef = useRef<HTMLVideoElement>(null);
  const timelineAudioRef = useRef<HTMLAudioElement>(null);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const sourceAudioRef = useRef<HTMLAudioElement>(null);

  const loadedTimelineVideoId = useRef<string | null>(null);
  const loadedTimelineAudioId = useRef<string | null>(null);
  const loadedSourceId = useRef<string | null>(null);
  /** Wall-time (performance.now) when we started holding the playhead for a seek. */
  const seekHoldStart = useRef<number | null>(null);

  const [buffering, setBuffering] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playheadSec);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const previewMode = useEditor((s) => s.previewMode);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);
  const selectedMediaId = useEditor((s) => s.selectedMediaId);
  const sourcePlayhead = useEditor((s) => s.sourcePlayheadSec);
  const setSourcePlayhead = useEditor((s) => s.setSourcePlayhead);
  const sourcePlaying = useEditor((s) => s.sourcePlaying);
  const setSourcePlaying = useEditor((s) => s.setSourcePlaying);

  const tracks = project?.tracks ?? [];
  const duration = timelineDuration(tracks);

  const sourceMedia = selectedMediaId
    ? project?.media.find((m) => m.id === selectedMediaId)
    : undefined;

  const { visualClip, visualMedia, audioClip: activeAudioClip, audioMedia: activeAudioMedia } =
    project ? findTimelineClips(project, playhead) : {};

  const activeSubtitleClip = tracks
    .filter((t) => !t.muted)
    .flatMap((t) => t.clips)
    .find((c) => c.text && playhead >= c.startSec && playhead < c.startSec + c.durationSec);
  const subtitleText = activeSubtitleClip?.text;

  const currentFps = visualMedia?.fps || 30;

  // -------------------------------------------------------------
  // 1) Timeline playback: wall-clock drives the playhead, media slaves to it.
  //    Effect depends only on [playing, previewMode] so crossing clip
  //    boundaries never tears down the RAF loop (the old freeze).
  // -------------------------------------------------------------
  useEffect(() => {
    if (previewMode !== 'timeline') {
      timelineVideoRef.current?.pause();
      timelineAudioRef.current?.pause();
      return;
    }
    if (!playing) {
      timelineVideoRef.current?.pause();
      timelineAudioRef.current?.pause();
      return;
    }

    let raf = 0;
    let lastWall = performance.now();
    setMediaError(null);
    seekHoldStart.current = null;

    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastWall) / 1000));
      lastWall = now;

      const st = useEditor.getState();
      const proj = st.project;
      if (!proj) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const head = st.playheadSec;
      const total = timelineDuration(proj.tracks ?? []);

      if (total > 0 && head >= total) {
        st.setPlaying(false);
        return;
      }

      const { visualClip: vc, visualMedia: vm, audioClip: ac, audioMedia: am } =
        findTimelineClips(proj, head);

      // While the picture element is seeking (or still loading data), hold the
      // playhead still so the seek target can't run away — re-seeking every
      // frame to a moving target is what stalls playback. Escape after 1s so
      // a wedged seek can never freeze the timecode for good.
      let holdForSeek = false;
      const v = timelineVideoRef.current;
      if (v) {
        if (vm?.kind === 'video' && vc) {
          ensureSrc(v, loadedTimelineVideoId, vm);
          applyProps(v, vc);
          const target = vc.inSec + (head - vc.startSec) * vc.speed;
          const drifted = Math.abs(v.currentTime - Math.max(0, target)) > 0.35;
          const seekOutstanding = syncClock(v, target, 0.35);
          if ((drifted || v.seeking) && (seekOutstanding || v.readyState < 2)) {
            holdForSeek = true;
          }
          playQuiet(v);
        } else if (!v.paused) {
          v.pause();
        }
      }

      const a = timelineAudioRef.current;
      if (a) {
        if (am && ac) {
          ensureSrc(a, loadedTimelineAudioId, am);
          applyProps(a, ac);
          syncClock(a, ac.inSec + (head - ac.startSec) * ac.speed, 0.35);
          playQuiet(a);
        } else if (!a.paused) {
          a.pause();
        }
      }

      if (holdForSeek) {
        if (seekHoldStart.current == null) seekHoldStart.current = now;
        if (now - seekHoldStart.current < 1000) {
          raf = requestAnimationFrame(tick);
          return;
        }
      }
      seekHoldStart.current = null;

      const next = head + dt;
      if (total > 0 && next >= total) {
        st.setPlayhead(total);
        st.setPlaying(false);
        return;
      }
      st.setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, previewMode]);

  // -------------------------------------------------------------
  // 2) Scrub sync while paused: snap media to the playhead.
  //    Never clears src (old code reloaded on every gap → flash/freeze).
  // -------------------------------------------------------------
  useEffect(() => {
    if (previewMode !== 'timeline' || playing) return;
    if (!project) return;
    const v = timelineVideoRef.current;
    if (v) {
      if (visualMedia?.kind === 'video' && visualClip) {
        ensureSrc(v, loadedTimelineVideoId, visualMedia);
        applyProps(v, visualClip);
        if (!v.paused) v.pause();
        syncClock(v, visualClip.inSec + (playhead - visualClip.startSec) * visualClip.speed, 0.04);
      } else if (!v.paused) {
        v.pause();
      }
    }
    const a = timelineAudioRef.current;
    if (a) {
      if (activeAudioMedia && activeAudioClip) {
        ensureSrc(a, loadedTimelineAudioId, activeAudioMedia);
        applyProps(a, activeAudioClip);
        if (!a.paused) a.pause();
        syncClock(a, activeAudioClip.inSec + (playhead - activeAudioClip.startSec) * activeAudioClip.speed, 0.04);
      } else if (!a.paused) {
        a.pause();
      }
    }
  }, [previewMode, playing, playhead, project, visualClip, visualMedia, activeAudioClip, activeAudioMedia]);

  // -------------------------------------------------------------
  // 3) Source playback: same wall-clock pattern. Deps exclude the
  //    playhead itself — the old [.., sourcePlayhead] dep restarted
  //    the loop every frame and stalled after a few seconds.
  // -------------------------------------------------------------
  useEffect(() => {
    if (previewMode !== 'source' || !sourceMedia) {
      sourceVideoRef.current?.pause();
      sourceAudioRef.current?.pause();
      return;
    }
    if (sourceMedia.kind === 'image') return;
    if (!sourcePlaying) {
      sourceVideoRef.current?.pause();
      sourceAudioRef.current?.pause();
      return;
    }

    let raf = 0;
    let lastWall = performance.now();
    setMediaError(null);
    seekHoldStart.current = null;

    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastWall) / 1000));
      lastWall = now;
      const st = useEditor.getState();
      const media = st.project?.media.find((m) => m.id === st.selectedMediaId);
      if (!media || media.kind === 'image') {
        raf = requestAnimationFrame(tick);
        return;
      }
      const head = st.sourcePlayheadSec;
      const total = media.durationSec || 0;
      if (total > 0 && head >= total) {
        st.setSourcePlaying(false);
        return;
      }

      let holdForSeek = false;
      const el =
        media.kind === 'video' ? sourceVideoRef.current : sourceAudioRef.current;
      if (el) {
        ensureSrc(el, loadedSourceId, media);
        if (el.volume !== 1) el.volume = 1;
        if (el.playbackRate !== 1) {
          try {
            el.playbackRate = 1;
          } catch {
            /* not ready */
          }
        }
        const drifted = Math.abs(el.currentTime - Math.max(0, head)) > 0.35;
        const seekOutstanding = syncClock(el, head, 0.35);
        if ((drifted || el.seeking) && (seekOutstanding || el.readyState < 2)) {
          holdForSeek = true;
        }
        playQuiet(el);
      }

      if (holdForSeek) {
        if (seekHoldStart.current == null) seekHoldStart.current = now;
        if (now - seekHoldStart.current < 1000) {
          raf = requestAnimationFrame(tick);
          return;
        }
      }
      seekHoldStart.current = null;

      const next = head + dt;
      if (total > 0 && next >= total) {
        st.setSourcePlayhead(total);
        st.setSourcePlaying(false);
        return;
      }
      st.setSourcePlayhead(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [previewMode, sourcePlaying, sourceMedia?.id]);

  // Source scrub while paused.
  useEffect(() => {
    if (previewMode !== 'source' || sourcePlaying || !sourceMedia) return;
    if (sourceMedia.kind === 'image') return;
    const el =
      sourceMedia.kind === 'video' ? sourceVideoRef.current : sourceAudioRef.current;
    if (!el) return;
    ensureSrc(el, loadedSourceId, sourceMedia);
    if (!el.paused) el.pause();
    syncClock(el, sourcePlayhead, 0.04);
  }, [previewMode, sourcePlaying, sourcePlayhead, sourceMedia]);

  // Keep the non-active engine parked when switching modes.
  useEffect(() => {
    if (previewMode === 'timeline') {
      sourceVideoRef.current?.pause();
      sourceAudioRef.current?.pause();
      setSourcePlaying(false);
    } else {
      timelineVideoRef.current?.pause();
      timelineAudioRef.current?.pause();
      setPlaying(false);
    }
    setBuffering(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode]);

  const step = (frames: number) => {
    if (previewMode === 'timeline') {
      setPlaying(false);
      setPlayhead(Math.max(0, Math.min(duration, playhead + frames / currentFps)));
    } else if (sourceMedia) {
      setSourcePlaying(false);
      const fps = sourceMedia.fps || 30;
      setSourcePlayhead(Math.max(0, Math.min(sourceMedia.durationSec, sourcePlayhead + frames / fps)));
    }
  };

  const togglePlay = () => {
    if (previewMode === 'timeline') {
      if (!playing && duration > 0 && playhead >= duration) setPlayhead(0);
      setPlaying(!playing);
    } else if (sourceMedia?.kind !== 'image') {
      if (!sourcePlaying && sourceMedia && sourcePlayhead >= sourceMedia.durationSec) {
        setSourcePlayhead(0);
      }
      setSourcePlaying(!sourcePlaying);
    }
  };

  const activePlayhead = previewMode === 'timeline' ? playhead : sourcePlayhead;
  const activeDuration = previewMode === 'timeline' ? duration : (sourceMedia?.durationSec ?? 0);
  const isPlaying = previewMode === 'timeline' ? playing : sourcePlaying;
  const showTimelineVideo = previewMode === 'timeline' && visualMedia?.kind === 'video';
  const showSourceVideo = previewMode === 'source' && sourceMedia?.kind === 'video';

  const onNeedBuffer = () => setBuffering(true);
  const onCanPlay = () => setBuffering(false);
  const onMediaError = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const el = e.currentTarget;
    const err = el.error;
    if (err && err.code !== err.MEDIA_ERR_ABORTED) {
      setMediaError(`Playback error (code ${err.code}). The file may use an unsupported codec — try transcoding to H.264/AAC.`);
    }
    setBuffering(false);
  };

  return (
    <div className="preview-panel">
      <div className="panel-header">
        <div className="preview-tabs">
          <button
            className={`tab-btn ${previewMode === 'timeline' ? 'active' : ''}`}
            onClick={() => setPreviewMode('timeline')}
          >
            Timeline
          </button>
          {sourceMedia && (
            <button
              className={`tab-btn ${previewMode === 'source' ? 'active' : ''}`}
              onClick={() => setPreviewMode('source')}
            >
              Source: {sourceMedia.name}
            </button>
          )}
        </div>
        <div className="spacer" />
        <span className="meta">
          {previewMode === 'source' && sourceMedia
            ? `${sourceMedia.kind.toUpperCase()}${sourceMedia.width ? ` · ${sourceMedia.width}×${sourceMedia.height}` : ''}${sourceMedia.fps ? ` · ${sourceMedia.fps.toFixed(0)}fps` : ''}`
            : '16:9 · Fit'}
        </span>
      </div>

      <div className="preview-stage">
        <div className="preview-wrap">
          {/* Timeline elements: always mounted so refs stay valid; hidden when inactive. */}
          <video
            ref={timelineVideoRef}
            className="preview-media"
            playsInline
            preload="auto"
            onWaiting={onNeedBuffer}
            onStalled={onNeedBuffer}
            onPlaying={onCanPlay}
            onCanPlay={onCanPlay}
            onError={onMediaError}
            style={{ display: showTimelineVideo ? 'block' : 'none' }}
          />
          <audio
            ref={timelineAudioRef}
            preload="auto"
            onWaiting={onNeedBuffer}
            onPlaying={onCanPlay}
            onError={onMediaError}
            style={{ display: 'none' }}
          />

          {/* Source elements: always mounted for the same reason. */}
          <video
            ref={sourceVideoRef}
            className="preview-media"
            playsInline
            preload="auto"
            onWaiting={onNeedBuffer}
            onStalled={onNeedBuffer}
            onPlaying={onCanPlay}
            onCanPlay={onCanPlay}
            onError={onMediaError}
            style={{ display: showSourceVideo ? 'block' : 'none' }}
          />
          <audio
            ref={sourceAudioRef}
            preload="auto"
            onWaiting={onNeedBuffer}
            onPlaying={onCanPlay}
            onError={onMediaError}
            style={{ display: 'none' }}
          />

          {/* Timeline image element */}
          {previewMode === 'timeline' && visualMedia?.kind === 'image' && (
            <img
              src={window.taxicut.mediaUrl(visualMedia.path)}
              className="preview-media preview-image"
              alt=""
            />
          )}

          {/* Timeline audio-only indicator (no video clip under playhead but audio is present). */}
          {previewMode === 'timeline' && !visualClip && (activeAudioMedia || visualMedia?.kind === 'audio') && (
            <div className="preview-audio-indicator">
              <span className="audio-icon"><IconAudio size={42} /></span>
              <span className="audio-title">{(activeAudioMedia ?? visualMedia)?.name}</span>
            </div>
          )}

          {/* Timeline empty state */}
          {previewMode === 'timeline' && !visualClip && !activeAudioMedia && (
            <div className="preview-empty-stage">
              {tracks.every((t) => t.clips.length === 0) ? (
                <div className="preview-empty-hint">
                  Timeline is empty.
                  <br />
                  Drag media from Library or Desktop to add clips.
                </div>
              ) : null}
            </div>
          )}

          {/* Subtitle text overlay */}
          {previewMode === 'timeline' && subtitleText && (
            <div className="preview-subtitle">{subtitleText}</div>
          )}

          {/* Source stills / audio indicator */}
          {previewMode === 'source' && sourceMedia?.kind === 'image' && (
            <img
              src={window.taxicut.mediaUrl(sourceMedia.path)}
              className="preview-media preview-image"
              alt=""
            />
          )}
          {previewMode === 'source' && sourceMedia?.kind === 'audio' && (
            <div className="preview-audio-indicator">
              <span className="audio-icon"><IconAudio size={42} /></span>
              <span className="audio-title">{sourceMedia.name}</span>
            </div>
          )}

          {buffering && isPlaying && (
            <div
              style={{
                position: 'absolute',
                bottom: 10,
                left: 0,
                right: 0,
                textAlign: 'center',
                fontSize: 11,
                color: 'var(--text-dim)',
                pointerEvents: 'none',
              }}
            >
              Buffering…
            </div>
          )}
          {mediaError && (
            <div
              style={{
                position: 'absolute',
                bottom: 28,
                left: 12,
                right: 12,
                textAlign: 'center',
                fontSize: 11,
                color: 'var(--danger)',
                pointerEvents: 'none',
              }}
            >
              {mediaError}
            </div>
          )}
        </div>
      </div>

      <div className="transport">
        <span className="tc">
          {formatTimecode(activePlayhead, currentFps)} / {formatTimecode(activeDuration, currentFps)}
        </span>
        <button className="icon" onClick={() => step(-1)} title="Back 1 frame (Left Arrow)">
          <IconStepBack size={13} />
        </button>
        <button className="icon" onClick={togglePlay} title="Play/Pause (Space)">
          {isPlaying ? <IconPause size={13} /> : <IconPlay size={13} />}
        </button>
        <button className="icon" onClick={() => step(1)} title="Forward 1 frame (Right Arrow)">
          <IconStepForward size={13} />
        </button>
        <button
          className="icon"
          onClick={() => {
            if (previewMode === 'timeline') {
              setPlaying(false);
              setPlayhead(0);
            } else {
              setSourcePlaying(false);
              setSourcePlayhead(0);
            }
          }}
          title="Return to start"
        >
          <IconJumpStart size={13} />
        </button>
      </div>
    </div>
  );
}
