import type { ChainOp } from './chain'

/** DESIGN.md operation notation. */
export function opNotation(op: ChainOp): string {
  switch (op.type) {
    case 'issue':
      return op.action === 'open' ? `Issue(${op.key})` : `Close(${op.key})=${op.outcome}`
    case 'version':
      return `Version(${op.name})`
    case 'round':
      return `Round(${op.key})`
    case 'add':
      return `Add(${op.id})`
    case 'link':
      return `Link(${op.from}->${op.to})`
    case 'unlink':
      return `Unlink(${op.from}||${op.to})`
    case 'mutate':
      return `Mutate(${op.id})`
    case 'verify':
      return `Verify(${op.id})=${op.result}`
    case 'doubt':
      return `Doubt(${op.id})`
  }
}

/** DESIGN.md short notation, for compact display. */
export function opShort(op: ChainOp): string {
  switch (op.type) {
    case 'issue':
      return op.action === 'open' ? `!${op.key}` : `${op.key}${op.outcome === 'fixed' ? '✓' : '–'}`
    case 'version':
      return `⚑${op.name}`
    case 'round':
      return `◆${op.key}`
    case 'add':
      return `+${op.id}`
    case 'link':
      return `${op.from}->${op.to}`
    case 'unlink':
      return `${op.from}||${op.to}`
    case 'mutate':
      return `${op.id}*`
    case 'verify':
      return op.result === 'valid' ? `${op.id}✓` : `${op.id}✗`
    case 'doubt':
      return `${op.id}?`
  }
}
