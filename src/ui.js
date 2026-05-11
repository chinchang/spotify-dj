import * as auth from './auth.js';
import * as api from './api.js';
import { DJ } from './player.js';
import { extractDominantDark, rgb } from './colors.js';

const $ = (sel) => document.querySelector(sel);

const CLIP_KEY = 'spotify_dj_clip_seconds';
const OFFSET_KEY = 'spotify_dj_offset_seconds';
const FADE_KEY = 'spotify_dj_crossfade_seconds';
const LOOP_KEY = 'spotify_dj_loop';

const CLIP_MIN = 5;    // 0:05
const CLIP_MAX = 90;   // 1:30
const CLIP_STEP = 5;
const OFFSET_MIN = 0;
const OFFSET_MAX = 120; // 2:00
const OFFSET_STEP = 5;
const FADE_MIN = 0;
const FADE_MAX = 5;
const FADE_STEP = 0.1;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getSavedClip() {
  const v = Number(localStorage.getItem(CLIP_KEY));
  return Number.isFinite(v) && v > 0 ? clamp(v, CLIP_MIN, CLIP_MAX) : 30;
}

function getSavedOffset() {
  const raw = localStorage.getItem(OFFSET_KEY);
  if (raw === null) return 30;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? clamp(v, OFFSET_MIN, OFFSET_MAX) : 30;
}

function getSavedFade() {
  const raw = localStorage.getItem(FADE_KEY);
  if (raw === null) return 1.5;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? clamp(v, FADE_MIN, FADE_MAX) : 1.5;
}

