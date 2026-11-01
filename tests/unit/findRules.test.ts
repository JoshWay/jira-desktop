import { describe, expect, it } from 'vitest'
import { FIND_BAR_SIZE, findBarBounds, parseFindQuery, toFindResult } from '../../src/main/find/findRules'
import { MAX_FIND_TEXT_LENGTH, matchCountText } from '../../src/shared/find'

describe('parseFindQuery', () => {
  it('accepts a well-formed query and copies only its known fields', () => {
    expect(parseFindQuery({ text: 'apple', forward: true, newSession: true })).toEqual({ text: 'apple', forward: true, newSession: true })
    expect(parseFindQuery({ text: 'apple', forward: false, newSession: false, extra: 'x' })).toEqual({ text: 'apple', forward: false, newSession: false })
  })

  it('accepts empty text (it clears the search) and text up to the limit', () => {
    expect(parseFindQuery({ text: '', forward: true, newSession: true })).toEqual({ text: '', forward: true, newSession: true })
    const longest = 'a'.repeat(MAX_FIND_TEXT_LENGTH)
    expect(parseFindQuery({ text: longest, forward: true, newSession: false })?.text).toBe(longest)
  })

  it('refuses anything malformed', () => {
    for (const raw of [
      undefined,
      null,
      'apple',
      42,
      [],
      { text: 'a', forward: true },
      { text: 'a', newSession: true },
      { forward: true, newSession: true },
      { text: 1, forward: true, newSession: true },
      { text: 'a', forward: 'yes', newSession: true },
      { text: 'a', forward: true, newSession: 1 },
      { text: 'a'.repeat(MAX_FIND_TEXT_LENGTH + 1), forward: true, newSession: true }
    ]) {
      expect(parseFindQuery(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it('reads a hostile getter-laden object without throwing', () => {
    const hostile = { get text(): string { throw new Error('boom') }, forward: true, newSession: true }
    expect(parseFindQuery(hostile)).toBeNull()
  })
})

describe('toFindResult', () => {
  it('passes match counts through', () => {
    expect(toFindResult({ activeMatchOrdinal: 2, matches: 3 })).toEqual({ activeMatchOrdinal: 2, matches: 3 })
  })

  it('clamps missing, negative or non-integer values to zero, and the ordinal to the count', () => {
    expect(toFindResult({})).toEqual({ activeMatchOrdinal: 0, matches: 0 })
    expect(toFindResult({ activeMatchOrdinal: -1, matches: Number.NaN })).toEqual({ activeMatchOrdinal: 0, matches: 0 })
    expect(toFindResult({ activeMatchOrdinal: 1.5, matches: 2 })).toEqual({ activeMatchOrdinal: 0, matches: 2 })
    expect(toFindResult({ activeMatchOrdinal: 9, matches: 2 })).toEqual({ activeMatchOrdinal: 2, matches: 2 })
  })
})

describe('matchCountText', () => {
  it('shows "n of m" once there is a query', () => {
    expect(matchCountText({ activeMatchOrdinal: 1, matches: 3 }, true)).toBe('1 of 3')
    expect(matchCountText({ activeMatchOrdinal: 0, matches: 0 }, true)).toBe('No matches')
  })

  it('shows nothing without a query or a result', () => {
    expect(matchCountText({ activeMatchOrdinal: 0, matches: 0 }, false)).toBe('')
    expect(matchCountText(null, true)).toBe('')
  })
})

describe('findBarBounds', () => {
  it('sits at the top right of the content area', () => {
    expect(findBarBounds({ width: 1200, height: 900 })).toEqual({
      x: 1200 - FIND_BAR_SIZE.width - FIND_BAR_SIZE.margin,
      y: 0,
      width: FIND_BAR_SIZE.width,
      height: FIND_BAR_SIZE.height
    })
  })

  it('never goes off the left edge or wider than the content', () => {
    expect(findBarBounds({ width: 200, height: 30 })).toEqual({ x: 0, y: 0, width: 200, height: FIND_BAR_SIZE.height })
    expect(findBarBounds({ width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 0, height: FIND_BAR_SIZE.height })
  })
})
