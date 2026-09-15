import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { EventChain, type ChainDump } from '../chain/chain'
import { opNotation } from '../chain/notation'
import { frontier } from '../kernel/actions'
import { auditChain, type ChainAudit } from '../mcp/provenance'
import { issueSummary, readIssues } from '../chain/issues'
import { latestVersion, versionLabel } from '../chain/versions'
import { Registry, type ProjectEntry } from '../mcp/registry'

/**
 * The standalone dashboard: one long-running process that serves the built
 * web app and a READ-ONLY API over the project registry. It reads files
 * outside this repository, so it reads only registered chain paths, binds to
 * localhost, and never writes. Started once (`npm run dashboard`); tabs stay
 * live while Claude Code sessions come and go.
 */
export interface ProjectSummary extends ProjectEntry {
  exists: boolean
  rootId?: string
  rootClaim?: string
  rootSolid?: boolean
  frontier?: number
  events?: number
  lastEvent?: string
  /** judgments whose pinned artifacts changed or vanished since */
  stale?: number
  /** recorded issues still open */
  openIssues?: number
  /** recorded issues closed (fixed, wontfix, invalid, duplicate) */
  closedIssues?: number
  /** the latest version mark, e.g. "v0.3 @abc1234", and events since it */
  version?: { label: string; eventsSince: number; rootSolid: boolean }
  error?: string
}

const AUDIT_TTL_MS = 10_000
const auditCache = new Map<string, { at: number; audit: ChainAudit }>()

/**
 * A project's provenance audit, computed from its chain against the files
 * on disk. Cached briefly: the home page polls every project, and directory
 * artifacts hash whole trees. Code can change without the chain changing —
 * that is the point — so the cache is time-based, not chain-based.
 */
export function auditFor(entry: ProjectEntry, chain: EventChain): ChainAudit {
  const hit = auditCache.get(entry.chain)
  if (hit && Date.now() - hit.at < AUDIT_TTL_MS) return hit.audit
  const audit = auditChain(chain, entry.dir, { diffs: true, chainFile: entry.chain })
  auditCache.set(entry.chain, { at: Date.now(), audit })
  return audit
}

/** Tests only: forget cached audits so a file edit is seen at once. */
export function _resetAuditCache(): void {
  auditCache.clear()
}

function loadChain(entry: ProjectEntry): EventChain | null {
  if (!existsSync(entry.chain)) return null
  return EventChain.replay(JSON.parse(readFileSync(entry.chain, 'utf8')) as ChainDump)
}

export function summarize(entry: ProjectEntry): ProjectSummary {
  if (!existsSync(entry.chain)) return { ...entry, exists: false }
  try {
    const chain = loadChain(entry)!
    const g = chain.graph
    const events = chain.chain()
    const last = events[events.length - 1]
    return {
      ...entry,
      exists: true,
      rootId: g.root,
      rootClaim: g.node(g.root).content.split('\n')[0],
      rootSolid: g.solid(g.root),
      frontier: frontier(g).length,
      events: events.length,
      lastEvent: last ? opNotation(last.op) : undefined,
      stale: auditFor(entry, chain).summary.stale,
      openIssues: issueSummary(readIssues(chain)).open,
      closedIssues: issueSummary(readIssues(chain)).closed,
      ...(() => {
        const v = latestVersion(chain)
        return v ? { version: { label: versionLabel(v), eventsSince: v.eventsSince, rootSolid: v.rootSolid } } : {}
      })(),
    }
  } catch {
    // never the parser's message: it quotes the file's first bytes (SEC-ROUTE-2)
    return { ...entry, exists: true, error: 'not a chain' }
  }
}

export interface DashboardOptions {
  registry: Registry
  /** built web app directory (index.html + assets); null serves the API only */
  staticDir: string | null
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function buildHandler(o: DashboardOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const staticRoot = o.staticDir ? resolve(o.staticDir) : null
  const handle = (req: IncomingMessage, res: ServerResponse): unknown => {
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      return json(res, 400, { error: 'malformed path' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read-only' })

    if (path === '/api/projects') {
      const projects = o.registry.read().map(summarize).sort((a, b) => (b.lastSeen > a.lastSeen ? 1 : -1))
      return json(res, 200, { projects })
    }
    if (path.startsWith('/api/audit/')) {
      const name = path.slice('/api/audit/'.length)
      const entry = name.includes('/') ? undefined : o.registry.find(name)
      if (!entry || !existsSync(entry.chain)) return json(res, 404, { error: `unknown project '${name}'` })
      let chain: EventChain
      try {
        chain = loadChain(entry)!
      } catch {
        return json(res, 404, { error: `'${name}' is registered but its file is not a chain` })
      }
      try {
        return json(res, 200, auditFor(entry, chain))
      } catch (e) {
        return json(res, 500, { error: String(e) })
      }
    }
    if (path.startsWith('/api/chain/')) {
      const name = path.slice('/api/chain/'.length)
      const entry = name.includes('/') ? undefined : o.registry.find(name) // names are single segments
      if (!entry || !existsSync(entry.chain)) return json(res, 404, { error: `unknown project '${name}'` })
      // the registry is data: serve a registered path only if it is a chain (SEC-ROUTE-1, SEC-ROUTE-3)
      let raw: Buffer
      try {
        raw = readFileSync(entry.chain)
        EventChain.replay(JSON.parse(raw.toString('utf8')) as ChainDump)
      } catch {
        return json(res, 404, { error: `'${name}' is registered but its file is not a chain` })
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(raw)
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' })

    if (!staticRoot) return json(res, 404, { error: 'no web app built — run npm run build:dashboard' })
    // static asset if it exists under the build dir (contained); otherwise the app shell — /, /p/<name>, /sandbox
    const asset = resolve(staticRoot, `.${path}`)
    // contained on the real path: a link planted in the build dir must not serve its target (SEC-STATIC-1)
    const real = (() => {
      try {
        const r = realpathSync(asset)
        const rootReal = realpathSync(staticRoot)
        return r === rootReal || r.startsWith(rootReal + sep) ? r : null
      } catch {
        return null
      }
    })()
    if (real !== null && (asset === staticRoot || asset.startsWith(staticRoot + sep)) && existsSync(asset) && statSync(asset).isFile()) {
      res.writeHead(200, { 'content-type': MIME[extname(asset)] ?? 'application/octet-stream' })
      return res.end(readFileSync(asset))
    }
    const shell = join(staticRoot, 'index.html')
    if (!existsSync(shell)) return json(res, 404, { error: 'app shell missing' })
    res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-store' })
    res.end(readFileSync(shell))
  }
  // no request may stop the process: anything a route throws is a 500, and the server keeps serving (SEC-DASH-1)
  return (req, res) => {
    try {
      handle(req, res)
    } catch (e) {
      if (res.headersSent) res.end()
      else json(res, 500, { error: 'internal error' })
      console.error(`ddag dashboard: ${req.method} ${req.url}: ${(e as Error).message}`)
    }
  }
}

export function startDashboard(o: DashboardOptions & { port: number; host?: string }): Promise<Server> {
  return new Promise((ok, fail) => {
    const server = createServer(buildHandler(o))
    server.once('error', fail)
    server.listen(o.port, o.host ?? '127.0.0.1', () => ok(server))
  })
}
