import { contextBridge, ipcRenderer } from 'electron'

// Custom APIs for renderer
const electronAPI = {
  // Theme management
  getTheme: () => ipcRenderer.invoke('get-theme'),
  onThemeChanged: (callback: (theme: string) => void) => {
    ipcRenderer.on('theme-changed', (_, theme) => callback(theme))
  },

  // Jira URL management
  setJiraUrl: (url: string) => ipcRenderer.invoke('set-jira-url', url),

  // Multi-window management
  showContextMenu: (params: any) => ipcRenderer.invoke('show-context-menu', params),

  // System info
  platform: process.platform,
  versions: process.versions
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Types for the exposed API
declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}