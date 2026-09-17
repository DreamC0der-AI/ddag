import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../../kernel/types'
import shape from './ddag-shape.json'
import { NODE_R, forceLayout, layoutDefects } from '../layout'

const snapOf = (root: string, ids: string[], arcs: { from: string; to: string }[]): Snapshot => ({
  root,
  nodes: ids.map((id) => ({ id, content: id, version: 0, verdict: 'pending' as const, fingerprint: null })),
  arcs,
})
const fixture = snapOf(shape.root, shape.nodes, shape.arcs)
const dist = (p: { x: number; y: number }) => Math.hypot(p.x, p.y)

/** Two adjacent hubs under one root, each with many parts, plus parts shared between them and with the root. */
const hubs = (): Snapshot => {
  const ids = ['root', 'A', 'B']
  const arcs = [
    { from: 'A', to: 'root' },
    { from: 'B', to: 'root' },
  ]
  for (let i = 0; i < 9; i++) {
    ids.push(`a${i}`)
    arcs.push({ from: `a${i}`, to: 'A' })
  }
  for (let i = 0; i < 6; i++) {
    ids.push(`b${i}`)
    arcs.push({ from: `b${i}`, to: 'B' })
  }
  arcs.push({ from: 'a0', to: 'B' }, { from: 'b0', to: 'A' }, { from: 'a1', to: 'root' }) // shared parts
  for (let i = 0; i < 4; i++) {
    ids.push(`d${i}`)
    arcs.push({ from: `d${i}`, to: 'a2' })
  }
  return snapOf('root', ids, arcs)
}

describe('graph layout — depth rings, arcs as obstacles (src/playground/layout.ts)', () => {
  it("this repository's own build cone, 58 claims: no arc through a foreign claim, no two claims overlapping", () => {
    const centers = forceLayout(fixture, new Map())
    expect(layoutDefects(fixture, centers)).toEqual({ arcThroughNode: 0, nodeOverlap: 0 })
  })

  it('grown one claim at a time, as the live view sees it, the picture stays clean', () => {
    let prev = new Map<string, { x: number; y: number }>()
    const seen: string[] = []
    for (const id of shape.nodes) {
      seen.push(id)
      const sub = snapOf(shape.root, seen, shape.arcs.filter((a) => seen.includes(a.from) && seen.includes(a.to)))
      prev = forceLayout(sub, prev)
    }
    expect(layoutDefects(fixture, prev)).toEqual({ arcThroughNode: 0, nodeOverlap: 0 })
  })

  it('two adjacent hubs with shared parts: still none', () => {
    const g = hubs()
    expect(layoutDefects(g, forceLayout(g, new Map()))).toEqual({ arcThroughNode: 0, nodeOverlap: 0 })
  })

  it('every arc points inward: a part sits farther from the root than the whole it supports', () => {
    for (const g of [fixture, hubs()]) {
      const c = forceLayout(g, new Map())
      for (const a of g.arcs) expect(dist(c.get(a.from)!), `${a.from}->${a.to}`).toBeGreaterThan(dist(c.get(a.to)!))
    }
  })

  it('is deterministic, and the root sits at the centre', () => {
    const one = forceLayout(fixture, new Map())
    const two = forceLayout(fixture, new Map())
    expect([...one]).toEqual([...two])
    expect(one.get('ddag')).toEqual({ x: 0, y: 0 })
  })

  it('a pinned claim holds its position, and the picture around it is still clean', () => {
    const pin = new Map([['evidence', { x: 420, y: -60 }]])
    const c = forceLayout(fixture, new Map(), pin)
    expect(c.get('evidence')).toEqual({ x: 420, y: -60 })
    expect(layoutDefects(fixture, c).nodeOverlap).toBe(0)
    expect(layoutDefects(fixture, c).arcThroughNode).toBeLessThanOrEqual(1) // a pin can force an arc across; the free claims still move off it
  })

  it('adding one claim moves the others by less than a radius on average', () => {
    const before = forceLayout(fixture, new Map())
    const grown = snapOf(shape.root, [...shape.nodes, 'new-claim'], [...shape.arcs, { from: 'new-claim', to: 'evidence' }])
    const after = forceLayout(grown, before)
    const moves = shape.nodes.map((id) => Math.hypot(after.get(id)!.x - before.get(id)!.x, after.get(id)!.y - before.get(id)!.y))
    const mean = moves.reduce((a, b) => a + b, 0) / moves.length
    expect(mean).toBeLessThan(NODE_R)
    expect(layoutDefects(grown, after)).toEqual({ arcThroughNode: 0, nodeOverlap: 0 })
  })
})
