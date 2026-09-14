process.on('uncaughtException', (e) => console.error(`ddag dashboard: uncaught: ${e.message}`))
process.on('unhandledRejection', (e) => console.error(`ddag dashboard: unhandled: ${String(e)}`))
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry } from '../mcp/registry'
import { startDashboard } from './server'

// dist/ddag-dashboard.mjs serves dist/dashboard/ (the built web app) beside it
const here = dirname(fileURLToPath(import.meta.url))
const staticDir = join(here, 'dashboard')
const port = Number(process.env['PORT'] ?? 5199)
const registry = new Registry()

startDashboard({ registry, staticDir: existsSync(staticDir) ? staticDir : null, port })
  .then(() => {
    console.log(`ddag dashboard: http://localhost:${port}/  (registry: ${registry.file}, ${registry.read().length} project(s))`)
    if (!existsSync(staticDir)) console.log('web app not built — API only; run: npm run build:dashboard')
  })
  .catch((e) => {
    console.error(`ddag dashboard failed to start on port ${port}: ${String(e)}`)
    process.exit(1)
  })
