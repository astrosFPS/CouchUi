const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  launchTile: (tileId) => ipcRenderer.invoke('launch-tile', tileId),
  listWaydroidApps: () => ipcRenderer.invoke('list-waydroid-apps'),
  launchWaydroidApp: (packageName) => ipcRenderer.invoke('launch-waydroid-app', packageName),
  powerAction: (action) => ipcRenderer.invoke('power-action', action),
  logError: (source, message) => ipcRenderer.invoke('log-error', { source, message }),
  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  onSettingsUpdated: (callback) => {
    ipcRenderer.on('settings-updated', (event, data) => callback(data));
  },
  spotify: {
    isAuthed: () => ipcRenderer.invoke('spotify-is-authed'),
    login: () => ipcRenderer.invoke('spotify-login'),
    logout: () => ipcRenderer.invoke('spotify-logout'),
    getHome: () => ipcRenderer.invoke('spotify-get-home'),
    play: (uri) => ipcRenderer.invoke('spotify-play', uri),
    search: (query) => ipcRenderer.invoke('spotify-search', query),
    getState: () => ipcRenderer.invoke('spotify-get-state'),
    toggle: () => ipcRenderer.invoke('spotify-toggle'),
    next: () => ipcRenderer.invoke('spotify-next'),
    previous: () => ipcRenderer.invoke('spotify-previous'),
    togglePin: (playlistId) => ipcRenderer.invoke('spotify-toggle-pin', playlistId),
  },
});
