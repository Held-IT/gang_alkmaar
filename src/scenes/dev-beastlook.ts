// Beast look-dev studio (module beast-visual). ?scene=dev-beastlook
//
// Params:
//   view=lineup|colours|grid|poses|faces|one|jiggle   (default lineup)
//     lineup  : every costume once, different colours, idle pose
//     colours : the 12 player colours, bare
//     grid    : all costumes x 3 colours
//     poses   : static action poses (idle, punch, grab, kick, fall, KO, cheer)
//     faces   : close-up of the 6 expressions (+ spiral KO)
//     one     : one beast (costume=, colour=, pose=, expr=, yaw=<deg>)
//     jiggle  : beasts swaying/hopping to show the jelly wobble
//   costume=<id> colour=<hex without #|name> pose=<name> expr=<expression> yaw=<deg> scale=<s>
//   bg=city     load the real city and stand them on the Kaasmarkt in front of De Waag
//   labels=0    hide the name tags
//   cam=x,y,z&look=x,y,z  camera (relative to the stage centre)
// window.__debug: { beasts, setExpr(e), setPose(p), info }
import * as THREE from 'three';
import type { Engine, SceneEntry } from '../contracts';
import type { BeastExpression, BeastPartName } from '../brawl/contracts';
import { setupDevCamera } from '../dev/devCamera';
import { BEAST_PARTS, BEAST_RIG } from '../beast/rig';
import {
  BEAST_COLOURS,
  COSTUMES,
  POSES,
  applyPose,
  createBeastVisual,
  type BeastVisualExt,
  type PoseSpec,
} from '../beast/visual';
import { loadWorld, type WorldExt } from '../world/world';

interface Placed {
  v: BeastVisualExt;
  pos: THREE.Vector3;
  facing: number;
  pose: PoseSpec;
  label?: string;
  anim?: (t: number, p: THREE.Vector3) => void;
}

const EXPRS: BeastExpression[] = ['neutral', 'angry', 'hurt', 'ko', 'happy', 'scared'];

function colourParam(s: string | null, fallback: string): string {
  if (!s) return fallback;
  const named = BEAST_COLOURS.find((c) => c.id === s);
  if (named) return named.hex;
  return /^[0-9a-f]{6}$/i.test(s) ? `#${s}` : fallback;
}

const _q = new THREE.Quaternion();
const _y = new THREE.Vector3();

/** Lowest point of the posed rig (physics shapes) relative to the root. */
function lowestPoint(v: BeastVisualExt, s: number): number {
  let min = Infinity;
  for (const name of BEAST_PARTS) {
    const spec = BEAST_RIG[name];
    const o = v.parts[name as BeastPartName];
    _q.copy(o.quaternion);
    _y.set(0, 1, 0).applyQuaternion(_q);
    const hh = spec.halfHeight * s;
    const ext = Math.abs(_y.y) * hh;
    min = Math.min(min, o.position.y - ext - spec.radius * s);
  }
  return min;
}

function studio(engine: Engine): THREE.Object3D {
  const g = new THREE.Group();
  // soft cyclorama: floor that curves up into a back wall
  const shape: THREE.Vector2[] = [];
  const R = 6;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * (Math.PI / 2);
    shape.push(new THREE.Vector2(-14 - Math.sin(a) * R, R - Math.cos(a) * R));
  }
  shape.unshift(new THREE.Vector2(30, 0));
  shape.push(new THREE.Vector2(-14 - R, 22));
  const geo = new THREE.BufferGeometry();
  const pos: number[] = [];
  const idx: number[] = [];
  const W = 40;
  for (const p of shape) pos.push(-W, p.y, p.x, W, p.y, p.x);
  for (let i = 0; i < shape.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc9c3b8, roughness: 0.92 }));
  m.receiveShadow = true;
  // make sure normals face up / towards the camera
  const n = geo.getAttribute('normal');
  if (n.getY(0) < 0) {
    geo.setIndex(idx.map((_, i) => idx[i - (i % 3) + [0, 2, 1][i % 3]]));
    geo.computeVertexNormals();
  }
  g.add(m);
  engine.scene.add(g);
  return g;
}

