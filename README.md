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

While TaxiCut is running, it exposes an MCP server (`taxicut-mcp-server`, Streamable
HTTP, stateless) at `http://127.0.0.1:19789/mcp` so external agents can edit the
open project. Port override: `TAXICUT_MCP_PORT=19800 npm run dev`.

**Zero-config:** this repo ships `.mcp.json` (live HTTP + headless stdio entries) —
most agents (Claude Code, Cursor, VS Code, OpenCode) pick it up automatically when
the folder is open. On startup the app also writes `~/.taxicut/mcp.json` with the
live URL, and serves discovery docs at `GET /health` and `GET /mcp.json`.

**Claude Code**

```bash
claude mcp add --transport http taxicut http://127.0.0.1:19789/mcp
```

**Codex**

```bash
codex mcp add taxicut --url http://127.0.0.1:19789/mcp
```

**Gemini CLI** (`~/.muse/settings.json`)

```json
{ "mcpServers": { "taxicut": { "httpUrl": "http://127.0.0.1:19789/mcp" } } }
```

**Cursor / VS Code** (`~/.cursor/mcp.json` or `.vscode/mcp.json`)

```json
{
  "mcpServers": {
    "taxicut": { "type": "http", "url": "http://127.0.0.1:19789/mcp" }
  }
}
```

**Headless stdio** (no GUI — CI or agents without the app; owns its own project,
use `--project` to open a `.taxicut` file):

```bash
npm run mcp:stdio -- --project /abs/path/project.taxicut
```

**In-app setup (recommended):** the built-in terminal panel has an **MCP Setup**
button with per-agent guides for Claude Code, Codex, OpenCode, Grok Build,
Gemini CLI, Cursor, Antigravity, and VS Code — each with a **Run** button that
types the setup command into the terminal (you press Enter) or a manual guide
where the agent has no setup command. A ▾ button collapses the terminal. Nothing
is ever written to your agent configs without you running the command yourself.

Tools (32, all with titles, descriptions, and read/destructive/idempotent
annotations; reads also return structured output): `server_info`, `project_info`,
`project_new/open/save`, `set_canvas_aspect`, `import_media`, `list_media`
(paginated `limit`/`offset`, `json`/`markdown`), `delete_media`, `get_timeline`
(full or `summary` mode), `find_clips`, `get_clip`, `add_track`, `delete_track`,
`move_track`, `set_track_mute/audio_mute/lock`, `add_clip`, `add_text`,
`move_clip`, `reorder_clip`, `trim_clip`, `split_clip`, `delete_clip` (with
ripple), `set_clip_properties`, `undo`/`redo`, `transcribe_media`,
`generate_subtitles`, `export_timeline`, `export_status`.

Resources: `taxicut://project/info`, `taxicut://timeline/summary`,
`taxicut://media/list`. Prompts: `edit-video`, `make-subtitles`, `export-video`.

Tip for agents: start with `server_info`, then `project_info` /
`get_timeline(summary=true)`; use `find_clips`/`get_clip` instead of scanning
full timelines. Large responses truncate past ~25k chars with recovery hints.

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
