# TaxiCut

**An open-source (MIT) desktop video editor built for AI agents.**

TaxiCut is an Electron + TypeScript video editor: media library, multi-track timeline
(video/audio), clip trimming/splitting, volume/fades, local speech-to-text subtitles,
and ffmpeg-based export — with a built-in **terminal** instead of an AI chat panel.
Run whatever agent you prefer (Claude Code, Codex, Gemini CLI, …) in that terminal and
let it drive the editor through MCP.

It's an original, clean-room implementation inspired by Palmier Pro's workflow —
no Palmier code is used. Where Palmier embeds a chat UI and generation backend and
requires a subscription, TaxiCut embeds a terminal and has **no accounts, no cloud**:
all speech-to-text runs locally with a Parakeet TDT model.

## Quick start

```bash
npm install
npm run dev
```

Requires macOS with `ffmpeg` and `ffprobe` (e.g. `brew install ffmpeg`).

## MCP server

While TaxiCut is running, it exposes an MCP server (Streamable HTTP) at
`http://127.0.0.1:19789/mcp` so external agents can edit the open project.

**Claude Code**

```bash
claude mcp add --transport http taxicut http://127.0.0.1:19789/mcp
```

**Codex**

```bash
codex mcp add taxicut --url http://127.0.0.1:19789/mcp
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "taxicut": { "type": "http", "url": "http://127.0.0.1:19789/mcp" }
  }
}
```

Available tools include: `project_info`, `project_new/open/save`, `import_media`,
`list_media`, `get_timeline`, `add_track`, `add_clip`, `move_clip`, `trim_clip`,
`split_clip`, `delete_clip` (with ripple), `set_clip_properties`, `undo`/`redo`,
`transcribe_media`, `generate_subtitles`, `export_timeline`, `export_status`.

## Local speech-to-text

Subtitles/transcription use a local Parakeet TDT v3 GGUF model — never a cloud API.
Defaults:

- CLI: `/Users/apple/asr/parakeet-tdt-v3/bin/parakeet-v0.5.0-bin-macos-metal-arm64/parakeet-cli`
- Model: `/Users/apple/asr/parakeet-tdt-v3/models/tdt-0.6b-v3-q5_k.gguf`

Override with `TAXICUT_PARAKEET_CLI` / `TAXICUT_PARAKEET_MODEL`.
Right-click an audio-capable asset in the media library to generate a subtitle track.

## Project files

Projects save as `.taxicut` — plain JSON of the media pool and tracks/clips.

## Development

```bash
npm run dev          # run with hot reload
npm run build        # production build (out/)
npm run typecheck    # tsc for main/preload/renderer
npm run smoke        # end-to-end MCP + ffmpeg smoke test (no GUI)
```

## Architecture

- `src/main/` — Electron main: window, project store + undo, ffmpeg pipeline,
  Parakeet ASR, MCP server (`mcp.ts`, standalone-testable), terminal (node-pty).
- `src/preload/` — typed `window.taxicut` bridge.
- `src/renderer/` — React UI: media bin, preview/compositor, inspector, timeline, terminal.
- `src/shared/` — shared types and IPC contract.

## License

MIT — see [LICENSE](LICENSE).
