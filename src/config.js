export const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
// Derive from current origin so it works for dev (127.0.0.1:5173) and prod
// (djspotify.kushagra.dev) without rebuilding. Each origin must be registered
// in the Spotify Dashboard's Redirect URIs list.
export const REDIRECT_URI = `${window.location.origin}/callback`;
export const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-playback-state',
  'user-modify-playback-state',
];
