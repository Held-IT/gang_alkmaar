// Loads the CC0 PBR texture sets produced by tools/assets/fetch.mjs (+ generate.mjs).
// Decoding happens off the main thread via createImageBitmap; on quality 'laag' large maps are
// downscaled to 1024 px at decode time to halve GPU memory.
import * as THREE from 'three';
import { ASSETS_URL } from '../../config';
import type { Engine } from '../../contracts';

export type TextureSetName =
  | 'brick_facade' | 'brick_facade_alt' | 'plaster' | 'brick_quay' | 'klinkers' | 'sidewalk_tiles'
  | 'square_cobbles' | 'asphalt' | 'curb' | 'roof_tiles' | 'roof_tiles_dark' | 'roof_flat' | 'grass'
  | 'stone' | 'wood' | 'mud' | 'metal_painted';

export const TEXTURE_SET_NAMES: TextureSetName[] = [
  'brick_facade', 'brick_facade_alt', 'plaster', 'brick_quay', 'klinkers', 'sidewalk_tiles',
  'square_cobbles', 'asphalt', 'curb', 'roof_tiles', 'roof_tiles_dark', 'roof_flat', 'grass',
  'stone', 'wood', 'mud', 'metal_painted',
];

export interface TextureSet {
  /** sRGB albedo */
  color: THREE.Texture;
  /** OpenGL tangent-space normal map */
  normal: THREE.Texture;
  /** R = AO, G = roughness, B = metalness */
  arm: THREE.Texture;
  /** real-world size of one texture tile in metres */
  metres: number;
}

export interface TextureStore {
  sets: Map<TextureSetName, TextureSet>;
  waterNormal: THREE.Texture;
  noise: THREE.Texture;
  /** every texture, for anisotropy updates / disposal */
  all: THREE.Texture[];
  setAnisotropy(a: number): void;
  dispose(): void;
}

/** Physical tile size fallback if meta.json is missing (keep in sync with tools/assets/fetch.mjs). */
const DEFAULT_METRES: Record<TextureSetName, number> = {
  brick_facade: 1.25, brick_facade_alt: 0.9, plaster: 2, brick_quay: 1.1, klinkers: 1.75,
  sidewalk_tiles: 2.4, square_cobbles: 1.15, asphalt: 2.5, curb: 2.3, roof_tiles: 2.9,
  roof_tiles_dark: 2.9, roof_flat: 2.2, grass: 1.4, stone: 2, wood: 1.57, mud: 1.3, metal_painted: 1,
};

async function loadBitmap(url: string, maxSize: number): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Textuur niet gevonden: ${url} (${res.status})`);
  const blob = await res.blob();
  const opts: ImageBitmapOptions = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  let bmp = await createImageBitmap(blob, opts);
  if (bmp.width > maxSize) {
    const w = maxSize;
    const h = Math.round((bmp.height / bmp.width) * maxSize);
    bmp.close();
    bmp = await createImageBitmap(blob, { ...opts, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  }
  return bmp;
}

function makeTexture(bmp: ImageBitmap, srgb: boolean, anisotropy: number): THREE.Texture {
  const t = new THREE.Texture(bmp as unknown as HTMLImageElement);
  t.flipY = false; // already flipped by createImageBitmap
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export async function loadTextureStore(engine: Engine): Promise<TextureStore> {
  const base = `${ASSETS_URL}textures/`;
  const maxAniso = engine.renderer.capabilities.getMaxAnisotropy();
  const aniso = Math.max(1, Math.min(engine.quality.anisotropy, maxAniso));
  const maxSize = engine.quality.level === 'laag' ? 1024 : 4096;

  let meta: Record<string, { metres: number }> = {};
  try {
    const r = await fetch(`${base}meta.json`);
    if (r.ok) meta = await r.json();
  } catch {
    /* fall back to defaults */
  }

  const all: THREE.Texture[] = [];
  const sets = new Map<TextureSetName, TextureSet>();
  const jobs: Promise<void>[] = [];
  for (const name of TEXTURE_SET_NAMES) {
    jobs.push((async () => {
      const [c, n, a] = await Promise.all([
        loadBitmap(`${base}${name}/color.jpg`, maxSize),
        loadBitmap(`${base}${name}/normal.jpg`, maxSize),
        loadBitmap(`${base}${name}/arm.jpg`, maxSize),
      ]);
      const set: TextureSet = {
        color: makeTexture(c, true, aniso),
        normal: makeTexture(n, false, aniso),
        arm: makeTexture(a, false, aniso),
        metres: meta[name]?.metres ?? DEFAULT_METRES[name],
      };
      set.color.name = `${name}/color`;
      set.normal.name = `${name}/normal`;
      set.arm.name = `${name}/arm`;
      all.push(set.color, set.normal, set.arm);
      sets.set(name, set);
    })());
  }
  const extra = Promise.all([
    loadBitmap(`${base}water/normal.png`, maxSize),
    loadBitmap(`${base}noise/noise.png`, maxSize),
  ]);
  await Promise.all(jobs);
  const [wn, nz] = await extra;
  const waterNormal = makeTexture(wn, false, aniso);
  waterNormal.name = 'water/normal';
  const noise = makeTexture(nz, false, 1);
  noise.name = 'noise';
  all.push(waterNormal, noise);

  return {
    sets,
    waterNormal,
    noise,
    all,
    setAnisotropy(a: number) {
      // Live quality switch: update the sampler parameter on the existing GL textures instead of
      // `needsUpdate` (which re-uploaded all ~50 maps + regenerated mipmaps: a 0.3-0.5 s hitch).
      const v = Math.max(1, Math.min(a, maxAniso));
      const renderer = engine.renderer;
      const gl = renderer.getContext();
      const ext = renderer.extensions.get('EXT_texture_filter_anisotropic') as
        { TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
      for (const t of all) {
        if (t === noise || t.anisotropy === v) continue;
        t.anisotropy = v;
        const props = renderer.properties.get(t) as { __webglTexture?: WebGLTexture; __currentAnisotropy?: number };
        if (!props.__webglTexture) continue; // not uploaded yet: three applies it on upload
        if (!ext) continue; // no anisotropic filtering on this GPU
        renderer.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture); // keeps three's state cache in sync
        gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, v);
        props.__currentAnisotropy = v;
      }
    },
    dispose() {
      for (const t of all) {
        t.dispose();
        const img = t.image as unknown as ImageBitmap | undefined;
        if (img && typeof img.close === 'function') img.close();
      }
    },
  };
}
