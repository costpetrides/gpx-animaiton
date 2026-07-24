import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so Electron can load dist/ via file://
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
