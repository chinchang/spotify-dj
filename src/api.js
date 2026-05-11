import { getAccessToken } from './auth.js';

const BASE = 'https://api.spotify.com/v1';

class SpotifyApiError extends Error {
  constructor(status, path, body) {
    super(`Spotify API ${status} ${path}: ${body}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

async function apiFetch(path, opts = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new SpotifyApiError(res.status, path, text);
  }
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return null;
}

export { SpotifyApiError };

export async function getMe() {
  return apiFetch('/me');
}

export async function getPlaylists() {
  const [me, ...rest] = await Promise.all([
    getMe(),
    (async () => {
      const all = [];
      let url = '/me/playlists?limit=50';
      while (url) {
        const data = await apiFetch(url);
        all.push(...(data.items || []));
        url = data.next ? data.next.replace(BASE, '') : null;
      }
      return all;
    })(),
  ]);
  const all = rest[0] || [];
  // Filter to playlists the user actually owns (drop followed/algorithmic/editorial/null entries).
  const owned = all.filter((p) => p && p.id && p.owner?.id === me.id);
  return owned.map((p) => ({
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url || null,
    trackCount: p.tracks?.total ?? 0,
    owner: p.owner?.display_name || p.owner?.id || '',
    ownerId: p.owner?.id || '',
    isSpotifyOwned: false,
  }));
}

export async function getPlaylistTracks(playlistId) {
  const all = [];
  // Spotify deprecated /tracks; new endpoint is /items. Max limit is 50.
  let url = `/playlists/${playlistId}/items?limit=50`;
  while (url) {
    const data = await apiFetch(url);
    all.push(...(data.items || []));
    url = data.next ? data.next.replace(BASE, '') : null;
  }
  return all
    .map((entry) => ({ ...entry, item: entry.item || entry.track }))
    .filter(
      (entry) =>
        !entry.is_local &&
        entry.item &&
        entry.item.uri &&
        entry.item.uri.startsWith('spotify:track:')
    )
    .map((entry) => ({
      uri: entry.item.uri,
      name: entry.item.name,
      artists: (entry.item.artists || []).map((a) => a.name).join(', '),
      duration_ms: entry.item.duration_ms,
      image:
        entry.item.album?.images?.[0]?.url ||
        entry.item.album?.images?.[1]?.url ||
        null,
    }));
}

export async function getPlaylistMeta(playlistId) {
  return apiFetch(`/playlists/${playlistId}`);
}

export function totalDurationMs(tracks) {
  return tracks.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
}

export function formatDurationLong(ms) {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function runDiagnostics(playlistId) {
  const out = { steps: [] };
  async function step(label, fn) {
    const t0 = performance.now();
    try {
      const result = await fn();
      out.steps.push({ label, ok: true, ms: Math.round(performance.now() - t0), result });
      return result;
    } catch (e) {
      out.steps.push({
        label,
        ok: false,
        ms: Math.round(performance.now() - t0),
        status: e.status,
        body: e.body,
        message: e.message,
      });
      return null;
    }
  }
  const me = await step('GET /me', () => getMe());
  const playlist = await step(`GET /playlists/${playlistId}`, () => getPlaylistMeta(playlistId));
  await step(`GET /playlists/${playlistId}/items?limit=1`, () =>
    apiFetch(`/playlists/${playlistId}/items?limit=1`)
  );
  out.summary = {
    me_id: me?.id,
    me_product: me?.product,
    playlist_owner_id: playlist?.owner?.id,
    playlist_collaborative: playlist?.collaborative,
    playlist_public: playlist?.public,
    user_owns_playlist: !!(me && playlist && me.id === playlist.owner?.id),
  };
  return out;
}

export async function transferPlayback(deviceId, play = false) {
  return apiFetch('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play }),
  });
}

export async function play(deviceId, uri, positionMs = 0) {
  return apiFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.floor(positionMs)) }),
  });
}

export async function pausePlayback(deviceId) {
  return apiFetch(`/me/player/pause?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
  });
}
