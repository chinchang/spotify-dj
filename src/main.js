import './style.css';
import * as auth from './auth.js';
import { renderLoggedIn, renderLoggedOut } from './ui.js';
import { CLIENT_ID } from './config.js';

async function boot() {
  const app = document.querySelector('#app');

  if (!CLIENT_ID) {
    app.innerHTML = `
      <div class="card centered">
        <h1>Auto DJ</h1>
        <p class="error">Missing <code>VITE_SPOTIFY_CLIENT_ID</code>.</p>
        <p class="muted small">Create <code>.env.local</code> at the project root with
        <code>VITE_SPOTIFY_CLIENT_ID=&lt;your client id&gt;</code> and restart <code>npm run dev</code>.</p>
      </div>`;
    return;
  }

  try {
    if (window.location.search.includes('code=')) {
      await auth.handleCallback();
    }
  } catch (e) {
    app.innerHTML = `<div class="card centered"><h1>Auth error</h1><p class="error">${e.message}</p>
      <button onclick="localStorage.clear();sessionStorage.clear();location.assign('/')">Reset</button></div>`;
    return;
  }

  if (auth.isLoggedIn()) {
    await renderLoggedIn();
  } else {
    await renderLoggedOut();
  }
}

boot();
