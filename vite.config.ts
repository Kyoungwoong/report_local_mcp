import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'app',
  plugins: [viteSingleFile()],
  build: {
    outDir: '../dist/apps',
    emptyOutDir: false,
    rollupOptions: { input: 'app/daily-draft.html' },
  },
});

