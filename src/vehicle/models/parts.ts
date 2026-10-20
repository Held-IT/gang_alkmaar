// Geometric parts around the body shell: glass, interior shell, wheel-arch liners, underbody.
// (Lights, mirrors, handles, plates and the interior are in details.ts / interior.ts.)
import type { BodyMap } from './bodyMap';
import type { BodyMesh } from './bodyMesh';
import { MeshBuilder } from './builder';
import type { BodyTextures } from './atlasPaint';
import { lerp } from './curves';

/** Glass panes: greenhouse quads that contain glass, slightly offset outwards (left + right). */
export function buildGlass(bm: BodyMesh, tex: BodyTextures): MeshBuilder {
  const g = bm.gh;
  const mb = new MeshBuilder();
  const off = 0.0015;
  const ids = new Int32Array(g.ns * g.nr).fill(-1);
  const vid = (k: number) => {
    if (ids[k] < 0) {
      ids[k] = mb.vert(
        g.pos[3 * k] + g.nrm[3 * k] * off,
        g.pos[3 * k + 1] + g.nrm[3 * k + 1] * off,
        g.pos[3 * k + 2] + g.nrm[3 * k + 2] * off,
        g.nrm[3 * k],
        g.nrm[3 * k + 1],
        g.nrm[3 * k + 2],
        g.uv[2 * k],
        g.uv[2 * k + 1],
      );
    }
    return ids[k];
  };
  const glassy = (k: number) => tex.glassAt(g.uv[2 * k], g.uv[2 * k + 1]);
  for (let si = 0; si < g.ns - 1; si++) {
    for (let ri = 0; ri < g.nr - 1; ri++) {
      const a = si * g.nr + ri;
      const b = (si + 1) * g.nr + ri;
      const cu = 0.25 * (g.uv[2 * a] + g.uv[2 * (a + 1)] + g.uv[2 * b] + g.uv[2 * (b + 1)]);
      const cv = 0.25 * (g.uv[2 * a + 1] + g.uv[2 * (a + 1) + 1] + g.uv[2 * b + 1] + g.uv[2 * (b + 1) + 1]);
      const any = Math.max(glassy(a), glassy(a + 1), glassy(b), glassy(b + 1), tex.glassAt(cu, cv));
      if (any < 0.05) continue;
      mb.tri(vid(a), vid(a + 1), vid(b));
      mb.tri(vid(b), vid(a + 1), vid(b + 1));
    }
  }
  mb.mirrorX();
  return mb;
}

/**
 * Inner shell (LOD 0): the greenhouse offset inwards with reversed winding (headliner, pillar
 * trims seen through the glass; window cut-outs via the atlas alpha), door cards and the window
 * sill strip. Goes into the detail bucket.
 */
export function buildInnerShell(m: BodyMap, bm: BodyMesh, mb: MeshBuilder): void {
  const g = bm.gh;
  const f = m.f;
  const start = mb.vertexCount;
  const off = 0.022;
  const white = m.atlas.patchUv('white');
  mb.setPbr(0.92, 0);
  // greenhouse inner surface (half resolution: it is only seen dimly through the glass)
  const pick = (n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 2) out.push(i);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  };
  const sSel = pick(g.ns);
  const rSel = pick(g.nr);
  const base = mb.vertexCount;
  for (const si of sSel) for (const ri of rSel) {
    const k = si * g.nr + ri;
    const r = g.rowR[ri];
    // headliner light grey, pillars slightly darker
    const c = r > 1.6 ? 0.36 : 0.2;
    mb.setColor([c, c * 0.98, c * 0.95]);
    mb.vert(
      g.pos[3 * k] - g.nrm[3 * k] * off,
      g.pos[3 * k + 1] - g.nrm[3 * k + 1] * off,
      g.pos[3 * k + 2] - g.nrm[3 * k + 2] * off,
      -g.nrm[3 * k],
      -g.nrm[3 * k + 1],
      -g.nrm[3 * k + 2],
      g.uv[2 * k],
      g.uv[2 * k + 1],
    );
  }
  const nr2 = rSel.length;
  for (let si = 0; si < sSel.length - 1; si++) {
    for (let ri = 0; ri < nr2 - 1; ri++) {
      const a = base + si * nr2 + ri;
      const b = base + (si + 1) * nr2 + ri;
      mb.tri(a, b, a + 1);
      mb.tri(b, b + 1, a + 1);
    }
  }
  // door cards + window sill strip for stations in the cabin
  const d = f.d;
  const floorY = Math.max(d.sillY + 0.12, 0.3);
  const cols: { top: number; cap: number; ids: number[] }[] = [];
  const P = { x: 0, y: 0, z: 0 };
  const N = { x: 0, y: 0, z: 0 };
  const stations = bm.stations.filter((p, i) => p >= f.pRearBase - 1e-6 && p <= f.pCowl + 1e-6 && i % 2 === 0);
  for (const p of stations) {
    const c = f.column(p);
    const tTop = f.K - 1;
    const tBot = f.tOfY(c, floorY);
    const ids: number[] = [];
    mb.setColor([0.075, 0.075, 0.08]).setPbr(0.8, 0);
    const n = 4;
    for (let i = 0; i <= n; i++) {
      const t = lerp(tBot, tTop, i / n);
      f.lowerPoint(c, t, P);
      f.lowerNormal(p, t, N);
      const o = 0.045;
      ids.push(mb.vert(P.x - N.x * o, P.y - N.y * o, P.z - N.z * o, -N.x, -N.y, -N.z, white[0], white[1]));
    }
    // sill strip: from the outer shoulder point to the top of the door card
    f.lowerPoint(c, tTop, P);
    mb.setColor([0.03, 0.03, 0.03]).setPbr(0.6, 0);
    const cap = mb.vert(P.x, P.y + 0.001, P.z, 0, 1, 0, white[0], white[1]);
    cols.push({ top: ids[ids.length - 1], cap, ids });
  }
  for (let i = 0; i < cols.length - 1; i++) {
    const A = cols[i].ids;
    const B = cols[i + 1].ids;
    for (let k = 0; k < A.length - 1; k++) {
      mb.tri(A[k], B[k], A[k + 1]);
      mb.tri(B[k], B[k + 1], A[k + 1]);
    }
    mb.tri(cols[i].cap, cols[i].top, cols[i + 1].cap);
    mb.tri(cols[i + 1].cap, cols[i].top, cols[i + 1].top);
  }
  void start;
}

