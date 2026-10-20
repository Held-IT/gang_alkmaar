// DEV: measures shader compile time per material of a root (props / landmarks), to find programs
// that take pathologically long on ANGLE/D3D11. Used by ?scene=dev-props&compiletest=1.
//
// Each unique (material, mesh kind) is compiled on its own with renderer.compileAsync and timed.
// With `bust` a random define is added first so neither three.js nor the GPU disk cache can
// reuse an earlier program (= cold compile, like a first start of the game).
import * as THREE from 'three';
import type { Engine } from '../../../contracts';

export interface CompileTiming { name: string; kind: string; ms: number }

function meshKind(o: THREE.Object3D): string {
  const m = o as THREE.Mesh;
  const g = m.geometry as THREE.BufferGeometry | undefined;
  const inst = (o as THREE.InstancedMesh).isInstancedMesh ? 'inst' + ((o as THREE.InstancedMesh).instanceColor ? '+col' : '') : 'mesh';
  const attrs = g ? Object.keys(g.attributes).sort().join(',') : '';
  return `${inst}|${attrs}`;
}

/**
 * compileAsync of a whole root (like a loading-screen warm-up), bounded by `timeoutMs`. On a
 * timeout it reports the materials whose program is still not ready (the culprits).
 */
export async function compileRootTimed(engine: Engine, root: THREE.Object3D, timeoutMs = 60000): Promise<{ ms: number; timedOut: boolean; materials: number; pending: string[] }> {
  const t = performance.now();
  let materials = 0;
  const done = engine.renderer.compileAsync(root, engine.camera, engine.scene).then(() => true);
  const ok = await Promise.race([done, new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
  const ms = performance.now() - t;
  const pending: string[] = [];
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      materials++;
      const prog = (engine.renderer.properties.get(mat) as { currentProgram?: { isReady(): boolean; name?: string } }).currentProgram;
      if (prog && !prog.isReady()) pending.push(`${o.name || o.parent?.name || '?'}:${mat.name || mat.type}`);
    }
  });
  return { ms: Math.round(ms), timedOut: !ok, materials, pending: pending.slice(0, 30) };
}

/**
 * Cold compile profile of a whole root: every material gets a random define (no program reuse,
 * no GPU disk cache), renderer.compile() starts all programs at once (parallel compile), then the
 * time until each program is ready is recorded. Logs progress every 10 s so a hang shows its
 * culprits (the materials still pending).
 */
export async function coldCompileProfile(engine: Engine, root: THREE.Object3D, timeoutMs = 300000): Promise<{ syncMs: number; totalMs: number; programs: number; pending: string[]; slowest: string[] }> {
  const tag = Math.floor(Math.random() * 1e9).toString(36);
  const mats = new Map<THREE.Material, string>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) || !m.material) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (mats.has(mat)) continue;
      mats.set(mat, `${o.name || o.parent?.name || '?'}:${mat.name || mat.type}`);
      mat.defines = { ...(mat.defines ?? {}), [`CB_${tag}`]: '' };
      mat.needsUpdate = true;
    }
  });
  const t0 = performance.now();
  engine.renderer.compile(root, engine.camera, engine.scene);
  const syncMs = performance.now() - t0;
  const readyAt = new Map<THREE.Material, number>();
  let lastLog = performance.now();
  const props = engine.renderer.properties;
  for (;;) {
    for (const mat of mats.keys()) {
      if (readyAt.has(mat)) continue;
      const prog = (props.get(mat) as { currentProgram?: { isReady(): boolean } }).currentProgram;
      if (!prog || prog.isReady()) readyAt.set(mat, performance.now() - t0);
    }
    const now = performance.now();
    if (readyAt.size === mats.size || now - t0 > timeoutMs) break;
    if (now - lastLog > 10000) {
      lastLog = now;
      const pend = [...mats.entries()].filter(([m]) => !readyAt.has(m)).map(([, n]) => n);
      console.info(`[coldcompile] ${((now - t0) / 1000).toFixed(0)} s: ${pend.length} wachtend: ${pend.slice(0, 12).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const totalMs = performance.now() - t0;
  const pending = [...mats.entries()].filter(([m]) => !readyAt.has(m)).map(([, n]) => n);
  const slowest = [...readyAt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([m, ms]) => `${mats.get(m)} ${ms.toFixed(0)}`);
  return { syncMs: Math.round(syncMs), totalMs: Math.round(totalMs), programs: mats.size, pending, slowest };
}

export async function compileTimings(engine: Engine, roots: THREE.Object3D[], bust = true, log = true): Promise<{ total: number; items: CompileTiming[] }> {
  const reps = new Map<string, THREE.Mesh>();
  for (const r of roots) {
    r.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const key = mat.uuid + '|' + meshKind(m);
        if (!reps.has(key)) reps.set(key, m);
      }
    });
  }
  const tag = Math.floor(Math.random() * 1e9).toString(36);
  if (bust) {
    const seen = new Set<THREE.Material>();
    for (const m of reps.values()) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (seen.has(mat)) continue;
        seen.add(mat);
        mat.defines = { ...(mat.defines ?? {}), [`CB_${tag}`]: '' };
        mat.needsUpdate = true;
      }
    }
  }
  const items: CompileTiming[] = [];
  const t0 = performance.now();
  let i = 0;
  for (const m of reps.values()) {
    i++;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const name = `${m.name || m.parent?.name || '?'}:${mats.map((x) => x.name || x.type).join('+')}`;
    if (log) console.info(`[compiletest] start ${i}/${reps.size} ${name}`);
    // compile this mesh alone (lights come from engine.scene)
    const wasVisible = m.visible;
    m.visible = true;
    const t = performance.now();
    const holder = new THREE.Group();
    const parent = m.parent;
    holder.add(m.clone(false) as THREE.Mesh);
    await engine.renderer.compileAsync(holder, engine.camera, engine.scene);
    const ms = performance.now() - t;
    m.visible = wasVisible;
    if (parent) { /* the original stays where it was */ }
    items.push({ name, kind: meshKind(m), ms });
    if (log) console.info(`[compiletest] ${ms.toFixed(0)} ms ${name} (${meshKind(m).split('|')[0]})`);
  }
  const total = performance.now() - t0;
  if (log) console.info(`[compiletest] totaal ${total.toFixed(0)} ms voor ${reps.size} programma's`);
  return { total, items };
}
