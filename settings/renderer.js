// ---------- Sidebar / pane switching ----------
const navItems = Array.from(document.querySelectorAll('.nav-item'));
const panes = Array.from(document.querySelectorAll('.pane'));

function showPane(name) {
  navItems.forEach((n) => n.classList.toggle('active', n.dataset.pane === name));
  panes.forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));

  if (name === 'connections') refreshConnections();
  if (name === 'storage') refreshStorage();
  if (name === 'appearance') refreshAppearance();
  if (name === 'updates') refreshUpdates();
}

navItems.forEach((n) => n.addEventListener('click', () => showPane(n.dataset.pane)));

// ---------- Info pane ----------
async function loadInfo() {
  const info = await window.settingsAPI.getSystemInfo();
  if (!info.ok) return;
  document.getElementById('info-ip').textContent = info.ip;
  document.getElementById('info-hostname').textContent = info.hostname;
  document.getElementById('info-cpu').textContent = `${info.cpuModel} (${info.cpuCores} cores)`;
  document.getElementById('info-cpu-usage').textContent = `${info.cpuUsage}%`;
  document.getElementById('info-ram').textContent = `${info.ramUsedGB} GB / ${info.ramTotalGB} GB`;
}

// ---------- Connections pane ----------
let connectionsLoaded = false;

async function refreshConnections() {
  const wifiToggle = document.getElementById('wifi-toggle');
  const btToggle = document.getElementById('bt-toggle');

  const [wifiStatus, btStatus] = await Promise.all([
    window.settingsAPI.wifiStatus(),
    window.settingsAPI.btStatus(),
  ]);
  wifiToggle.checked = !!wifiStatus.enabled;
  btToggle.checked = !!btStatus.enabled;

  if (wifiStatus.enabled) loadWifiList();
  loadBtList();
  connectionsLoaded = true;
}

document.getElementById('wifi-toggle').addEventListener('change', async (e) => {
  await window.settingsAPI.wifiToggle(e.target.checked);
  if (e.target.checked) loadWifiList();
  else document.getElementById('wifi-list').innerHTML = '';
});

document.getElementById('bt-toggle').addEventListener('change', async (e) => {
  await window.settingsAPI.btToggle(e.target.checked);
});

