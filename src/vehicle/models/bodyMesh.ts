// Tessellates a BodyFrame into triangle meshes for one LOD: lower body (with wheel-arch cuts),
// greenhouse and deck (hood + trunk), using analytic normals so the surfaces shade smoothly no
// matter how irregular the sampling is. Also returns the greenhouse grid (for glass and the inner
// shell) and the wheel-arch edges (for the arch liners).
import { AtlasLayout } from './atlasLayout';
import { BodyFrame, type Column, type GhSection, type V3 } from './body';
import { MeshBuilder } from './builder';
import { clamp, lerp } from './curves';

export interface BodyLod {
  sideStep: number;
  cornerStep: number;
  dyTol: number;
  maxAngle: number;
  /** lower body rows: t values (control index space) */
  rows: number[];
  /** greenhouse rows per segment: side line, roof-edge corner, roof */
  ghRows: [number, number, number];
  deckCols: number;
  archSegs: number;
}

function rowsFromCounts(counts: number[]): number[] {
  const t: number[] = [];
  for (let k = 0; k < counts.length; k++) {
    for (let i = 0; i < counts[k]; i++) t.push(k + i / counts[k]);
  }
  t.push(counts.length);
  return t;
}

export const BODY_LODS: BodyLod[] = [
  {
    sideStep: 0.11,
    cornerStep: 0.042,
    dyTol: 0.03,
    maxAngle: 0.09,
    rows: rowsFromCounts([2, 2, 2, 2, 2, 3, 3, 3]),
    ghRows: [6, 5, 8],
    deckCols: 10,
    archSegs: 28,
  },
  {
    sideStep: 0.3,
    cornerStep: 0.1,
    dyTol: 0.08,
    maxAngle: 0.26,
    rows: rowsFromCounts([1, 1, 1, 1, 1, 2, 2, 2]),
    ghRows: [2, 2, 4],
    deckCols: 5,
    archSegs: 12,
  },
  {
    sideStep: 0.85,
    cornerStep: 0.28,
    dyTol: 0.26,
    maxAngle: 0.8,
    rows: [0, 3, 6, 7.5, 8],
    ghRows: [1, 1, 1],
    deckCols: 2,
    archSegs: 5,
  },
];

export interface GhGrid {
  /** stations x rows, left half */
  ns: number;
  nr: number;
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  /** row parameter (0..3, see BodyFrame.rowArc) and arc length per vertex */
  arc: Float32Array;
  rowR: number[];
}

export interface ArchEdge {
  axle: 0 | 1;
  /** bottom-edge points of the columns cut by this arch (left side), ordered by z */
  pts: V3[];
}

export interface BodyMesh {
  body: MeshBuilder;
  gh: GhGrid;
  stations: number[];
  arches: ArchEdge[];
  /** per station: plan z and floor half width / height (for the underbody) */
  floor: { z: number; x: number; y: number }[];
  triangles: number;
}

/** Station list (plan parameter p) with adaptive refinement at arches and steep glass. */
export function buildStations(f: BodyFrame, lod: BodyLod): number[] {
  const ps: number[] = [];
  const uni = (a: number, b: number, step: number) => {
    const n = Math.max(1, Math.ceil((b - a) / step));
    for (let i = 0; i <= n; i++) ps.push(lerp(a, b, i / n));
  };
  uni(0, f.pSide0, lod.cornerStep);
  uni(f.pSide0, f.pSide1, lod.sideStep);
  uni(f.pSide1, f.P, lod.cornerStep);
  ps.push(f.pCowl, f.pRearBase);
  const R = f.archR;
  for (const za of [f.zFA, f.zRA]) {
    for (const dz of [-R, R]) ps.push(f.pOfPlanZ(za + dz));
    const leg = (f.wheelR - f.d.sillY) * 0.12;
    for (const dz of [-(R + leg), R + leg]) ps.push(f.pOfPlanZ(za + dz));
  }
  ps.sort((a, b) => a - b);
  const base: number[] = [];
  for (const p of ps) if (!base.length || p - base[base.length - 1] > 1e-4) base.push(p);

  const info = (p: number) => {
    const c = f.column(p);
    const s = f.shoulderPoint(p);
    const inGh = p >= f.pRearBase - 1e-6 && p <= f.pCowl + 1e-6;
    return { by: f.bottomY(c.z, c.yRef), ty: inGh ? f.topY(s.z) : NaN, nx: c.nx, nz: c.nz };
  };
  const out: number[] = [base[0]];
  const refine = (p0: number, p1: number, i0: ReturnType<typeof info>, i1: ReturnType<typeof info>, depth: number) => {
    let m = Math.abs(i1.by - i0.by) / lod.dyTol;
    if (!Number.isNaN(i0.ty) && !Number.isNaN(i1.ty)) m = Math.max(m, Math.abs(i1.ty - i0.ty) / (lod.dyTol * 1.6));
    const ang = Math.acos(clamp(i0.nx * i1.nx + i0.nz * i1.nz, -1, 1));
    m = Math.max(m, ang / lod.maxAngle);
    if (m > 1 && depth < 7 && p1 - p0 > 0.004) {
      const pm = 0.5 * (p0 + p1);
      const im = info(pm);
      refine(p0, pm, i0, im, depth + 1);
      refine(pm, p1, im, i1, depth + 1);
    } else out.push(p1);
  };
  let prev = info(base[0]);
  for (let i = 1; i < base.length; i++) {
    const cur = info(base[i]);
    refine(base[i - 1], base[i], prev, cur, 0);
    prev = cur;
  }
  return out;
}

