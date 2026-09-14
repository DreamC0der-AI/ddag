import { defineConfig } from 'vite'

// Bundles the dashboard server as a single Node ESM file: dist/ddag-dashboard.mjs
export default defineConfig({
  build: {
    target: 'node18',
    ssr: true,
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/dashboard/main.ts',
      output: { entryFileNames: 'ddag-dashboard.mjs', format: 'es' },
    },
  },
  ssr: { noExternal: true },
})
