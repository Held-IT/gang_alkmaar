#!/usr/bin/env node
// Downloads the raw OpenStreetMap data for Alkmaar Drive from the Overpass API and caches it in
// data-raw/osm/. Run once (or with --force to refresh); tools/osm/build.mjs works offline from
// the cache. The downloaded JSON is treated as untrusted data: it is only parsed, never executed.
//
// Usage: node tools/osm/fetch.mjs [--force]
//
// Area: the playable binnenstad (inside the Singel) plus a ~900 m backdrop ring, roughly
// lat 52.615..52.649, lon 4.716..4.777. Two polite queries (ways+relations with geometry, and
// tagged nodes) with retry + exponential backoff on 429/504.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'data-raw/osm');
mkdirSync(outDir, { recursive: true });

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'AlkmaarDrive/0.1 (hobby game)';
/** south, west, north, east */
export const FETCH_BBOX = [52.615, 4.716, 52.649, 4.777];
const force = process.argv.includes('--force');

const bb = FETCH_BBOX.join(',');
const QUERIES = {
  // All ways (streets, water, landuse, buildings, barriers, ...) and multipolygon relations, with
  // geometry inline. Ways keep their node id lists (needed for the road graph topology).
  'ways.json': `[out:json][timeout:180][bbox:${bb}];
(
  way;
  relation[type=multipolygon];
);
out body geom;`,
  // Tagged nodes only (trees, lamps, benches, signs, crossings, windmill, ...).
  'nodes.json': `[out:json][timeout:180][bbox:${bb}];
node[~"."~"."];
out body;`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQuery(name, query) {
  const file = resolve(outDir, name);
  if (existsSync(file) && !force) {
    console.log(`[fetch] ${name} cached, skipping (use --force to refresh)`);
    return;
  }
  let delay = 15000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    console.log(`[fetch] ${name}: attempt ${attempt} ...`);
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
    } catch (e) {
      console.log(`[fetch] network error: ${e.message}`);
      res = null;
    }
    if (res && res.ok) {
      const text = await res.text();
      // Validate that it is JSON with elements before caching.
      const json = JSON.parse(text);
      if (!Array.isArray(json.elements)) throw new Error(`${name}: unexpected response (no elements)`);
      if (json.remark) console.log(`[fetch] remark: ${json.remark}`);
      writeFileSync(file, text);
      console.log(`[fetch] ${name}: ${json.elements.length} elements, ${(text.length / 1e6).toFixed(1)} MB`);
      return;
    }
    const status = res ? res.status : 'ERR';
    if (res && ![429, 502, 503, 504].includes(res.status)) {
      const body = await res.text().catch(() => '');
      throw new Error(`${name}: HTTP ${status}: ${body.slice(0, 400)}`);
    }
    console.log(`[fetch] ${name}: HTTP ${status}, retrying in ${delay / 1000} s`);
    await sleep(delay);
    delay *= 2;
  }
  throw new Error(`${name}: giving up after retries`);
}

for (const [name, q] of Object.entries(QUERIES)) {
  await runQuery(name, q);
  await sleep(3000);
}
writeFileSync(resolve(outDir, 'fetch-info.json'), JSON.stringify({ bbox: FETCH_BBOX, endpoint: ENDPOINT, date: new Date().toISOString() }, null, 2));
console.log('[fetch] done');
