const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const settingsStore = require('./store');
const spotify = require('./spotify');
const updater = require('./updater');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(__dirname, 'config.example.json');
const ERROR_LOG_PATH = path.join(__dirname, 'error.log');

// config.json holds your Spotify client ID and weather location, so it's
// kept out of git (see .gitignore) and config.example.json is committed in
// its place. On a fresh clone there's no config.json yet, so seed one from
// the example — otherwise the app would have nothing to read.
function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return;
  try {
    fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
  } catch (err) {
    console.error('Failed to create config.json from config.example.json:', err.message);
  }
}
ensureConfigExists();

// Running inside a VM (VMware, VirtualBox, etc.) commonly has no real
// VAAPI-capable GPU exposed to it, which spams "vaInitialize failed"
// warnings on every launch and can make Chromium's GPU process flaky.
// CouchUI itself doesn't need hardware-accelerated video — VLC/Kodi run
// as their own separate processes and handle their own decoding — so it's
// safe to just turn it off here. Remove these two lines if you later run
// on bare metal with a real GPU and want Electron's own UI to use it.
app.disableHardwareAcceleration();
// disableHardwareAcceleration() above stops Chromium's GPU compositor, but
// VAAPI hardware video decode/encode is a separate feature that still
// probes for a GPU on startup regardless — that's what's still printing
// "vaInitialize failed" even with the line above in place. This turns
// that specific feature off so the probe never runs at all.
app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder');

// ===================== Error log =====================
// Every operational failure (failed launches, Waydroid/Spotify/Wi-Fi/BT
// errors, etc.) is appended here instead of being dumped on screen. See
// Troubleshooting in DOCUMENTATION.md.
function logError(source, message) {
  const line = `[${new Date().toISOString()}] [${source}] ${message}\n`;
  try {
    fs.appendFileSync(ERROR_LOG_PATH, line);
  } catch (err) {
    // If we can't even write the log, this is the one case that still
    // goes to the terminal.
    console.error('Failed to write error.log:', err.message);
  }
  console.error(line.trim());
}

process.on('uncaughtException', (err) => {
  logError('main-uncaught', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  logError('main-unhandled-rejection', reason instanceof Error ? (reason.stack || reason.message) : String(reason));
});

ipcMain.handle('log-error', (event, { source, message } = {}) => {
  logError(source || 'renderer', message || 'Unknown error');
  return { ok: true };
});

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    logError('load-config', err.message);
    return { weather: {}, tiles: [] };
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    backgroundColor: '#14161C',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Escape key is the documented "break glass" exit — useful while you're
  // setting this up. Remove the accelerator in production if you want it
  // truly locked down.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape' && input.type === 'keyDown') {
      mainWindow.setKiosk(false);
      mainWindow.setFullScreen(false);
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  scheduleAutoUpdateChecks();
});

app.on('window-all-closed', () => {
  app.quit();
});

// ===================== Settings window =====================
let settingsWindow = null;

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 520,
    title: 'Settings',
    backgroundColor: '#14161C',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings', 'index.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

ipcMain.handle('open-settings', () => {
  createSettingsWindow();
  return { ok: true };
});

function broadcastSettings(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-updated', data);
  }
}

ipcMain.handle('get-app-settings', () => settingsStore.load());