async function loadWifiList() {
  const container = document.getElementById('wifi-list');
  container.innerHTML = '<div class="empty-note">Scanning…</div>';
  const result = await window.settingsAPI.wifiList();
  if (!result.ok) {
    container.innerHTML = `<div class="empty-note">Couldn't list networks: ${result.error}</div>`;
    return;
  }
  if (!result.networks.length) {
    container.innerHTML = '<div class="empty-note">No networks found.</div>';
    return;
  }
  container.innerHTML = '';
  result.networks.forEach((net) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="list-row-main">
        <span class="list-row-name ${net.connected ? 'connected' : ''}">${net.ssid}</span>
        <span class="list-row-sub">${net.secured ? 'Secured' : 'Open'} · signal ${net.signal}%</span>
      </div>
    `;
    if (!net.connected) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-small';
      btn.textContent = 'Connect';
      btn.addEventListener('click', () => promptWifiConnect(net, row, btn));
      row.appendChild(btn);
    }
    container.appendChild(row);
  });
}

function promptWifiConnect(net, row, btn) {
  if (!net.secured) {
    connectWifi(net.ssid, '', btn);
    return;
  }
  if (row.querySelector('.pw-row')) return; // already open

  const pwRow = document.createElement('div');
  pwRow.className = 'pw-row';
  pwRow.innerHTML = `
    <input type="password" placeholder="Wi-Fi password" />
    <button class="btn btn-small">Join</button>
  `;
  row.appendChild(pwRow);
  const input = pwRow.querySelector('input');
  const joinBtn = pwRow.querySelector('button');
  input.focus();
  joinBtn.addEventListener('click', () => connectWifi(net.ssid, input.value, joinBtn));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectWifi(net.ssid, input.value, joinBtn);
  });
}

async function connectWifi(ssid, password, btn) {
  btn.textContent = 'Connecting…';
  btn.disabled = true;
  const result = await window.settingsAPI.wifiConnect(ssid, password);
  if (result.ok) {
    loadWifiList();
  } else {
    btn.textContent = 'Failed';
    btn.disabled = false;
  }
}

async function loadBtList() {
  const container = document.getElementById('bt-list');
  const result = await window.settingsAPI.btStatus();
  if (!result.enabled) {
    container.innerHTML = '<div class="empty-note">Turn Bluetooth on, then scan.</div>';
    return;
  }
  container.innerHTML = '<div class="empty-note">Press "Scan for devices" to find nearby devices.</div>';
}

document.getElementById('bt-scan-btn').addEventListener('click', async () => {
  const container = document.getElementById('bt-list');
  container.innerHTML = '<div class="empty-note">Scanning (a few seconds)…</div>';
  const result = await window.settingsAPI.btScan();
  if (!result.ok) {
    container.innerHTML = `<div class="empty-note">Scan failed: ${result.error}</div>`;
    return;
  }
  if (!result.devices.length) {
    container.innerHTML = '<div class="empty-note">No devices found.</div>';
    return;
  }
  container.innerHTML = '';
  result.devices.forEach((dev) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="list-row-main">
        <span class="list-row-name">${dev.name}</span>
        <span class="list-row-sub">${dev.mac}</span>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = 'Connect';
    btn.addEventListener('click', async () => {
      btn.textContent = 'Connecting…';
      btn.disabled = true;
      const res = await window.settingsAPI.btConnect(dev.mac);
      btn.textContent = res.ok ? 'Connected' : 'Failed';
      btn.disabled = res.ok;
    });
    row.appendChild(btn);
    container.appendChild(row);
  });
});

// ---------- Storage pane ----------
async function refreshStorage() {
  const container = document.getElementById('storage-list');
  container.innerHTML = '<div class="empty-note">Reading storage…</div>';
  const result = await window.settingsAPI.getStorage();
  if (!result.ok) {
    container.innerHTML = `<div class="empty-note">Couldn't read storage: ${result.error}</div>`;
    return;
  }
  if (!result.volumes.length) {
    container.innerHTML = '<div class="empty-note">No volumes found.</div>';
    return;
  }
  container.innerHTML = '';
  result.volumes.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="list-row-main">
        <span class="list-row-name">${v.target}</span>
        <span class="list-row-sub">${v.source} · ${v.used} used of ${v.size}</span>
      </div>
      <span class="list-row-sub">${v.pcent}</span>
    `;
    container.appendChild(row);
  });
}

// ---------- Appearance pane ----------
const BACKGROUND_COLOR_PRESETS = [
  '#14161C', // near-black
  '#1D2027', // slate
  '#0B3D91', // deep blue
  '#1B4332', // deep green
  '#5C2A9D', // purple
  '#7A2E2E', // deep red
  '#3E3226', // warm brown
  '#EEF0F3', // near-white
];

let currentAppSettings = null;

function buildColorSwatches() {
  const row = document.getElementById('color-swatch-row');
  row.innerHTML = '';
  BACKGROUND_COLOR_PRESETS.forEach((hex) => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch';
    btn.style.background = hex;
    btn.title = hex;
    btn.addEventListener('click', async () => {
      await window.settingsAPI.setBackgroundColor(hex);
      refreshAppearance();
    });
    row.appendChild(btn);
  });
}
buildColorSwatches();

function renderSlideshowList(images) {
  const container = document.getElementById('slideshow-list');
  if (!images.length) {
    container.innerHTML = '<div class="empty-note">No images added yet.</div>';
    return;
  }
  container.innerHTML = '';
  images.forEach((imagePath) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="list-row-main">
        <span class="list-row-name">${imagePath.split('/').pop()}</span>
        <span class="list-row-sub">${imagePath}</span>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-small btn-secondary';
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      await window.settingsAPI.removeSlideshowImage(imagePath);
      refreshAppearance();
    });
    row.appendChild(btn);
    container.appendChild(row);
  });
}

async function refreshAppearance() {
  const settings = await window.settingsAPI.getAppSettings();
  currentAppSettings = settings;

  document.querySelectorAll('.theme-btn[data-theme]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === settings.theme);
  });

  // Background
  const bg = settings.background;
  document.querySelectorAll('.theme-btn[data-bg-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.bgMode === bg.mode);
  });
  document.querySelectorAll('.bg-mode-panel').forEach((panel) => panel.classList.remove('active'));
  const activePanel = document.getElementById(`bg-panel-${bg.mode}`);
  if (activePanel) activePanel.classList.add('active');

  document.querySelectorAll('.color-swatch').forEach((sw) => {
    sw.classList.toggle('active', bg.mode === 'color' && sw.style.background === hexToRgbCss(bg.color));
  });
  document.getElementById('image-path').textContent =
    bg.image ? bg.image : 'No image chosen yet.';
  renderSlideshowList(bg.slideshow.images);
  document.getElementById('slideshow-interval').value = bg.slideshow.intervalSeconds;
  document.getElementById('slideshow-fade').value = bg.slideshow.fadeSeconds;

  // Font
  const font = settings.font;
  document.getElementById('font-family-select').value = font.family;
  document.getElementById('custom-font-name').textContent =
    font.family === 'custom' && font.customName ? `Using: ${font.customName} (${font.customPath})` : '';
  document.getElementById('font-scale').value = font.scale;
  document.getElementById('font-scale-value').textContent = `${font.scale}%`;
  document.getElementById('font-color').value = font.color || '#000000';
  document.getElementById('font-opacity').value = font.opacity;
  document.getElementById('font-opacity-value').textContent = `${font.opacity}%`;
}

// A <button style="background: #HEX"> reads back as an rgb(...) string, not
// the hex — this converts a stored hex the same way so the active-swatch
// comparison above actually matches.
function hexToRgbCss(hex) {
  const clean = (hex || '').replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  return `rgb(${r}, ${g}, ${b})`;
}

document.querySelectorAll('.theme-btn[data-theme]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await window.settingsAPI.setTheme(btn.dataset.theme);
    document.documentElement.setAttribute('data-theme', btn.dataset.theme);
    refreshAppearance();
  });
});

document.querySelectorAll('.theme-btn[data-bg-mode]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.bgMode;
    if (mode === 'theme') await window.settingsAPI.clearBackground();
    else await window.settingsAPI.setBackground({ mode });
    refreshAppearance();
  });
});

document.getElementById('choose-image-btn').addEventListener('click', async () => {
  const result = await window.settingsAPI.chooseBackgroundImage();
  if (result.ok) refreshAppearance();
});

document.getElementById('add-slideshow-images-btn').addEventListener('click', async () => {
  const result = await window.settingsAPI.chooseSlideshowImages();
  if (result.ok) refreshAppearance();
});

document.getElementById('slideshow-interval').addEventListener('change', async (e) => {
  await window.settingsAPI.setSlideshowTiming({ intervalSeconds: Number(e.target.value) });
});

document.getElementById('slideshow-fade').addEventListener('change', async (e) => {
  await window.settingsAPI.setSlideshowTiming({ fadeSeconds: Number(e.target.value) });
});

document.getElementById('clear-background-btn').addEventListener('click', async () => {
  await window.settingsAPI.clearBackground();
  refreshAppearance();
});

// ---- Font controls ----
document.getElementById('font-family-select').addEventListener('change', async (e) => {
  await window.settingsAPI.setFont({ family: e.target.value });
  refreshAppearance();
});

document.getElementById('upload-font-btn').addEventListener('click', async () => {
  const result = await window.settingsAPI.chooseCustomFont();
  if (result.ok) refreshAppearance();
});

document.getElementById('font-scale').addEventListener('input', (e) => {
  document.getElementById('font-scale-value').textContent = `${e.target.value}%`;
});
document.getElementById('font-scale').addEventListener('change', async (e) => {
  await window.settingsAPI.setFont({ scale: Number(e.target.value) });
});

document.getElementById('font-color').addEventListener('change', async (e) => {
  await window.settingsAPI.setFont({ color: e.target.value });
});
document.getElementById('font-color-reset-btn').addEventListener('click', async () => {
  await window.settingsAPI.setFont({ color: null });
  refreshAppearance();
});

document.getElementById('font-opacity').addEventListener('input', (e) => {
  document.getElementById('font-opacity-value').textContent = `${e.target.value}%`;
});
document.getElementById('font-opacity').addEventListener('change', async (e) => {
  await window.settingsAPI.setFont({ opacity: Number(e.target.value) });
});

// ---------- Updates pane ----------
function formatCheckedAt(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}

async function refreshUpdates() {
  const [settings, version] = await Promise.all([
    window.settingsAPI.getAppSettings(),
    window.settingsAPI.getAppVersion(),
  ]);
  document.getElementById('update-current-version').textContent = version;
  document.getElementById('update-last-checked').textContent = formatCheckedAt(settings.updates.lastChecked);
  document.getElementById('auto-update-toggle').checked = settings.updates.autoCheck;
  document.getElementById('update-status').textContent = '';
}

document.getElementById('check-update-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('update-status');
  const btn = document.getElementById('check-update-btn');
  btn.disabled = true;
  statusEl.textContent = 'Checking…';

  const result = await window.settingsAPI.checkForUpdate();
  btn.disabled = false;

  if (!result.ok) {
    statusEl.textContent = `Couldn't check for updates: ${result.error}`;
  } else if (!result.configured) {
    statusEl.textContent = "Update checking isn't set up yet.";
  } else if (result.updateAvailable) {
    statusEl.textContent = `Update available: v${result.latestVersion}`;
  } else {
    statusEl.textContent = "You're on the latest version.";
  }

  if (result.ok) {
    document.getElementById('update-last-checked').textContent = formatCheckedAt(result.checkedAt);
  }
});

document.getElementById('auto-update-toggle').addEventListener('change', async (e) => {
  await window.settingsAPI.setAutoUpdate(e.target.checked);
});

// ---------- Boot ----------
(async function init() {
  const settings = await window.settingsAPI.getAppSettings();
  document.documentElement.setAttribute('data-theme', settings.theme);
  loadInfo();
})();
