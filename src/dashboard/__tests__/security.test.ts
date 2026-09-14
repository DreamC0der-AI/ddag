import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Registry } from '../../mcp/registry'
import { McpStore } from '../../mcp/store'
import { startDashboard } from '../server'

const scratch = () => mkdtempSync(join(tmpdir(), 'ddag-sec-'))

describe('security: the dashboard on hostile input', () => {
  let server: Server
  let base: string
  beforeAll(async () => {
    const registry = new Registry(join(scratch(), 'projects.json'))
    const dir = join(scratch(), 'alpha')
    mkdirSync(dir)
    const store = new McpStore(join(dir, 'ddag.json'), dir, (f) => registry.register(f))
    store.dispatch({ type: 'add', id: 'x', content: 'x', successor: 'target' })
    const notes = join(scratch(), 'notes')
    mkdirSync(notes)
    writeFileSync(join(notes, 'ddag.json'), 'SECRET NOTES, not a chain\n')
    registry.register(join(notes, 'ddag.json'))
    const dirproj = join(scratch(), 'dirproj')
    mkdirSync(join(dirproj, 'ddag.json'), { recursive: true }) // a registered path that is a directory
    registry.register(join(dirproj, 'ddag.json'))
    const staticDir = scratch()
    mkdirSync(join(staticDir, 'assets'))
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shell</title>')
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)')
    const outside = join(scratch(), 'outside.txt')
    writeFileSync(outside, 'OUTSIDE THE BUILD DIR')
    symlinkSync(outside, join(staticDir, 'assets', 'link.txt'))
    server = await startDashboard({ registry, staticDir, port: 0 })
    const addr = server.address() as { port: number }
    base = `http://127.0.0.1:${addr.port}`
  })
  afterAll(() => server.close())

  it('sec-static: traversal, encoded traversal and absolute paths never leave the build dir', async () => {
    for (const p of ['/../package.json', '/assets/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '//etc/passwd', '/assets/%2e%2e/index.html']) {
      const r = await fetch(`${base}${p}`)
      const body = await r.text()
      expect([200, 404]).toContain(r.status)
      expect(body).not.toContain('root:')
      expect(body).not.toContain('"name"')
    }
  })

  it('sec-static: a symlink planted in the build dir does not serve the file it points at', async () => {
    const r = await fetch(`${base}/assets/link.txt`)
    expect(await r.text()).not.toContain('OUTSIDE THE BUILD DIR')
  })

  it('sec-chain-route: names with slashes, encoding or other case select nothing', async () => {
    for (const n of ['alpha%2F..%2Fprojects.json', 'ALPHA', 'alpha/', '..', 'alpha%00']) {
      expect((await fetch(`${base}/api/chain/${n}`)).status).toBe(404)
      expect((await fetch(`${base}/api/audit/${n}`)).status).toBe(404)
    }
  })

  it('sec-chain-route: a registry entry that is not a chain is refused, its bytes never served', async () => {
    const chain = await fetch(`${base}/api/chain/notes`)
    expect(await chain.text()).not.toContain('SECRET NOTES')
    expect(chain.status).toBe(404)
    expect((await fetch(`${base}/api/audit/notes`)).status).toBe(404)
  })

  it('sec-robust: a malformed percent-escape is answered 400 and the server keeps serving', async () => {
    const bad = await fetch(`${base}/api/chain/%E0%A4%A`)
    expect(bad.status).toBe(400)
    const next = await fetch(`${base}/api/projects`)
    expect(next.status).toBe(200)
  })

  it('sec-chain-route: /api/projects never echoes a registered non-chain file\'s bytes in its error text', async () => {
    const body = await (await fetch(`${base}/api/projects`)).text()
    expect(body).not.toContain('SECRET')
    expect(body).toContain('not a chain')
  })

  it('sec-robust / sec-chain-route: an unparsable request target is 400, a registered directory is 404 on both routes', async () => {
    const { connect } = await import('node:net')
    const port = (server.address() as { port: number }).port
    const status = await new Promise<string>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
      sock.once('data', (d) => {
        resolve(d.toString().split(' ')[1] ?? '')
        sock.destroy()
      })
    })
    expect(status).toBe('400')
    expect((await fetch(`${base}/api/chain/dirproj`)).status).toBe(404)
    expect((await fetch(`${base}/api/audit/dirproj`)).status).toBe(404)
  })

  it('sec-read-only: every method but GET and HEAD is refused on every route, and the bind is loopback', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const route of ['/api/projects', '/api/chain/alpha', '/api/audit/alpha', '/', '/assets/app.js']) {
        expect((await fetch(`${base}${route}`, { method })).status).toBe(405)
      }
    }
    expect((server.address() as { address: string }).address).toBe('127.0.0.1')
  })
})
