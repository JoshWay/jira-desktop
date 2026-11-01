import { basename, join } from 'path'

// Where the app's resources/ folder is. Packaged, electron-builder's extraResources copies it to
// <process.resourcesPath>/resources (outside app.asar); otherwise it is <app path>/resources, the
// repo's own folder (npm run dev, e2e).
export interface IconLocation {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

export const APP_ICON_FILE = 'icon.png'

// codex:run npm test -- tests/unit/appIcon.test.ts
export function resourcesDir(location: IconLocation): string {
  return location.isPackaged ? join(location.resourcesPath, 'resources') : join(location.appPath, 'resources')
}

// codex:run npm test -- tests/unit/appIcon.test.ts
export function appIconPath(location: IconLocation): string {
  return join(resourcesDir(location), APP_ICON_FILE)
}

// A product's own icon from resources/ when it exists there, else the app icon. Only the file
// name is used, so a name can never point outside resources/.
// codex:run npm test -- tests/unit/appIcon.test.ts
export function productIconPath(location: IconLocation, iconFile: string, exists: (path: string) => boolean): string {
  const name = basename(iconFile)
  if (!name || name === '.' || name === '..') return appIconPath(location)
  const candidate = join(resourcesDir(location), name)
  return exists(candidate) ? candidate : appIconPath(location)
}
