// Dev scene of the world module: the whole city as the game loads it.
//   ?scene=dev-city
//   &spawn=<spawnId>        camera at a spawn point (osm-meta), eye height, looking along the heading
//   &street=<name>[&along=0.4][&flip=1]  camera on a named street (road graph), looking along it
//   &view=<preset>          aerial | waag | kerk | verdronkenoord | luttik | accijnstoren | molen | brug | langestraat | station
//   &cam=x,y,z&look=x,y,z   explicit camera (devCamera)
//   &eye=1.7                eye height for spawn/street
//   &sb=2&sg=4              super-chunk size in 200 m chunks (buildings / ground)
//   &props=0 &landmarks=0 &buildings=0 &backdrop=0 &physics=0 &compile=0 &hud=0 &night=0..1
// Controls: orbit (mouse), fly with WASD + Q/E (down/up), Shift = fast.
// window.__debug: world, physics, setCam(...), goto(spawnId), street(name, along, flip), heightAt(x,z),
//                 surfaceAt(x,z), stats(), setQuality(level)
import * as THREE from 'three';
import type { Engine, PhysicsWorld, QualityLevel, SceneEntry } from '../contracts';
import { setupDevCamera } from '../dev/devCamera';
import { loadWorld, type WorldExt } from '../world/world';

type PhysicsModule = { createPhysics: () => Promise<PhysicsWorld> };
const physicsModules = import.meta.glob<PhysicsModule>('../physics/physics.ts');

const VIEWS: Record<string, { cam: [number, number, number]; look: [number, number, number] }> = {
  aerial: { cam: [380, 420, 700], look: [-260, 0, -60] },
  aerialHigh: { cam: [420, 720, 980], look: [-260, 0, -60] },
  waag: { cam: [36, 1.7, -36], look: [0, 9, 2] },
  waagZuid: { cam: [18, 1.7, 38], look: [0, 10, 0] },
  waagLow: { cam: [95, 45, -95], look: [0, 5, 0] },
  kerk: { cam: [-322, 1.7, -95], look: [-422, 14, -136] },
  kerkLow: { cam: [-330, 60, -40], look: [-430, 10, -140] },
  verdronkenoord: { cam: [40, 1.7, 192], look: [108, 2, 236] },
  luttik: { cam: [140, 1.7, 62], look: [240, 2, 125] },
  mient: { cam: [28, 1.7, 56], look: [-8, 3, 112] },
  accijnstoren: { cam: [339, 1.7, 276], look: [314, 9, 329] },
  molen: { cam: [-550, 1.7, 104], look: [-565, 12, 146] },
  molenSingel: { cam: [-637, 1.7, 128], look: [-565, 12, 146] },
  molenLow: { cam: [-470, 50, 60], look: [-565, 5, 146] },
  brug: { cam: [140, 1.7, 62], look: [240, 2, 125] },
  friesebrug: { cam: [296, 1.7, -66], look: [322, 0.5, -110] },
  brugLow: { cam: [335, 9, -70], look: [310, 0, -92] },
  langestraat: { cam: [-232, 1.7, -33], look: [-300, 4, -80] }, // on the street axis, towards the Stadhuis
  station: { cam: [-592, 1.7, -812], look: [-640, 6, -760] },
  stationLow: { cam: [-520, 70, -660], look: [-640, 0, -800] },
};

function parseVec(s: string | null): THREE.Vector3 | null {
  if (!s) return null;
  const p = s.split(',').map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? new THREE.Vector3(p[0], p[1], p[2]) : null;
}

/** Loading text + stats overlay (top-left). */
function createOverlay(): { el: HTMLDivElement; set(text: string): void } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:50;padding:6px 9px;background:rgba(10,12,14,.62);color:#e8ecef;' +
    'font:12px/1.35 Consolas,monospace;white-space:pre;border-radius:4px;pointer-events:none;';
  document.body.appendChild(el);
  return { el, set: (t) => (el.textContent = t) };
}

function streetCamera(world: WorldExt, name: string, along: number, flip: boolean, eye: number) {
  const edges = world.roadGraph.edges.filter((e) => e.name?.toLowerCase() === name.toLowerCase());
  if (!edges.length) return null;
  const e = edges.reduce((a, b) => (b.len > a.len ? b : a));
  const pts = flip ? [...e.pts].reverse() : e.pts;
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(l);
    total += l;
  }
  let target = total * Math.min(1, Math.max(0, along));
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const t = seg[i] > 0 ? Math.min(1, target / seg[i]) : 0;
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const dx = (bx - ax) / (seg[i] || 1), dz = (bz - az) / (seg[i] || 1);
      const y = world.heightAt(x, z) + eye;
      return { cam: new THREE.Vector3(x, y, z), look: new THREE.Vector3(x + dx * 30, y - 0.3, z + dz * 30) };
    }
    target -= seg[i];
  }
  return null;
}

