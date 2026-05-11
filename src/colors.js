// Sample the dominant dark color from a playlist image so each card can pick up
// its own background tone. Uses a tiny canvas + bucket-counting approach.

const memCache = new Map();
const LS_KEY = 'spotify_dj_color_cache_v1';
const LS_MAX = 200;

function loadLs() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveLs(map) {
  try {
    const entries = Object.entries(map);
    if (entries.length > LS_MAX) {
      // Drop oldest
      const trimmed = Object.fromEntries(entries.slice(-LS_MAX));
      localStorage.setItem(LS_KEY, JSON.stringify(trimmed));
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify(map));
    }
  } catch {}
}

let lsCache = loadLs();

export function extractDominantDark(imageUrl) {
  if (!imageUrl) return Promise.resolve(null);
  if (memCache.has(imageUrl)) return Promise.resolve(memCache.get(imageUrl));
  if (lsCache[imageUrl]) {
    memCache.set(imageUrl, lsCache[imageUrl]);
    return Promise.resolve(lsCache[imageUrl]);
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    const finish = (color) => {
      memCache.set(imageUrl, color);
      if (color) {
        lsCache[imageUrl] = color;
        saveLs(lsCache);
      }
      resolve(color);
    };
    img.onload = () => {
      try {
        const w = 36, h = 36;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);

        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 200) continue;
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          if (luma > 110) continue; // only "dark enough" pixels
          if (luma < 12) continue;  // skip near-black; we want hue
          const key = `${Math.round(r / 18) * 18},${Math.round(g / 18) * 18},${Math.round(b / 18) * 18}`;
          const e = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
          e.r += r; e.g += g; e.b += b; e.count++;
          buckets.set(key, e);
        }

        if (buckets.size === 0) return finish(null);
        let best = null;
        for (const [, v] of buckets) {
          if (!best || v.count > best.count) best = v;
        }
        let r = Math.round(best.r / best.count);
        let g = Math.round(best.g / best.count);
        let b = Math.round(best.b / best.count);

        // Drive luma down a bit so it stays a "card background" shade and white reads well.
        const targetLuma = 36; // keep contrast strong
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luma > targetLuma) {
          const k = targetLuma / luma;
          r = Math.round(r * k);
          g = Math.round(g * k);
          b = Math.round(b * k);
        }
        finish([r, g, b]);
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = imageUrl;
  });
}

export function rgb([r, g, b]) {
  return `rgb(${r}, ${g}, ${b})`;
}
