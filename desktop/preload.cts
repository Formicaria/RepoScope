import { contextBridge, ipcRenderer } from 'electron'

/**
 * The bridge between the window and the desktop shell.
 *
 * Everything here is a named request the main process answers. The renderer gets no
 * filesystem, no child processes and no arbitrary IPC channel — if a future feature needs
 * something from the host, it gets its own method here and a handler that validates its
 * input, rather than a general-purpose escape hatch.
 */
contextBridge.exposeInMainWorld('reposcope', {
  desktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  licence: {
    status: () => ipcRenderer.invoke('licence:status'),
    set: (key: string) => ipcRenderer.invoke('licence:set', key),
  },
  updates: {
    setMode: (mode: 'off' | 'notify' | 'auto') => ipcRenderer.invoke('update:mode', mode),
    check: () => ipcRenderer.invoke('update:check'),
    openReleases: () => ipcRenderer.invoke('app:open-releases'),
  },
})
