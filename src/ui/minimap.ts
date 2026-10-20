// Circular heading-up minimap (bottom-left of the HUD) and the full-screen north-up city map
// (toggle with M). Both draw crops of the pre-rendered StaticMap.

import type { Footprints, Landmark, Map2D, RoadGraph } from '../contracts';
import { hintBar, type UiContext } from './context';
import { clamp, fromHTML, h } from './dom';
import { ICONS } from './icons';
import { buildStaticMap, MAP_COLORS, type MapView, type StaticMap } from './mapRender';
import { NavLayer } from './nav';

export interface Minimap {
  /**
   * Pre-renders the static map (call once after loading). The work is time-sliced over a few
   * hundred ms so the loading screen keeps animating; the returned promise resolves when the
   * map is ready (awaiting it is optional — the minimap simply appears when done).
   */
  setData(map2d: Map2D, footprints: Footprints | null, graph: RoadGraph): Promise<void>;
  /** Player position + heading (radians, 0 = facing +z). Call every frame while driving. */
  update(x: number, z: number, heading: number): void;
  /** Open / close the full-screen map (`force` sets the state). The UI already opens it on M and
   *  closes it on M / Esc / pad B / View; wiring the input 'map' action to toggleBigMap() is safe
   *  (a duplicate unforced toggle within 250 ms of a change is ignored). */
  toggleBigMap(force?: boolean): void;
  readonly bigMapOpen: boolean;
  /** Optional landmark labels on the full-screen map (OsmMeta.landmarks). Their footprints are
   *  painted into the static map (highlighted): footprints.json lacks De Waag, Accijnstoren, molen. */
  setLandmarks(l: Landmark[]): void;
  getMap(): StaticMap | null;
  dispose(): void;
}

const PLAYER_SVG = `<svg class="ad-mm-player" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 2.5 19.5 20 12 16.2 4.5 20z" fill="#ffffff" stroke="#d4202c" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`;

export interface MinimapHooks {
  /** Current speed (km/u) — the minimap zooms out with speed. */
  getSpeed(): number;
  hudVisible(): boolean;
  /** Called with the road graph as soon as setData() starts. */
  onGraph?(graph: RoadGraph): void;
  /** Called when the pre-rendered map is ready. */
  onReady?(): void;
}

