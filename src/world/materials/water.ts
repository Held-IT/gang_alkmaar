// Canal water: dark green-brown Dutch canal, scrolling dual normal maps, PBR fresnel + sun glint
// (MeshStandardMaterial lighting), and reflections:
//   quality.waterReflections === 'planar' -> one shared half-resolution planar reflection
//     (mirror camera about y = WATER_LEVEL with an oblique near plane, rendered at most once per
//     frame from the first visible water mesh's onBeforeRender; all water meshes are hidden
//     during that pass). The mirror camera renders ONLY render layer LAYER_REFLECT (buildings,
//     ground near water, backdrop, landmarks, canal trees: set by their owners) plus the sky dome
//     and all lights, which are put on that layer here (same light set = same shader programs),
//   'env' -> scene.environment (IBL) only.
// Planar cost control (the pass is vertex-bound: ~90 draws / 0.8 M tris at the Waag, ~4 ms of fixed
// cost on the dev iGPU): every water mesh draw in the main pass is wrapped in an occlusion query and
// the reflection is skipped while no water pixel survived the depth test in the last frames (canals
// behind the houses of a street); on every level below ultra it is refreshed every 2nd frame (the
// texture keeps the mirror matrix it was rendered with, so a 1-frame-old image stays registered).
import * as THREE from 'three';
import { LAYER_REFLECT, WATER_LEVEL } from '../../config';
import type { Engine, QualitySettings } from '../../contracts';
import { patchSurface } from './shaderLib';

const WATER_PARS = /* glsl */ `
uniform sampler2D tWaterN;
uniform sampler2D tReflection;
uniform float uTime;
uniform float uPlanarMix;
uniform float uDistort;
varying vec4 vReflCoord;
vec2 waterSlope; // written by the surface, read after the IBL lookup
`;

const WATER_SURFACE = /* glsl */ `
  vec2 p = vAdWorldPos.xz;
  float t = uTime;
  const mat2 R1 = mat2(0.8, 0.6, -0.6, 0.8);
  const mat2 R2 = mat2(0.28, -0.96, 0.96, 0.28);
  vec2 uvA = p / 9.0 + vec2(0.008, 0.005) * t;
  vec2 uvB = R1 * p / 3.4 + vec2(-0.013, 0.008) * t;
  vec2 uvC = R2 * p / 1.1 + vec2(0.03, -0.018) * t;
  vec3 nA = texture2D(tWaterN, uvA).xyz * 2.0 - 1.0;
  vec3 nB = texture2D(tWaterN, uvB).xyz * 2.0 - 1.0;
  vec3 nC = texture2D(tWaterN, uvC).xyz * 2.0 - 1.0;
  nB.xy = nB.xy * R1;
  nC.xy = nC.xy * R2;
  // calmer further away (also hides normal-map aliasing at grazing angles)
  float dist = length(cameraPosition - vAdWorldPos);
  float calm = mix(1.0, 0.35, smoothstep(15.0, 160.0, dist));
  vec2 slope = (nA.xy * 0.5 + nB.xy * 0.35 + nC.xy * 0.15) * 0.09 * calm;
  sNormal = normalize(vec3(slope, 1.0));
  sTbnUv = p;
  // murky canal water: very dark green-brown body colour, slight variation
  vec4 m = adMacro(p, 47.0);
  sAlbedo = vec3(0.014, 0.019, 0.011) * (0.8 + 0.4 * m.r);
  sRough = 0.04 + 0.03 * m.g;
  sMetal = 0.0;
  sAO = 1.0;
  waterSlope = slope;
  // env-only reflections: low rays see the quays and houses along the canal, not the open sky
  sSkyOcc = 1.0 - uPlanarMix;
  sOppDist = 20.0;   // typical horizontal distance from the water to the facades
`;

const WATER_REFLECT = /* glsl */ `
  if (uPlanarMix > 0.0) {
    vec2 ruv = vReflCoord.xy / vReflCoord.w + waterSlope * uDistort;
    vec3 refl = texture2D(tReflection, ruv).rgb * 1.25;
    radiance = mix(radiance, refl, uPlanarMix);
  }
`;

// Debug overrides: ?wr_far=<m> (mirror camera far plane), ?wr_scale=<0.2..1> (reflection resolution).
const DEBUG_PARAMS = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
function debugNumber(name: string, min: number, max: number): number | null {
  const v = Number(DEBUG_PARAMS.get(name));
  return DEBUG_PARAMS.has(name) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
}
const REFLECT_FAR = debugNumber('wr_far', 50, 6000) ?? 900;
const REFLECT_SCALE = debugNumber('wr_scale', 0.2, 1) ?? 0.5;

