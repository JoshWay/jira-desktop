// Where an app-owned page (src/renderer/<file>) is loaded from: the built file, or the
// electron-vite dev server's copy under `npm run dev` (never when packaged). Every such URL must
// also be registered with registerLocalPage (webContentsPolicy.ts).
import { app } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'

export function localPageUrl(file: string): string {
  const devServer = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  if (devServer) return new URL(file, devServer.endsWith('/') ? devServer : `${devServer}/`).href
  return pathToFileURL(join(__dirname, '../renderer', file)).href
}
