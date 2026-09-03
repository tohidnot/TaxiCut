import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { formatTimecode } from '../time';
import type { Clip, MediaAsset } from '../../../shared/types';

/** Find the topmost video clip covering time t. */
function clipAt(clips: Clip[], t: number): Clip | undefined {
  return [...clips]
    .sort((a, b) => a.startSec - b.startSec)
    .find((c) => t >= c.startSec && t < c.startSec + c.durationSec);
}

export default function PreviewPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playheadSec);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const videoClips =
    project?.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips) ?? [];
  const duration = videoClips.reduce((e, c) => Math.max(e, c.startSec + c.durationSec), 0);
  const clip = clipAt(videoClips, playhead);
  const media: MediaAsset | undefined = clip
    ? project?.media.find((m) => m.id === clip.mediaId)
    : undefined;
  const subtitle = clip?.text;

  // Load the right source into the video element
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (media && media.kind === 'video') {
      const url = window.taxicut.mediaUrl(media.path);
      if (loadedFor !== media.id) {
        v.src = url;
        setLoadedFor(media.id);
      }
      const sourceT = clip!.inSec + (playhead - clip!.startSec) * clip!.speed;
      if (Math.abs(v.currentTime - sourceT) > 0.35) v.currentTime = sourceT;
    } else {
      v.removeAttribute('src');
      v.load();
      setLoadedFor(null);
    }
  }, [media, clip, playhead, loadedFor]);

  // Playback loop
  useEffect(() => {
    if (!playing) {
      videoRef.current?.pause();
      return;
    }
    const v = videoRef.current;
    if (media?.kind === 'video' && v) {
      v.playbackRate = clip?.speed ?? 1;
      v.volume = Math.pow(10, (clip?.volumeDb ?? 0) / 20);
      v.play().catch(() => {});
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const v2 = videoRef.current;
      let t: number;
      if (media?.kind === 'video' && v2 && clip) {
        t = clip.startSec + (v2.currentTime - clip.inSec) / clip.speed;
      } else {
        t = useEditor.getState().playheadSec + dt;
      }
      if (t >= duration) {
        setPlaying(false);
        setPlayhead(duration);
        return;
      }
      setPlayhead(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const step = (frames: number) => {
    setPlaying(false);
    const fps = media?.fps || 30;
    setPlayhead(Math.max(0, Math.min(duration, playhead + frames / fps)));
  };

  return (
    <div className="preview-panel">
      <div className="panel-header">
        Timeline
      </div>
      <div className="preview-stage">
        <div className="preview-wrap">
          <video ref={videoRef} />
          {subtitle && <div className="preview-subtitle">{subtitle}</div>}
        </div>
      </div>
      <div className="transport">
        <span className="tc">
          {formatTimecode(playhead, media?.fps || 30)} / {formatTimecode(duration, media?.fps || 30)}
        </span>
        <button className="icon" onClick={() => step(-1)} title="Back 1 frame">
          |◂
        </button>
        <button className="icon" onClick={() => (playing ? setPlaying(false) : setPlaying(true))}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="icon" onClick={() => step(1)} title="Forward 1 frame">
          ▸|
        </button>
        <span className="meta">16:9 · FHD · Fit</span>
      </div>
    </div>
  );
}
