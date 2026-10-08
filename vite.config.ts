import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // the web app builds beside the server bundles: dist/dashboard/
  // two pages: the app shell (index.html) and the 3D view (graph3d.html), which alone carries three.js
  build: { outDir: 'dist/dashboard', emptyOutDir: true, rollupOptions: { input: { index: 'index.html', graph3d: 'graph3d.html' } } },
  resolve: { dedupe: ['three'] },
  // dev: the app on 5299, /api proxied to a running dashboard server (npm run dashboard, 5199)
  server: { port: 5299, proxy: { '/api': 'http://127.0.0.1:5199' } },
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'testbed/**/__tests__/**/*.test.ts',
      'testcases/**/__tests__/**/*.test.ts',
    ],
    environment: 'node',
  },
})
