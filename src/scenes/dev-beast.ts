// Beast physics test arena (beast-physics module). ?scene=dev-beast
//
// A 16 x 16 m platform 3 m above the water with a low wall, a ledge block to hang from and a few
// boxes; no city (unless city=1). One keyboard-controlled beast + N dummies.
//
// Besturing (toetsenbord):
//   WASD / pijltjes  lopen (t.o.v. de camera)     Shift   rennen
//   Spatie           springen (vasthouden aan een richel: optrekken; loslaten: afzetten)
//   Q / linkermuis   linkerhand (tik = stoot, vasthouden = grijpen)
//   E / rechtermuis  rechterhand
//   F                optillen (met iets vast) / juichen; loslaten = gooien
//   C                trappen (in de lucht: dropkick)
//   Ctrl             bukken (kort tikken = kopstoot)
//   R                reset (alle beesten terug)    K   dummy knock-out    T  volgende testpositie
//
// Params:
//   beasts=N            number of dummy beasts (default 1)
//   dummy=idle|wander|fight   dummy behaviour (default idle)
//   test=walk|punch|kick|headbutt|grab|drag|throw|ko|ledge|water|fall|perf   scripted test; results in the console
//                       ("[beast-test] RESULT {...}") and window.__debug.results
//   devcam=1            free orbit camera (cam=x,y,z&look=x,y,z)
//   camyaw=<deg>        follow camera yaw (default 0 = looking north/-z), camdist=<m>
//   city=1              load the real city and fight on the Kaasmarkt near the canal instead
//   hud=0               hide the debug HUD
//   scale=<s>           player scale
//   visual=fallback     use the simple capsule visuals instead of src/beast/visual
import * as THREE from 'three';
import { WATER_LEVEL } from '../config';
import type { Engine, SceneEntry } from '../contracts';
import type { BeastInput } from '../brawl/contracts';
import { setupDevCamera } from '../dev/devCamera';
import { COLLISION_GROUPS, createPhysics } from '../physics/physics';
import { createBeastSystem, type BeastExt, type BeastSystemExt } from '../beast/physics';
import type { WorldExt } from '../world/types';

const COLOURS = ['#f2a03d', '#4f9be8', '#e8505b', '#66c45a', '#b07ce0', '#f4d548', '#5ad1c8', '#f08fc0'];
const PLATFORM_Y = WATER_LEVEL + 3; // top of the platform
const HALF = 8;

function neutralInput(): BeastInput {
  return { moveX: 0, moveZ: 0, jump: false, duck: false, lift: false, kick: false, grabLeft: false, grabRight: false, run: false };
}

function checker(engine: Engine, a: string, b: string, cells: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const n = 256 / cells;
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++) {
      g.fillStyle = (i + j) % 2 ? a : b;
      g.fillRect(i * n, j * n, n, n);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, engine.renderer.capabilities.getMaxAnisotropy());
  return t;
}

interface ArenaBox {
  mesh: THREE.Mesh;
  body: unknown;
}

async function buildArena(engine: Engine, physics: Awaited<ReturnType<typeof createPhysics>>): Promise<{ boxes: ArenaBox[]; ledge: THREE.Vector3 }> {
  const scene = engine.scene;
  const R = physics.RAPIER;
  let floorMat: THREE.Material = new THREE.MeshStandardMaterial({ map: checker(engine, '#8d8a80', '#7f7c73', 16), roughness: 0.85 });
  let wallMat: THREE.Material = new THREE.MeshStandardMaterial({ color: 0x9a5a3c, roughness: 0.8 });
  let boxMat: THREE.Material = new THREE.MeshStandardMaterial({ color: 0xb08850, roughness: 0.7 });
  let waterMesh: THREE.Mesh | null = null;
  try {
    const { createMaterialLibrary } = await import('../world/materials');
    const lib = await createMaterialLibrary(engine);
    floorMat = lib.pbr('square_cobbles', { repeat: 16 / lib.metres('square_cobbles') });
    wallMat = lib.pbr('brick_quay', { repeat: [3, 1] });
    boxMat = lib.pbr('wood', { repeat: 1 });
    const wg = new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2);
    waterMesh = lib.createWater(wg);
    waterMesh.position.y = WATER_LEVEL;
  } catch (e) {
    console.warn('[dev-beast] materialen niet beschikbaar:', e);
  }
  if (!waterMesh) {
    waterMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x2d5a6a, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }),
    );
    waterMesh.position.y = WATER_LEVEL;
  }
  scene.add(waterMesh);

  const addBox = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, mat: THREE.Material, tag: string) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
    m.position.set(cx, cy, cz);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    physics.addStaticBox(new THREE.Vector3(cx, cy, cz), new THREE.Vector3(hx, hy, hz), 0, tag);
  };
  // platform + pillars
  addBox(0, PLATFORM_Y - 0.25, 0, HALF, 0.25, HALF, floorMat, 'ground');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) addBox(sx * (HALF - 1), (PLATFORM_Y - 0.5 + WATER_LEVEL - 2) / 2, sz * (HALF - 1), 0.5, (PLATFORM_Y - 0.5 - WATER_LEVEL + 2) / 2, 0.5, wallMat, 'post');
  // low wall on the west edge
  addBox(-HALF + 0.2, PLATFORM_Y + 0.275, 0, 0.2, 0.275, 4, wallMat, 'wall');
  // ledge block (top 1.75 m above the floor) on the north side
  const ledgeTop = PLATFORM_Y + 1.75;
  addBox(3, PLATFORM_Y + 0.875, -6, 2, 0.875, 1.5, wallMat, 'wall');
  // canal bed
  physics.addStaticBox(new THREE.Vector3(0, WATER_LEVEL - 3.5, 0), new THREE.Vector3(200, 0.5, 200), 0, 'canal_bed');

  // dynamic boxes (props)
  const boxes: ArenaBox[] = [];
  const world = physics.world;
  for (const [x, z] of [
    [-4, -4],
    [-3.2, -4.4],
    [5, 3],
  ]) {
    const s = 0.3;
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, PLATFORM_Y + s + 0.01, z));
    world.createCollider(R.ColliderDesc.cuboid(s, s, s).setMass(14).setFriction(0.7).setCollisionGroups(COLLISION_GROUPS.prop), body);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s * 2, s * 2, s * 2), boxMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    boxes.push({ mesh, body });
  }
  return { boxes, ledge: new THREE.Vector3(3, ledgeTop, -4.5) };
}

