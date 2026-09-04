const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getStorage: () => ipcRenderer.invoke('get-storage'),

  wifiStatus: () => ipcRenderer.invoke('wifi-status'),
  wifiToggle: (enabled) => ipcRenderer.invoke('wifi-toggle', enabled),
  wifiList: () => ipcRenderer.invoke('wifi-list'),
  wifiConnect: (ssid, password) => ipcRenderer.invoke('wifi-connect', { ssid, password }),

  btStatus: () => ipcRenderer.invoke('bt-status'),
  btToggle: (enabled) => ipcRenderer.invoke('bt-toggle', enabled),
  btScan: () => ipcRenderer.invoke('bt-scan'),
  btConnect: (mac) => ipcRenderer.invoke('bt-connect', mac),

  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),

  setBackground: (background) => ipcRenderer.invoke('set-background', background),
  setBackgroundColor: (color) => ipcRenderer.invoke('set-background-color', color),
  chooseBackgroundImage: () => ipcRenderer.invoke('choose-background-image'),
  chooseSlideshowImages: () => ipcRenderer.invoke('choose-slideshow-images'),
  removeSlideshowImage: (imagePath) => ipcRenderer.invoke('remove-slideshow-image', imagePath),
  setSlideshowTiming: (timing) => ipcRenderer.invoke('set-slideshow-timing', timing),
  clearBackground: () => ipcRenderer.invoke('clear-background'),

  setFont: (font) => ipcRenderer.invoke('set-font', font),
  chooseCustomFont: () => ipcRenderer.invoke('choose-custom-font'),

  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  setAutoUpdate: (enabled) => ipcRenderer.invoke('set-auto-update', enabled),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  listTimezones: () => ipcRenderer.invoke('list-timezones'),
  setLocation: (location) => ipcRenderer.invoke('set-location', location),
  setWeatherDisplay: (weather) => ipcRenderer.invoke('set-weather-display', weather),
  setWeatherLocation: (loc) => ipcRenderer.invoke('set-weather-location', loc),
  getConfig: () => ipcRenderer.invoke('get-config'),
});
