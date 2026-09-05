import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@modelcontextprotocol/sdk', 'zod'] })],
    build: { outDir: 'out/main' },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/preload' },
  },
  renderer: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: { outDir: 'out/renderer' },
  },
});
