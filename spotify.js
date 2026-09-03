const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');

const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
].join(' ');

function tokenPath() {
  return path.join(app.getPath('userData'), 'spotify-tokens.json');
}

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(), 'utf-8'));
  } catch (err) {
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2));
}

function clearTokens() {
  try { fs.unlinkSync(tokenPath()); } catch (err) { /* nothing to clear */ }
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ---------- Login (opens a small Electron window for Spotify's own login page) ----------
function login(clientId, redirectUri) {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error('Spotify Client ID is not set in config.json'));
      return;
    }
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(16).toString('hex');

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', SCOPES);

    const authWindow = new BrowserWindow({
      width: 480,
      height: 720,
      title: 'Log in to Spotify',
      autoHideMenuBar: true,
    });
    authWindow.loadURL(authUrl.toString());

    let settled = false;

    function handleRedirect(event, url) {
      if (!url.startsWith(redirectUri)) return;
      event.preventDefault();
      settled = true;
      const parsed = new URL(url);
      const code = parsed.searchParams.get('code');
      const returnedState = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');
      authWindow.close();

      if (error) { reject(new Error(error)); return; }
      if (returnedState !== state) { reject(new Error('Login state mismatch — please try again.')); return; }
      if (!code) { reject(new Error('No authorization code returned.')); return; }

      exchangeCode(clientId, redirectUri, code, verifier).then(resolve).catch(reject);
    }

    authWindow.webContents.on('will-redirect', handleRedirect);
    authWindow.webContents.on('will-navigate', handleRedirect);
    authWindow.on('closed', () => {
      if (!settled) reject(new Error('Login window closed before completing.'));
    });
  });
}

