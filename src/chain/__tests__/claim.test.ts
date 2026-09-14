import { describe, expect, it } from 'vitest'
import { composeClaim, parseClaim } from '../claim'

describe('claim content convention', () => {
  it('composes and parses claim + criterion; a bare claim has no criterion', () => {
    const c = composeClaim('  the lexer is correct ', ' unit tests over every token class pass ')
    expect(c).toBe('the lexer is correct\nVerify: unit tests over every token class pass')
    expect(parseClaim(c)).toEqual({ claim: 'the lexer is correct', criterion: 'unit tests over every token class pass' })
    expect(parseClaim('just a claim')).toEqual({ claim: 'just a claim', criterion: null })
    expect(composeClaim('x', '')).toBe('x')
    expect(parseClaim('x\nVerify:   ')).toEqual({ claim: 'x', criterion: null })
  })

  it('a multi-line claim keeps its lines; the marker is case-insensitive', () => {
    const c = 'line one\nline two\nverify: by argument'
    expect(parseClaim(c)).toEqual({ claim: 'line one\nline two', criterion: 'by argument' })
  })
})
