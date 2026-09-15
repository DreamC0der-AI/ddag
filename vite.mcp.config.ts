import { defineConfig } from 'vite'

// Bundles the MCP server as a single Node ESM file: dist/ddag-mcp.mjs
export default defineConfig({
  build: {
    target: 'node18',
    ssr: true,
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/mcp/main.ts',
      output: { entryFileNames: 'ddag-mcp.mjs', format: 'es', banner: '#!/usr/bin/env node' },
    },
  },
  ssr: { noExternal: true },
})
