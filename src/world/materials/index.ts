// MaterialLibrary: real CC0 PBR materials for every MaterialClass (see src/contracts.ts).
//
//   const materials = await createMaterialLibrary(engine);
//   mesh.material = materials.get('klinkers');
//   const water = materials.createWater(waterGeometry);
//
// Extra (optional) API for other modules: see MaterialLibraryExt below.
import * as THREE from 'three';
import type { Engine, MaterialClass, MaterialLibrary } from '../../contracts';
import { createFacadeMaterial } from './facade';
import { createBackdropMaterial, createRoofMaterial } from './roofs';
import { createSurfaceMaterial, CURB_EXTRA, lin, QUAY_EXTRA } from './surfaces';
import { loadTextureStore, TEXTURE_SET_NAMES, type TextureSetName, type TextureStore } from './textures';
import { WaterSystem } from './water';

export type { TextureSetName } from './textures';

export interface PbrOptions {
  /** UV repeat (for 0..1 UV models) — default 1 */
  repeat?: number | [number, number];
  color?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  normalScale?: number;
}

/** Optional extensions on top of the contract (feature-detect with `'pbr' in lib`). */
export interface MaterialLibraryExt extends MaterialLibrary {
  /**
   * A plain MeshStandardMaterial (map/normalMap/aoMap/roughnessMap/metalnessMap) using one of the
   * texture sets, for props / landmarks with ordinary UVs. Textures share GPU memory with the library.
   * Results are cached per (name, options).
   */
  pbr(name: TextureSetName, opts?: PbrOptions): THREE.MeshStandardMaterial;
  /** Real-world tile size (metres) of a texture set, to compute UV repeats for metric geometry. */
  metres(name: TextureSetName): number;
  /** 0 = day .. 1 = night: interior lights in windows / shop fronts. */
  setNight(amount: number): void;
  readonly store: TextureStore;
}

const ALL_CLASSES: MaterialClass[] = [
  'wall', 'roof_slanted', 'roof_flat', 'backdrop', 'asphalt', 'klinkers', 'sidewalk', 'square', 'curb',
  'bikelane', 'grass', 'water', 'quay', 'quay_cap', 'bridge_deck', 'bridge_side', 'bridge_rail',
  'road_marking', 'parking', 'canal_bed', 'ground',
];

