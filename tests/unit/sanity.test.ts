import { describe, expect, it } from 'vitest'

describe('unit test harness', () => {
  it('runs in a node environment', () => {
    expect(typeof window).toBe('undefined')
    expect(process.versions.node).toMatch(/^\d+\./)
  })
})
