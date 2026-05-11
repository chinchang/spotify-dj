import { CLIENT_ID, REDIRECT_URI, SCOPES } from './config.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const STORAGE_KEY = 'spotify_dj_tokens';
const VERIFIER_KEY = 'spotify_dj_pkce_verifier';
const STATE_KEY = 'spotify_dj_pkce_state';

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length];
  return out;
}

function base64urlencode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(input) {
  const data = new TextEncoder().encode(input);
  return await crypto.subtle.digest('SHA-256', data);
}

function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null;
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function isLoggedIn() {
  return !!loadTokens()?.refresh_token;
}

export async function login() {
  if (!CLIENT_ID) {
    throw new Error('Missing VITE_SPOTIFY_CLIENT_ID. Set it in .env.local.');
  }
  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const challenge = base64urlencode(await sha256(verifier));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES.join(' '),
  });
  window.location.assign(`${AUTHORIZE_URL}?${params.toString()}`);
}

export async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  if (error) throw new Error(`Spotify auth error: ${error}`);
  if (!code) return false;

  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!expectedState || state !== expectedState) {
    throw new Error('OAuth state mismatch — possible CSRF.');
  }
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('Missing PKCE verifier in session.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope || '',
  });
  console.log('[Auto DJ] Granted scopes:', data.scope);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  // Clean URL: remove ?code=... query and /callback path
  window.history.replaceState({}, document.title, '/');
  return true;
}

let refreshInFlight = null;

async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  const tokens = loadTokens();
  if (!tokens?.refresh_token) throw new Error('No refresh token; please log in again.');

  refreshInFlight = (async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      localStorage.removeItem(STORAGE_KEY);
      throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    // PKCE refresh tokens rotate — persist the new one if returned.
    saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      scope: data.scope || tokens.scope || '',
    });
    return data.access_token;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not logged in.');
  if (Date.now() >= tokens.expires_at - 60_000) {
    return await refresh();
  }
  return tokens.access_token;
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  window.location.assign('/');
}

export function getGrantedScopes() {
  const tokens = loadTokens();
  return tokens?.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [];
}