/** Dark wheel-well liners and inner walls for both arches (left side; caller mirrors). */
export function buildArchLiners(m: BodyMap, bm: BodyMesh, mb: MeshBuilder, lod: number): void {
  const f = m.f;
  const spec = f.spec;
  const satin = m.atlas.patchUv('white');
  mb.setColor([0.018, 0.018, 0.02]).setPbr(0.92, 0);
  for (const arch of bm.arches) {
    const pts = [...arch.pts].sort((a, b) => a.z - b.z);
    if (pts.length < 2) continue;
    const front = arch.axle === 0;
    const za = front ? f.zFA : f.zRA;
    const track = front ? spec.trackFront : spec.trackRear;
    const xIn = track / 2 - spec.wheelWidth / 2 - 0.06;
    const yc = f.wheelR;
    // decimate for low LOD
    const step = lod === 0 ? 1 : Math.max(1, Math.floor(pts.length / (lod === 1 ? 8 : 2)));
    const sel = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    const outer: number[] = [];
    const inner: number[] = [];
    const wall: number[] = [];
    for (const q of sel) {
      // radial direction from the wheel centre in the zy plane
      let rz = q.z - za;
      let ry = q.y - yc;
      const l = Math.hypot(rz, ry) || 1;
      rz /= l;
      ry /= l;
      const push = 0.012;
      outer.push(mb.vert(q.x - 0.004, q.y + ry * push, q.z + rz * push, 0, -ry, -rz, satin[0], satin[1]));
      inner.push(mb.vert(xIn, q.y + ry * push, q.z + rz * push, 0, -ry, -rz, satin[0], satin[1]));
      wall.push(mb.vert(xIn, q.y + ry * push, q.z + rz * push, 1, 0, 0, satin[0], satin[1]));
    }
    // liner faces the wheel (normal towards the centre)
    for (let i = 0; i < sel.length - 1; i++) {
      mb.quad(outer[i], outer[i + 1], inner[i + 1], inner[i]);
    }
    // inner wall: fan from the wheel centre at xIn, facing outwards (+x)
    const c = mb.vert(xIn, yc - 0.05, za, 1, 0, 0, satin[0], satin[1]);
    for (let i = 0; i < sel.length - 1; i++) mb.tri(c, wall[i], wall[i + 1]);
  }
}

/** Flat dark underbody between the sills (left half; caller mirrors). */
export function buildUnderbody(m: BodyMap, bm: BodyMesh, mb: MeshBuilder): void {
  const f = m.f;
  const spec = f.spec;
  const satin = m.atlas.patchUv('white');
  mb.setColor([0.02, 0.02, 0.022]).setPbr(0.9, 0);
  const xInF = spec.trackFront / 2 - spec.wheelWidth / 2 - 0.06;
  const xInR = spec.trackRear / 2 - spec.wheelWidth / 2 - 0.06;
  const R = f.archR + 0.05;
  const rows: [number, number][] = [];
  const fl = bm.floor;
  for (let i = 0; i < fl.length; i++) {
    const q = fl[i];
    let x = q.x;
    if (Math.abs(q.z - f.zFA) < R) x = Math.min(x, xInF);
    if (Math.abs(q.z - f.zRA) < R) x = Math.min(x, xInR);
    const y = q.y + 0.004;
    rows.push([mb.vert(Math.max(0, x - 0.005), y, q.z, 0, -1, 0, satin[0], satin[1]), mb.vert(0, y, q.z, 0, -1, 0, satin[0], satin[1])]);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const [a0, a1] = rows[i];
    const [b0, b1] = rows[i + 1];
    // facing down
    mb.quad(a0, b0, b1, a1);
  }
}