export async function createMaterialLibrary(engine: Engine): Promise<MaterialLibraryExt> {
  const store = await loadTextureStore(engine);
  const S = (n: TextureSetName) => {
    const s = store.sets.get(n);
    if (!s) throw new Error(`texture set ${n} ontbreekt`);
    return s;
  };
  const noise = store.noise;
  const mats = new Map<MaterialClass, THREE.Material>();

  // --- buildings
  mats.set('wall', createFacadeMaterial({ brickA: S('brick_facade'), brickB: S('brick_facade_alt'), plaster: S('plaster') }, noise));
  mats.set('roof_slanted', createRoofMaterial(S('roof_tiles'), S('roof_tiles_dark'), noise));
  mats.set('roof_flat', createSurfaceMaterial({
    key: 'roof_flat', set: S('roof_flat'), useAttr: true, macro: 0.25, stochastic: true,
    extra: /* glsl */ `
      // mostly dark bitumen, some grey gravel ballast, a few sedum (green) roofs
      float k = adHash11(vAdAttr.r * 71.0 + 3.0);
      sAlbedo *= k < 0.55 ? vec3(0.45) : (k < 0.8 ? vec3(0.85) : (k < 0.9 ? vec3(1.2, 1.17, 1.1) : vec3(0.5, 0.62, 0.3)));
      sRough = k < 0.55 ? mix(sRough, 0.7, 0.5) : sRough;`,
  }, noise));
  mats.set('backdrop', createBackdropMaterial(S('brick_facade'), noise));

  // --- streets
  mats.set('asphalt', createSurfaceMaterial({
    key: 'asphalt', set: S('asphalt'), stochastic: true, macro: 0.22, tint: 0xb2b2b0, roughnessAdd: 0.2, normalStrength: 1.6,
    extra: /* glsl */ `
      // patched / repaired areas and darker oily centre wear
      vec4 mp = adMacro(wp.xz * vec2(1.0, 0.35), 23.0);
      float patchA = smoothstep(0.72, 0.74, mp.a);
      sAlbedo *= mix(1.0, 0.72, patchA);
      sRough = mix(sRough, 0.75, patchA);`,
  }, noise));
  mats.set('bikelane', createSurfaceMaterial({
    key: 'bikelane', set: S('asphalt'), stochastic: true, macro: 0.18,
    recolor: { color: lin(0x763f38), amount: 0.92, avgLuma: 0.19 }, roughnessAdd: 0.15,
  }, noise));
  mats.set('klinkers', createSurfaceMaterial({
    key: 'klinkers', set: S('klinkers'), macro: 0.25, tint: 0xf2f0f0, normalStrength: 1.2, roughnessAdd: 0.25,
    antiMoire: [0.05, 0.2],
    extra: /* glsl */ `
      // a few replaced / darker pavers patches and tyre polish
      vec4 mk = adMacro(wp.xz, 11.0);
      sAlbedo *= mix(1.0, 0.8, smoothstep(0.62, 0.8, mk.a));
      // paver batches / resets at a 3-6 m scale: breaks up the 1.75 m texture repeat at mid distance
      vec4 mb = adMacro(wp.xz + 31.0, 4.3);
      sAlbedo *= 0.93 + 0.14 * mb.r;
      // street grime: klinkers in use are duller / browner than new ones
      sAlbedo = mix(sAlbedo, vec3(adLuma(sAlbedo)) * vec3(1.25, 0.95, 0.8), 0.22 + 0.12 * mk.g);`,
  }, noise));
  mats.set('sidewalk', createSurfaceMaterial({
    key: 'sidewalk', set: S('sidewalk_tiles'), macro: 0.22, tint: 0xd0d0d0, roughnessAdd: 0.3, antiMoire: [0.06, 0.24],
    extra: /* glsl */ `
      // dirt / chewing-gum speckles and shade near walls are left to AO
      vec4 ms = adMacro(wp.xz, 7.0);
      sAlbedo *= mix(1.0, 0.82, smoothstep(0.6, 0.85, ms.b));`,
  }, noise));
  mats.set('square', createSurfaceMaterial({ key: 'square', set: S('square_cobbles'), macro: 0.2, tint: 0xd8d4d0, normalStrength: 1.2, roughnessAdd: 0.25, antiMoire: [0.05, 0.2] }, noise));
  mats.set('parking', createSurfaceMaterial({
    key: 'parking', set: S('klinkers'), macro: 0.2, recolor: { color: lin(0x5d5b58), amount: 0.85, avgLuma: 0.1 }, roughnessAdd: 0.25, antiMoire: [0.05, 0.2],
  }, noise));
  mats.set('curb', createSurfaceMaterial({ key: 'curb', set: S('curb'), scale: 0.6, tint: 0xb0b0b0, macro: 0.1, roughnessAdd: 0.2, extra: CURB_EXTRA }, noise));
  mats.set('road_marking', createSurfaceMaterial({
    key: 'road_marking', set: S('asphalt'), macro: 0.05, polygonOffset: 2,
    extra: /* glsl */ `
      // white thermoplastic paint over the aggregate, worn by traffic
      vec4 mw = adMacro(wp.xz * 3.0, 5.0);
      float wear = smoothstep(0.62, 0.92, mw.r * 0.7 + mw.g * 0.5) * 0.45;
      vec3 paint = vec3(0.78) * (0.92 + 0.16 * adLuma(sAlbedo) / 0.25);
      sAlbedo = mix(paint, sAlbedo, wear);
      sRough = mix(0.55, sRough, wear);
      sNormal = normalize(vec3(sNormal.xy * 0.5, sNormal.z));`,
  }, noise));
  mats.set('grass', createSurfaceMaterial({
    key: 'grass', set: S('grass'), stochastic: true, macro: 0.35, tint: 0xa4ac94, roughnessAdd: 0.6,
    extra: /* glsl */ `
      vec4 mg = adMacro(wp.xz, 17.0);
      sAlbedo = mix(sAlbedo, sAlbedo * vec3(1.25, 1.1, 0.6), smoothstep(0.55, 0.85, mg.g) * 0.6);`,
  }, noise));
  mats.set('ground', createSurfaceMaterial({
    key: 'ground', set: S('mud'), stochastic: true, macro: 0.25, recolor: { color: lin(0x6b6155), amount: 0.8, avgLuma: 0.08 },
    roughnessAdd: 0.1,
  }, noise));

  // --- canals & bridges
  mats.set('quay', createSurfaceMaterial({ key: 'quay', set: S('brick_quay'), macro: 0.15, tint: 0xd0c8c4, roughnessAdd: 0.25, extra: QUAY_EXTRA }, noise));
  mats.set('quay_cap', createSurfaceMaterial({ key: 'quay_cap', set: S('curb'), tint: 0x8a9094, macro: 0.12, roughnessAdd: 0.15, extra: CURB_EXTRA }, noise));
  mats.set('bridge_deck', createSurfaceMaterial({ key: 'bridge_deck', set: S('klinkers'), macro: 0.2, tint: 0xc8c0c0, roughnessAdd: 0.25, antiMoire: [0.05, 0.2] }, noise));
  mats.set('bridge_side', createSurfaceMaterial({ key: 'bridge_side', set: S('brick_facade_alt'), macro: 0.15, roughnessAdd: 0.3, extra: QUAY_EXTRA }, noise));
  mats.set('bridge_rail', createSurfaceMaterial({
    key: 'bridge_rail', set: S('metal_painted'), tint: 0x2a4a36, macro: 0.05, normalStrength: 0.3,
    extra: /* glsl */ `
      // mostly intact paint: soften the scratches of the source texture
      sAlbedo = mix(vec3(adLuma(sAlbedo)) * vec3(0.06, 0.12, 0.08) * 1.6, sAlbedo, 0.25);
      sRough = 0.42;
      sMetal *= 0.25;`,
  }, noise));
  mats.set('canal_bed', createSurfaceMaterial({ key: 'canal_bed', set: S('mud'), stochastic: true, macro: 0.3, tint: 0x707060 }, noise));

  const water = new WaterSystem(engine, store.waterNormal, noise);
  mats.set('water', water.material);

  for (const c of ALL_CLASSES) if (!mats.has(c)) throw new Error(`materiaal ${c} ontbreekt`);

  const unsubQ = engine.onQualityChange((q) => store.setAnisotropy(q.anisotropy));

  const pbrCache = new Map<string, THREE.MeshStandardMaterial>();
  const texCache = new Map<string, THREE.Texture>();
  const repeated = (t: THREE.Texture, r: [number, number]) => {
    if (r[0] === 1 && r[1] === 1) return t;
    const key = `${t.uuid}:${r[0]}:${r[1]}`;
    let c = texCache.get(key);
    if (!c) {
      c = t.clone(); // shares the Source -> no extra GPU upload
      c.repeat.set(r[0], r[1]);
      c.needsUpdate = true;
      texCache.set(key, c);
    }
    return c;
  };

  const lib: MaterialLibraryExt = {
    store,
    get(name: MaterialClass): THREE.Material {
      const m = mats.get(name);
      if (!m) {
        console.warn(`[materials] onbekende materiaalklasse "${name}", gebruik 'ground'`);
        return mats.get('ground')!;
      }
      return m;
    },
    createWater(geometry: THREE.BufferGeometry): THREE.Mesh {
      return water.createWater(geometry);
    },
    texture(name: string): THREE.Texture | undefined {
      // 'brick_facade' -> colour map; 'brick_facade/normal', 'brick_facade_normal', '.../arm' too.
      const alias: Record<string, string> = { brick_red: 'brick_facade', brick: 'brick_facade', water_normal: 'water' };
      const m = /^(.*?)(?:[/_](color|normal|arm))?$/.exec(name);
      let base = m?.[1] ?? name;
      let kind = m?.[2] ?? 'color';
      if (!store.sets.has(base as TextureSetName) && store.sets.has(name as TextureSetName)) { base = name; kind = 'color'; }
      base = alias[base] ?? base;
      if (base === 'water') return store.waterNormal;
      if (base === 'noise') return store.noise;
      const set = store.sets.get(base as TextureSetName);
      if (!set) return undefined;
      return kind === 'normal' ? set.normal : kind === 'arm' ? set.arm : set.color;
    },
    pbr(name: TextureSetName, opts: PbrOptions = {}): THREE.MeshStandardMaterial {
      const key = `${name}:${JSON.stringify(opts)}`;
      let m = pbrCache.get(key);
      if (m) return m;
      const set = S(name);
      const r: [number, number] = typeof opts.repeat === 'number' ? [opts.repeat, opts.repeat] : opts.repeat ?? [1, 1];
      const arm = repeated(set.arm, r);
      m = new THREE.MeshStandardMaterial({
        name: `pbr:${name}`,
        map: repeated(set.color, r),
        normalMap: repeated(set.normal, r),
        aoMap: arm,
        roughnessMap: arm,
        metalnessMap: arm,
        color: opts.color ?? 0xffffff,
        roughness: opts.roughness ?? 1,
        metalness: opts.metalness ?? 1,
        normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
      });
      pbrCache.set(key, m);
      return m;
    },
    metres(name: TextureSetName): number {
      return S(name).metres;
    },
    setNight(amount: number): void {
      const u = (mats.get('wall') as THREE.MeshStandardMaterial).userData.adUniforms as Record<string, THREE.IUniform>;
      u.uLit.value = THREE.MathUtils.clamp(amount, 0, 1);
    },
    dispose(): void {
      unsubQ();
      water.dispose();
      for (const m of mats.values()) m.dispose();
      for (const m of pbrCache.values()) m.dispose();
      for (const t of texCache.values()) t.dispose();
      store.dispose();
    },
  };
  return lib;
}

export { TEXTURE_SET_NAMES };