export function createMinimap(hudEl: HTMLElement, ctx: UiContext, hooks: MinimapHooks): Minimap {
  const { getSpeed, hudVisible } = hooks;
  // ---- minimap
  const canvas = h('canvas', 'ad-mm-canvas');
  const north = h('div', 'ad-mm-north', 'N');
  const mini = h('div', 'ad-minimap is-empty', canvas, h('div', 'ad-mm-ring'), fromHTML(PLAYER_SVG), north);
  hudEl.append(mini);
  let map: StaticMap | null = null;
  let dataToken = 0;
  let px = 0;
  let pz = 0;
  let ph = 0;
  let radiusM = 160;
  let lastRot = 1e9;
  let miniSize = 0;
  const v: MapView = { cx: 0, cz: 0, pxPerM: 1, rotation: 0, ox: 0, oy: 0, w: 0, h: 0 };

  const ro = new ResizeObserver(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    miniSize = Math.round(canvas.clientWidth * dpr);
    canvas.width = canvas.height = miniSize;
    lastRot = 1e9;
    drawMini();
  });
  ro.observe(canvas);

  function drawMini(): void {
    if (!map || !miniSize) return;
    const g = canvas.getContext('2d')!;
    const w = miniSize;
    g.fillStyle = MAP_COLORS.land;
    g.fillRect(0, 0, w, w);
    // zoom out with speed: ~115 m radius when slow, up to ~250 m at 110 km/u
    const target = 115 + clamp(getSpeed() / 110, 0, 1) * 135;
    radiusM += (target - radiusM) * 0.04;
    v.cx = px;
    v.cz = pz;
    v.pxPerM = w / 2 / radiusM;
    v.rotation = ph - Math.PI;
    v.ox = w / 2;
    v.oy = w * 0.58;
    v.w = w;
    v.h = w;
    map.draw(g, v);
    if (Math.abs(v.rotation - lastRot) > 0.003) {
      lastRot = v.rotation;
      const r = canvas.clientWidth / 2;
      north.style.transform = `rotate(${v.rotation}rad) translateY(${-r}px) rotate(${-v.rotation}rad)`;
    }
  }

  // ---- big map
  const big = h('canvas', 'ad-bm-canvas');
  const scaleBar = h('div', 'ad-bm-scale', h('i'), h('span'));
  const legendItem = (cls: string, label: string) => h('span', 'ad-bm-leg', h('i', cls), label);
  const bigEl = h(
    'div',
    'ad-bigmap is-hidden',
    big,
    h(
      'div',
      'ad-bm-head',
      fromHTML(ICONS.map),
      h('div', null, h('div', 'ad-bm-title', 'Kaart van Alkmaar'), h('div', 'ad-bm-sub', 'Binnenstad binnen de Singel')),
    ),
    h(
      'div',
      'ad-bm-legend',
      legendItem('lg-road', 'Weg'),
      legendItem('lg-ped', 'Voetgangersgebied'),
      legendItem('lg-cycle', 'Fietspad'),
      legendItem('lg-water', 'Water'),
      legendItem('lg-park', 'Park'),
    ),
    h('div', 'ad-bm-compass', fromHTML(ICONS.compass), h('span', null, 'N')),
    scaleBar,
    hintBar([
      { kb: ['M'], pad: ['B'], label: 'Sluiten' },
      { kb: ['+', '−'], pad: ['LB', 'RB'], label: 'Zoomen' },
      { kb: ['←', '→', '↑', '↓'], pad: ['LS'], label: 'Verschuiven' },
      { kb: ['Spatie'], pad: ['A'], label: 'Centreren' },
    ], 'ad-bm-hints'),
  );
  ctx.root.append(bigEl);
  let bigOpen = false;
  let follow = true;
  let bcx = 0;
  let bcz = 0;
  let bppm = 1;
  let bigW = 0;
  let bigH = 0;
  let bigDirty = true;
  let raf = 0;
  let lastBigFollow = 0;
  const bv: MapView = { cx: 0, cz: 0, pxPerM: 1, rotation: 0, ox: 0, oy: 0, w: 0, h: 0 };
  const tmp = { x: 0, y: 0 };
  let landmarks: Landmark[] = [];

  function minZoom(): number {
    if (!map || !bigW) return 0.3;
    const b = map.bounds;
    return Math.min(bigW / (b.maxX - b.minX), bigH / (b.maxZ - b.minZ)) * 0.95;
  }

  function zoomBy(f: number, sx = bigW / 2, sy = bigH / 2): void {
    const old = bppm;
    const dpr = bigW / Math.max(1, big.clientWidth);
    bppm = clamp(bppm * f, minZoom(), 4 * dpr);
    // keep the world point under (sx, sy) fixed
    const wx = bcx + (sx - bigW / 2) / old;
    const wz = bcz + (sy - bigH / 2) / old;
    bcx = wx - (sx - bigW / 2) / bppm;
    bcz = wz - (sy - bigH / 2) / bppm;
    if (f !== 1 && (sx !== bigW / 2 || sy !== bigH / 2)) follow = false;
    clampCenter();
    requestBig();
  }

  function clampCenter(): void {
    if (!map) return;
    const b = map.bounds;
    bcx = clamp(bcx, b.minX, b.maxX);
    bcz = clamp(bcz, b.minZ, b.maxZ);
  }

  function pan(dxPx: number, dyPx: number): void {
    follow = false;
    bcx += dxPx / bppm;
    bcz += dyPx / bppm;
    clampCenter();
    requestBig();
  }

  function requestBig(): void {
    bigDirty = true;
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      if (bigDirty) drawBig();
    });
  }

  function drawBig(): void {
    bigDirty = false;
    if (!bigOpen || !bigW) return;
    const g = big.getContext('2d')!;
    const dpr = bigW / Math.max(1, big.clientWidth);
    g.fillStyle = '#12161c';
    g.fillRect(0, 0, bigW, bigH);
    if (!map) {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.font = `${16 * dpr}px "Segoe UI", sans-serif`;
      g.textAlign = 'center';
      g.fillText('Kaartgegevens worden nog geladen…', bigW / 2, bigH / 2);
      return;
    }
    if (follow) {
      bcx = px;
      bcz = pz;
    }
    bv.cx = bcx;
    bv.cz = bcz;
    bv.pxPerM = bppm;
    bv.rotation = 0;
    bv.ox = bigW / 2;
    bv.oy = bigH / 2;
    bv.w = bigW;
    bv.h = bigH;
    map.draw(g, bv);

    // street labels (collision-avoided), more of them when zoomed in
    if (bppm / dpr > 0.55) {
      const placed: [number, number, number, number][] = [];
      const fs = Math.round(clamp(10.5 + (bppm / dpr - 0.55) * 3, 10.5, 14) * dpr);
      g.font = `600 ${fs}px "Segoe UI", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      let count = 0;
      for (const lb of map.labels) {
        map.project(bv, lb.x, lb.z, tmp);
        if (tmp.x < -50 || tmp.y < -20 || tmp.x > bigW + 50 || tmp.y > bigH + 20) continue;
        const tw = g.measureText(lb.name).width;
        const hw = (Math.abs(Math.cos(lb.angle)) * tw + Math.abs(Math.sin(lb.angle)) * fs) / 2 + 4 * dpr;
        const hh = (Math.abs(Math.sin(lb.angle)) * tw + Math.abs(Math.cos(lb.angle)) * fs) / 2 + 3 * dpr;
        const box: [number, number, number, number] = [tmp.x - hw, tmp.y - hh, tmp.x + hw, tmp.y + hh];
        if (placed.some((p) => p[0] < box[2] && p[2] > box[0] && p[1] < box[3] && p[3] > box[1])) continue;
        // skip labels longer than their street on screen
        if (tw > lb.len * bppm * 0.95) continue;
        placed.push(box);
        g.save();
        g.translate(tmp.x, tmp.y);
        g.rotate(lb.angle);
        g.lineWidth = 3.2 * dpr;
        g.strokeStyle = 'rgba(14,17,22,0.9)';
        g.strokeText(lb.name, 0, 0);
        g.fillStyle = lb.major ? '#ffffff' : 'rgba(225,232,240,0.86)';
        g.fillText(lb.name, 0, 0);
        g.restore();
        if (++count > 140) break;
      }
    }
    // landmarks (or spawn points when no landmark data is available)
    const marks: { name: string; x: number; z: number }[] = landmarks.length ? landmarks : ctx.getSpawnPoints();
    g.font = `600 ${Math.round(12.5 * dpr)}px Bahnschrift, "Segoe UI", sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (const m of marks) {
      map.project(bv, m.x, m.z, tmp);
      if (tmp.x < -100 || tmp.y < -40 || tmp.x > bigW + 100 || tmp.y > bigH + 40) continue;
      const s = 5.5 * dpr;
      g.save();
      g.translate(tmp.x, tmp.y);
      g.rotate(Math.PI / 4);
      g.fillStyle = '#d4202c';
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.6 * dpr;
      g.fillRect(-s, -s, s * 2, s * 2);
      g.strokeRect(-s, -s, s * 2, s * 2);
      g.restore();
      g.lineWidth = 3.5 * dpr;
      g.strokeStyle = 'rgba(10,12,16,0.92)';
      g.strokeText(m.name, tmp.x + 12 * dpr, tmp.y);
      g.fillStyle = '#ffffff';
      g.fillText(m.name, tmp.x + 12 * dpr, tmp.y);
    }
    // player arrow
    map.project(bv, px, pz, tmp);
    g.save();
    g.translate(tmp.x, tmp.y);
    g.rotate(Math.PI - ph);
    const a = 11 * dpr;
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 8 * dpr;
    g.beginPath();
    g.moveTo(0, -a * 1.15);
    g.lineTo(a * 0.82, a * 0.85);
    g.lineTo(0, a * 0.42);
    g.lineTo(-a * 0.82, a * 0.85);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 2 * dpr;
    g.strokeStyle = '#d4202c';
    g.stroke();
    g.restore();
    // pulsing halo
    g.beginPath();
    g.arc(tmp.x, tmp.y, 22 * dpr, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(212,32,44,0.45)';
    g.lineWidth = 1.5 * dpr;
    g.stroke();
    updateScale(dpr);
  }

  function updateScale(dpr: number): void {
    const cssPpm = bppm / dpr;
    const target = 120 / cssPpm; // metres covered by ~120 css px
    const steps = [25, 50, 100, 200, 250, 500, 1000];
    let m = steps[0];
    for (const s of steps) if (s <= target) m = s;
    (scaleBar.firstChild as HTMLElement).style.width = `${(m * cssPpm) / parseFloat(getComputedStyle(scaleBar).fontSize)}em`;
    (scaleBar.lastChild as HTMLElement).textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  }

  function resizeBig(): void {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.round(big.clientWidth * dpr);
    const hh = Math.round(big.clientHeight * dpr);
    if (!w || !hh) return;
    const oldW = bigW;
    bigW = big.width = w;
    bigH = big.height = hh;
    if (!oldW) bppm = Math.max(minZoom(), (bigH / 820) * 1.0);
    requestBig();
  }
  const roBig = new ResizeObserver(resizeBig);
  roBig.observe(big);

  // mouse interaction
  let drag: { x: number; y: number } | null = null;
  big.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    big.setPointerCapture(e.pointerId);
    bigEl.classList.add('is-drag');
  });
  big.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dpr = bigW / Math.max(1, big.clientWidth);
    pan(-(e.clientX - drag.x) * dpr, -(e.clientY - drag.y) * dpr);
    drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => {
    drag = null;
    bigEl.classList.remove('is-drag');
  };
  big.addEventListener('pointerup', endDrag);
  big.addEventListener('pointercancel', endDrag);
  big.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const dpr = bigW / Math.max(1, big.clientWidth);
      const r = big.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
    },
    { passive: false },
  );

  const layer = new NavLayer({
    onBack: () => toggleBigMap(false),
    onBumper: (d) => zoomBy(d > 0 ? 1.25 : 0.8),
    onKey: (e) => {
      const step = 60 * (bigW / Math.max(1, big.clientWidth));
      switch (e.key) {
        case 'm':
        case 'M':
        case 'Escape':
          if (!e.repeat) toggleBigMap(false);
          return true;
        case 'ArrowLeft':
          pan(-step, 0);
          return true;
        case 'ArrowRight':
          pan(step, 0);
          return true;
        case 'ArrowUp':
          pan(0, -step);
          return true;
        case 'ArrowDown':
          pan(0, step);
          return true;
        case '+':
        case '=':
          zoomBy(1.25);
          return true;
        case '-':
        case '_':
          zoomBy(0.8);
          return true;
        case ' ':
        case 'c':
        case 'C':
        case 'Enter':
          follow = true;
          requestBig();
          return true;
        default:
          return false;
      }
    },
    onPadFrame: (pad, dt) => {
      // View (the button that opened the map) closes it again — edge-triggered
      const view = !!pad.buttons[8]?.pressed;
      if (view && !padViewPrev) {
        padViewPrev = true;
        toggleBigMap(false);
        return;
      }
      padViewPrev = view;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const dz = (a: number) => (Math.abs(a) < 0.2 ? 0 : a);
      if (dz(ax) || dz(ay)) {
        const sp = 900 * dt * (bigW / Math.max(1, big.clientWidth));
        pan(dz(ax) * sp, dz(ay) * sp);
      }
      if (pad.buttons[0]?.pressed && !follow) {
        follow = true;
        requestBig();
      }
    },
  });
  // The pad hook handles the stick itself; keep the generic D-pad/stick nav from moving focus.
  layer.setRows([]);

  let padViewPrev = true;
  let toggledAt = -1e9;
  function toggleBigMap(force?: boolean): void {
    // The UI opens the map on M itself and the Vehicle input also emits 'map' for the same key
    // press; ignore an unforced toggle that arrives right after a state change.
    const now = performance.now();
    if (force === undefined && now - toggledAt < 250) return;
    const open = force ?? !bigOpen;
    if (open === bigOpen) return;
    bigOpen = open;
    toggledAt = now;
    padViewPrev = true; // the button that opened it may still be held
    if (open) {
      follow = true;
      bigEl.classList.remove('is-hidden');
      requestAnimationFrame(() => bigEl.classList.add('is-visible'));
      ctx.nav.push(layer);
      resizeBig();
      requestBig();
    } else {
      ctx.nav.remove(layer);
      bigEl.classList.remove('is-visible');
      window.setTimeout(() => {
        if (!bigOpen) bigEl.classList.add('is-hidden');
      }, 260);
    }
  }

  return {
    async setData(map2d, footprints, graph) {
      const token = ++dataToken;
      hooks.onGraph?.(graph);
      const next = await buildStaticMap(map2d, footprints, graph);
      if (token !== dataToken) {
        next.dispose(); // superseded by a newer setData call
        return;
      }
      map?.dispose();
      map = next;
      map.landmarks = landmarks;
      map.paintLandmarks(landmarks);
      mini.classList.remove('is-empty');
      lastRot = 1e9;
      drawMini();
      requestBig();
      hooks.onReady?.();
    },
    update(x, z, heading) {
      px = x;
      pz = z;
      ph = heading;
      if (hudVisible()) drawMini();
      // the full-screen map follows the player at ~8 Hz (labels make a redraw a few ms)
      const now = performance.now();
      if (bigOpen && now - lastBigFollow > 120) {
        lastBigFollow = now;
        requestBig();
      }
    },
    toggleBigMap,
    get bigMapOpen() {
      return bigOpen;
    },
    setLandmarks(l) {
      landmarks = l ?? [];
      if (map) {
        map.landmarks = landmarks;
        // landmark footprints (De Waag, Accijnstoren, molen) are not in footprints.json
        if (map.paintLandmarks(landmarks)) {
          lastRot = 1e9;
          if (hudVisible()) drawMini();
          hooks.onReady?.(); // menu / pause thumbnails redraw from the updated map
        }
      }
      requestBig();
    },
    getMap() {
      return map;
    },
    dispose() {
      ro.disconnect();
      roBig.disconnect();
      cancelAnimationFrame(raf);
      ctx.nav.remove(layer);
      map?.dispose();
      map = null;
      mini.remove();
      bigEl.remove();
    },
  };
}
