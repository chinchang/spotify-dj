import { getAccessToken } from "./auth.js";
import * as api from "./api.js";

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";
const FADE_MS = 1500;

let sdkReadyPromise = null;
function loadSdk() {
  if (sdkReadyPromise) return sdkReadyPromise;
  sdkReadyPromise = new Promise((resolve, reject) => {
    if (window.Spotify) return resolve(window.Spotify);
    window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
    const s = document.createElement("script");
    s.src = SDK_SRC;
    s.async = true;
    s.onerror = () =>
      reject(new Error("Failed to load Spotify Web Playback SDK."));
    document.head.appendChild(s);
  });
  return sdkReadyPromise;
}

function fadeVolume(player, from, to, durationMs) {
  let cancelled = false;
  let rafId = 0;
  let safetyTimer = 0;
  let resolveOuter;
  // Snap to start immediately so there's no ~16ms gap before the first rAF tick.
  player.setVolume(Math.max(0, Math.min(1, from))).catch(() => {});
  if (durationMs <= 0) {
    player.setVolume(Math.max(0, Math.min(1, to))).catch(() => {});
    return {
      promise: Promise.resolve(),
      cancel() {
        cancelled = true;
      },
    };
  }
  const start = performance.now();
  const promise = new Promise((resolve) => {
    resolveOuter = resolve;
    function complete() {
      cancelAnimationFrame(rafId);
      clearTimeout(safetyTimer);
      player.setVolume(Math.max(0, Math.min(1, to))).catch(() => {});
      resolve();
    }
    function step(now) {
      if (cancelled) return resolve();
      const t = Math.min(1, (now - start) / durationMs);
      const v = from + (to - from) * t;
      player.setVolume(Math.max(0, Math.min(1, v))).catch(() => {});
      if (t >= 1) {
        complete();
      } else {
        rafId = requestAnimationFrame(step);
      }
    }
    rafId = requestAnimationFrame(step);
    // Browsers freeze rAF when the tab is hidden. setTimeout still fires (throttled,
    // but it does run), so use it as a safety net to guarantee the fade finishes.
    safetyTimer = setTimeout(complete, durationMs + 80);
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      cancelAnimationFrame(rafId);
      clearTimeout(safetyTimer);
      // Ensure waiters don't deadlock if cancelled before any rAF tick.
      if (resolveOuter) resolveOuter();
    },
  };
}

export class DJ {
  constructor({ onState, onTrack, onError, onProgress } = {}) {
    this.player = null;
    this.deviceId = null;
    this.tracks = [];
    this.index = 0;
    this.state = "IDLE";
    this.clipMs = 30_000;
    this.offsetMs = 0;
    this.fadeMs = FADE_MS;
    this.loop = false;

    this.onState = onState || (() => {});
    this.onTrack = onTrack || (() => {});
    this.onError = onError || ((e) => console.error(e));
    this.onProgress = onProgress || (() => {});

    this._fadeHandle = null;
    this._timeoutId = null;
    this._waitForUri = null; // { uri, resolve, reject }
    this._connected = false;
    this._progressId = null;
    // Monotonic generation counter. Every async transition (load, fade-out, pause, stop)
    // captures a value; if it's no longer current after an await, the continuation bails.
    this._gen = 0;
  }

  _bumpGen() {
    this._gen += 1;
    return this._gen;
  }

  _isCurrentGen(g) {
    return g === this._gen;
  }

  _startProgressPolling() {
    if (this._progressId) return;
    this._progressId = setInterval(async () => {
      if (!this.player) return;
      try {
        const state = await this.player.getCurrentState();
        if (state) {
          this.onProgress({
            positionMs: state.position,
            durationMs: state.duration,
            paused: state.paused,
          });
        }
      } catch {}
    }, 500);
  }

  _stopProgressPolling() {
    if (this._progressId) clearInterval(this._progressId);
    this._progressId = null;
  }

  setState(s) {
    this.state = s;
    this.onState(s);
  }

