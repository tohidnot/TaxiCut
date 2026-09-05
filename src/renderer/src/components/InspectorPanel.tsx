import { useEditor, op } from '../store';
import { formatDuration } from '../time';
import { canvasSize, CLIP_FILTERS, DEFAULT_CLIP_COLOR, FONT_FAMILIES, TEXT_TEMPLATES } from '../../../shared/types';
import type { Clip } from '../../../shared/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { AlignCenter, AlignLeft, AlignRight, Plus, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

const ALIGN_SPOTS = [
  { id: 'tl', x: -1, y: -1 }, { id: 'tc', x: 0, y: -1 }, { id: 'tr', x: 1, y: -1 },
  { id: 'ml', x: -1, y: 0 }, { id: 'c', x: 0, y: 0 }, { id: 'mr', x: 1, y: 0 },
  { id: 'bl', x: -1, y: 1 }, { id: 'bc', x: 0, y: 1 }, { id: 'br', x: 1, y: 1 },
] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <FieldGroup className="gap-3">{children}</FieldGroup>
      </CardContent>
    </Card>
  );
}

function RowLabel({ children, value }: { children: ReactNode; value?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <FieldLabel>{children}</FieldLabel>
      {value !== undefined && <Badge variant="secondary">{value}</Badge>}
    </div>
  );
}

