#!/usr/bin/env node
// Fetch step of the 3D BAG pipeline: downloads all 3D BAG buildings (CityJSONFeatures) in the
// playable rectangle + backdrop ring, and a small Overpass query for landmarks / the windmill.
// Everything is cached in data-raw/bag/ so `build.mjs` runs offline.
//
//   node tools/bag/fetch.mjs            fetch everything that is not cached yet
//   node tools/bag/fetch.mjs --force    refetch everything
//   node tools/bag/fetch.mjs --osm      only (re)fetch the Overpass landmark query
//
// API notes (verified against api.3dbag.nl, 2026):
//  * GET /collections/pand/items?bbox=xmin,ymin,xmax,ymax&limit=N (RD), limit is capped at 100.
//  * `limit`/`offset` count CityObjects (Building + BuildingPart ...), not features; `offset` is
//    1-based (offset=0 -> HTTP 500). A feature is returned when its Building object is in range,
//    so following the `next` links is gap free. Features overlapping tile borders appear in
//    several tiles: the build step dedupes by id.
//  * Vertices are integers; dequantise with the page's `metadata.transform` (differs per page).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import proj4 from 'proj4';
import { BACKDROP_RD, OSM_DIR, PAGES_DIR, PLAYABLE_RD, USER_AGENT } from './lib/config.mjs';

const TILE = 250;
const LIMIT = 100;
const DELAY_MS = 150;
const API = 'https://api.3dbag.nl/collections/pand/items';

const args = new Set(process.argv.slice(2));
const force = args.has('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, init = {}, tries = 7) {
  let wait = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      if (attempt >= tries) throw new Error(`failed after ${tries} tries: ${url}: ${err.message}`);
      console.warn(`  retry ${attempt} in ${wait} ms (${err.message})`);
      await sleep(wait);
      wait = Math.min(wait * 2, 30000);
    }
  }
}

function tilesFor(rect) {
  const tiles = [];
  for (let y = rect.minY; y < rect.maxY; y += TILE) {
    for (let x = rect.minX; x < rect.maxX; x += TILE) {
      tiles.push({ x0: x, y0: y, x1: Math.min(x + TILE, rect.maxX), y1: Math.min(y + TILE, rect.maxY) });
    }
  }
  return tiles;
}

const overlapsPlayable = (t) =>
  t.x0 < PLAYABLE_RD.maxX && t.x1 > PLAYABLE_RD.minX && t.y0 < PLAYABLE_RD.maxY && t.y1 > PLAYABLE_RD.minY;

async function fetchTile(t) {
  const key = `t_${t.x0}_${t.y0}`;
  const doneFile = resolve(PAGES_DIR, `${key}.done.json`);
  if (!force && existsSync(doneFile)) return { key, cached: true, pages: JSON.parse(readFileSync(doneFile, 'utf8')).pages };
  let url = `${API}?bbox=${t.x0},${t.y0},${t.x1},${t.y1}&limit=${LIMIT}`;
  const pages = [];
  let features = 0;
  for (let p = 0; url && p < 400; p++) {
    const json = await fetchWithRetry(url);
    if (!Array.isArray(json.features)) throw new Error(`unexpected response for ${url}`);
    const file = `${key}_p${String(p).padStart(3, '0')}.json.gz`;
    // Keep only what the build needs: features + the dequantisation transform.
    const slim = { transform: json.metadata?.transform ?? null, features: json.features };
    writeFileSync(resolve(PAGES_DIR, file), gzipSync(JSON.stringify(slim)));
    pages.push(file);
    features += json.features.length;
    const next = (json.links ?? []).find((l) => l.rel === 'next');
    url = json.features.length > 0 && (json.numberReturned ?? 0) >= LIMIT && next ? next.href : null;
    await sleep(DELAY_MS);
  }
  writeFileSync(doneFile, JSON.stringify({ tile: t, pages, features }));
  return { key, cached: false, pages, features };
}

async function fetchBag() {
  mkdirSync(PAGES_DIR, { recursive: true });
  const all = tilesFor(BACKDROP_RD);
  // Playable tiles first so development can start on the centre while the ring downloads.
  const tiles = [...all.filter(overlapsPlayable), ...all.filter((t) => !overlapsPlayable(t))];
  console.log(`3D BAG: ${tiles.length} tiles of ${TILE} m`);
  let n = 0;
  for (const t of tiles) {
    n++;
    const r = await fetchTile(t);
    if (!r.cached) console.log(`[${n}/${tiles.length}] ${r.key}: ${r.pages.length} pages, ${r.features} features`);
  }
  console.log('3D BAG fetch complete');
}

const RD_PROJ =
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs';

async function fetchOsm() {
  mkdirSync(OSM_DIR, { recursive: true });
  const out = resolve(OSM_DIR, 'landmarks.json');
  if (!force && !args.has('--osm') && existsSync(out)) return;
  const toWgs = proj4(RD_PROJ, 'WGS84');
  const [w, s] = toWgs.forward([PLAYABLE_RD.minX, PLAYABLE_RD.minY]);
  const [e, n] = toWgs.forward([PLAYABLE_RD.maxX, PLAYABLE_RD.maxY]);
  const bb = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  const names = 'Waag|Stadhuis|Accijnstoren|Grote Kerk|Sint-Laurenskerk|Grote of Sint-Laurenskerk|Kapelkerk';
  const q = `[out:json][timeout:90];
(
  nwr["building"~"^(church|chapel|cathedral)$"](${bb});
  nwr["amenity"="place_of_worship"](${bb});
  nwr["historic"](${bb});
  nwr["man_made"~"^(tower|windmill)$"](${bb});
  nwr["name"~"^(${names})$"](${bb});
  nwr["name"~"(Waag|Accijnstoren|Kapelkerk|Laurenskerk|Stadhuis)"](${bb});
);
out tags geom;`;
  console.log('Overpass landmark query ...');
  const json = await fetchWithRetry('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`,
  });
  writeFileSync(out, JSON.stringify(json));
  console.log(`Overpass: ${json.elements?.length ?? 0} elements -> ${out}`);
}

await fetchOsm();
if (!args.has('--osm')) await fetchBag();
