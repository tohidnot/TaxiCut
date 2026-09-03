// Local ASR (Parakeet TDT v3) configuration. No cloud APIs are ever used.
import { homedir } from 'node:os';
import { join } from 'node:path';

const defaultRoot = join(homedir(), 'asr', 'parakeet-tdt-v3');

export const ASR_MODEL_PATH =
  process.env.TAXICUT_PARAKEET_MODEL ??
  join(defaultRoot, 'models', 'tdt-0.6b-v3-q5_k.gguf');

export const ASR_CLI_PATH =
  process.env.TAXICUT_PARAKEET_CLI ??
  join(defaultRoot, 'bin', 'parakeet-v0.5.0-bin-macos-metal-arm64', 'parakeet-cli');
