import { resolve } from 'path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/main/main.ts')
        }
      }
    }
  },
  // Per-window preloads for local pages only (sandboxed, so each is one self-contained CJS file)
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          dialog: resolve(__dirname, 'src/preload/dialog.ts'),
          find: resolve(__dirname, 'src/preload/find.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          dialog: resolve(__dirname, 'src/renderer/dialog.html'),
          // The find bar, overlaid on a content window (src/main/find/FindBarController.ts)
          find: resolve(__dirname, 'src/renderer/find.html'),
          // Static, script-free page the main window shows while no site is loaded
          placeholder: resolve(__dirname, 'src/renderer/placeholder.html')
        }
      }
    }
  }
})
