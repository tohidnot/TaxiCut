# TaxiCut agent/contributor notes

MIT-licensed Electron + TypeScript video editor. Build: `npm install && npm run build`.
Run: `npm run dev`. Typecheck: `npm run typecheck`. Smoke test (MCP + ffmpeg, no GUI):
`npm run smoke`.

## Rules

- All speech-to-text must use the local Parakeet model via `src/main/asr.ts`
  (env overrides `TAXICUT_PARAKEET_CLI` / `TAXICUT_PARAKEET_MODEL`). Never add a cloud ASR API.
- No AI chat UI, no generation backend, no accounts/subscriptions. The left panel is a
  terminal; external agents connect over MCP.
- All timeline mutations go through `ProjectStore` (`src/main/store.ts`) so UI, MCP, and
  IPC share undo history and validation. Never mutate project state directly elsewhere.
- MCP server (`src/main/mcp.ts`) must stay Electron-free so it runs in the smoke test.
- ffmpeg/ffprobe live in `src/main/ffmpeg.ts`; export renders per-clip intermediates,
  concatenates, then mixes audio tracks.
- UI styling uses CSS variables in `src/renderer/src/styles.css`; no hardcoded colors in components.
- Wordmark is plain text "TaxiCut" — no logo assets.