// ------------------------------------------------------------------------------------ keyboard
function createKeyboard(engine: Engine) {
  const down = new Set<string>();
  const mouse = [false, false, false];
  const taps: string[] = [];
  const onKey = (e: KeyboardEvent, d: boolean) => {
    if (d) {
      if (!down.has(e.code)) taps.push(e.code);
      down.add(e.code);
    } else down.delete(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ControlLeft', 'ControlRight'].includes(e.code)) e.preventDefault();
  };
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  engine.canvas.addEventListener('mousedown', (e) => (mouse[e.button] = true));
  window.addEventListener('mouseup', (e) => (mouse[e.button] = false));
  engine.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  return {
    read(out: BeastInput, camYaw: number): BeastInput {
      let x = 0;
      let z = 0;
      if (down.has('KeyW') || down.has('ArrowUp')) z += 1;
      if (down.has('KeyS') || down.has('ArrowDown')) z -= 1;
      if (down.has('KeyA') || down.has('ArrowLeft')) x -= 1;
      if (down.has('KeyD') || down.has('ArrowRight')) x += 1;
      const l = Math.hypot(x, z) || 1;
      x /= l;
      z /= l;
      // camera-relative: forward = camera look direction projected (yaw 0 = looking -z)
      const fx = -Math.sin(camYaw);
      const fz = -Math.cos(camYaw);
      const rx = -fz;
      const rz = fx;
      out.moveX = fx * z + rx * x;
      out.moveZ = fz * z + rz * x;
      out.jump = down.has('Space');
      out.duck = down.has('ControlLeft') || down.has('ControlRight');
      out.lift = down.has('KeyF');
      out.kick = down.has('KeyC');
      out.grabLeft = down.has('KeyQ') || mouse[0];
      out.grabRight = down.has('KeyE') || mouse[2];
      out.run = down.has('ShiftLeft') || down.has('ShiftRight');
      return out;
    },
    takeTaps(): string[] {
      return taps.splice(0, taps.length);
    },
    get active(): boolean {
      return down.size > 0 || mouse.some(Boolean);
    },
  };
}

// ------------------------------------------------------------------------------------ scene
const devBeast: SceneEntry = async (engine, params) => {
  const physics = await createPhysics();
  const testName = params.get('test');
  const useCity = params.get('city') === '1';
  let world: WorldExt | null = null;
  let boxes: ArenaBox[] = [];
  let ledge = new THREE.Vector3(3, PLATFORM_Y + 1.75, -4.5);
  let origin = new THREE.Vector3(0, PLATFORM_Y, 0);
  /** horizontal direction from the spawn toward the water (dev arena: +z edge) */
  const toWater = new THREE.Vector3(0, 0, 1);

  engine.start();
  if (useCity) {
    const { loadWorld } = await import('../world/world');
    world = await loadWorld(engine, physics, undefined, {});
    // spot on the Kaasmarkt near the canal: nearest open water around De Waag (world origin)
    let best = Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      for (let r = 10; r < 120; r += 0.5) {
        const x = dx * r;
        const z = dz * r;
        if (world.isInsideBuilding(x, z)) break;
        if (world.isWater(x, z)) {
          if (r < best) {
            best = r;
            toWater.set(dx, 0, dz);
          }
          break;
        }
      }
    }
    if (!Number.isFinite(best)) best = 30;
    const ox = toWater.x * (best - 6);
    const oz = toWater.z * (best - 6);
    origin = new THREE.Vector3(ox, Math.max(0, world.heightAt(ox, oz)), oz);
    console.info('[dev-beast] stad: water op', best.toFixed(1), 'm richting', toWater.toArray().map((v) => v.toFixed(2)).join(','));
  } else {
    const a = await buildArena(engine, physics);
    boxes = a.boxes;
    ledge = a.ledge;
  }

  const system: BeastSystemExt = await createBeastSystem(engine, physics, {
    world,
    visual: params.get('visual') === 'fallback' ? 'fallback' : 'auto',
  });
  const nDummies = Math.max(0, Math.min(7, Number(params.get('beasts') ?? (testName === 'walk' || testName === 'ledge' || testName === 'water' || testName === 'fall' ? 0 : 1))));
  const dummyMode = params.get('dummy') ?? (testName === 'perf' ? 'fight' : 'idle');

  const spawnPlayer = useCity ? origin.clone() : new THREE.Vector3(origin.x, origin.y, origin.z + 2);
  const player = system.spawn(
    { name: 'Speler', colour: COLOURS[0], costume: params.get('costume') ?? 'kaasdrager', isBot: false, scale: Number(params.get('scale') ?? 1) },
    spawnPlayer,
    Math.PI,
  );
  const dummies: BeastExt[] = [];
  for (let i = 0; i < nDummies; i++) {
    const a = (i / Math.max(1, nDummies)) * Math.PI * 2;
    const p = nDummies === 1 ? new THREE.Vector3(origin.x, origin.y, origin.z + 0.9) : new THREE.Vector3(origin.x + Math.sin(a) * 3.5, origin.y, origin.z + Math.cos(a) * 3.5 - 1);
    const facing = nDummies === 1 ? 0 : Math.atan2(spawnPlayer.x - p.x, spawnPlayer.z - p.z);
    dummies.push(system.spawn({ name: `Dummy ${i + 1}`, colour: COLOURS[(i + 1) % COLOURS.length], costume: 'tourist', isBot: true }, p, facing));
  }
  const dummyInputs = dummies.map(() => neutralInput());

  // ---------------------------------------------------------------- events log
  const events: string[] = [];
  const results: Record<string, unknown> = {};
  const counters = { hits: 0, kos: 0, grabs: 0, splashes: 0, maxHit: 0 };
  const firstTimes: Record<string, number> = {};
  const simNow = () => physics.time;
  system.on({
    onHit(t, a, s) {
      counters.hits++;
      counters.maxHit = Math.max(counters.maxHit, s);
      if (events.length < 60) events.push(`${simNow().toFixed(2)} hit ${a?.options.name ?? 'omgeving'} -> ${t.options.name} ${s.toFixed(2)}`);
    },
    onKnockout(t) {
      counters.kos++;
      firstTimes['ko_' + t.id] ??= simNow();
      events.push(`${simNow().toFixed(2)} KO ${t.options.name}`);
    },
    onGrab(g, t) {
      counters.grabs++;
      firstTimes['grab_' + g.id] ??= simNow();
      events.push(`${simNow().toFixed(2)} grab ${g.options.name} -> ${t?.options.name ?? 'object'}`);
    },
    onSplash(t) {
      counters.splashes++;
      firstTimes['splash_' + t.id] ??= simNow();
      events.push(`${simNow().toFixed(2)} splash ${t.options.name}`);
    },
  });

  // ---------------------------------------------------------------- camera
  const devcam = params.get('devcam') === '1';
  let camYaw = (Number(params.get('camyaw') ?? 0) * Math.PI) / 180;
  const camDist = Number(params.get('camdist') ?? 7.5);
  const camTarget = new THREE.Vector3().copy(player.position);
  if (devcam) {
    setupDevCamera(engine, params, {
      cam: new THREE.Vector3(origin.x + 6, origin.y + 5, origin.z + 9),
      look: new THREE.Vector3(origin.x, origin.y + 0.8, origin.z),
    });
  } else {
    const tmp = new THREE.Vector3();
    engine.onUpdate((dt) => {
      // frame the player and the nearest dummy (Gang Beasts style group framing)
      tmp.copy(player.position);
      let n = 1;
      for (const d of dummies) {
        if (d.position.distanceTo(player.position) < 9) {
          tmp.add(d.position);
          n++;
        }
      }
      tmp.multiplyScalar(1 / n);
      camTarget.lerp(tmp, 1 - Math.exp(-dt * 4));
      const cam = engine.camera;
      const dist = camDist;
      cam.position.set(camTarget.x + Math.sin(camYaw) * dist, camTarget.y + dist * 0.62, camTarget.z + Math.cos(camYaw) * dist);
      cam.lookAt(camTarget.x, camTarget.y + 0.2, camTarget.z);
      engine.setFocus(camTarget);
    }, 50);
  }

  // ---------------------------------------------------------------- input
  const keyboard = createKeyboard(engine);
  const playerInput = neutralInput();
  let scripted = !!testName;
  const resetAll = () => {
    player.teleport(spawnPlayer, Math.PI);
    dummies.forEach((d, i) => {
      const a = (i / Math.max(1, nDummies)) * Math.PI * 2;
      const p = nDummies === 1 ? new THREE.Vector3(origin.x, origin.y, origin.z + 0.9) : new THREE.Vector3(origin.x + Math.sin(a) * 3.5, origin.y, origin.z + Math.cos(a) * 3.5 - 1);
      d.teleport(p, 0);
    });
  };

  // dummy brains
  let wanderT = 0;
  const wanderDir = dummies.map(() => new THREE.Vector2());
  const dummyBrain = (dt: number) => {
    wanderT -= dt;
    dummies.forEach((d, i) => {
      const inp = dummyInputs[i];
      if (dummyMode === 'idle' || d.state === 'eliminated') {
        Object.assign(inp, neutralInput());
      } else {
        if (wanderT <= 0) wanderDir[i].set(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        let tx = wanderDir[i].x;
        let tz = wanderDir[i].y;
        // stay on the platform
        const p = d.position;
        if (!useCity && (Math.abs(p.x - origin.x) > HALF - 2 || Math.abs(p.z - origin.z) > HALF - 2)) {
          tx = origin.x - p.x;
          tz = origin.z - p.z;
        }
        let near: BeastExt | null = null;
        if (dummyMode === 'fight') {
          let best = 1e9;
          for (const o of system.beasts) {
            if (o === d || o.state === 'eliminated' || o.mode === 'ko') continue;
            const dd = o.position.distanceToSquared(p);
            if (dd < best) {
              best = dd;
              near = o;
            }
          }
          if (near && best < 36) {
            tx = near.position.x - p.x;
            tz = near.position.z - p.z;
          }
        }
        const l = Math.hypot(tx, tz) || 1;
        inp.moveX = (tx / l) * 0.8;
        inp.moveZ = (tz / l) * 0.8;
        const close = near ? near.position.distanceTo(p) < 1.3 : false;
        const ph = (physics.time * 2.3 + i * 0.37) % 1;
        inp.grabLeft = close && ph < 0.1;
        inp.grabRight = close && ph > 0.5 && ph < 0.6;
        if (close) {
          inp.moveX *= 0.3;
          inp.moveZ *= 0.3;
        }
        inp.jump = false;
      }
      d.setInput(inp);
    });
    if (wanderT <= 0) wanderT = 2 + Math.random() * 2;
  };

  // ---------------------------------------------------------------- scripted tests
  type Script = (t: number, dt: number) => boolean; // returns true when done
  const P = player;
  const D = dummies[0] ?? null;
  const set = (o: Partial<BeastInput>) => Object.assign(playerInput, neutralInput(), o);
  const log = (name: string, data: Record<string, unknown>) => {
    results[name] = data;
    console.info(`[beast-test] RESULT ${JSON.stringify({ test: name, ...data })}`);
  };
  const tmpV = new THREE.Vector3();
  const tilt = (b: BeastExt) => {
    const c = b.parts[1];
    tmpV.set(0, 1, 0).applyQuaternion(c.quat);
    return Math.acos(Math.min(1, Math.max(-1, tmpV.y)));
  };
  /** approach the dummy and repeat a tapped action; logs hits and damage */
  const strikeTest = (name: string, every: number, tap: number, press: (on: boolean) => void): Script => {
    let next = 0.8;
    let presses = 0;
    let release = -1;
    let hits0 = -1;
    return (t) => {
      if (!D) return true;
      if (hits0 < 0) hits0 = counters.hits;
      set({});
      const dx = D.position.x - P.position.x;
      const dz = D.position.z - P.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.9 && (release < 0 || t > release + 0.3)) set({ moveX: (dx / d) * 0.5, moveZ: (dz / d) * 0.5 });
      if (t >= next && D.mode !== 'ko') {
        release = t + tap;
        next = t + every;
        presses++;
      }
      press(release > 0 && t < release);
      if (D.mode === 'ko' || t > 12) {
        log(name, { presses, hits: counters.hits - hits0, timeToKo: firstTimes['ko_' + D.id] ?? null, dummyHealth: +D.health.toFixed(1), maxStrength: +counters.maxHit.toFixed(2), events: events.slice(-6) });
        return true;
      }
      return false;
    };
  };
  const scripts: Record<string, () => Script> = {
    walk: () => {
      const st = { speedSum: 0, speedN: 0, maxTilt: 0, turnT: -1, z0: 0, standVar: 0, standN: 0, pelvisMin: 9, pelvisMax: 0, runSum: 0, runN: 0 };
      return (t) => {
        if (t < 0.5) set({});
        else if (t < 3.5) set({ moveX: -1 });
        else if (t < 6) set({ moveZ: -1 });
        else if (t < 8) set({ moveX: 0.8, moveZ: 0.6, run: true });
        else set({});
        const vh = Math.hypot(P.velocity.x, P.velocity.z);
        if (t > 1.5 && t < 3.5) {
          st.speedSum += vh;
          st.speedN++;
        }
        if (t > 6.8 && t < 8) {
          st.runSum += vh;
          st.runN++;
          if (t > 7.5 && t < 7.51) console.info('[beast-test] run sample', P.mode, P.strength.toFixed(2), vh.toFixed(2), JSON.stringify(P.position.toArray().map((v) => +v.toFixed(2))));
        }
        if (t > 3.4 && t < 3.41) console.info('[beast-test] walk end', JSON.stringify(P.position.toArray().map((v) => +v.toFixed(2))));
        if (t > 5.9 && t < 5.91) console.info('[beast-test] turn end', JSON.stringify(P.position.toArray().map((v) => +v.toFixed(2))));
        if (t > 0.5) st.maxTilt = Math.max(st.maxTilt, tilt(P));
        if (t > 3.5 && st.turnT < 0 && Math.abs(((P.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > Math.PI - 0.26) st.turnT = t - 3.5;
        if (t > 9.5) {
          const py = P.parts[0].pos.y - P.groundY;
          st.pelvisMin = Math.min(st.pelvisMin, py);
          st.pelvisMax = Math.max(st.pelvisMax, py);
        }
        if (t > 11) {
          log('walk', {
            walkSpeed: +(st.speedSum / Math.max(1, st.speedN)).toFixed(2),
            runSpeed: +(st.runSum / Math.max(1, st.runN)).toFixed(2),
            maxTiltDeg: +((st.maxTilt * 180) / Math.PI).toFixed(1),
            turn90s: +st.turnT.toFixed(2),
            standPelvisRange: [+st.pelvisMin.toFixed(3), +st.pelvisMax.toFixed(3)],
            mode: P.mode,
          });
          return true;
        }
        return false;
      };
    },
    punch: () => {
      let next = 0.6;
      let side = 0;
      let punches = 0;
      let release = -1;
      return (t) => {
        if (!D) return true;
        set({});
        // keep facing the dummy and close the distance
        const dx = D.position.x - P.position.x;
        const dz = D.position.z - P.position.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.95) set({ moveX: (dx / d) * 0.6, moveZ: (dz / d) * 0.6 });
        if (t >= next && D.mode !== 'ko') {
          release = t + 0.06;
          next = t + 0.45;
          side = 1 - side;
          punches++;
        }
        if (release > 0 && t < release) {
          if (side) playerInput.grabRight = true;
          else playerInput.grabLeft = true;
        }
        if (D.mode === 'ko' || t > 14) {
          log('punch', { punches, hits: counters.hits, timeToKo: firstTimes['ko_' + D.id] ?? null, dummyHealth: +D.health.toFixed(1), events: events.slice(0, 12) });
          return true;
        }
        return false;
      };
    },
    kick: () => strikeTest('kick', 0.75, 0.09, (on) => (playerInput.kick = on)),
    headbutt: () => strikeTest('headbutt', 1.0, 0.1, (on) => (playerInput.duck = on)),
    ko: () => {
      const inner = scripts.punch();
      let koAt = -1;
      let wokeAt = -1;
      let standAt = -1;
      return (t, dt) => {
        if (!D) return true;
        if (koAt < 0) {
          inner(t, dt);
          if (D.mode === 'ko') koAt = t;
          if (t > 14) {
            log('ko', { koAt: null });
            return true;
          }
          return false;
        }
        set({});
        if (wokeAt < 0 && D.mode !== 'ko') wokeAt = t;
        if (wokeAt > 0 && standAt < 0 && D.mode === 'stand' && D.parts[1].pos.y - D.groundY > 0.82) standAt = t;
        if (standAt > 0 || t > koAt + 14) {
          log('ko', { koAt: +koAt.toFixed(2), koDuration: +(wokeAt - koAt).toFixed(2), getUpTime: standAt > 0 ? +(standAt - wokeAt).toFixed(2) : null, hits: counters.hits });
          return true;
        }
        return false;
      };
    },
    grab: () => {
      let grabbedAt = -1;
      let z0 = 0;
      return (t) => {
        if (!D) return true;
        set({});
        if (t > 0.4) playerInput.grabRight = true;
        if (t > 0.4) playerInput.grabLeft = true;
        if (grabbedAt < 0) {
          const dx = D.position.x - P.position.x;
          const dz = D.position.z - P.position.z;
          const d = Math.hypot(dx, dz) || 1;
          if (d > 0.75) {
            playerInput.moveX = (dx / d) * 0.4;
            playerInput.moveZ = (dz / d) * 0.4;
          }
        }
        if (grabbedAt < 0 && (P.holding.left !== null || P.holding.right !== null)) {
          grabbedAt = t;
          z0 = D.position.z;
        }
        if (grabbedAt > 0 && t > grabbedAt + 0.5 && t < grabbedAt + 3) playerInput.moveZ = 1; // walk backwards (player faces -z)
        if (t > 5 || (grabbedAt > 0 && t > grabbedAt + 3.2)) {
          log('grab', { grabbedAt: grabbedAt > 0 ? +grabbedAt.toFixed(2) : null, holding: { ...P.holding }, dummyMoved: +(D.position.z - z0).toFixed(2), dummyMode: D.mode });
          return true;
        }
        return false;
      };
    },
    drag: () => {
      let grabbedAt = -1;
      const p0 = new THREE.Vector3();
      let held = 0;
      let n = 0;
      return (t) => {
        if (!D) return true;
        if (t < 0.05) D.knockOut(30);
        set({});
        if (t > 1.0) {
          playerInput.grabLeft = true;
          playerInput.grabRight = true;
        }
        // lean in toward the dummy until grabbed
        if (t > 1.0 && grabbedAt < 0) {
          const dx = D.parts[1].pos.x - P.position.x;
          const dz = D.parts[1].pos.z - P.position.z;
          const d = Math.hypot(dx, dz) || 1;
          if (d > 0.7) {
            playerInput.moveX = (dx / d) * 0.5;
            playerInput.moveZ = (dz / d) * 0.5;
          }
          playerInput.duck = true;
        }
        if (grabbedAt < 0 && (P.holding.left !== null || P.holding.right !== null)) {
          grabbedAt = t;
          p0.copy(D.position);
        }
        if (grabbedAt > 0 && t > grabbedAt + 0.6) {
          playerInput.moveX = 1; // drag toward the east edge (x = +8)
          n++;
          if (P.holding.left !== null || P.holding.right !== null) held++;
        }
        if (t > 12 || (grabbedAt > 0 && t > grabbedAt + 4.6)) {
          log('drag', {
            grabbedAt: grabbedAt > 0 ? +grabbedAt.toFixed(2) : null,
            dragDistance: +Math.hypot(D.position.x - p0.x, D.position.z - p0.z).toFixed(2),
            heldFraction: +(held / Math.max(1, n)).toFixed(2),
            playerSpeed: +Math.hypot(P.velocity.x, P.velocity.z).toFixed(2),
          });
          return true;
        }
        return false;
      };
    },
    throw: () => {
      let grabbedAt = -1;
      let thrownAt = -1;
      const p0 = new THREE.Vector3();
      let maxH = 0;
      return (t) => {
        if (!D) return true;
        if (t < 0.05) D.knockOut(30);
        set({});
        if (t > 1.0 && thrownAt < 0) {
          playerInput.grabLeft = true;
          playerInput.grabRight = true;
        }
        if (t > 1.0 && grabbedAt < 0) {
          const dx = D.parts[1].pos.x - P.position.x;
          const dz = D.parts[1].pos.z - P.position.z;
          const d = Math.hypot(dx, dz) || 1;
          if (d > 0.7) {
            playerInput.moveX = (dx / d) * 0.5;
            playerInput.moveZ = (dz / d) * 0.5;
          }
          playerInput.duck = true;
        }
        if (grabbedAt < 0 && (P.holding.left !== null || P.holding.right !== null)) grabbedAt = t;
        if (grabbedAt > 0 && thrownAt < 0) {
          const lt = t - grabbedAt;
          if (lt > 0.4) playerInput.lift = true;
          if (lt > 1.6 && lt < 4.2) playerInput.moveZ = 1; // walk toward the south edge (z = +8)
          maxH = Math.max(maxH, D.parts[1].pos.y - P.groundY);
          if (lt > 4.4) {
            playerInput.lift = false; // release lift -> throw
            thrownAt = t;
            p0.copy(D.position);
          }
        }
        if (thrownAt > 0 && (t > thrownAt + 3 || firstTimes['splash_' + D.id] !== undefined)) {
          log('throw', {
            grabbedAt: +grabbedAt.toFixed(2),
            liftHeight: +maxH.toFixed(2),
            throwDistance: +Math.hypot(D.position.x - p0.x, D.position.z - p0.z).toFixed(2),
            splash: firstTimes['splash_' + D.id] ?? null,
            dummyY: +D.position.y.toFixed(2),
          });
          return true;
        }
        return t > 16;
      };
    },
    ledge: () => {
      let grabbedAt = -1;
      let best = -9;
      let onTopAt = -1;
      return (t) => {
        set({});
        // walk to the ledge block and jump at it
        const dx = ledge.x - P.position.x;
        const dz = ledge.z + 0.3 - P.position.z;
        const d = Math.hypot(dx, dz);
        if (t < 2.6 && d > 0.75) set({ moveX: dx / d, moveZ: dz / d });
        if (t > 1.6) {
          playerInput.grabLeft = true;
          playerInput.grabRight = true;
        }
        if (t > 2.2 && t < 2.35) playerInput.jump = true;
        if (grabbedAt < 0 && P.mode === 'climb') grabbedAt = t;
        if (onTopAt < 0 && P.grounded && P.groundY > ledge.y - 0.1) onTopAt = t;
        if (grabbedAt > 0 && t > grabbedAt + 0.6 && onTopAt < 0) {
          playerInput.jump = true; // pull up
          playerInput.moveZ = -1;
        }
        if (onTopAt > 0) set({});
        best = Math.max(best, P.parts[1].pos.y - ledge.y);
        if (t > 8) {
          log('ledge', { grabbedAt: grabbedAt > 0 ? +grabbedAt.toFixed(2) : null, chestAboveLedge: +best.toFixed(2), onTopAt: onTopAt > 0 ? +onTopAt.toFixed(2) : null, climbTime: onTopAt > 0 ? +(onTopAt - grabbedAt).toFixed(2) : null, mode: P.mode });
          return true;
        }
        return false;
      };
    },
    water: () => {
      let splash = -1;
      let yMin = 9;
      return (t) => {
        set(t > 0.5 && t < 6 && splash < 0 ? { moveX: toWater.x, moveZ: toWater.z } : {});
        if (splash < 0 && firstTimes['splash_' + P.id] !== undefined) splash = firstTimes['splash_' + P.id];
        if (splash > 0) yMin = Math.min(yMin, P.parts[2].pos.y);
        if (t > 8) {
          log('water', { splashAt: splash, state: P.state, headY: +P.parts[2].pos.y.toFixed(2), headMinY: +yMin.toFixed(2), waterLevel: WATER_LEVEL });
          return true;
        }
        return false;
      };
    },
    fall: () => {
      let landAt = -1;
      let standAt = -1;
      return (t) => {
        set({});
        if (t < 0.02) {
          P.teleport(spawnPlayer, Math.PI);
          P.translate(new THREE.Vector3(0, 4, 0));
        }
        if (t > 0.3 && landAt < 0 && P.grounded) landAt = t;
        if (landAt > 0 && standAt < 0 && P.mode === 'stand' && P.parts[1].pos.y - P.groundY > 0.82 && P.strength > 0.9) standAt = t;
        if (standAt > 0 || t > 8) {
          log('fall', { landAt: +landAt.toFixed(2), recoverTime: standAt > 0 ? +(standAt - landAt).toFixed(2) : null, health: +P.health.toFixed(1), mode: P.mode, hits: counters.hits });
          return true;
        }
        return false;
      };
    },
    perf: () => (t) => {
      set({});
      if (t > 8) {
        log('perf', { beasts: system.beasts.length, controllerMs: +system.perf.controllerMs.toFixed(3), readMs: +system.perf.readMs.toFixed(3), syncMs: +system.perf.syncMs.toFixed(3), physicsMs: +perfStats.physicsMs.toFixed(3), fps: +engine.stats.fps.toFixed(1), hits: counters.hits, kos: counters.kos });
        return true;
      }
      return false;
    },
  };

  let script: Script | null = testName && scripts[testName] ? scripts[testName]() : null;
  if (testName && !script) console.warn(`[dev-beast] onbekende test "${testName}"`);
  let scriptT = 0;
  let scriptDone = false;
  // sim-time trace of one beast (window.__debug.trace(i, every) / dumpTrace())
  const trace: string[] = [];
  let traceBeast: BeastExt | null = null;
  let traceEvery = 0.2;
  let traceAcc = 0;
  physics.onPostStep((dt) => {
    if (!traceBeast) return;
    traceAcc += dt;
    if (traceAcc < traceEvery || trace.length > 400) return;
    traceAcc = 0;
    const b = traceBeast;
    const f = (v: number) => v.toFixed(2);
    trace.push(
      [f(physics.time), b.mode, 'c' + f(b.parts[1].pos.y - b.groundY), 'p' + f(b.parts[0].pos.y - b.groundY), 'gy' + f(b.groundY),
        'L' + b.holding.left, 'R' + b.holding.right, 's' + f(b.strength), 'st' + b.stamina.toFixed(0), 'hp' + b.health.toFixed(0),
        'ly' + f(b.climbLedgeY), b.lastRelease, 'x' + f(b.position.x), 'y' + f(b.position.y), 'z' + f(b.position.z)].join(' '),
    );
  });
  physics.onPreStep((dt) => {
    if (script && !scriptDone && window.__ready) {
      scriptT += dt;
      scriptDone = script(scriptT, dt);
      if (scriptDone) Object.assign(playerInput, neutralInput());
    }
    if (scripted) P.setInput(playerInput);
  });

  // ---------------------------------------------------------------- frame loop
  const perfStats = { physicsMs: 0, substeps: 0 };
  const boxBodies = boxes.map((b) => b.body as { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number } });
  engine.onUpdate((dt) => {
    if (!scripted || keyboard.active) {
      if (keyboard.active) scripted = false;
      keyboard.read(playerInput, camYaw);
      P.setInput(playerInput);
    }
    for (const code of keyboard.takeTaps()) {
      if (code === 'KeyR') resetAll();
      if (code === 'KeyK' && D) D.knockOut();
      if (code === 'KeyT') camYaw += Math.PI / 2;
    }
    dummyBrain(dt);
  }, 0);
  engine.onUpdate((dt) => {
    const t0 = performance.now();
    const n = physics.step(dt);
    perfStats.physicsMs += (performance.now() - t0 - perfStats.physicsMs) * 0.08;
    perfStats.substeps = n;
  }, 10);
  engine.onUpdate((dt) => {
    system.update(dt);
    for (let i = 0; i < boxes.length; i++) {
      const t = boxBodies[i].translation();
      const r = boxBodies[i].rotation();
      boxes[i].mesh.position.set(t.x, t.y, t.z);
      boxes[i].mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }, 20);

  // ---------------------------------------------------------------- HUD
  if (params.get('hud') !== '0') {
    const hud = document.createElement('div');
    hud.style.cssText =
      'position:fixed;left:12px;top:12px;padding:8px 10px;background:rgba(10,14,20,0.62);color:#e8eef5;' +
      'font:12px/1.45 Consolas,monospace;border-radius:6px;pointer-events:none;white-space:pre;z-index:10';
    document.body.appendChild(hud);
    let acc = 0;
    engine.onUpdate((dt) => {
      acc += dt;
      if (acc < 0.1) return;
      acc = 0;
      const line = (b: BeastExt) =>
        `${b.options.name.padEnd(8)} ${b.mode.padEnd(6)} kracht ${b.strength.toFixed(2)} hp ${b.health.toFixed(0).padStart(3)} ` +
        `uith ${b.stamina.toFixed(0).padStart(3)} ${b.holding.left !== null ? 'L' : '-'}${b.holding.right !== null ? 'R' : '-'}` +
        (b.mode === 'ko' ? ` KO ${b.koTime.toFixed(1)}s` : '');
      hud.textContent =
        `Beesttest ${testName ?? ''}${scriptDone ? ' (klaar)' : ''}   ${engine.stats.fps.toFixed(0)} fps\n` +
        `ctrl ${system.perf.controllerMs.toFixed(2)} ms  fysica ${perfStats.physicsMs.toFixed(2)} ms  sync ${system.perf.syncMs.toFixed(2)} ms  (${system.visualSource})\n` +
        system.beasts.slice(0, 6).map(line).join('\n') +
        '\nWASD lopen  Shift rennen  Spatie springen  Q/E (muis) handen  F tillen  C trap  Ctrl bukken  R reset  K KO';
    }, 60);
  }

  window.__debug = window.__debug ?? {};
  Object.assign(window.__debug, {
    system,
    physics,
    player: P,
    dummies,
    beasts: system.beasts,
    results,
    events,
    counters,
    perf: perfStats,
    tuning: system.tuning,
    input: playerInput,
    setInput: (o: Partial<BeastInput>) => {
      scripted = true;
      Object.assign(playerInput, neutralInput(), o);
    },
    isTestDone: () => scriptDone,
    trace: (i = -1, every = 0.2) => {
      traceBeast = i < 0 ? P : (dummies[i] ?? null);
      traceEvery = every;
      trace.length = 0;
    },
    dumpTrace: () => console.info('[beast-trace] ' + JSON.stringify(trace)),
    reset: resetAll,
    ko: (i = 0) => dummies[i]?.knockOut(),
    setCamYaw: (deg: number) => (camYaw = (deg * Math.PI) / 180),
    state: () =>
      system.beasts.map((b) => ({
        name: b.options.name,
        mode: b.mode,
        state: b.state,
        pos: b.position.toArray().map((v) => +v.toFixed(2)),
        facing: +b.facing.toFixed(2),
        strength: +b.strength.toFixed(2),
        health: +b.health.toFixed(1),
        holding: { ...b.holding },
      })),
  });
  physics.resetAccumulator();
  await new Promise((r) => setTimeout(r, 200));
  window.__ready = true;
};

export default devBeast;
