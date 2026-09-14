import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Registry } from '../registry'
import { McpStore } from '../store'

const scratch = () => mkdtempSync(join(tmpdir(), 'ddag-reg-'))

describe('project registry', () => {
  it('registers by chain path, dedupes with a refreshed timestamp, names by folder', async () => {
    const home = scratch()
    const reg = new Registry(join(home, 'projects.json'))
    const proj = join(scratch(), 'shop')
    mkdirSync(proj)
    const chain = join(proj, 'ddag.json')
    const first = reg.register(chain)
    expect(first.name).toBe('shop')
    expect(first.dir).toBe(proj)
    await new Promise((r) => setTimeout(r, 5))
    const again = reg.register(chain)
    expect(reg.read()).toHaveLength(1)
    expect(again.name).toBe('shop')
    expect(again.lastSeen >= first.lastSeen).toBe(true)
  })

  it('two folders both named app register as app and app-2', () => {
    const reg = new Registry(join(scratch(), 'projects.json'))
    const a = join(scratch(), 'app')
    const b = join(scratch(), 'app')
    mkdirSync(a)
    mkdirSync(b)
    expect(reg.register(join(a, 'ddag.json')).name).toBe('app')
    expect(reg.register(join(b, 'ddag.json')).name).toBe('app-2')
    expect(reg.find('app-2')?.dir).toBe(b)
    expect(reg.find('nope')).toBeUndefined()
  })

  it('a corrupt registry file reads as empty and is overwritten on the next register', () => {
    const file = join(scratch(), 'projects.json')
    writeFileSync(file, '{ not json')
    const reg = new Registry(file)
    expect(reg.read()).toEqual([])
    reg.register(join(scratch(), 'x', 'ddag.json'))
    expect(JSON.parse(readFileSync(file, 'utf8')).projects).toHaveLength(1)
  })

  it('the store registers on loading an existing chain and on the first write of a new one', () => {
    const reg = new Registry(join(scratch(), 'projects.json'))
    const hook = (f: string) => reg.register(f)
    const dir = scratch()
    const fresh = join(dir, 'ddag.json')
    const store = new McpStore(fresh, dir, hook)
    expect(reg.read()).toHaveLength(0) // nothing on disk yet — nothing to register
    store.dispatch({ type: 'add', id: 'a', content: 'first claim', successor: 'target' })
    expect(reg.read().map((p) => p.chain)).toEqual([fresh])
    // a second store opening the now-existing file registers on load
    new McpStore(fresh, dir, hook)
    expect(reg.read()).toHaveLength(1)
  })
})