export function buildBodyMesh(f: BodyFrame, atlas: AtlasLayout, lodIndex: 0 | 1 | 2): BodyMesh {
  const lod = BODY_LODS[lodIndex];
  const mb = new MeshBuilder();
  const stations = buildStations(f, lod);
  const P = { x: 0, y: 0, z: 0 };
  const N = { x: 0, y: 0, z: 0 };
  const uv: [number, number] = [0, 0];

  // ---------------- lower body ----------------
  const colIdx: number[][] = [];
  const colT: number[][] = [];
  const arches: ArchEdge[] = [
    { axle: 0, pts: [] },
    { axle: 1, pts: [] },
  ];
  const floor: { z: number; x: number; y: number }[] = [];
  const col: Column = f.column(0);
  for (const p of stations) {
    f.column(p, col);
    const tB = f.bottomT(col);
    const ts = [tB];
    for (const t of lod.rows) if (t > tB + 0.035) ts.push(t);
    if (ts[ts.length - 1] < f.K - 1) ts.push(f.K - 1);
    const ids: number[] = [];
    for (const t of ts) {
      f.lowerPoint(col, t, P);
      f.lowerNormal(p, t, N);
      atlas.uv(atlas.lower, p, P.y, uv);
      ids.push(mb.vert(P.x, P.y, P.z, N.x, N.y, N.z, uv[0], uv[1]));
    }
    colIdx.push(ids);
    colT.push(ts);
    // arch edges
    if (tB > 1e-4) {
      f.lowerPoint(col, tB, P);
      const axle: 0 | 1 = Math.abs(col.z - f.zFA) < Math.abs(col.z - f.zRA) ? 0 : 1;
      arches[axle].pts.push({ x: P.x, y: P.y, z: P.z });
    }
    f.lowerPoint(col, 0, P);
    floor.push({ z: P.z, x: P.x, y: P.y });
  }
  for (let c = 0; c < stations.length - 1; c++) {
    const A = colIdx[c];
    const B = colIdx[c + 1];
    const tA = colT[c];
    const tB = colT[c + 1];
    let i = 0;
    let j = 0;
    while (i < A.length - 1 || j < B.length - 1) {
      const advA = j >= B.length - 1 || (i < A.length - 1 && tA[i + 1] <= tB[j + 1]);
      if (advA) {
        mb.tri(A[i], A[i + 1], B[j]);
        i++;
      } else {
        mb.tri(B[j], A[i], B[j + 1]);
        j++;
      }
    }
  }

  // ---------------- greenhouse ----------------
  const ghStations = stations.filter((p) => p >= f.pRearBase - 1e-6 && p <= f.pCowl + 1e-6);
  const rowR: number[] = [];
  const [nSide, nCorner, nRoof] = lod.ghRows;
  for (let i = 0; i < nSide; i++) rowR.push(i / nSide);
  for (let i = 0; i < nCorner; i++) rowR.push(1 + i / nCorner);
  for (let i = 0; i <= nRoof; i++) rowR.push(2 + i / nRoof);
  const ns = ghStations.length;
  const nr = rowR.length;
  const gh: GhGrid = {
    ns,
    nr,
    pos: new Float32Array(ns * nr * 3),
    nrm: new Float32Array(ns * nr * 3),
    uv: new Float32Array(ns * nr * 2),
    arc: new Float32Array(ns * nr),
    rowR,
  };
  let sec: GhSection | undefined;
  let secA: GhSection | undefined;
  let secB: GhSection | undefined;
  const gp = { x: 0, y: 0, tx: 0, ty: 0 };
  const gpa = { x: 0, y: 0, tx: 0, ty: 0 };
  const gpb = { x: 0, y: 0, tx: 0, ty: 0 };
  const ghIdx: number[][] = [];
  const ep = 0.004;
  for (let si = 0; si < ns; si++) {
    const p = ghStations[si];
    sec = f.ghSection(p, sec);
    secA = f.ghSection(Math.max(0, p - ep), secA);
    secB = f.ghSection(Math.min(f.P, p + ep), secB);
    const u = f.sc(sec.z);
    const ids: number[] = [];
    for (let ri = 0; ri < nr; ri++) {
      const r = rowR[ri];
      const a = BodyFrame.rowArc(sec, r);
      f.ghPoint(sec, a, gp);
      f.ghPoint(secA, BodyFrame.rowArc(secA, r), gpa);
      f.ghPoint(secB, BodyFrame.rowArc(secB, r), gpb);
      // D = dG/dp, T = in-section tangent; N = T x D
      const dx = gpb.x - gpa.x;
      const dy = gpb.y - gpa.y;
      const dz = secB.z - secA.z;
      const tx = gp.tx;
      const ty = gp.ty;
      let nx = ty * dz;
      let ny = -tx * dz;
      let nz = tx * dy - ty * dx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      atlas.uv(atlas.gh, u, a, uv);
      const k = si * nr + ri;
      gh.pos[3 * k] = gp.x;
      gh.pos[3 * k + 1] = gp.y;
      gh.pos[3 * k + 2] = sec.z;
      gh.nrm[3 * k] = nx;
      gh.nrm[3 * k + 1] = ny;
      gh.nrm[3 * k + 2] = nz;
      gh.uv[2 * k] = uv[0];
      gh.uv[2 * k + 1] = uv[1];
      gh.arc[k] = a;
      ids.push(mb.vert(gp.x, gp.y, sec.z, nx, ny, nz, uv[0], uv[1]));
    }
    ghIdx.push(ids);
  }
  for (let si = 0; si < ns - 1; si++) {
    const A = ghIdx[si];
    const B = ghIdx[si + 1];
    for (let ri = 0; ri < nr - 1; ri++) {
      mb.tri(A[ri], A[ri + 1], B[ri]);
      mb.tri(B[ri], A[ri + 1], B[ri + 1]);
    }
  }

  // ---------------- deck: hood and trunk ----------------
  const deck = (from: number, to: number, crown0: number, hood: boolean) => {
    const st = stations.filter((p) => p >= from - 1e-6 && p <= to + 1e-6);
    const nc = lod.deckCols;
    const rows: number[][] = [];
    const S = { x: 0, y: 0, z: 0 };
    const Sa = { x: 0, y: 0, z: 0 };
    const Sb = { x: 0, y: 0, z: 0 };
    const hw = f.d.halfWidth;
    const pt = (s: V3, w: number, o: V3) => {
      const crown = crown0 * Math.min(1, s.x / (0.6 * hw));
      o.x = s.x * w;
      o.y = s.y + crown * (1 - w * w);
      o.z = s.z;
    };
    const A = { x: 0, y: 0, z: 0 };
    const B = { x: 0, y: 0, z: 0 };
    const C = { x: 0, y: 0, z: 0 };
    const D = { x: 0, y: 0, z: 0 };
    let lastZ = -Infinity;
    for (const p of st) {
      f.shoulderPoint(p, S);
      // never let deck rows fold back: tiny non-monotonic shoulder z near the tips (a few mm) is
      // clamped, so the cap stays closed against the lower body
      if (S.z < lastZ) S.z = lastZ;
      lastZ = S.z;
      f.shoulderPoint(Math.max(0, p - ep), Sa);
      f.shoulderPoint(Math.min(f.P, p + ep), Sb);
      const ids: number[] = [];
      for (let i = 0; i <= nc; i++) {
        // w from 1 (shoulder) to 0 (centre), denser near the edge
        const q = i / nc;
        const w = 1 - (q * 0.55 + 0.45 * q * q);
        pt(S, w, P);
        pt(S, Math.min(1, w + 0.01), A);
        pt(S, Math.max(0, w - 0.01), B);
        pt(Sa, w, C);
        pt(Sb, w, D);
        // T (towards centre) x dP/dp
        const tx = B.x - A.x;
        const ty = B.y - A.y;
        const tz = B.z - A.z;
        const vx = D.x - C.x;
        const vy = D.y - C.y;
        const vz = D.z - C.z;
        let nx = ty * vz - tz * vy;
        let ny = tz * vx - tx * vz;
        let nz = tx * vy - ty * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-12) {
          nx = 0;
          ny = 1;
          nz = 0;
        } else {
          nx /= l;
          ny /= l;
          nz /= l;
        }
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        atlas.uv(hood ? atlas.hood : atlas.trunk, P.z, P.x, uv);
        ids.push(mb.vert(P.x, P.y, P.z, nx, ny, nz, uv[0], uv[1]));
      }
      rows.push(ids);
    }
    for (let si = 0; si < rows.length - 1; si++) {
      const A2 = rows[si];
      const B2 = rows[si + 1];
      for (let i = 0; i < nc; i++) {
        mb.tri(A2[i], A2[i + 1], B2[i]);
        mb.tri(B2[i], A2[i + 1], B2[i + 1]);
      }
    }
  };
  deck(f.pCowl, f.P, f.d.hoodCrown, true);
  deck(0, f.pRearBase, f.d.deckCrown, false);

  mb.mirrorX();
  return { body: mb, gh, stations, arches, floor, triangles: mb.triangleCount };
}