function getSavedLoop() {
  return localStorage.getItem(LOOP_KEY) === '1';
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const dj = new DJ({
  onState: (s) => updatePlayerState(s),
  onTrack: (info) => updateNowPlaying(info),
  onError: (e) => showError(e.message || String(e)),
  onProgress: ({ positionMs }) => updateProgress(positionMs),
});

let lastFailedPlaylistId = null;
let allPlaylists = [];
let currentPlaylist = null;
let currentTracks = [];
let lastTrackUri = null;
let consecutiveSkipsForLog = 0;

function header() {
  return `
    <div class="bg-grain"></div>
    <header class="top">
      <div class="back-slot" id="back-slot"></div>
      <div class="logo">
        <div class="logo-script">DJ for Spotify</div>
        <div class="logo-tag"><span class="dash"></span>play your playlist. your way.<span class="dash"></span></div>
      </div>
      <div class="header-right" id="header-right"></div>
    </header>
  `;
}

function showError(msg) {
  console.warn('[DJ]', msg);
}

function clearError() {}

// ---------- Logged-out screen ----------

export async function renderLoggedOut() {
  $('#app').innerHTML = `
    ${header()}
    <main class="login">
      <div class="login-card">
        <p class="muted">Plays your Spotify playlists DJ-style — clip each song to N seconds with a smooth volume-dip transition.</p>
        <p class="muted small">Spotify Premium required.</p>
        <button id="login" class="primary">Login with Spotify</button>
      </div>
    </main>
  `;
  $('#login').addEventListener('click', () => auth.login());
}

// ---------- Logged-in shell ----------

export async function renderLoggedIn() {
  $('#app').innerHTML = `
    ${header()}
    <main id="view"></main>
  `;
  $('#header-right').innerHTML = `<button id="logout" class="ghost-btn">Logout</button>`;
  $('#logout').addEventListener('click', () => auth.logout());

  await renderPicker();
}

// ---------- Playlist picker view ----------

async function renderPicker() {
  currentPlaylist = null;
  currentTracks = [];
  $('#back-slot').innerHTML = '';
  $('#view').innerHTML = `
    <section class="panel">
      <div class="playlist-header">
        <div class="kicker">CHOOSE A PLAYLIST</div>
        <h2 class="title">Your Library</h2>
      </div>
      <div id="playlists" class="playlists"><p class="muted center">Loading…</p></div>
    </section>
  `;
  try {
    if (!allPlaylists.length) {
      allPlaylists = await api.getPlaylists();
    }
    renderPlaylists(allPlaylists);
  } catch (e) {
    showError(e.message);
  }
}

function renderPlaylists(playlists) {
  const container = $('#playlists');
  if (!playlists.length) {
    container.innerHTML = '<p class="muted center">No playlists you created. Make one in Spotify and refresh.</p>';
    return;
  }
  const card = (p) => `
    <button class="pl-card" data-id="${p.id}" data-img="${p.image || ''}">
      <div class="pl-art">
        ${p.image ? `<img src="${p.image}" alt="" crossorigin="anonymous" referrerpolicy="no-referrer" />` : '<div class="pl-art-fallback"></div>'}
      </div>
      <div class="pl-meta">
        <div class="pl-name">${escapeHtml(p.name)}</div>
        <div class="pl-sub">${p.trackCount > 0 ? `${p.trackCount} songs` : '&nbsp;'}</div>
      </div>
    </button>`;

  container.innerHTML = `<div class="pl-grid">${playlists.map(card).join('')}</div>`;
  container.querySelectorAll('.pl-card').forEach((el) => {
    el.addEventListener('click', () => startPlaylist(el.dataset.id));
    const url = el.dataset.img;
    if (url) {
      extractDominantDark(url).then((color) => {
        if (color) el.style.setProperty('--card-bg', rgb(color));
      });
    }
  });
}

// ---------- Player view ----------

async function startPlaylist(id) {
  clearError();
  lastFailedPlaylistId = null;
  lastTrackUri = null;
  const meta = allPlaylists.find((p) => p.id === id);
  currentPlaylist = meta;

  renderPlayer(meta, null, null, []);

  try {
    if (!dj._connected) {
      await dj.connect();
    }
    const tracks = await api.getPlaylistTracks(id);
    if (!tracks.length) throw new Error('Playlist has no playable tracks.');
    currentTracks = tracks;
    // Update header now that we have track count + total duration
    paintPlaylistHeader(meta, tracks);
    await dj.start(tracks, 0);
  } catch (e) {
    lastFailedPlaylistId = id;
    showError(e.message);
  }
}

function renderPlayer(meta, _curTrack, _next, tracks) {
  $('#back-slot').innerHTML = `<button id="back" class="back-btn"><span class="back-arrow">←</span> BACK TO PLAYLISTS</button>`;
  $('#back').addEventListener('click', () => {
    dj._stop();
    renderPicker();
  });

  const clip = getSavedClip();
  const offset = getSavedOffset();
  const fade = getSavedFade();
  const loop = getSavedLoop();

  $('#view').innerHTML = `
    <section class="panel player-panel">
      <div class="playlist-header">
        <div class="kicker" id="playing-kicker">LOADING</div>
        <h2 class="title">
          ${escapeHtml(meta?.name || '')}
          <span class="spotify-badge" aria-label="Spotify"></span>
        </h2>
        <div class="playlist-stats" id="playlist-stats">${
          tracks.length
            ? `${tracks.length} songs · ${api.formatDurationLong(api.totalDurationMs(tracks))}`
            : '&nbsp;'
        }</div>
      </div>

      <div class="now-card">
        <div class="now-art" id="now-art"><div class="pl-art-fallback"></div></div>
        <div class="now-body">
          <div class="now-label">
            <span class="bars"><span></span><span></span><span></span><span></span></span>
            NOW PLAYING
          </div>
          <div class="now-title" id="now-title">—</div>
          <div class="now-artist" id="now-artist">—</div>
          <div class="progress-row">
            <span class="time-l" id="time-pos">00:00</span>
            <div class="progress"><div class="progress-fill" id="progress-fill"></div></div>
            <span class="time-r" id="time-dur">00:00</span>
          </div>
        </div>
      </div>

      <div class="next-card">
        <div class="next-art" id="next-art"><div class="pl-art-fallback"></div></div>
        <div class="next-body">
          <div class="next-label">UP NEXT</div>
          <div class="next-title" id="next-title">—</div>
          <div class="next-artist" id="next-artist">—</div>
        </div>
        <div class="next-controls">
          <button class="icon-btn toggle-btn${loop ? ' on' : ''}" id="loop-btn" title="Loop playlist">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
          </button>
          <button class="icon-btn" id="pause-btn" title="Pause / Resume">
            <svg id="pause-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          </button>
          <button class="icon-btn" id="skip-btn" title="Skip">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4l10 8-10 8V4zM17 5h2v14h-2z"/></svg>
          </button>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-header">
          <span class="settings-title">PLAYBACK SETTINGS</span>
          <span class="settings-sub">(applies to all songs)</span>
        </div>
        <div class="settings-grid">
          <div class="slider-block pink">
            <div class="slider-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4V8z" fill="currentColor"/></svg>
            </div>
            <div class="slider-content">
              <div class="slider-label">START OFFSET</div>
              <div class="slider-value" id="offset-val">${fmtTime(offset)}</div>
              <input id="offset" type="range" min="${OFFSET_MIN}" max="${OFFSET_MAX}" step="${OFFSET_STEP}" value="${offset}" />
              <div class="slider-scale"><span>${fmtTime(OFFSET_MIN)}</span><span>${fmtTime(OFFSET_MAX)}</span></div>
            </div>
          </div>
          <div class="slider-block cyan">
            <div class="slider-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 7v5l3 2"/></svg>
            </div>
            <div class="slider-content">
              <div class="slider-label">SONG DURATION</div>
              <div class="slider-value" id="clip-val">${fmtTime(clip)}</div>
              <input id="clip" type="range" min="${CLIP_MIN}" max="${CLIP_MAX}" step="${CLIP_STEP}" value="${clip}" />
              <div class="slider-scale"><span>${fmtTime(CLIP_MIN)}</span><span>${fmtTime(CLIP_MAX)}</span></div>
            </div>
          </div>
          <div class="slider-block yellow">
            <div class="slider-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12c4-8 8 8 12 0s8 8 8 0"/></svg>
            </div>
            <div class="slider-content">
              <div class="slider-label">CROSSFADE</div>
              <div class="slider-value" id="fade-val">${fade.toFixed(1)}s</div>
              <input id="fade" type="range" min="${FADE_MIN}" max="${FADE_MAX}" step="${FADE_STEP}" value="${fade}" />
              <div class="slider-scale"><span>${FADE_MIN}s</span><span>${FADE_MAX}s</span></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  function paintSliderFill(el) {
    const pct = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
    el.style.setProperty('--val', `${pct}%`);
  }

  function wireSlider({ el, valEl, key, format, onChange }) {
    // Force the DOM value to match the saved/default we resolved in JS, in case
    // the browser's range-input parsing clamped or ignored the inline `value`
    // attribute for any reason.
    const wireInitial = (initial) => {
      el.value = String(initial);
      valEl.textContent = format(Number(el.value));
      onChange(Number(el.value));
      paintSliderFill(el);
    };
    const onInput = () => {
      const v = Number(el.value);
      valEl.textContent = format(v);
      onChange(v);
      localStorage.setItem(key, el.value);
      paintSliderFill(el);
    };
    el.addEventListener('input', onInput);
    return wireInitial;
  }

  wireSlider({
    el: $('#clip'),
    valEl: $('#clip-val'),
    key: CLIP_KEY,
    format: fmtTime,
    onChange: (v) => dj.setClipSeconds(v),
  })(clip);

  wireSlider({
    el: $('#offset'),
    valEl: $('#offset-val'),
    key: OFFSET_KEY,
    format: fmtTime,
    onChange: (v) => dj.setOffsetSeconds(v),
  })(offset);

  wireSlider({
    el: $('#fade'),
    valEl: $('#fade-val'),
    key: FADE_KEY,
    format: (v) => v.toFixed(1) + 's',
    onChange: (v) => dj.setFadeMs(v * 1000),
  })(fade);

  // Loop toggle
  const loopBtn = $('#loop-btn');
  dj.setLoop(loop);
  loopBtn.addEventListener('click', () => {
    const next = !dj.loop;
    dj.setLoop(next);
    loopBtn.classList.toggle('on', next);
    localStorage.setItem(LOOP_KEY, next ? '1' : '0');
  });

  // Controls
  $('#pause-btn').addEventListener('click', () => {
    if (dj.state === 'PAUSED') dj.resume();
    else dj.pause();
  });
  $('#skip-btn').addEventListener('click', () => dj.skip().catch((e) => showError(e.message)));
}

function paintPlaylistHeader(meta, tracks) {
  const stats = $('#playlist-stats');
  if (stats) {
    stats.textContent = `${tracks.length} songs · ${api.formatDurationLong(api.totalDurationMs(tracks))}`;
  }
}

function updatePlayerState(s) {
  const kicker = $('#playing-kicker');
  if (!kicker) return;
  const labelMap = {
    IDLE: 'STOPPED',
    LOADING_TRACK: 'LOADING',
    FADING_IN: 'PLAYING',
    PLAYING: 'PLAYING',
    FADING_OUT: 'CROSSFADING',
    SWITCHING: 'CROSSFADING',
    PAUSED: 'PAUSED',
    ERROR: 'ERROR',
  };
  kicker.textContent = labelMap[s] || s;
  // toggle pause icon shape
  const icon = $('#pause-icon');
  if (icon) {
    if (s === 'PAUSED') {
      icon.innerHTML = '<path d="M6 4l14 8-14 8V4z"/>';
    } else {
      icon.innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
    }
  }
}

function paintNowPlaying({ track, next }) {
  const t = $('#now-title');
  const a = $('#now-artist');
  const art = $('#now-art');
  if (t) t.textContent = track.name;
  if (a) a.textContent = track.artists;
  if (art) {
    art.innerHTML = track.image
      ? `<img src="${track.image}" alt="" />`
      : '<div class="pl-art-fallback"></div>';
  }
  const nt = $('#next-title');
  const na = $('#next-artist');
  const nart = $('#next-art');
  if (next) {
    if (nt) nt.textContent = next.name;
    if (na) na.textContent = next.artists;
    if (nart) {
      nart.innerHTML = next.image
        ? `<img src="${next.image}" alt="" />`
        : '<div class="pl-art-fallback"></div>';
    }
  } else {
    if (nt) nt.textContent = 'End of playlist';
    if (na) na.textContent = '';
    if (nart) nart.innerHTML = '<div class="pl-art-fallback"></div>';
  }
}

function updateNowPlaying(info) {
  const isTrackChange = lastTrackUri && lastTrackUri !== info.track.uri;
  lastTrackUri = info.track.uri;

  if (!isTrackChange || !document.startViewTransition) {
    paintNowPlaying(info);
    return;
  }

  const nowCard = document.querySelector('.now-card');
  const nextCard = document.querySelector('.next-card');
  // OLD-state names: tag the up-next card so it morphs into the now-playing slot.
  if (nowCard) nowCard.style.viewTransitionName = 'leaving-track';
  if (nextCard) nextCard.style.viewTransitionName = 'promoted-track';

  const tx = document.startViewTransition(() => {
    paintNowPlaying(info);
    // NEW-state names: now the now-card carries the promoted-track identity,
    // so the browser morphs from old up-next position to current now-playing position.
    const newNow = document.querySelector('.now-card');
    const newNext = document.querySelector('.next-card');
    if (newNow) newNow.style.viewTransitionName = 'promoted-track';
    if (newNext) newNext.style.viewTransitionName = 'fresh-next';
  });

  tx.finished
    .catch(() => {})
    .finally(() => {
      document.querySelectorAll('.now-card, .next-card').forEach((el) => {
        el.style.viewTransitionName = '';
      });
    });
}

function updateProgress(positionMs) {
  // Progress is relative to the configured clip — not the full song.
  const clipMs = dj.clipMs;
  const offsetMs = dj.offsetMs;
  const elapsedInClip = Math.max(0, Math.min(clipMs, positionMs - offsetMs));

  const pos = $('#time-pos');
  const dur = $('#time-dur');
  const fill = $('#progress-fill');
  if (pos) pos.textContent = api.formatTime(elapsedInClip);
  if (dur) dur.textContent = api.formatTime(clipMs);
  if (fill && clipMs > 0) {
    fill.style.width = `${Math.min(100, (elapsedInClip / clipMs) * 100)}%`;
  }
}