export default function InspectorPanel() {
  const project = useEditor((s) => s.project);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const selectedMediaId = useEditor((s) => s.selectedMediaId);
  const playheadSec = useEditor((s) => s.playheadSec);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);
  const setCropMode = useEditor((s) => s.setCropMode);
  const cropMode = useEditor((s) => s.cropMode);

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

  return (
    <div className="inspector">
      <div className="panel-header">Inspector</div>
      {!clip && !selectedMedia ? (
        <div className="p-3">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SlidersHorizontal />
              </EmptyMedia>
              <EmptyTitle>Nothing selected</EmptyTitle>
              <EmptyDescription>
                Select a clip on the timeline or a media item in the library to inspect its properties.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : clip ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
          <Section title="Clip">
            <Field>
              <FieldLabel htmlFor="clip-name">Name</FieldLabel>
              <Input
                id="clip-name"
                value={clip.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            <div className="flex items-center justify-between gap-2">
              <Badge variant="outline">{formatDuration(clip.durationSec)}</Badge>
              <span className="text-muted-foreground text-xs">
                @ {clip.startSec.toFixed(2)}s (in: {clip.inSec.toFixed(2)}s)
              </span>
            </div>
            {clip.kind !== 'text' && clip.text !== undefined && clip.text !== '' && (
              <Field>
                <FieldLabel htmlFor="clip-captions">Captions (auto)</FieldLabel>
                <Input
                  id="clip-captions"
                  value={clip.text}
                  onChange={(e) => set({ text: e.target.value })}
                />
              </Field>
            )}
          </Section>
          <Section title="Levels">
            <Field>
              <RowLabel value={`${clip.volumeDb.toFixed(1)} dB`}>Volume</RowLabel>
              <Slider
                aria-label="Volume"
                min={-60}
                max={12}
                step={0.5}
                value={[clip.volumeDb]}
                onValueChange={([v]) => set({ volumeDb: v })}
              />
            </Field>
            {(clip.kind === 'audio' || (clip.kind === 'video' && (clipMedia?.hasAudio ?? false))) && (
              <Field orientation="horizontal">
                <Checkbox
                  id="clip-mute"
                  checked={!!clip.audioMuted}
                  onCheckedChange={(v) => set({ audioMuted: v === true })}
                />
                <FieldLabel htmlFor="clip-mute">Mute audio (picture keeps playing)</FieldLabel>
              </Field>
            )}
            <Field orientation="horizontal">
              <FieldLabel htmlFor="clip-fadein">Fade In</FieldLabel>
              <div className="flex items-center gap-1.5">
                <Input
                  id="clip-fadein"
                  type="number"
                  min={0}
                  step={0.1}
                  value={clip.fadeInSec}
                  onChange={(e) => set({ fadeInSec: Number(e.target.value) })}
                  className="w-20"
                />
                <span className="text-muted-foreground text-xs">s</span>
              </div>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="clip-fadeout">Fade Out</FieldLabel>
              <div className="flex items-center gap-1.5">
                <Input
                  id="clip-fadeout"
                  type="number"
                  min={0}
                  step={0.1}
                  value={clip.fadeOutSec}
                  onChange={(e) => set({ fadeOutSec: Number(e.target.value) })}
                  className="w-20"
                />
                <span className="text-muted-foreground text-xs">s</span>
              </div>
            </Field>
          </Section>
          <Section title="Playback">
            <Field orientation="horizontal">
              <FieldLabel htmlFor="clip-speed">Speed</FieldLabel>
              <div className="flex items-center gap-1.5">
                <Input
                  id="clip-speed"
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={clip.speed}
                  onChange={(e) => set({ speed: Number(e.target.value) })}
                  className="w-20"
                />
                <span className="text-muted-foreground text-xs">x</span>
              </div>
            </Field>
          </Section>
          {(clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'text') && (
            <Section title="Transform">
              <Field>
                <RowLabel value={`${(clip.scale ?? 1).toFixed(2)}x`}>Scale</RowLabel>
                <Slider
                  aria-label="Scale"
                  min={0.1}
                  max={4}
                  step={0.05}
                  value={[clip.scale ?? 1]}
                  onValueChange={([v]) => set({ scale: v })}
                />
              </Field>
              <div className="flex items-end gap-2">
                <Field className="flex-1">
                  <FieldLabel htmlFor="clip-posx">X</FieldLabel>
                  <Input
                    id="clip-posx"
                    type="number"
                    step={0.05}
                    value={clip.posX ?? 0}
                    onChange={(e) => set({ posX: Number(e.target.value) })}
                  />
                </Field>
                <Field className="flex-1">
                  <FieldLabel htmlFor="clip-posy">Y</FieldLabel>
                  <Input
                    id="clip-posy"
                    type="number"
                    step={0.05}
                    value={clip.posY ?? 0}
                    onChange={(e) => set({ posY: Number(e.target.value) })}
                  />
                </Field>
              </div>
              {(clip.kind === 'video' || clip.kind === 'image') && (
                <>
                  <div className="flex gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      title="Fit whole video in canvas"
                      onClick={() => set({ scale: 1, posX: 0, posY: 0 })}
                    >
                      Fit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      title="Fill the whole canvas (crops overflow)"
                      onClick={() => set({ scale: Math.round(fillScale * 100) / 100, posX: 0, posY: 0 })}
                    >
                      Fill
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      title="Center video on canvas"
                      onClick={() => set({ posX: 0, posY: 0 })}
                    >
                      Center
                    </Button>
                  </div>
                  <Field orientation="horizontal">
                    <FieldLabel>Align</FieldLabel>
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
                  </Field>
                </>
              )}
              {clip.kind === 'text' && (
                <Button
                  variant="outline"
                  size="sm"
                  title="Center text on canvas"
                  onClick={() => set({ posX: 0, posY: 0 })}
                >
                  Center
                </Button>
              )}
              <p className="text-muted-foreground text-xs">
                Tip: drag the video in the viewer to move it, drag a corner to resize.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => set({ scale: 1, posX: 0, posY: 0 })}
              >
                Reset transform
              </Button>
            </Section>
          )}
          <Section title="Layer">
            {(clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'text') && (
              <Field>
                <RowLabel
                  value={`${Math.round(((clip as { opacity?: number }).opacity ?? 1) * 100)}%`}
                >
                  Opacity
                </RowLabel>
                <Slider
                  aria-label="Layer opacity"
                  title="Layer opacity — lower the top layer to see the background through it"
                  min={0}
                  max={100}
                  step={1}
                  value={[Math.round(((clip as { opacity?: number }).opacity ?? 1) * 100)]}
                  onValueChange={([v]) => set({ opacity: v / 100 })}
                />
              </Field>
            )}
            <Field>
              <FieldLabel>Order</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  title="Send to back (Cmd+Shift+[)"
                  onClick={() => op({ op: 'timeline:reorderClip', clipId: clip.id, position: 'back' })}
                >
                  Back
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  title="Move down one layer (Cmd+[)"
                  onClick={() => op({ op: 'timeline:reorderClip', clipId: clip.id, direction: -1 })}
                >
                  ↓
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  title="Move up one layer (Cmd+])"
                  onClick={() => op({ op: 'timeline:reorderClip', clipId: clip.id, direction: 1 })}
                >
                  ↑
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  title="Bring to front (Cmd+Shift+])"
                  onClick={() => op({ op: 'timeline:reorderClip', clipId: clip.id, position: 'front' })}
                >
                  Front
                </Button>
              </div>
            </Field>
            <p className="text-muted-foreground text-xs">
              Drag a clip onto another lane to restack it, or use Back / ↓ / ↑ / Front.
            </p>
          </Section>
          {(clip.kind === 'video' || clip.kind === 'image') && (
            <Section title="Crop (%)">
              <div className="flex items-end gap-2">
                <Field className="flex-1">
                  <FieldLabel htmlFor="clip-cropl">Left</FieldLabel>
                  <Input
                    id="clip-cropl"
                    type="number"
                    min={0}
                    max={90}
                    step={1}
                    value={Math.round((clip.cropL ?? 0) * 100)}
                    onChange={(e) => set({ cropL: Number(e.target.value) / 100 })}
                  />
                </Field>
                <Field className="flex-1">
                  <FieldLabel htmlFor="clip-cropr">Right</FieldLabel>
                  <Input
                    id="clip-cropr"
                    type="number"
                    min={0}
                    max={90}
                    step={1}
                    value={Math.round((clip.cropR ?? 0) * 100)}
                    onChange={(e) => set({ cropR: Number(e.target.value) / 100 })}
                  />
                </Field>
              </div>
              <div className="flex items-end gap-2">
                <Field className="flex-1">
                  <FieldLabel htmlFor="clip-cropt">Top</FieldLabel>
                  <Input
                    id="clip-cropt"
                    type="number"
                    min={0}
                    max={90}
                    step={1}
                    value={Math.round((clip.cropT ?? 0) * 100)}
                    onChange={(e) => set({ cropT: Number(e.target.value) / 100 })}
                  />
                </Field>
                <Field className="flex-1">
                  <FieldLabel htmlFor="clip-cropb">Bottom</FieldLabel>
                  <Input
                    id="clip-cropb"
                    type="number"
                    min={0}
                    max={90}
                    step={1}
                    value={Math.round((clip.cropB ?? 0) * 100)}
                    onChange={(e) => set({ cropB: Number(e.target.value) / 100 })}
                  />
                </Field>
              </div>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  title="Edit crop by dragging in the viewer"
                  onClick={() => {
                    setPreviewMode('timeline');
                    setCropMode(!cropMode);
                  }}
                >
                  {cropMode ? 'Exit viewer crop' : 'Crop in viewer'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  title="Remove crop"
                  onClick={() => set({ cropL: 0, cropT: 0, cropR: 0, cropB: 0 })}
                >
                  Reset crop
                </Button>
              </div>
            </Section>
          )}
          {clip.kind === 'text' && (
            <Section title="Text">
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
              <Field>
                <FieldLabel htmlFor="clip-text">Content</FieldLabel>
                <Textarea
                  id="clip-text"
                  rows={3}
                  value={clip.text ?? ''}
                  onChange={(e) => set({ text: e.target.value })}
                  placeholder="Text overlay…"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="clip-font">Font</FieldLabel>
                <Select
                  value={clip.fontFamily || 'Arial'}
                  onValueChange={(v) => set({ fontFamily: v })}
                >
                  <SelectTrigger id="clip-font">
                    <SelectValue placeholder="Font" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {FONT_FAMILIES.map((f) => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <RowLabel value={`${clip.fontSize ?? 72}px`}>Size</RowLabel>
                <Slider
                  aria-label="Font size"
                  min={16}
                  max={240}
                  step={2}
                  value={[clip.fontSize ?? 72]}
                  onValueChange={([v]) => set({ fontSize: v })}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="clip-color">Color</FieldLabel>
                <div className="flex items-center gap-2">
                  <input
                    id="clip-color"
                    type="color"
                    value={clip.textColor || '#ffffff'}
                    onChange={(e) => set({ textColor: e.target.value })}
                    className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
                  />
                  <FieldLabel htmlFor="clip-textbg">BG</FieldLabel>
                  <input
                    id="clip-textbg"
                    type="color"
                    value={clip.textBg || '#000000'}
                    onChange={(e) => set({ textBg: e.target.value })}
                    className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
                  />
                  <Button
                    variant="outline"
                    size="xs"
                    title="Transparent background"
                    disabled={!clip.textBg}
                    onClick={() => set({ textBg: '' })}
                  >
                    Clear
                  </Button>
                </div>
              </Field>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="clip-bold"
                    checked={!!clip.bold}
                    onCheckedChange={(v) => set({ bold: v === true })}
                  />
                  <Label htmlFor="clip-bold">Bold</Label>
                </div>
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={clip.textAlign || 'center'}
                  onValueChange={(v) => {
                    if (v) set({ textAlign: v });
                  }}
                  aria-label="Text alignment"
                >
                  <ToggleGroupItem value="left" aria-label="Align left">
                    <AlignLeft />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="center" aria-label="Align center">
                    <AlignCenter />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="right" aria-label="Align right">
                    <AlignRight />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <p className="text-muted-foreground text-xs">
                Tip: double-click the text in the viewer to edit it there.
              </p>
            </Section>
          )}
          {(clip.kind === 'video' || clip.kind === 'image') && (
            <Section title="Filter">
              <div className="flex flex-wrap gap-1.5">
                {CLIP_FILTERS.map((f) => (
                  <Button
                    key={f.id || 'none'}
                    size="xs"
                    variant={(clip.filter || '') === f.id ? 'default' : 'outline'}
                    title={f.id ? `${f.name} look` : 'No filter'}
                    onClick={() => set({ filter: f.id })}
                  >
                    {f.name}
                  </Button>
                ))}
              </div>
            </Section>
          )}
          {(clip.kind === 'video' || clip.kind === 'image') && (
            <Section title="Color Grade">
              {(
                [
                  { key: 'exposure', label: 'Exposure', min: -1, max: 1, step: 0.05 },
                  { key: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.05 },
                  { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.05 },
                  { key: 'warmth', label: 'Warmth', min: -1, max: 1, step: 0.05 },
                ] as const
              ).map((s) => {
                const val = clip.color?.[s.key] ?? DEFAULT_CLIP_COLOR[s.key];
                return (
                  <Field key={s.key}>
                    <RowLabel value={val.toFixed(2)}>{s.label}</RowLabel>
                    <Slider
                      aria-label={s.label}
                      min={s.min}
                      max={s.max}
                      step={s.step}
                      value={[val]}
                      onValueChange={([v]) =>
                        set({ color: { ...clip.color, [s.key]: v } })
                      }
                    />
                  </Field>
                );
              })}
              <Button variant="ghost" size="sm" onClick={() => set({ color: { ...DEFAULT_CLIP_COLOR } })}>
                Reset grade
              </Button>
            </Section>
          )}
        </div>
      ) : selectedMedia ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
          <Section title="Media Asset">
            <div className="text-sm font-semibold break-all">{selectedMedia.name}</div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Type</span>
              <Badge variant="outline">{selectedMedia.kind.toUpperCase()}</Badge>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Duration</span>
              <span>{formatDuration(selectedMedia.durationSec)}</span>
            </div>
            {selectedMedia.width > 0 && (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Resolution</span>
                <span>{selectedMedia.width} × {selectedMedia.height}</span>
              </div>
            )}
            {selectedMedia.fps > 0 && (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Framerate</span>
                <span>{selectedMedia.fps.toFixed(2)} fps</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Audio</span>
              <span>{selectedMedia.hasAudio ? 'Yes' : 'No'}</span>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setPreviewMode('timeline');
                op({ op: 'timeline:addClip', mediaId: selectedMedia.id, startSec: playheadSec });
              }}
            >
              <Plus data-icon="inline-start" /> Add to Timeline
            </Button>
          </Section>
        </div>
      ) : null}
    </div>
  );
}
