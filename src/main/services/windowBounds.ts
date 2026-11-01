// Where the main window opens (spec R3): saved bounds are kept only while enough of them is on a
// display that still exists, and are then pulled fully onto it. Pure (no electron imports): main
// passes in screen.getAllDisplays()' work areas.
// codex:run npm test -- tests/unit/windowBounds.test.ts
import type { MainWindowState, WindowBounds } from './settings'

export interface WindowSize {
  width: number
  height: number
}

// Less of the window than this on a display (in either direction) counts as off-screen
export const MIN_VISIBLE_PX = 64

function overlap(start: number, length: number, areaStart: number, areaLength: number): number {
  return Math.max(0, Math.min(start + length, areaStart + areaLength) - Math.max(start, areaStart))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// The bounds moved and resized to sit wholly inside the work area they overlap most, or null when
// they are malformed or no display shows at least MIN_VISIBLE_PX of them both ways. Bounds below
// minSize grow to it; bounds larger than the work area shrink to it.
export function fitBoundsToDisplays(bounds: WindowBounds, workAreas: readonly WindowBounds[], minSize: WindowSize): WindowBounds | null {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null
  const [x, y, width, height] = values.map(Math.round)

  let best: WindowBounds | null = null
  let bestArea = 0
  for (const area of workAreas) {
    const visibleWidth = overlap(x, width, area.x, area.width)
    const visibleHeight = overlap(y, height, area.y, area.height)
    if (visibleWidth < MIN_VISIBLE_PX || visibleHeight < MIN_VISIBLE_PX) continue
    if (visibleWidth * visibleHeight > bestArea) {
      best = area
      bestArea = visibleWidth * visibleHeight
    }
  }
  if (!best) return null

  const fittedWidth = Math.min(Math.max(width, minSize.width), best.width)
  const fittedHeight = Math.min(Math.max(height, minSize.height), best.height)
  return {
    x: clamp(x, best.x, best.x + best.width - fittedWidth),
    y: clamp(y, best.y, best.y + best.height - fittedHeight),
    width: fittedWidth,
    height: fittedHeight
  }
}

export interface MainWindowPlacement {
  // BrowserWindow constructor options
  options: WindowBounds | (WindowSize & { center: true })
  maximize: boolean
}

// Saved bounds that still fit a display, else the default size centered. A saved maximized state
// is restored either way (it maximizes on whichever display the window opens on).
// codex:run npm test -- tests/unit/windowBounds.test.ts
export function mainWindowPlacement(
  saved: MainWindowState | undefined,
  workAreas: readonly WindowBounds[],
  defaultSize: WindowSize,
  minSize: WindowSize
): MainWindowPlacement {
  const fitted = saved ? fitBoundsToDisplays(saved.bounds, workAreas, minSize) : null
  return {
    options: fitted ?? { width: defaultSize.width, height: defaultSize.height, center: true },
    maximize: saved?.isMaximized ?? false
  }
}