ipcMain.handle('set-theme', (event, theme) => {
  const data = settingsStore.load();
  data.theme = theme === 'light' ? 'light' : 'dark';
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('set-background', (event, background) => {
  const data = settingsStore.load();
  data.background = {
    ...data.background,
    ...background,
    slideshow: { ...data.background.slideshow, ...background?.slideshow },
  };
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('set-background-color', (event, color) => {
  const data = settingsStore.load();
  data.background.mode = 'color';
  data.background.color = color;
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('choose-background-image', async () => {
  const result = await dialog.showOpenDialog(settingsWindow, {
    title: 'Choose a background image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const data = settingsStore.load();
  data.background.mode = 'image';
  data.background.image = result.filePaths[0];
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('choose-slideshow-images', async () => {
  const result = await dialog.showOpenDialog(settingsWindow, {
    title: 'Choose slideshow images',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const data = settingsStore.load();
  data.background.mode = 'slideshow';
  data.background.slideshow.images = [...data.background.slideshow.images, ...result.filePaths];
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('remove-slideshow-image', (event, imagePath) => {
  const data = settingsStore.load();
  data.background.slideshow.images = data.background.slideshow.images.filter((p) => p !== imagePath);
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('set-slideshow-timing', (event, { intervalSeconds, fadeSeconds } = {}) => {
  const data = settingsStore.load();
  if (intervalSeconds != null) data.background.slideshow.intervalSeconds = Math.max(1, Number(intervalSeconds) || 15);
  if (fadeSeconds != null) data.background.slideshow.fadeSeconds = Math.max(0, Number(fadeSeconds) || 2);
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('clear-background', () => {
  const data = settingsStore.load();
  data.background.mode = 'theme';
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('set-font', (event, font) => {
  const data = settingsStore.load();
  data.font = { ...data.font, ...font };
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('choose-custom-font', async () => {
  const result = await dialog.showOpenDialog(settingsWindow, {
    title: 'Choose a font file',
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const filePath = result.filePaths[0];
  const baseName = path.basename(filePath, path.extname(filePath));
  const data = settingsStore.load();
  data.font.family = 'custom';
  data.font.customPath = filePath;
  data.font.customName = `Custom ${baseName}`;
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

// ===================== Updates =====================
// The actual check is a stub for now — see updater.js. Everything here
// (manual check, the auto-check toggle, and its schedule) is fully wired
// and ready for whenever that stub is filled in.
const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
let autoUpdateTimer = null;

function scheduleAutoUpdateChecks() {
  clearInterval(autoUpdateTimer);
  autoUpdateTimer = null;
  const data = settingsStore.load();
  if (!data.updates.autoCheck) return;
  autoUpdateTimer = setInterval(async () => {
    try {
      const result = await updater.checkForUpdate();
      const d = settingsStore.load();
      d.updates.lastChecked = result.checkedAt;
      settingsStore.save(d);
      broadcastSettings(d);
    } catch (err) {
      logError('auto-update-check', err.message);
    }
  }, AUTO_UPDATE_CHECK_INTERVAL_MS);
}

ipcMain.handle('get-app-version', () => app.getVersion());

// ===================== Location & weather display =====================
// A curated set rather than the full ~418-zone IANA list — that's far more
// than anyone scrolls through, and most entries are duplicates of the same
// offset and rules. These cover the major population centres and every
// commonly used offset. DST still comes from Intl's own database, so a zone
// like Pacific/Auckland shifts on its own at the right dates.
// Add to this list to support somewhere that isn't covered.
const COMMON_TIMEZONES = [
  'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Fiji',
  'Australia/Sydney', 'Australia/Brisbane', 'Australia/Adelaide',
  'Australia/Darwin', 'Australia/Perth',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong',
  'Asia/Singapore', 'Asia/Manila', 'Asia/Jakarta', 'Asia/Bangkok',
  'Asia/Kolkata', 'Asia/Karachi', 'Asia/Dubai', 'Asia/Tehran',
  'Asia/Jerusalem', 'Europe/Istanbul', 'Europe/Moscow',
  'Africa/Cairo', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Johannesburg',
  'Europe/Athens', 'Europe/Helsinki', 'Europe/Berlin', 'Europe/Paris',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm',
  'Europe/Warsaw', 'Europe/Lisbon', 'Europe/London', 'Europe/Dublin',
  'Atlantic/Reykjavik', 'UTC',
  'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Santiago',
  'America/Bogota', 'America/Lima', 'America/New_York', 'America/Toronto',
  'America/Chicago', 'America/Mexico_City', 'America/Denver',
  'America/Phoenix', 'America/Los_Angeles', 'America/Vancouver',
  'America/Anchorage', 'Pacific/Honolulu',
];

ipcMain.handle('list-timezones', () => ({ ok: true, zones: COMMON_TIMEZONES }));

ipcMain.handle('set-location', (event, location) => {
  const data = settingsStore.load();
  data.location = { ...data.location, ...location };
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

ipcMain.handle('set-weather-display', (event, weather) => {
  const data = settingsStore.load();
  data.weather = { ...data.weather, ...weather };
  settingsStore.save(data);
  broadcastSettings(data);
  return { ok: true, data };
});

// Geocoding runs in the settings renderer, not here. Main-process fetch
// uses Node's network stack rather than Chromium's, so it doesn't pick up
// the same proxy/DNS configuration and can fail with a bare "fetch failed"
// on setups where the renderer reaches the network fine. The weather
// lookup already fetches from the renderer for the same reason.

// The weather location lives in config.json (it's a tile-level concern like
// the rest of that file), so this writes there rather than app-settings.
ipcMain.handle('set-weather-location', (event, { latitude, longitude, locationName }) => {
  try {
    const config = loadConfig();
    config.weather = { ...config.weather, latitude, longitude, locationName };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    if (mainWindow) mainWindow.webContents.send('config-updated', config);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('check-for-update', async () => {
  try {
    const result = await updater.checkForUpdate();
    const data = settingsStore.load();
    data.updates.lastChecked = result.checkedAt;
    settingsStore.save(data);
    broadcastSettings(data);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-auto-update', (event, enabled) => {
  const data = settingsStore.load();
  data.updates.autoCheck = !!enabled;
  settingsStore.save(data);
  broadcastSettings(data);
  scheduleAutoUpdateChecks();
  return { ok: true, data };
});

// ===================== System info (Info pane) =====================
function cpuSnapshot() {
  return os.cpus().map((c) => ({ ...c.times }));
}

function getCpuUsagePercent() {
  return new Promise((resolve) => {
    const start = cpuSnapshot();
    setTimeout(() => {
      const end = cpuSnapshot();
      let idleDelta = 0;
      let totalDelta = 0;
      start.forEach((core, i) => {
        const endCore = end[i];
        const idle = endCore.idle - core.idle;
        const total = Object.keys(endCore).reduce(
          (sum, k) => sum + (endCore[k] - core[k]), 0
        );
        idleDelta += idle;
        totalDelta += total;
      });
      const usage = totalDelta > 0 ? 100 * (1 - idleDelta / totalDelta) : 0;
      resolve(Math.round(usage));
    }, 200);
  });
}

function getPrimaryIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'Not connected';
}

ipcMain.handle('get-system-info', async () => {
  const cpus = os.cpus();
  const cpuUsage = await getCpuUsagePercent();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    ok: true,
    ip: getPrimaryIPv4(),
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model?.trim() || 'Unknown CPU',
    cpuCores: cpus.length,
    cpuUsage,
    ramTotalGB: (totalMem / 1024 ** 3).toFixed(1),
    ramUsedGB: ((totalMem - freeMem) / 1024 ** 3).toFixed(1),
  };
});

// ===================== Storage pane =====================
ipcMain.handle('get-storage', async () => {
  try {
    const { stdout } = await execFileAsync('df', [
      '-h', '--output=source,target,size,used,avail,pcent',
      '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay',
    ]);
    const lines = stdout.trim().split('\n').slice(1); // drop header
    const volumes = lines.map((line) => {
      const [source, target, size, used, avail, pcent] = line.trim().split(/\s+/);
      return { source, target, size, used, avail, pcent };
    });
    return { ok: true, volumes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ===================== Connections pane: WiFi (nmcli) =====================
ipcMain.handle('wifi-status', async () => {
  try {
    const { stdout } = await execFileAsync('nmcli', ['radio', 'wifi']);
    return { ok: true, enabled: stdout.trim() === 'enabled' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wifi-toggle', async (event, enabled) => {
  try {
    await execFileAsync('nmcli', ['radio', 'wifi', enabled ? 'on' : 'off']);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wifi-list', async () => {
  try {
    const { stdout } = await execFileAsync('nmcli', [
      '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list',
    ]);
    const networks = stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [inUse, ssid, signal, security] = line.split(':');
      return {
        ssid: ssid || '(hidden)',
        signal: parseInt(signal, 10) || 0,
        secured: !!security,
        connected: inUse === '*',
      };
    }).filter((n) => n.ssid !== '(hidden)');
    return { ok: true, networks };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wifi-connect', async (event, { ssid, password }) => {
  try {
    const args = ['dev', 'wifi', 'connect', ssid];
    if (password) args.push('password', password);
    await execFileAsync('nmcli', args, { timeout: 20000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ===================== Connections pane: Bluetooth (bluetoothctl) =====================
ipcMain.handle('bt-status', async () => {
  try {
    const { stdout } = await execFileAsync('bluetoothctl', ['show'], { timeout: 5000 });
    const enabled = /Powered:\s*yes/.test(stdout);
    return { ok: true, enabled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('bt-toggle', async (event, enabled) => {
  try {
    await execFileAsync('bluetoothctl', ['power', enabled ? 'on' : 'off'], { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('bt-scan', async () => {
  try {
    // Bounded scan (bluez 5.65+ supports --timeout on scan on).
    await execFileAsync('bluetoothctl', ['--timeout', '6', 'scan', 'on'], { timeout: 9000 });
    const { stdout } = await execFileAsync('bluetoothctl', ['devices'], { timeout: 5000 });
    const devices = stdout.trim().split('\n').filter(Boolean).map((line) => {
      const match = line.match(/Device\s+([0-9A-F:]+)\s+(.*)/i);
      return match ? { mac: match[1], name: match[2] } : null;
    }).filter(Boolean);
    return { ok: true, devices };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('bt-connect', async (event, mac) => {
  try {
    await execFileAsync('bluetoothctl', ['connect', mac], { timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ===================== Spotify =====================
function spotifyConfig() {
  const config = loadConfig();
  return config.spotify || {};
}

// The Web API can only control a Spotify player that already exists — it
// can't create one. So if nothing is running, every play request fails
// with "no device found" until the user manually opens Spotify first.
// This starts the desktop client on their behalf and waits for it to
// register as a Connect device, which is what actually makes playback
// possible from a cold start.
const SPOTIFY_LAUNCH_TIMEOUT_MS = 25000;
const SPOTIFY_POLL_INTERVAL_MS = 1000;

let spotifyLaunchInFlight = null;

async function ensureSpotifyClient(clientId) {
  const devices = await spotify.listDevices(clientId);
  if (devices.length) return;

  // Several tiles can be activated in quick succession; without this,
  // each one would spawn its own Spotify process.
  if (spotifyLaunchInFlight) return spotifyLaunchInFlight;

  spotifyLaunchInFlight = (async () => {
    const command = spotifyConfig().launchCommand || 'spotify';
    await new Promise((resolve, reject) => {
      const child = spawn(command, [], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        reject(new Error(
          err.code === 'ENOENT'
            ? `Couldn't start Spotify: no "${command}" command found. Install the Spotify desktop app, or set spotify.launchCommand in config.json.`
            : `Couldn't start Spotify: ${err.message}`
        ));
      });
      child.unref();
      // spawn() reports ENOENT asynchronously, so give it a tick to fail
      // before treating the launch as successfully started.
      setTimeout(resolve, 100);
    });

    const deadline = Date.now() + SPOTIFY_LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SPOTIFY_POLL_INTERVAL_MS));
      const found = await spotify.listDevices(clientId);
      if (found.length) return;
    }
    throw new Error('Started Spotify but it didn\'t come online in time. Try again in a moment.');
  })();

  try {
    await spotifyLaunchInFlight;
  } finally {
    spotifyLaunchInFlight = null;
  }
}

ipcMain.handle('spotify-is-authed', () => ({ ok: true, authed: spotify.isAuthed() }));

ipcMain.handle('spotify-login', async () => {
  try {
    const { clientId, redirectUri } = spotifyConfig();
    await spotify.login(clientId, redirectUri);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-logout', () => {
  spotify.logout();
  return { ok: true };
});

ipcMain.handle('spotify-get-home', async () => {
  try {
    const { clientId } = spotifyConfig();
    const [playlists, recentlyPlayed, recentTracks, moodRows] = await Promise.all([
      spotify.getPlaylists(clientId),
      spotify.getRecentlyPlayed(clientId).catch(() => []),
      spotify.getRecentTracks(clientId).catch(() => []),
      spotify.getMoodRows(clientId).catch(() => []),
    ]);
    const { pinnedPlaylistIds } = settingsStore.load().spotify;
    return { ok: true, playlists, recentlyPlayed, recentTracks, moodRows, pinnedPlaylistIds };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-toggle-pin', (event, playlistId) => {
  const data = settingsStore.load();
  const ids = data.spotify.pinnedPlaylistIds;
  const idx = ids.indexOf(playlistId);
  if (idx === -1) ids.push(playlistId);
  else ids.splice(idx, 1);
  settingsStore.save(data);
  return { ok: true, pinnedPlaylistIds: ids, pinned: idx === -1 };
});

ipcMain.handle('spotify-play', async (event, uri) => {
  try {
    const { clientId } = spotifyConfig();
    await ensureSpotifyClient(clientId);
    const { shuffle } = settingsStore.load().spotify;
    await spotify.playAny(clientId, uri, { shuffle });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-set-shuffle', async (event, state) => {
  try {
    const { clientId } = spotifyConfig();
    const data = settingsStore.load();
    data.spotify.shuffle = !!state;
    settingsStore.save(data);
    // Apply immediately if something is already playing; if nothing is,
    // the saved preference gets used on the next play.
    await spotify.setShuffle(clientId, !!state).catch(() => {});
    return { ok: true, shuffle: !!state };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-queue', async (event, uri) => {
  try {
    const { clientId } = spotifyConfig();
    await ensureSpotifyClient(clientId);
    await spotify.queueUri(clientId, uri);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-get-queue', async () => {
  try {
    const { clientId } = spotifyConfig();
    return { ok: true, queue: await spotify.getQueue(clientId) };
  } catch (err) {
    return { ok: false, error: err.message, queue: [] };
  }
});

ipcMain.handle('spotify-search', async (event, query) => {
  try {
    const { clientId } = spotifyConfig();
    const results = await spotify.search(clientId, query);
    return { ok: true, ...results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-get-state', async () => {
  try {
    const { clientId } = spotifyConfig();
    const state = await spotify.getState(clientId);
    return { ok: true, ...state };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-toggle', async () => {
  try {
    const { clientId } = spotifyConfig();
    await ensureSpotifyClient(clientId);
    await spotify.togglePlayback(clientId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-next', async () => {
  try {
    const { clientId } = spotifyConfig();
    await spotify.nextTrack(clientId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-previous', async () => {
  try {
    const { clientId } = spotifyConfig();
    await spotify.previousTrack(clientId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- IPC: config ---
ipcMain.handle('get-config', () => loadConfig());

// --- IPC: launch an app by tile id ---
ipcMain.handle('launch-tile', (event, tileId) => {
  const config = loadConfig();
  const tile = config.tiles.find((t) => t.id === tileId);
  if (!tile) return { ok: false, error: 'Unknown tile: ' + tileId };

  try {
    // Optional pre-launch shell step (e.g. starting a waydroid session)
    if (tile.prelaunch) {
      spawn('bash', ['-c', tile.prelaunch], { detached: true, stdio: 'ignore' }).unref();
    }
    const child = spawn(tile.command, tile.args || [], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', (err) => {
      logError('launch-tile', `Failed to launch ${tile.command}: ${err.message}`);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- IPC: list Android apps installed inside Waydroid ---
function parseWaydroidApps(output) {
  const apps = [];
  const blocks = output.split(/\n\s*\n/);
  for (const block of blocks) {
    const nameMatch = block.match(/Name:\s*(.+)/);
    const pkgMatch = block.match(/packageName:\s*(.+)/);
    if (nameMatch && pkgMatch) {
      apps.push({ name: nameMatch[1].trim(), packageName: pkgMatch[1].trim() });
    }
  }
  return apps;
}

ipcMain.handle('list-waydroid-apps', async () => {
  try {
    const { stdout } = await execFileAsync('waydroid', ['app', 'list'], { timeout: 8000 });
    const apps = parseWaydroidApps(stdout);
    return { ok: true, apps };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- IPC: launch a specific Android app inside Waydroid by package name ---
ipcMain.handle('launch-waydroid-app', (event, packageName) => {
  try {
    const child = spawn('waydroid', ['app', 'launch', packageName], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- IPC: power actions ---
ipcMain.handle('power-action', async (event, action) => {
  try {
    if (action === 'exit') {
      app.quit();
      return { ok: true };
    }
    if (action === 'settings') {
      createSettingsWindow();
      return { ok: true };
    }
    if (action === 'shutdown') {
      await execFileAsync('loginctl', ['poweroff']);
      return { ok: true };
    }
    if (action === 'restart') {
      await execFileAsync('loginctl', ['reboot']);
      return { ok: true };
    }
    return { ok: false, error: 'Unknown power action: ' + action };
  } catch (err) {
    // loginctl exits non-zero (and writes to stderr) when polkit refuses the
    // action — most commonly "Interactive authentication required" on a
    // kiosk/autologin session polkit doesn't see as "active". See
    // Troubleshooting §7.7 in DOCUMENTATION.md.
    const detail = err.stderr?.trim() || err.message;
    return { ok: false, error: detail };
  }
});
