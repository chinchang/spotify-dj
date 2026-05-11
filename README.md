# Auto DJ — Spotify

A small browser-only web app that plays your Spotify playlists DJ-style: each track plays for N seconds (configurable), starting at a configurable offset, with a quick volume-dip transition between songs (~1.5s fade out → switch track + seek → ~1.5s fade in).

Requires **Spotify Premium** (Web Playback SDK requirement).

## One-time setup

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**.
2. Set a name (e.g. "Auto DJ"). Under **Redirect URIs**, add exactly:

   ```
   http://127.0.0.1:5173/callback
   ```

   *(Spotify deprecated `http://localhost` for new apps in April 2025 — `127.0.0.1` is required.)*
3. Under **APIs used**, check **Web API** and **Web Playback SDK**. Save.
4. Copy the **Client ID** from the app settings.
5. Create `.env.local` in the project root:

   ```
   VITE_SPOTIFY_CLIENT_ID=<paste your client id>
   ```

## Run

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Click **Login with Spotify**, pick a playlist, adjust the sliders, and the DJ loop starts.

## Controls

- **Play each song for**: 5–60 seconds per clip
- **Start each song at**: 0–120 seconds in (skip intros)
- **Pause / Resume / Skip / Stop**: standard controls

## Notes

- Tokens (access + refresh) are persisted in `localStorage`. PKCE refresh tokens rotate, so the app re-saves them on every refresh.
- The Spotify Connect device is named **Auto DJ** — it will appear as an active device in your other Spotify clients while the app is running.
- Two simultaneous overlapping streams aren't possible on a single Spotify account (Connect allows only one active stream), so this is a *volume-dip* transition rather than a true overlapping crossfade. It's brief and smooth.