const devCity: SceneEntry = async (engine: Engine, params: URLSearchParams) => {
  const overlay = createOverlay();
  const hud = params.get('hud') !== '0';
  if (!hud) overlay.el.style.display = 'none';
  const flag = (k: string, def = true): boolean => (params.has(k) ? params.get(k) !== '0' : def);

  let physics: PhysicsWorld | null = null;
  const loadPhysics = physicsModules['../physics/physics.ts'];
  if (flag('physics') && loadPhysics) {
    try {
      physics = await (await loadPhysics()).createPhysics();
    } catch (e) {
      console.warn('[dev-city] physics niet beschikbaar:', e);
    }
  }

  engine.start(); // keep the sky/loading frames running while the city streams in
  const world = await loadWorld(engine, physics, (f, label) => overlay.set(`${label} … ${(f * 100).toFixed(0)}%`), {
    props: flag('props'),
    landmarks: flag('landmarks'),
    buildings: flag('buildings'),
    backdrop: flag('backdrop'),
    compileShaders: flag('compile'),
    superChunk: { building: Number(params.get('sb') ?? 2), ground: Number(params.get('sg') ?? 4) },
  });
  if (params.has('night')) world.setNight(Number(params.get('night')));

  // ---------------------------------------------------------------- camera
  const eye = Number(params.get('eye') ?? 1.7);
  let cam = new THREE.Vector3(420, 720, 980);
  let look = new THREE.Vector3(-260, 0, -60);
  // street-level presets (y < 3) stand on the local ground (sidewalk 0.12, bridge decks)
  const resolveView = (name: string): { cam: THREE.Vector3; look: THREE.Vector3 } | null => {
    const v = VIEWS[name];
    if (!v) return null;
    const c = new THREE.Vector3(...v.cam);
    const l = new THREE.Vector3(...v.look);
    if (c.y < 3) {
      const g = Math.max(0, world.heightAt(c.x, c.z)); // over water: street level
      c.y += g;
      l.y += g;
    }
    return { cam: c, look: l };
  };
  const view = resolveView(params.get('view') ?? '');
  if (view) {
    cam = view.cam;
    look = view.look;
  }
  const spawnId = params.get('spawn');
  if (spawnId) {
    const s = world.spawn(spawnId);
    const y = world.heightAt(s.x, s.z) + eye;
    cam.set(s.x, y, s.z);
    look.set(s.x + Math.sin(s.heading) * 30, y - 0.3, s.z + Math.cos(s.heading) * 30);
  }
  const street = params.get('street');
  if (street) {
    const sc = streetCamera(world, street, Number(params.get('along') ?? 0.4), params.get('flip') === '1', eye);
    if (sc) {
      cam = sc.cam;
      look = sc.look;
    } else console.warn(`[dev-city] straat "${street}" niet gevonden`);
  }
  // explicit cam/look win (devCamera parses them)
  const controls = setupDevCamera(engine, params, { cam, look });
  controls.maxPolarAngle = Math.PI * 0.62; // allow looking up at towers from street level

  // fly controls
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  engine.onUpdate((dt) => {
    if (!keys.size) return;
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 80 : 20) * dt;
    engine.camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    right.set(-fwd.z, 0, fwd.x);
    move.set(0, 0, 0);
    if (keys.has('KeyW')) move.add(fwd);
    if (keys.has('KeyS')) move.sub(fwd);
    if (keys.has('KeyD')) move.add(right);
    if (keys.has('KeyA')) move.sub(right);
    if (keys.has('KeyE')) move.y += 1;
    if (keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(speed);
    engine.camera.position.add(move);
    controls.target.add(move);
  }, 45);

  // ---------------------------------------------------------------- per-frame
  if (physics) engine.onUpdate((dt) => physics!.step(dt), 10);
  engine.onUpdate((dt) => world.update(dt, engine.camera.position), 40);

  let acc = 0;
  engine.onUpdate((dt) => {
    acc += dt;
    if (acc < 0.5 || !hud) return;
    acc = 0;
    const s = engine.stats;
    const ws = world.stats();
    const p = engine.camera.position;
    overlay.set(
      `fps ${s.fps.toFixed(0)}  ${s.frameMs.toFixed(1)} ms\n` +
        `draw calls ${s.drawCalls}  tris ${(s.triangles / 1e6).toFixed(2)} M\n` +
        `stad meshes ${ws.visibleMeshes}/${ws.meshes}  props ${ws.props?.drawCalls ?? 0} dc\n` +
        `kwaliteit ${engine.quality.level}  laadtijd ${(world.loadMs / 1000).toFixed(1)} s\n` +
        `pos ${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)}  grond ${world.heightAt(p.x, p.z).toFixed(2)} ${world.surfaceAt(p.x, p.z) ?? '-'}`,
    );
  }, 60);

  window.__debug = window.__debug ?? {};
  Object.assign(window.__debug, {
    world,
    physics,
    goto(id: string): void {
      const s = world.spawn(id);
      const y = world.heightAt(s.x, s.z) + eye;
      (window.__debug!.setCam as (...a: number[]) => void)(s.x, y, s.z, s.x + Math.sin(s.heading) * 30, y - 0.3, s.z + Math.cos(s.heading) * 30);
    },
    street(name: string, along = 0.4, flip = false): boolean {
      const sc = streetCamera(world, name, along, flip, eye);
      if (!sc) return false;
      (window.__debug!.setCam as (...a: number[]) => void)(sc.cam.x, sc.cam.y, sc.cam.z, sc.look.x, sc.look.y, sc.look.z);
      return true;
    },
    view(name: string): boolean {
      const v = resolveView(name);
      if (!v) return false;
      (window.__debug!.setCam as (...a: number[]) => void)(v.cam.x, v.cam.y, v.cam.z, v.look.x, v.look.y, v.look.z);
      return true;
    },
    heightAt: (x: number, z: number) => world.heightAt(x, z),
    surfaceAt: (x: number, z: number) => world.surfaceAt(x, z),
    raycast: (x: number, z: number) => physics?.raycastDown(x, z, 50) ?? null,
    stats: () => ({ engine: { ...engine.stats }, world: world.stats(), loadMs: world.loadMs, timings: world.timings }),
    setQuality: (level: QualityLevel) => engine.setQuality({ level }),
    /**
     * Compares world.heightAt with a physics ray cast at n random points of the playable rect
     * (land only) and on all car road nodes; reports the error distribution, the surface tags the
     * rays hit and the heightAt cost.
     */
    heightCheck(n = 4000): Record<string, unknown> {
      if (!physics) return { error: 'geen physics' };
      const r = world.osmMeta.playable;
      const ext = physics as PhysicsWorld & { raycast?: (o: THREE.Vector3, d: THREE.Vector3, m: number) => { tag?: string } | null };
      const errs: number[] = [];
      const tags: Record<string, number> = {};
      const bad: string[] = [];
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) pts.push([r.minX + rnd() * (r.maxX - r.minX), r.minZ + rnd() * (r.maxZ - r.minZ)]);
      for (const e of world.roadGraph.edges) if (e.car) for (const p of e.pts) pts.push(p);
      const o = new THREE.Vector3(), d = new THREE.Vector3(0, -1, 0);
      for (const [x, z] of pts) {
        if (world.isWater(x, z) || world.surfaceAt(x, z) === null) continue;
        const ray = physics.raycastDown(x, z, 30);
        if (ray === null) continue;
        const h = world.heightAt(x, z);
        const err = Math.abs(h - ray);
        errs.push(err);
        if (err > 0.3 && bad.length < 8) bad.push(`${x.toFixed(1)},${z.toFixed(1)}: grid ${h.toFixed(2)} ray ${ray.toFixed(2)}`);
        const hit = ext.raycast?.(o.set(x, 30, z), d, 60);
        const t = hit?.tag ?? '?';
        tags[t] = (tags[t] ?? 0) + 1;
      }
      errs.sort((a, b) => a - b);
      const q = (f: number) => +(errs[Math.floor(f * (errs.length - 1))] ?? 0).toFixed(3);
      const t0 = performance.now();
      let s = 0;
      for (let i = 0; i < 200000; i++) s += world.heightAt(r.minX + (i % 1000) * 1.7, r.minZ + (i % 937) * 1.6);
      const usPerCall = ((performance.now() - t0) / 200000) * 1000;
      return { samples: errs.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1), over30cm: errs.filter((e) => e > 0.3).length, bad, tags, usPerCall: +usPerCall.toFixed(3), s: Math.sign(s) };
    },
    /** Main-pass draw calls / triangles of the city meshes per material inside the view frustum. */
    breakdown(): Record<string, [number, number]> {
      const cam = engine.camera;
      cam.updateMatrixWorld();
      const fr = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
      );
      const out: Record<string, [number, number]> = {};
      world.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.visible || !m.geometry.boundingSphere) return;
        let p: THREE.Object3D | null = m;
        while (p) {
          if (!p.visible) return;
          p = p.parent;
        }
        if (!fr.intersectsObject(m)) return;
        const key = m.name.split(':').slice(0, 2).join(':') || (m as THREE.Mesh & { isInstancedMesh?: boolean }).type;
        const tris = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
        const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
        const e = (out[key] ??= [0, 0]);
        e[0]++;
        e[1] += Math.round(tris * inst);
      });
      return out;
    },
  });

  window.__ready = true;
};

export default devCity;