async function exchangeCode(clientId, redirectUri, code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token exchange failed');

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function refreshTokens(clientId) {
  const stored = loadTokens();
  if (!stored || !stored.refresh_token) throw new Error('Not logged in');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: clientId,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || stored.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function getValidAccessToken(clientId) {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Not logged in');
  if (Date.now() > tokens.expires_at - 60000) {
    tokens = await refreshTokens(clientId);
  }
  return tokens.access_token;
}

function isAuthed() {
  return !!loadTokens();
}

// ---------- Web API helpers ----------
async function apiFetch(endpoint, clientId, options = {}) {
  const token = await getValidAccessToken(clientId);
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error?.message || `Spotify API error (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function getPlaylists(clientId) {
  const data = await apiFetch('/me/playlists?limit=50', clientId);
  return (data.items || []).filter(Boolean).map((p) => ({
    id: p.id,
    name: p.name,
    uri: p.uri,
    image: p.images?.[0]?.url || null,
    trackCount: p.tracks?.total ?? 0,
  }));
}

// "Jump back in" — recently played tracks, deduped by the playlist/album
// they came from (or the track itself, if played standalone) so the row
// doesn't just repeat the same context multiple times.
async function getRecentlyPlayed(clientId) {
  const data = await apiFetch('/me/player/recently-played?limit=20', clientId);
  const seen = new Set();
  const items = [];
  for (const entry of data.items || []) {
    const track = entry.track;
    const context = entry.context;
    if (!track) continue;
    const uri = context?.uri || track.uri;
    if (seen.has(uri)) continue;
    seen.add(uri);
    items.push({
      id: uri,
      name: context ? track.album?.name || track.name : track.name,
      subtitle: (track.artists || []).map((a) => a.name).join(', '),
      image: track.album?.images?.[0]?.url || null,
      uri,
    });
    if (items.length >= 10) break;
  }
  return items;
}

// The same play history as getRecentlyPlayed, but as individual songs —
// deduped only by track, never collapsed into the playlist/album they
// were played from. "Jump back in" resumes where you left off; this is
// just "here's what you've actually been listening to."
async function getRecentTracks(clientId) {
  const data = await apiFetch('/me/player/recently-played?limit=20', clientId);
  const seen = new Set();
  const items = [];
  for (const entry of data.items || []) {
    const track = entry.track;
    if (!track || seen.has(track.uri)) continue;
    seen.add(track.uri);
    items.push({
      id: track.uri,
      name: track.name,
      subtitle: (track.artists || []).map((a) => a.name).join(', '),
      image: track.album?.images?.[0]?.url || null,
      uri: track.uri,
    });
    if (items.length >= 10) break;
  }
  return items;
}

// A handful of "Mood"-style rows, built from Spotify's own browse
// categories (Chill, Workout, Focus, etc. — whatever the market returns)
// each populated with a few of that category's playlists.
async function getMoodRows(clientId) {
  const data = await apiFetch('/browse/categories?limit=4', clientId).catch(() => null);
  const categories = data?.categories?.items || [];

  const rows = await Promise.all(
    categories.map(async (cat) => {
      const plData = await apiFetch(`/browse/categories/${cat.id}/playlists?limit=8`, clientId).catch(() => null);
      const items = (plData?.playlists?.items || []).filter(Boolean).map((p) => ({
        id: p.id,
        name: p.name,
        image: p.images?.[0]?.url || null,
        uri: p.uri,
      }));
      return { title: cat.name, items };
    })
  );

  return rows.filter((row) => row.items.length > 0);
}

async function findActiveOrFirstDevice(clientId) {
  const state = await apiFetch('/me/player', clientId).catch(() => null);
  if (state?.device?.id) return state.device.id;
  const devices = await apiFetch('/me/player/devices', clientId).catch(() => null);
  return devices?.devices?.[0]?.id || null;
}

async function playContext(clientId, contextUri) {
  const deviceId = await findActiveOrFirstDevice(clientId);
  if (!deviceId) {
    throw new Error('No Spotify device found. Open Spotify once on this PC, then try again.');
  }
  await apiFetch(`/me/player/play?device_id=${deviceId}`, clientId, {
    method: 'PUT',
    body: JSON.stringify({ context_uri: contextUri }),
  });
  // Best-effort shuffle for a casual "just play the playlist" feel.
  apiFetch(`/me/player/shuffle?state=true&device_id=${deviceId}`, clientId, { method: 'PUT' }).catch(() => {});
}

async function playUris(clientId, uris) {
  const deviceId = await findActiveOrFirstDevice(clientId);
  if (!deviceId) {
    throw new Error('No Spotify device found. Open Spotify once on this PC, then try again.');
  }
  await apiFetch(`/me/player/play?device_id=${deviceId}`, clientId, {
    method: 'PUT',
    body: JSON.stringify({ uris }),
  });
}

// Single entry point for "play this thing" regardless of whether it's a
// playlist/album/artist (context) or a standalone track — the renderer
// doesn't need to know or care which.
async function playAny(clientId, uri) {
  if (uri.startsWith('spotify:track:')) {
    return playUris(clientId, [uri]);
  }
  return playContext(clientId, uri);
}

async function search(clientId, query) {
  const q = encodeURIComponent(query);
  const data = await apiFetch(`/search?q=${q}&type=track,playlist,album&limit=10`, clientId);
  return {
    tracks: (data.tracks?.items || []).filter(Boolean).map((t) => ({
      id: t.id,
      name: t.name,
      subtitle: (t.artists || []).map((a) => a.name).join(', '),
      image: t.album?.images?.[0]?.url || null,
      uri: t.uri,
    })),
    playlists: (data.playlists?.items || []).filter(Boolean).map((p) => ({
      id: p.id,
      name: p.name,
      image: p.images?.[0]?.url || null,
      uri: p.uri,
    })),
    albums: (data.albums?.items || []).filter(Boolean).map((a) => ({
      id: a.id,
      name: a.name,
      subtitle: (a.artists || []).map((ar) => ar.name).join(', '),
      image: a.images?.[0]?.url || null,
      uri: a.uri,
    })),
  };
}

async function getState(clientId) {
  const state = await apiFetch('/me/player', clientId);
  if (!state || !state.item) return { active: false };
  return {
    active: true,
    isPlaying: state.is_playing,
    trackName: state.item.name,
    artistName: (state.item.artists || []).map((a) => a.name).join(', '),
    albumArt: state.item.album?.images?.[0]?.url || null,
    progressMs: state.progress_ms || 0,
    durationMs: state.item.duration_ms || 0,
  };
}

async function togglePlayback(clientId) {
  const state = await apiFetch('/me/player', clientId).catch(() => null);
  if (state?.is_playing) {
    await apiFetch('/me/player/pause', clientId, { method: 'PUT' });
  } else {
    const deviceId = await findActiveOrFirstDevice(clientId);
    if (!deviceId) throw new Error('No Spotify device found. Open Spotify once on this PC.');
    await apiFetch(`/me/player/play?device_id=${deviceId}`, clientId, { method: 'PUT' });
  }
}

async function nextTrack(clientId) {
  await apiFetch('/me/player/next', clientId, { method: 'POST' });
}

async function previousTrack(clientId) {
  await apiFetch('/me/player/previous', clientId, { method: 'POST' });
}

function logout() {
  clearTokens();
}

module.exports = {
  login,
  logout,
  isAuthed,
  getPlaylists,
  getRecentlyPlayed,
  getRecentTracks,
  getMoodRows,
  playContext,
  playAny,
  search,
  getState,
  togglePlayback,
  nextTrack,
  previousTrack,
};