const beastlook: SceneEntry = async (engine, params) => {
  const view = params.get('view') ?? 'lineup';
  const bgCity = params.get('bg') === 'city';
  const showLabels = params.get('labels') !== '0';
  const scale = Number(params.get('scale') ?? 1);

  // ---------------------------------------------------------------- stage
  let world: WorldExt | null = null;
  const stage = new THREE.Vector3(0, 0, 0);
  let stageRot = 0;
  if (bgCity) {
    engine.start();
    world = await loadWorld(engine, null, undefined, {});
    await world.landmarks?.ready;
    const site = world.landmarks?.kaasmarktSite();
    if (site) {
      // stand next to the cheese rows, on the Waag side
      const ax = Math.cos(site.rot), az = Math.sin(site.rot);
      const px = -az, pz = ax; // perpendicular
      const off = site.width / 2 + 2.2;
      stage.set(site.x + px * off, 0, site.z + pz * off);
      // face away from the cheese (towards +perp), so the camera sees the cheese behind them
      stageRot = Math.atan2(px, pz);
      // pick the side that is not inside a building
      if (world.isInsideBuilding(stage.x, stage.z) || world.isWater(stage.x, stage.z)) {
        stage.set(site.x - px * off, 0, site.z - pz * off);
        stageRot = Math.atan2(-px, -pz);
      }
    } else {
      stage.set(0, 0, 18);
    }
    stage.y = world.heightAt(stage.x, stage.z);
  } else {
    studio(engine);
  }

  // ---------------------------------------------------------------- beasts
  const placed: Placed[] = [];
  const col = (i: number) => BEAST_COLOURS[i % BEAST_COLOURS.length].hex;
  const add = (costume: string, colour: string, x: number, z: number, pose: PoseSpec = POSES.idle, expr: BeastExpression = 'neutral', label?: string, facing = 0) => {
    const v = createBeastVisual({ colour, costume, scale });
    v.setExpression(expr);
    v.snapExpression();
    engine.scene.add(v.root);
    placed.push({ v, pos: new THREE.Vector3(x, 0, z), facing, pose, label });
    return placed[placed.length - 1];
  };

  let camDef = { cam: new THREE.Vector3(0, 1.6, 7.5), look: new THREE.Vector3(0, 0.8, 0) };
  const costumeOrder = COSTUMES.map((c) => c.id);
  const colourOrder = [0, 7, 2, 4, 9, 1, 6, 8, 3, 5, 10, 11];
  if (view === 'lineup') {
    const n = costumeOrder.length;
    const sp = 1.05;
    costumeOrder.forEach((id, i) => add(id, col(colourOrder[i]), (i - (n - 1) / 2) * sp, 0, POSES.idle, 'neutral', COSTUMES[i].name));
    camDef = { cam: new THREE.Vector3(0, 1.5, n * 0.9 + 1.5), look: new THREE.Vector3(0, 0.75, 0) };
  } else if (view === 'colours') {
    BEAST_COLOURS.forEach((c, i) => add('geen', c.hex, ((i % 6) - 2.5) * 1.05, Math.floor(i / 6) * -1.3, POSES.idle, 'neutral', c.name));
    camDef = { cam: new THREE.Vector3(0, 2.2, 6.6), look: new THREE.Vector3(0, 0.6, -0.65) };
  } else if (view === 'grid') {
    const cols = [0, 6, 2];
    costumeOrder.forEach((id, i) => cols.forEach((ci, r) => add(id, col(ci + i), (i - (costumeOrder.length - 1) / 2) * 1.0, -r * 1.25)));
    camDef = { cam: new THREE.Vector3(0, 3.4, 10.5), look: new THREE.Vector3(0, 0.6, -1.25) };
  } else if (view === 'poses') {
    const list: [string, BeastExpression, string][] = [
      ['idle', 'neutral', 'kaasdrager'], ['punch', 'angry', 'boer'], ['grab', 'scared', 'toerist'],
      ['kick', 'angry', 'wielrenner'], ['fall', 'hurt', 'visser'], ['ko', 'ko', 'kok'], ['cheer', 'happy', 'klederdracht'],
    ];
    list.forEach(([pose, expr, cos], i) => add(cos, col(colourOrder[i]), (i - (list.length - 1) / 2) * 1.35, 0, POSES[pose], expr, `${pose} / ${expr}`, pose === 'ko' ? -0.4 : 0.25));
    camDef = { cam: new THREE.Vector3(0, 1.9, 9.2), look: new THREE.Vector3(0, 0.65, 0) };
  } else if (view === 'faces') {
    const list: BeastExpression[] = [...EXPRS, 'ko'];
    list.forEach((e, i) => {
      const p = add('geen', col(colourOrder[i]), (i - (list.length - 1) / 2) * 0.62, 0, POSES.rest, e, i === list.length - 1 ? 'ko (spiraal)' : e);
      if (i === list.length - 1) {
        p.v.setKoStyle('spiraal');
        p.v.snapExpression();
      }
    });
    camDef = { cam: new THREE.Vector3(0, 1.3 * scale, 3.4), look: new THREE.Vector3(0, 1.22 * scale, 0) };
  } else if (view === 'jiggle') {
    for (let i = 0; i < 4; i++) {
      const p = add(costumeOrder[(i * 3 + 1) % costumeOrder.length], col(colourOrder[i]), (i - 1.5) * 1.3, 0, POSES.idle);
      const base = p.pos.clone();
      p.anim = (t, out) => {
        const ph = t * (2.2 + i * 0.4);
        if (i % 2 === 0) out.set(base.x + Math.sin(ph) * 0.25 * Math.sign(Math.sin(ph * 0.5)), base.y, base.z);
        else out.set(base.x, base.y + Math.max(0, Math.sin(ph * 1.3)) * 0.35, base.z);
      };
    }
    camDef = { cam: new THREE.Vector3(0, 1.5, 6.2), look: new THREE.Vector3(0, 0.8, 0) };
  } else {
    // one
    const pose = POSES[params.get('pose') ?? 'idle'] ?? POSES.idle;
    const expr = (params.get('expr') as BeastExpression) ?? 'neutral';
    add(params.get('costume') ?? 'kaasdrager', colourParam(params.get('colour'), BEAST_COLOURS[0].hex), 0, 0, pose, expr, undefined, (Number(params.get('yaw') ?? 20) * Math.PI) / 180);
    camDef = { cam: new THREE.Vector3(0.4, 1.3, 2.9), look: new THREE.Vector3(0, 0.84, 0) };
  }

  // stage transform (city: around the Kaasmarkt)
  const stageM = new THREE.Matrix4().makeRotationY(stageRot).setPosition(stage);
  const toStage = (p: THREE.Vector3) => p.clone().applyMatrix4(stageM);
  const exprOverride = params.get('expr');
  for (const p of placed) {
    if (exprOverride && view !== 'one' && view !== 'faces') {
      p.v.setExpression(exprOverride as BeastExpression);
      p.v.snapExpression();
    }
  }

  const tmp = new THREE.Vector3();
  const posAll = (t: number) => {
    for (const p of placed) {
      const local = p.anim ? (p.anim(t, tmp), tmp) : p.pos;
      const wp = toStage(local);
      if (world) wp.y = world.heightAt(wp.x, wp.z);
      applyPose(p.v.parts, { position: wp, facing: p.facing + stageRot, scale, pose: p.pose });
      if (!p.anim) {
        // rest posed beasts on the ground (lying KO, falling...)
        const low = lowestPoint(p.v, scale) - wp.y;
        if (Math.abs(low) > 0.005 && p.pose !== POSES.fall) {
          wp.y -= low;
          applyPose(p.v.parts, { position: wp, facing: p.facing + stageRot, scale, pose: p.pose });
        }
        if (p.pose === POSES.fall) {
          wp.y += 0.35 - low;
          applyPose(p.v.parts, { position: wp, facing: p.facing + stageRot, scale, pose: p.pose });
        }
      }
    }
  };
  posAll(0);

  // ---------------------------------------------------------------- labels
  const labels: { el: HTMLDivElement; p: Placed }[] = [];
  if (showLabels) {
    for (const p of placed) {
      if (!p.label) continue;
      const el = document.createElement('div');
      el.textContent = p.label;
      el.style.cssText = 'position:fixed;transform:translate(-50%,0);font:600 13px system-ui,sans-serif;color:#222;background:rgba(255,255,255,.75);padding:2px 7px;border-radius:9px;pointer-events:none;white-space:nowrap;z-index:5';
      document.body.appendChild(el);
      labels.push({ el, p });
    }
  }

  const camWorld = { cam: toStage(camDef.cam), look: toStage(camDef.look) };
  camWorld.cam.y = camDef.cam.y + stage.y;
  camWorld.look.y = camDef.look.y + stage.y;
  // custom cam/look params are relative to the stage too
  const rel = (key: string, def: THREE.Vector3) => {
    const s = params.get(key);
    if (!s) return def;
    const a = s.split(',').map(Number);
    if (a.length !== 3 || a.some((x) => !Number.isFinite(x))) return def;
    const v = toStage(new THREE.Vector3(a[0], 0, a[2]));
    v.y = a[1] + stage.y;
    return v;
  };
  const p2 = new URLSearchParams(params);
  p2.delete('cam');
  p2.delete('look');
  setupDevCamera(engine, p2, { cam: rel('cam', camWorld.cam), look: rel('look', camWorld.look) });
  engine.camera.fov = view === 'faces' ? 30 : 40;
  engine.camera.updateProjectionMatrix();

  let elapsed = 0;
  engine.onUpdate((dt) => {
    elapsed += dt;
    if (view === 'jiggle') posAll(elapsed);
    for (const p of placed) p.v.update(dt);
    if (labels.length) {
      const w = engine.canvas.clientWidth, h = engine.canvas.clientHeight;
      for (const l of labels) {
        const head = l.p.v.parts.pelvis.position;
        tmp.copy(head);
        tmp.y = toStage(l.p.pos).y - 0.02;
        tmp.project(engine.camera);
        l.el.style.left = `${((tmp.x + 1) / 2) * w}px`;
        l.el.style.top = `${((1 - tmp.y) / 2) * h + 6}px`;
      }
    }
  }, 45);

  if (world) await world.warmUp(placed.map((p) => p.v.root));
  engine.start();

  const tri = placed.reduce((s, p) => s + p.v.info().triangles, 0);
  const perBeast = placed.map((p) => `${p.v.costume}:${p.v.info().triangles}`);
  window.__debug = Object.assign(window.__debug ?? {}, {
    beasts: placed.map((p) => p.v),
    info: { view, beasts: placed.length, triangles: tri, perBeast },
    setExpr: (e: BeastExpression) => placed.forEach((p) => p.v.setExpression(e)),
    snap: () => placed.forEach((p) => p.v.snapExpression()),
    setPose: (name: string) => placed.forEach((p) => (p.pose = POSES[name] ?? p.pose)),
    repose: () => posAll(elapsed),
  });
  console.info(`[beastlook] view=${view} beasts=${placed.length} tris=${tri} ${perBeast.join(' ')}`);
  window.__ready = true;
};

export default beastlook;
