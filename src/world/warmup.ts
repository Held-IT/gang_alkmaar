// Shader warm-up: compiles the programs of a set of objects ahead of time, in the program
// variants the current render path really uses, so the first frames of a drive do not stall.
//
// three builds a different program for the same material depending on the bound render target:
// on screen (renderer tone mapping + sRGB output) or into a render target (no tone mapping,
// linear output). With the post-processing composer active the main pass renders into a render
// target, and the planar water reflection always does; compiling only the screen variant (what a
// plain renderer.compile() does) would warm programs that are never used. Each call compiles
// per subtree with compileAsync (KHR_parallel_shader_compile: the driver links in parallel and
// the main thread stays responsive) and gives up waiting after a time limit, so a slow or hung
// driver compile never blocks loading.
import * as THREE from 'three';
import type { Engine } from '../contracts';

export interface WarmUpStage {
  name: string;
  objects: readonly THREE.Object3D[];
  timeoutMs: number;
}

export interface WarmUpResult {
  name: string;
  ms: number;
  ok: boolean;
  /** programs created by this stage (renderer.info.programs) */
  programs: number;
}

function sleepFalse(ms: number): Promise<false> {
  return new Promise((r) => setTimeout(() => r(false), Math.max(0, ms)));
}

export class ShaderWarmer {
  private rt: THREE.WebGLRenderTarget | null = null;

  constructor(private readonly engine: Engine) {}

  /** Render-target bindings (null = screen) whose program variants the frame will use. */
  private targets(): (THREE.WebGLRenderTarget | null)[] {
    const postfx = (this.engine as unknown as { postfx?: { active?: boolean } }).postfx;
    const viaComposer = postfx?.active === true;
    const planar = this.engine.quality.waterReflections === 'planar';
    if (!viaComposer && !planar) return [null];
    this.rt ??= new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
    // composer path: the main pass and the reflection share the render-target variant;
    // direct path with planar water: screen variant + render-target variant (reflection)
    return viaComposer ? [this.rt] : [null, this.rt];
  }

  private programCount(): number {
    return this.engine.renderer.info.programs?.length ?? 0;
  }

  /** Compiles `objects` (all descendants, visible or not); resolves false on timeout. */
  async compile(objects: readonly THREE.Object3D[], timeoutMs: number): Promise<boolean> {
    const list = objects.filter((o) => !!o);
    if (!list.length) return true;
    const r = this.engine.renderer;
    const deadline = performance.now() + timeoutMs;
    for (const target of this.targets()) {
      const pending: Promise<unknown>[] = [];
      const prev = r.getRenderTarget();
      try {
        r.setRenderTarget(target);
        // compileAsync() runs compile() synchronously, i.e. with this target bound
        for (const o of list) pending.push(r.compileAsync(o, this.engine.camera, this.engine.scene));
      } finally {
        r.setRenderTarget(prev);
      }
      const ok = await Promise.race([Promise.all(pending).then(() => true as const), sleepFalse(deadline - performance.now())]);
      if (!ok) return false;
    }
    return true;
  }

  /** Runs the stages one after the other (each with its own limit) and reports per stage. */
  async run(stages: readonly WarmUpStage[], onStage?: (i: number, s: WarmUpStage) => void): Promise<WarmUpResult[]> {
    const out: WarmUpResult[] = [];
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      onStage?.(i, s);
      const t = performance.now();
      const p0 = this.programCount();
      let ok = false;
      try {
        ok = await this.compile(s.objects, s.timeoutMs);
      } catch (e) {
        console.warn(`[world] shaders '${s.name}' vooraf compileren mislukt`, e);
      }
      out.push({ name: s.name, ms: Math.round(performance.now() - t), ok, programs: this.programCount() - p0 });
      if (!ok) console.warn(`[world] shaders '${s.name}' niet klaar binnen ${s.timeoutMs} ms, verder zonder te wachten`);
    }
    return out;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
  }
}