class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  private readonly cam = new THREE.PerspectiveCamera();
  private readonly plane = new THREE.Plane();
  private readonly clipPlane = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly camPos = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly size = new THREE.Vector2();
  private readonly rot = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();
  private layerSyncIn = 0;
  private readonly hidden: THREE.Object3D[] = [];
  renderedFrame = -1;
  /** frame of the last actual render (-1e9: stale, never or not since the water was hidden) */
  lastRender = -1e9;

  /**
   * Puts every light and the sky dome on LAYER_REFLECT (rescanned every ~2 s for lights added
   * later, e.g. headlights). Lights are layer-tested by three: without them the reflection pass
   * would be unlit and every material would switch shader programs twice per frame.
   */
  private syncLayers(scene: THREE.Scene): void {
    if (--this.layerSyncIn > 0) return;
    this.layerSyncIn = 120;
    scene.traverse((o) => {
      if ((o as THREE.Light).isLight || o.name === 'SkyDome' || o.userData.reflectAlways === true) {
        o.layers.enable(LAYER_REFLECT);
      }
    });
  }

  constructor(private readonly scale: number) {
    this.target = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.target.texture.name = 'water-reflection';
  }

  /** Renders the mirrored scene. Returns false when skipped. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, hide: Iterable<THREE.Object3D>): boolean {
    if (!(camera instanceof THREE.PerspectiveCamera)) return false;
    camera.getWorldPosition(this.camPos);
    if (this.camPos.y < WATER_LEVEL + 0.05) return false; // camera under water / at the surface

    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(16, Math.round(this.size.x * this.scale));
    const h = Math.max(16, Math.round(this.size.y * this.scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    // mirror camera about the horizontal plane y = WATER_LEVEL
    const vc = this.cam;
    vc.copy(camera, false);
    vc.position.set(this.camPos.x, 2 * WATER_LEVEL - this.camPos.y, this.camPos.z);
    this.rot.extractRotation(camera.matrixWorld);
    this.lookAt.set(0, 0, -1).applyMatrix4(this.rot).add(this.camPos);
    this.lookAt.y = 2 * WATER_LEVEL - this.lookAt.y;
    this.tmp.set(0, 1, 0).applyMatrix4(this.rot);
    vc.up.set(this.tmp.x, -this.tmp.y, this.tmp.z);
    vc.lookAt(this.lookAt);
    vc.far = Math.min(camera.far, REFLECT_FAR);
    // keep the renderer's depth convention, otherwise it would rebuild (and lose) our matrix
    const reversed = renderer.state.buffers.depth.getReversed();
    (vc as unknown as { _reversedDepth: boolean })._reversedDepth = reversed;
    vc.updateProjectionMatrix();
    vc.updateMatrixWorld(true);
    vc.layers.set(LAYER_REFLECT);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // oblique near plane = water plane (Lengyel), so nothing below the water is rendered
    this.plane.set(new THREE.Vector3(0, 1, 0), -WATER_LEVEL).applyMatrix4(vc.matrixWorldInverse);
    this.clipPlane.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = vc.projectionMatrix.elements;
    if (reversed) {
      // reversed depth (NDC z: near = 1, far = 0): row3' = a * C + row4 with the far plane
      // through the frustum corner Q = M^-1 (sx, sy, 0, 1)
      this.q.set((Math.sign(this.clipPlane.x) + pm[8]) / pm[0], (Math.sign(this.clipPlane.y) + pm[9]) / pm[5], -1, pm[10] / pm[14]);
      const a = -1 / this.clipPlane.dot(this.q);
      pm[2] = a * this.clipPlane.x;
      pm[6] = a * this.clipPlane.y;
      pm[10] = a * this.clipPlane.z - 1;
      pm[14] = a * this.clipPlane.w;
    } else {
      // classic OpenGL depth (NDC z in -1..1), Lengyel's oblique near plane as in three's Reflector
      this.q.set((Math.sign(this.clipPlane.x) + pm[8]) / pm[0], (Math.sign(this.clipPlane.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
      this.clipPlane.multiplyScalar(2 / this.clipPlane.dot(this.q));
      pm[2] = this.clipPlane.x;
      pm[6] = this.clipPlane.y;
      pm[10] = this.clipPlane.z + 1 - 0.003;
      pm[14] = this.clipPlane.w;
    }
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();

    this.syncLayers(scene);
    const hidden = this.hidden;
    hidden.length = 0;
    for (const o of hide) if (o.visible) { o.visible = false; hidden.push(o); }
    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, vc);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.xr.enabled = prevXr;
    for (const o of hidden) o.visible = true;
    hidden.length = 0;
    return true;
  }

  dispose(): void {
    this.target.dispose();
  }
}

export class WaterSystem {
  readonly material: THREE.MeshStandardMaterial;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly meshes = new Set<THREE.Mesh>();
  private reflection: PlanarReflection | null = null;
  private frame = 0;
  /** reflection refresh interval in frames (1 = every frame) */
  private interval = 1;
  /** per water mesh: occlusion query state (visibility of its main-pass draw) */
  private readonly vis = new Map<THREE.Mesh, { query: WebGLQuery | null; open: boolean; visible: boolean; drawn: number }>();
  private queryOpen = false;
  private readonly blank: THREE.DataTexture;
  private readonly unsub: (() => void)[] = [];

  constructor(private readonly engine: Engine, waterNormal: THREE.Texture, noise: THREE.Texture) {
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blank.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0 });
    mat.name = 'water';
    patchSurface(mat, {
      key: 'water-v1',
      uniforms: {
        tWaterN: { value: waterNormal },
        tReflection: { value: this.blank },
        uTime: { value: 0 },
        uPlanarMix: { value: 0 },
        uDistort: { value: 0.12 },
        uTextureMatrix: { value: new THREE.Matrix4() },
      },
      vertexPars: 'uniform mat4 uTextureMatrix;\nvarying vec4 vReflCoord;',
      vertexMain: 'vReflCoord = uTextureMatrix * vec4(adWp.xyz, 1.0);',
      fragmentPars: WATER_PARS,
      surface: WATER_SURFACE,
      afterLightsMaps: WATER_REFLECT,
    }, noise);
    this.material = mat;
    this.uniforms = mat.userData.adUniforms as Record<string, THREE.IUniform>;

    this.unsub.push(engine.onUpdate((dt) => {
      this.frame++;
      if (this.queryOpen) {
        // a draw threw between onBeforeRender and onAfterRender: close the query so they keep working
        const gl = engine.renderer.getContext() as WebGL2RenderingContext;
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
        this.queryOpen = false;
        for (const st of this.vis.values()) st.open = false;
      }
      this.uniforms.uTime.value += dt;
    }, 39));
    this.unsub.push(engine.onQualityChange((q) => this.applyQuality(q)));
    this.applyQuality(engine.quality);
  }

  private applyQuality(q: Readonly<QualitySettings>): void {
    this.interval = q.level === 'ultra' ? 1 : 2;
    if (q.waterReflections === 'planar') {
      if (!this.reflection) {
        this.reflection = new PlanarReflection(REFLECT_SCALE);
        this.uniforms.tReflection.value = this.reflection.target.texture;
      }
      this.uniforms.uPlanarMix.value = 1;
    } else {
      this.uniforms.uPlanarMix.value = 0;
      this.uniforms.tReflection.value = this.blank;
      this.reflection?.dispose();
      this.reflection = null;
    }
  }

  createWater(geometry: THREE.BufferGeometry): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'water';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    const st = { query: null as WebGLQuery | null, open: false, visible: true, drawn: -1e9 };
    this.vis.set(mesh, st);
    mesh.onBeforeRender = (renderer, scene, camera) => {
      if (scene.overrideMaterial) return;
      const r = this.reflection;
      if (r && r.renderedFrame !== this.frame) {
        r.renderedFrame = this.frame; // also guards against re-entry from the reflection pass
        this.updateReflection(r, renderer, scene, camera);
      }
      if (r) this.beginQuery(renderer, st);
    };
    mesh.onAfterRender = (renderer) => {
      if (!st.open) return;
      const gl = renderer.getContext() as WebGL2RenderingContext;
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      st.open = false;
      this.queryOpen = false;
    };
    this.meshes.add(mesh);
    mesh.addEventListener('removed', () => {
      this.meshes.delete(mesh);
      const q = this.vis.get(mesh)?.query;
      if (q) (this.engine.renderer.getContext() as WebGL2RenderingContext).deleteQuery(q);
      this.vis.delete(mesh);
    });
    return mesh;
  }

  /** Renders (or skips) the shared reflection for this frame. */
  private updateReflection(r: PlanarReflection, renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    // visible = a water draw of the last 3 frames passed the depth test (query results lag 1-2 frames)
    let visible = false;
    for (const st of this.vis.values()) {
      if (st.visible && st.drawn >= this.frame - 3) { visible = true; break; }
    }
    if (!visible) {
      // nothing to reflect: skip; until the next render the (rare) first visible frames fall back to
      // the env-only look instead of showing an outdated mirror image
      r.lastRender = -1e9;
      this.uniforms.uPlanarMix.value = 0;
      return;
    }
    if (this.frame - r.lastRender < this.interval) return; // half-rate refresh (texture still valid)
    if (r.render(renderer, scene, camera, this.meshes)) {
      (this.uniforms.uTextureMatrix.value as THREE.Matrix4).copy(r.textureMatrix);
      r.lastRender = this.frame;
      this.uniforms.uPlanarMix.value = 1;
    }
  }

  /** Occlusion query around this mesh's main-pass draw (collects the previous result first). */
  private beginQuery(renderer: THREE.WebGLRenderer, st: { query: WebGLQuery | null; open: boolean; visible: boolean; drawn: number }): void {
    st.drawn = this.frame;
    if (this.queryOpen) return; // one query of a target at a time (never nests in practice)
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (st.query) {
      if (!gl.getQueryParameter(st.query, gl.QUERY_RESULT_AVAILABLE)) return; // still in flight
      st.visible = !!gl.getQueryParameter(st.query, gl.QUERY_RESULT);
    } else {
      st.query = gl.createQuery();
      if (!st.query) return;
    }
    gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, st.query);
    st.open = true;
    this.queryOpen = true;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    const gl = this.engine.renderer.getContext() as WebGL2RenderingContext;
    for (const st of this.vis.values()) if (st.query) gl.deleteQuery(st.query);
    this.vis.clear();
    this.reflection?.dispose();
    this.blank.dispose();
    this.material.dispose();
  }
}