  setClipSeconds(sec) {
    this.clipMs = Math.max(5, Math.floor(sec)) * 1000;
  }

  setOffsetSeconds(sec) {
    this.offsetMs = Math.max(0, Math.floor(sec)) * 1000;
  }

  setFadeMs(ms) {
    this.fadeMs = Math.max(0, Math.floor(ms));
  }

  setLoop(on) {
    this.loop = !!on;
  }

  async connect() {
    if (this._connected) return;
    const Spotify = await loadSdk();
    this.player = new Spotify.Player({
      name: "Auto DJ",
      getOAuthToken: (cb) => {
        getAccessToken()
          .then(cb)
          .catch((e) => this.onError(e));
      },
      volume: 1.0,
    });

    this.player.addListener("initialization_error", ({ message }) =>
      this.onError(new Error(`SDK init: ${message}`)),
    );
    this.player.addListener("authentication_error", ({ message }) =>
      this.onError(new Error(`SDK auth: ${message}`)),
    );
    this.player.addListener("account_error", () =>
      this.onError(
        new Error("Spotify Premium is required to use the Web Playback SDK."),
      ),
    );
    this.player.addListener("playback_error", ({ message }) =>
      this.onError(new Error(`Playback: ${message}`)),
    );

    this.player.addListener("player_state_changed", (state) => {
      if (!state) return;
      const cur = state.track_window?.current_track;
      if (
        this._waitForUri &&
        cur &&
        cur.uri === this._waitForUri.uri &&
        !state.paused
      ) {
        const w = this._waitForUri;
        this._waitForUri = null;
        w.resolve();
      }
    });

    const ready = new Promise((resolve, reject) => {
      this.player.addListener("ready", ({ device_id }) => {
        this.deviceId = device_id;
        resolve();
      });
      this.player.addListener("not_ready", ({ device_id }) => {
        console.warn("Device went offline:", device_id);
      });
      setTimeout(() => reject(new Error("SDK ready timeout (15s).")), 15_000);
    });

    const ok = await this.player.connect();
    if (!ok) throw new Error("player.connect() returned false.");
    await ready;
    await api.transferPlayback(this.deviceId, false);
    this._connected = true;
  }

  async start(tracks, startIndex = 0) {
    this._cancelTimers();
    this.tracks = tracks.filter((t) => t && t.uri);
    if (!this.tracks.length) {
      this.onError(new Error("Playlist is empty."));
      return;
    }
    this.index = Math.max(0, Math.min(startIndex, this.tracks.length - 1));
    this._consecutiveFails = 0;
    await this._loadTrack(this.tracks[this.index]);
  }

  async _advanceAfterFail(reason, callerGen) {
    if (callerGen !== undefined && !this._isCurrentGen(callerGen)) return;
    this._consecutiveFails = (this._consecutiveFails || 0) + 1;
    if (this._consecutiveFails >= this.tracks.length) {
      console.warn("All tracks failed to play, stopping.", reason);
      return this._stop();
    }
    this.index += 1;
    if (this.index >= this.tracks.length) {
      if (this.loop) this.index = 0;
      else return this._stop();
    }
    return this._loadTrack(this.tracks[this.index]);
  }

  async skip() {
    if (this.state === "IDLE") return;
    this._cancelTimers();
    this.index += 1;
    if (this.index >= this.tracks.length) {
      if (this.loop) {
        this.index = 0;
      } else {
        await this._stop();
        return;
      }
    }
    await this._loadTrack(this.tracks[this.index]);
  }

  async pause() {
    this._bumpGen(); // invalidate any in-flight load / fade-out
    this._cancelTimers();
    if (this.player) await this.player.pause().catch(() => {});
    this.setState("PAUSED");
  }

  async resume() {
    if (!this.player) return;
    // Volume might be at a partial value if we were interrupted mid-fade.
    await this.player.setVolume(1).catch(() => {});
    await this.player.resume().catch(() => {});
    this.setState("PLAYING");
    this._scheduleFadeOut();
  }

