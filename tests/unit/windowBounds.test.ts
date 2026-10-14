import { describe, expect, it } from 'vitest'
import { MIN_VISIBLE_PX, fitBoundsToDisplays, mainWindowPlacement } from '../../src/main/services/windowBounds'

const MIN = { width: 800, height: 600 }
const DEFAULT = { width: 1200, height: 900 }
// A laptop panel below the menu bar, and an external display to its left
const PRIMARY = { x: 0, y: 25, width: 1440, height: 875 }
const LEFT = { x: -1920, y: 0, width: 1920, height: 1080 }

describe('fitBoundsToDisplays', () => {
  it('keeps bounds that are fully on a display', () => {
    expect(fitBoundsToDisplays({ x: 100, y: 80, width: 1000, height: 700 }, [PRIMARY], MIN)).toEqual({ x: 100, y: 80, width: 1000, height: 700 })
  })

  it('keeps bounds on a secondary display at negative coordinates', () => {
    expect(fitBoundsToDisplays({ x: -1800, y: 40, width: 1200, height: 900 }, [PRIMARY, LEFT], MIN)).toEqual({ x: -1800, y: 40, width: 1200, height: 900 })
  })

  it('pulls partly off-screen bounds fully onto the display they overlap', () => {
    expect(fitBoundsToDisplays({ x: 1000, y: 500, width: 1000, height: 700 }, [PRIMARY], MIN)).toEqual({ x: 440, y: 200, width: 1000, height: 700 })
    // Above the work area (under the menu bar)
    expect(fitBoundsToDisplays({ x: 10, y: -200, width: 1000, height: 700 }, [PRIMARY], MIN)).toEqual({ x: 10, y: 25, width: 1000, height: 700 })
  })

  it('returns null for bounds on no display (a monitor that was unplugged)', () => {
    expect(fitBoundsToDisplays({ x: 5000, y: 100, width: 1000, height: 700 }, [PRIMARY], MIN)).toBeNull()
    expect(fitBoundsToDisplays({ x: -1800, y: 40, width: 1200, height: 900 }, [PRIMARY], MIN)).toBeNull()
    expect(fitBoundsToDisplays({ x: 100, y: 100, width: 1000, height: 700 }, [], MIN)).toBeNull()
  })

  it('returns null when only a sliver is visible', () => {
    const x = PRIMARY.width - (MIN_VISIBLE_PX - 1)
    expect(fitBoundsToDisplays({ x, y: 100, width: 1000, height: 700 }, [PRIMARY], MIN)).toBeNull()
    expect(fitBoundsToDisplays({ x: x - 1, y: 100, width: 1000, height: 700 }, [PRIMARY], MIN)).toEqual({ x: 440, y: 100, width: 1000, height: 700 })
    // The e2e harness parks windows at (-32000, 32000); macOS leaves a sliver of them on a display
    expect(fitBoundsToDisplays({ x: -32000, y: 32000, width: 1200, height: 900 }, [PRIMARY], MIN)).toBeNull()
  })

  it('shrinks bounds larger than the display to its work area', () => {
    expect(fitBoundsToDisplays({ x: -50, y: 0, width: 3000, height: 2000 }, [PRIMARY], MIN)).toEqual(PRIMARY)
  })

  it('grows bounds below the minimum size', () => {
    expect(fitBoundsToDisplays({ x: 100, y: 100, width: 300, height: 200 }, [PRIMARY], MIN)).toEqual({ x: 100, y: 100, width: 800, height: 600 })
  })

  it('uses the display with the larger overlap when bounds span two', () => {
    // 300px on LEFT, 900px on PRIMARY
    expect(fitBoundsToDisplays({ x: -300, y: 100, width: 1200, height: 700 }, [LEFT, PRIMARY], MIN)).toEqual({ x: 0, y: 100, width: 1200, height: 700 })
    // 900px on LEFT, 300px on PRIMARY
    expect(fitBoundsToDisplays({ x: -900, y: 100, width: 1200, height: 700 }, [PRIMARY, LEFT], MIN)).toEqual({ x: -1200, y: 100, width: 1200, height: 700 })
  })

  it('rejects malformed bounds and rounds fractional ones', () => {
    for (const bad of [
      { x: Number.NaN, y: 0, width: 1000, height: 700 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 1000, height: 700 },
      { x: 0, y: 0, width: 0, height: 700 },
      { x: 0, y: 0, width: 1000, height: -1 }
    ]) {
      expect(fitBoundsToDisplays(bad, [PRIMARY], MIN), JSON.stringify(bad)).toBeNull()
    }
    expect(fitBoundsToDisplays({ x: 100.4, y: 80.6, width: 1000.5, height: 700.2 }, [PRIMARY], MIN)).toEqual({ x: 100, y: 81, width: 1001, height: 700 })
  })
})

describe('mainWindowPlacement', () => {
  it('uses the default centered size when nothing is saved', () => {
    expect(mainWindowPlacement(undefined, [PRIMARY], DEFAULT, MIN)).toEqual({ options: { width: 1200, height: 900, center: true }, maximize: false })
  })

  it('restores visible saved bounds and the maximized state', () => {
    const bounds = { x: 100, y: 80, width: 1000, height: 700 }
    expect(mainWindowPlacement({ bounds, isMaximized: false }, [PRIMARY], DEFAULT, MIN)).toEqual({ options: bounds, maximize: false })
    expect(mainWindowPlacement({ bounds, isMaximized: true }, [PRIMARY], DEFAULT, MIN)).toEqual({ options: bounds, maximize: true })
  })

  it('falls back to the default centered size for off-screen bounds, keeping maximized', () => {
    const bounds = { x: 5000, y: 80, width: 1000, height: 700 }
    expect(mainWindowPlacement({ bounds, isMaximized: true }, [PRIMARY], DEFAULT, MIN)).toEqual({ options: { width: 1200, height: 900, center: true }, maximize: true })
  })
})
