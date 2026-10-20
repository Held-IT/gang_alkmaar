// Credits page: static attributions + entries from public/assets/credits.json and
// public/assets/hdri/credits.json (format-tolerant: arrays of objects with name/author/license).

import { ASSETS_URL } from '../config';
import { h } from './dom';
import { NavLayer } from './nav';

export interface CreditsPage {
  readonly el: HTMLElement;
  readonly layer: NavLayer;
  /** Loads the JSON credit files on first call. */
  load(): void;
}

interface Entry {
  name: string;
  author?: string;
  license?: string;
  source?: string;
}

const STATIC: { title: string; lines: string[] }[] = [
  {
    title: 'Data',
    lines: [
      'Kaartdata © OpenStreetMap-bijdragers (ODbL)',
      'Gebouwen: 3D BAG door tudelft3d en 3DGI (CC BY 4.0)',
    ],
  },
  {
    title: 'Beeld',
    lines: ['Texturen en lucht: ambientCG / Poly Haven (CC0)'],
  },
  {
    title: 'Software',
    lines: ['three.js (MIT)', 'Rapier physics (Apache-2.0)', 'postprocessing (Zlib), N8AO (ISC)', 'Electron (MIT)'],
  },
];

const str = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
};

/** Collect credit-like objects from any JSON shape. */
function flatten(json: unknown, out: Entry[], depth = 0): void {
  if (depth > 4 || json === null || json === undefined) return;
  if (Array.isArray(json)) {
    json.forEach((x) => flatten(x, out, depth + 1));
    return;
  }
  if (typeof json !== 'object') return;
  const o = json as Record<string, unknown>;
  const name = str(o, ['name', 'title', 'asset', 'id', 'file']);
  const author = str(o, ['author', 'authors', 'creator', 'by', 'artist', 'credit']);
  const license = str(o, ['license', 'licence', 'licenseName']);
  const source = str(o, ['source', 'url', 'link', 'site', 'origin']);
  if (name && (author || license || source)) {
    out.push({ name, author, license, source });
    return;
  }
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') {
      // object maps like { "brick_red": { author, license } }
      if (!Array.isArray(v)) {
        const vo = v as Record<string, unknown>;
        if (!str(vo, ['name', 'title']) && (str(vo, ['author', 'license', 'licence', 'source', 'url']))) {
          flatten({ name: k, ...vo }, out, depth + 1);
          continue;
        }
      }
      flatten(v, out, depth + 1);
    }
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') ?? '';
    if (ct && !ct.includes('json')) return null; // dev server SPA fallback returns HTML
    return await r.json();
  } catch {
    return null;
  }
}

function domain(u?: string): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

export function createCreditsPage(): CreditsPage {
  const list = h('div', 'ad-credits-assets');
  const status = h('div', 'ad-credits-status', 'Gebruikte texturen en materialen worden geladen…');
  const scroller = h('div', 'ad-credits');
  scroller.append(
    h(
      'div',
      'ad-credits-hero',
      h('div', 'ad-credits-title', 'Alkmaar Drive'),
      h('p', null, 'Een rij-game door de historische binnenstad van Alkmaar, gebouwd met open data. Alle automerken in het spel zijn fictief.'),
    ),
  );
  for (const s of STATIC) {
    const sec = h('section', 'ad-credits-sec', h('h3', null, s.title));
    for (const l of s.lines) sec.append(h('div', 'ad-credits-line', l));
    scroller.append(sec);
  }
  scroller.append(h('section', 'ad-credits-sec', h('h3', null, 'Texturen, lucht en modellen'), status, list));

  // A single nav row so B / Esc go back; arrows scroll.
  const layer = new NavLayer({
    onKey: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        scroller.scrollBy({ top: (e.key === 'ArrowDown' ? 1 : -1) * 80, behavior: 'smooth' });
        return true;
      }
      return false;
    },
    onPadFrame: (pad, dt) => {
      const ay = pad.axes[1] ?? 0;
      const up = pad.buttons[12]?.pressed ? -1 : pad.buttons[13]?.pressed ? 1 : 0;
      const v = Math.abs(ay) > 0.2 ? ay : up;
      if (v) scroller.scrollTop += v * 700 * dt;
    },
  });

  let loaded = false;
  return {
    el: scroller,
    layer,
    load() {
      if (loaded) return;
      loaded = true;
      void Promise.all([fetchJson(`${ASSETS_URL}credits.json`), fetchJson(`${ASSETS_URL}hdri/credits.json`)]).then((res) => {
        const entries: Entry[] = [];
        res.forEach((j) => flatten(j, entries));
        // de-duplicate by name
        const seen = new Set<string>();
        const uniq = entries.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
        if (!uniq.length) {
          status.textContent = 'Alle texturen en luchten zijn CC0 (publiek domein) van ambientCG en Poly Haven.';
          return;
        }
        status.remove();
        for (const e of uniq) {
          const meta = [e.author, e.license, domain(e.source)].filter(Boolean).join(' · ');
          list.append(h('div', 'ad-credits-asset', h('span', null, e.name), h('span', 'ad-credits-meta', meta)));
        }
      });
    },
  };
}