  async _stop() {
    this._bumpGen();
    this._cancelTimers();
    this._stopProgressPolling();
    if (this.player) await this.player.pause().catch(() => {});
    this.setState("IDLE");
  }

  _cancelTimers() {
    if (this._fadeHandle) {
      this._fadeHandle.cancel();
      this._fadeHandle = null;
    }
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._waitForUri) {
      const w = this._waitForUri;
      this._waitForUri = null;
      w.reject(new Error("cancelled"));
    }
  }

  _effectiveClipMs(track) {
    // Clamp clip so we don't overrun the track. Leave 200ms of headroom.
    const maxFromOffset = track.duration_ms - this.offsetMs - 200;
    return Math.max(2000, Math.min(this.clipMs, maxFromOffset));
  }

  async _loadTrack(track) {
    const myGen = this._bumpGen();
    this._cancelTimers();
    this.onTrack({
      track,
      next: this.tracks[this.index + 1] || null,
      index: this.index,
      total: this.tracks.length,
    });

    if (track.duration_ms <= this.offsetMs + 2000) {
      return this._advanceAfterFail("track too short", myGen);
    }

    this.setState("LOADING_TRACK");
    try {
      await this.player.setVolume(0);
      if (!this._isCurrentGen(myGen)) return;
      await api.play(this.deviceId, track.uri, this.offsetMs);
      if (!this._isCurrentGen(myGen)) return;
      await this._waitForTrackLoaded(track.uri);
      if (!this._isCurrentGen(myGen)) return;
      // SDK may reset volume on track change — re-assert 0 immediately.
      await this.player.setVolume(0).catch(() => {});
      if (!this._isCurrentGen(myGen)) return;
    } catch (e) {
      if (!this._isCurrentGen(myGen)) return; // superseded — drop the error
      console.warn("Track failed, skipping:", track.name, e?.status || "", e?.message || e);
      return this._advanceAfterFail(e?.message || "play failed", myGen);
    }

    if (!this._isCurrentGen(myGen)) return;
    this._consecutiveFails = 0;
    this.setState("FADING_IN");
    await this.player.setVolume(0).catch(() => {});
    if (!this._isCurrentGen(myGen)) return;
    this._fadeHandle = fadeVolume(this.player, 0, 1, this.fadeMs);
    this._startProgressPolling();
    await this._fadeHandle.promise;
    if (!this._isCurrentGen(myGen)) return;
    this._fadeHandle = null;
    this.setState("PLAYING");
    this._scheduleFadeOut();
  }

  _scheduleFadeOut() {
    const track = this.tracks[this.index];
    if (!track) return;
    const D = this._effectiveClipMs(track);
    const wait = Math.max(0, D - this.fadeMs);
    this._timeoutId = setTimeout(() => {
      this._timeoutId = null;
      this._beginFadeOut();
    }, wait);
  }

  async _beginFadeOut() {
    const myGen = this._bumpGen();
    this.setState("FADING_OUT");
    this._fadeHandle = fadeVolume(this.player, 1, 0, this.fadeMs);
    await this._fadeHandle.promise;
    this._fadeHandle = null;
    if (!this._isCurrentGen(myGen)) return; // pause/skip/stop happened mid-fade
    this.setState("SWITCHING");
    this.index += 1;
    if (this.index >= this.tracks.length) {
      if (this.loop) {
        this.index = 0;
      } else {
        return this._stop();
      }
    }
    await this._loadTrack(this.tracks[this.index]);
  }

  _waitForTrackLoaded(uri) {
    return new Promise((resolve, reject) => {
      this._waitForUri = { uri, resolve, reject };
      // Fallback: if the SDK never fires for this URI, time out.
      setTimeout(() => {
        if (this._waitForUri && this._waitForUri.uri === uri) {
          this._waitForUri = null;
          reject(new Error(`Timed out waiting for track ${uri}`));
        }
      }, 8000);
    });
  }
}
