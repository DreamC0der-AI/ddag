import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { coneOf, mainTarget, projectOf, targetsOf } from '../chain/targets'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { EventChain, type ChainDump } from '../chain/chain'
import { opNotation } from '../chain/notation'
import { frontier } from '../kernel/actions'
import { auditChain, type ChainAudit } from '../mcp/provenance'
import { issueSummary, readIssues } from '../chain/issues'
import { latestVersion, versionLabel } from '../chain/versions'
import { Registry, type ProjectEntry } from '../mcp/registry'
import { flatGraph } from '../graph3d/flat'

/**
 * The standalone dashboard: one long-running process that serves the built
 * web app and a READ-ONLY API over the project registry. It reads files
 * outside this repository, so it reads only registered chain paths, binds to
 * localhost, and never writes to a project. Its one write is to its own
 * registry: DELETE /api/projects/<name> forgets an entry whose chain file is
 * gone. Started once (`npm run dashboard`); tabs stay live while Claude Code
 * sessions come and go.
 */
export interface ProjectSummary extends ProjectEntry {
  exists: boolean
  rootId?: string
  rootClaim?: string
  rootSolid?: boolean
  /** every target on a multi-target chain, the main one first; absent on a legacy chain */
  targets?: { id: string; solid: boolean; frontier: number; nodes: number }[]
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
    const main = mainTarget(chain)
    const project = projectOf(chain)
    const front = new Set(frontier(g))
    const perTarget = targetsOf(chain).map((id) => {
      const cone = coneOf(g, id)
      return { id, solid: g.solid(id), frontier: [...cone].filter((n) => front.has(n)).length, nodes: cone.size }
    })
    return {
      ...entry,
      exists: true,
      rootId: main,
      rootClaim: g.node(main).content.split('\n')[0],
      rootSolid: g.solid(main),
      frontier: perTarget[0]!.frontier,
      ...(project !== null ? { targets: perTarget } : {}),
      events: chain.position,
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

/**
 * A write is taken only from this dashboard's own page: the Host must be a
 * loopback name (a rebound DNS name is not), and an Origin, when the browser
 * sends one, must be that same host. DELETE is not a simple method, so another
 * site's page is stopped at the preflight, which this server never grants.
 */
function sameLoopbackOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host ?? ''
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://${host}`
}

export function buildHandler(o: DashboardOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const staticRoot = o.staticDir ? resolve(o.staticDir) : null
  const handle = (req: IncomingMessage, res: ServerResponse): unknown => {
    let path: string
    let query: URLSearchParams
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      path = decodeURIComponent(url.pathname)
      query = url.searchParams
    } catch {
      return json(res, 400, { error: 'malformed path' })
    }
    // the one write: forget a registry entry whose chain file is gone. No project file is touched.
    if (req.method === 'DELETE' && path.startsWith('/api/projects/')) {
      if (!sameLoopbackOrigin(req)) return json(res, 403, { error: 'not from this dashboard' })
      const name = path.slice('/api/projects/'.length)
      const outcome = name.includes('/') ? 'unknown' : o.registry.forget(name)
      if (outcome === 'unknown') return json(res, 404, { error: `unknown project '${name}'` })
      if (outcome === 'present') return json(res, 409, { error: `'${name}' still has its chain file; only a missing project can be removed` })
      return json(res, 200, { removed: name })
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
    // the 3D view's data: one target's cone as nodes, arcs and arc tags, replayed here so the page carries no chain code
    if (path.startsWith('/api/graph/')) {
      const name = path.slice('/api/graph/'.length)
      const entry = name.includes('/') ? undefined : o.registry.find(name)
      if (!entry || !existsSync(entry.chain)) return json(res, 404, { error: `unknown project '${name}'` })
      let chain: EventChain
      try {
        chain = loadChain(entry)!
      } catch {
        return json(res, 404, { error: `'${name}' is registered but its file is not a chain` })
      }
      const flat = flatGraph(chain, entry.name, query.get('target') ?? undefined)
      if (flat === null) return json(res, 404, { error: `'${name}' has no such target` })
      return json(res, 200, flat)
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' })

    if (!staticRoot) return json(res, 404, { error: 'no web app built — run npm run build:dashboard' })
    // static asset if it exists under the build dir (contained); otherwise a shell — /, /p/<name>, /p/<name>/3d, /sandbox
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
    // /p/<name>/3d is the 3D view's own page; every other route is the app shell
    const shell = join(staticRoot, /^\/p\/[^/]+\/3d\/?$/.test(path) ? 'graph3d.html' : 'index.html')
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
