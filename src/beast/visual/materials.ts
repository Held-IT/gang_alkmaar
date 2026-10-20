// Materials of the jelly beasts.
//
// Body: MeshPhysicalMaterial (soft roughness + velvet sheen) patched with
//   - a wrap-lighting "subsurface" term for the gummy look (inside RE_Direct, so it respects shadows),
//   - the procedural FACE painted from the bind-space position (eyes, lids, brows, mouth, KO eyes,
//     blush) -> no extra meshes/draw calls, crisp at every distance (fwidth anti-aliasing),
//   - the jiggle vertex offset (per-beast spring, see index.ts).
// Costume: MeshPhysicalMaterial with vertex colours + per-vertex roughness/metalness/sheen and
//   procedural fabric patterns (stripes, gingham, dots, straw weave, denim, lace...).
// Every beast gets its own material instances (own uniforms) but all share the same two programs
// (customProgramCacheKey), so more beasts cost no extra shader compiles.
import * as THREE from 'three';

export const PATTERN = {
  none: 0,
  stripesH: 1,
  gingham: 2,
  dots: 3,
  straw: 4,
  denim: 5,
  lace: 6,
  stripesV: 7,
  check: 8,
  knit: 9,
} as const;

/** Uniforms shared by the body and costume materials of ONE beast. */
export interface BeastUniforms {
  uJiggle: { value: THREE.Vector3 };
  uTime: { value: number };
}

export interface FaceUniforms {
  uHeadC: { value: THREE.Vector3 };
  uHeadR: { value: number };
  uFaceA: { value: THREE.Vector4 };
  uFaceB: { value: THREE.Vector4 };
  uFaceC: { value: THREE.Vector4 };
  uFaceD: { value: THREE.Vector4 };
  uFaceE: { value: THREE.Vector4 };
  uLook: { value: THREE.Vector2 };
  uBrowCol: { value: THREE.Color };
  uSSSColor: { value: THREE.Color };
  uWrap: { value: number };
}

export function createBeastUniforms(): BeastUniforms {
  return { uJiggle: { value: new THREE.Vector3() }, uTime: { value: 0 } };
}

export function createFaceUniforms(): FaceUniforms {
  return {
    uHeadC: { value: new THREE.Vector3(0, 1.28, 0) },
    uHeadR: { value: 0.22 },
    uFaceA: { value: new THREE.Vector4(0.1, 0, 0, 1) },
    uFaceB: { value: new THREE.Vector4(1, 0, 0, 1) },
    uFaceC: { value: new THREE.Vector4(0.3, 0, 0.8, 0) },
    uFaceD: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFaceE: { value: new THREE.Vector4(0, 0, 0, 1) },
    uLook: { value: new THREE.Vector2() },
    uBrowCol: { value: new THREE.Color(0x1d1714) },
    uSSSColor: { value: new THREE.Color(1, 0.5, 0.4) },
    uWrap: { value: 0.55 },
  };
}

// ---------------------------------------------------------------------------------------------
// shared vertex patch
// ---------------------------------------------------------------------------------------------

function patchVertex(shader: THREE.WebGLProgramParametersWithUniforms, costume: boolean): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
attribute float jig;
uniform vec3 uJiggle;
varying vec3 vBindPos;
${costume ? 'attribute vec3 color2;\nattribute vec4 surf;\nattribute vec4 pmap;\nvarying vec3 vColor2;\nvarying vec4 vSurf;\nvarying vec4 vPmap;' : ''}`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vBindPos = position;
${costume ? 'vColor2 = color2;\nvSurf = surf;\nvPmap = pmap;' : ''}`,
    )
    .replace(
      '#include <skinning_vertex>',
      `#include <skinning_vertex>
transformed += uJiggle * jig;`,
    );
}

// ---------------------------------------------------------------------------------------------
// body (jelly + face)
// ---------------------------------------------------------------------------------------------

const BODY_FRAG_PARS = /* glsl */ `
uniform vec3 uHeadC;
uniform float uHeadR;
uniform vec4 uFaceA; // openTop, openBottom, lidTilt, pupilScale
uniform vec4 uFaceB; // eyeScale, browY, browAngle, browAlpha
uniform vec4 uFaceC; // mouthCurve, mouthOpen, mouthWidth, mouthWobble
uniform vec4 uFaceD; // xEyes, spiralEyes, happyArcs, blush
uniform vec4 uFaceE; // teeth, tongue, mouthUpper, faceOn
uniform vec2 uLook;
uniform float uTime;
uniform vec3 uBrowCol;
varying vec3 vBindPos;
float gGloss = 0.0;

float bfSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float bfEll(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 < 1e-4 ? -min(r.x, r.y) : k0 * (k0 - 1.0) / k1;
}
float bfCov(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

vec3 beastFace(vec3 col, vec2 f, float aa, float mask) {
  float R = uHeadR;
  float side = f.x >= 0.0 ? 1.0 : -1.0;
  // ---------------- eyes (mirrored: +p.x points away from the nose)
  vec2 ec = vec2(0.36 * R, 0.12 * R);
  vec2 p = vec2(abs(f.x) - ec.x, f.y - ec.y);
  vec2 er = vec2(0.235, 0.3) * R * uFaceB.x;
  float dE = bfEll(p, er);
  float inEye = bfCov(dE, aa);
  float tilt = uFaceA.z;
  float yT = er.y * (1.0 - 2.0 * uFaceA.x) + tilt * p.x;
  float yBl = -er.y * (1.0 - 2.0 * uFaceA.y) - tilt * 0.3 * p.x;
  float lidT = smoothstep(-aa, aa, p.y - yT);
  float lidB = smoothstep(-aa, aa, yBl - p.y);
  float lid = max(lidT, lidB);
  float sclera = inEye * (1.0 - lid);
  vec2 pc = vec2(uLook.x * side, uLook.y) * er * 0.4;
  float pr = 0.135 * R * uFaceA.w;
  float pupil = bfCov(length(p - pc) - pr, aa) * sclera;
  float hi = bfCov(length(p - pc - vec2(0.38, 0.42) * pr) - pr * 0.33, aa) * sclera;
  float lw = 0.024 * R;
  float outline = bfCov(abs(dE) - lw, aa);
  float lash = inEye * max(bfCov(abs(p.y - yT) - lw * 1.15, aa), bfCov(abs(p.y - yBl) - lw * 0.7, aa) * step(0.02, uFaceA.y));
  float special = max(max(uFaceD.x, uFaceD.y), uFaceD.z);
  float normalEyes = 1.0 - special;

  vec3 eyes = col;
  eyes = mix(eyes, col * 0.78, inEye * lid);
  eyes = mix(eyes, vec3(0.86, 0.86, 0.84), sclera);
  eyes = mix(eyes, vec3(0.012), pupil);
  eyes = mix(eyes, vec3(1.0), hi);
  eyes = mix(eyes, uBrowCol, max(outline, lash));
  float eyeGloss = sclera;

  // X eyes
  float xa = 0.21 * R;
  float dX = min(bfSeg(p, vec2(-xa, -xa), vec2(xa, xa)), bfSeg(p, vec2(-xa, xa), vec2(xa, -xa))) - 0.052 * R;
  vec3 xEyes = mix(col, uBrowCol, bfCov(dX, aa));
  // spiral eyes (spinning)
  float rr = length(p);
  float disc = bfCov(rr - 0.28 * R, aa);
  float pitch = 0.082 * R;
  float sv = rr / pitch - atan(p.y, p.x * side) / 6.2831853 + uTime * 1.4;
  float a2 = aa / pitch;
  float ink = 1.0 - smoothstep(0.17 - a2, 0.17 + a2, abs(fract(sv) - 0.5));
  vec3 spiral = mix(col, vec3(0.86), disc);
  spiral = mix(spiral, uBrowCol, max(ink * disc, bfCov(abs(rr - 0.28 * R) - lw, aa)));
  // happy arcs (^ ^)
  vec2 ac = vec2(0.0, -0.13 * R);
  float dA = abs(length(p - ac) - 0.23 * R) - 0.052 * R;
  dA = max(dA, -(p.y - ac.y - 0.03 * R));
  vec3 arcs = mix(col, uBrowCol, bfCov(dA, aa));

  vec3 eyeCol = eyes * normalEyes + xEyes * uFaceD.x + spiral * uFaceD.y + arcs * uFaceD.z;
  float eyeArea = bfCov(rr - 0.47 * R, aa);
  vec3 outCol = mix(col, eyeCol, eyeArea);
  gGloss = eyeGloss * normalEyes * eyeArea + disc * uFaceD.y;

  // ---------------- brows
  vec2 bc = vec2(0.0, er.y + 0.17 * R + uFaceB.y * R);
  float hl = 0.19 * R;
  float ba = uFaceB.z;
  float dB = bfSeg(p, bc + vec2(-hl, -ba * hl), bc + vec2(hl, ba * hl * 0.6)) - 0.05 * R;
  outCol = mix(outCol, uBrowCol, bfCov(dB, aa) * uFaceB.w);

  // ---------------- blush
  float bl = 1.0 - smoothstep(0.0, 0.17 * R, length(vec2(abs(f.x) - 0.5 * R, f.y + 0.17 * R)));
  outCol = mix(outCol, outCol * vec3(1.15, 0.5, 0.55) + vec3(0.16, 0.012, 0.02), bl * uFaceD.w * 0.65);

  // ---------------- mouth
  vec2 q = f - vec2(0.0, -0.33 * R);
  float w = 0.25 * R * uFaceC.z;
  float xn = clamp(q.x / max(w, 1e-4), -1.0, 1.0);
  float cv = uFaceC.x * 0.14 * R * (xn * xn - 0.3) + uFaceC.w * 0.02 * R * sin(q.x / R * 40.0 + uTime * 10.0);
  float yq = q.y - cv;
  float env = sqrt(max(1.0 - xn * xn, 0.0));
  float open = uFaceC.y;
  float depth = open * 0.3 * R * env;
  float upper = uFaceE.z * open * 0.3 * R * env;
  float th = 0.032 * R;
  float dS = length(vec2(max(abs(q.x) - w, 0.0), yq)) - th;
  float dM = max(abs(q.x) - w, max(yq - upper, -yq - depth));
  float hasOpen = smoothstep(0.02, 0.08, open);
  float inM = bfCov(dM, aa) * hasOpen;
  float rim = bfCov(abs(dM) - th * 0.7, aa) * hasOpen;
  outCol = mix(outCol, uBrowCol, max(bfCov(dS, aa) * (1.0 - hasOpen), rim));
  vec3 mouthIn = vec3(0.13, 0.016, 0.024);
  float teeth = inM * smoothstep(-aa, aa, yq - (upper - 0.42 * (depth + upper))) * uFaceE.x;
  float tongue = inM * bfCov(length(vec2(q.x * 0.9, yq + depth * 0.95)) - 0.62 * w * min(1.0, open * 2.0), aa) * uFaceE.y;
  outCol = mix(outCol, mouthIn, inM * (1.0 - rim));
  outCol = mix(outCol, vec3(0.8, 0.78, 0.74), teeth);
  outCol = mix(outCol, vec3(0.62, 0.13, 0.17), tongue);
  gGloss = max(gGloss, inM * 0.6);

  gGloss *= mask;
  return mix(col, outCol, mask);
}
`;

const BODY_FACE_MAIN = /* glsl */ `
{
  vec3 fd = vBindPos - uHeadC;
  vec2 ff = vec2(atan(fd.x, max(fd.z, 1e-4)), atan(fd.y, length(fd.xz))) * uHeadR;
  float faa = max(length(fwidth(ff)) * 0.7, 1e-5);
  float fl = length(fd);
  float fmask = smoothstep(0.05, 0.3, fd.z / max(fl, 1e-4)) * step(fl, uHeadR * 1.4) * uFaceE.w;
  diffuseColor.rgb = beastFace(diffuseColor.rgb, ff, faa, fmask);
}
`;

const JELLY_DIRECT = /* glsl */ `
uniform vec3 uSSSColor;
uniform float uWrap;
float gSSS = 1.0;
void RE_Direct_Jelly( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float nl = dot( geometryNormal, directLight.direction );
  float wrapped = clamp( ( nl + uWrap ) / ( 1.0 + uWrap ), 0.0, 1.0 );
  float extra = max( wrapped - max( nl, 0.0 ), 0.0 );
  reflectedLight.directDiffuse += directLight.color * extra * uSSSColor * BRDF_Lambert( material.diffuseContribution ) * gSSS;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Jelly
`;

export function createBodyMaterial(colour: THREE.Color, bu: BeastUniforms, fu: FaceUniforms): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: colour,
    roughness: 0.42,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.42,
    sheenColor: new THREE.Color(1, 1, 1),
    specularIntensity: 0.75,
  });
  m.name = 'beast_body';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, bu, fu);
    patchVertex(shader, false);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BODY_FRAG_PARS}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${JELLY_DIRECT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${BODY_FACE_MAIN}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.16, gGloss);\ngSSS = 1.0 - gGloss;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor *= (1.0 - gGloss);\n#endif`);
  };
  m.customProgramCacheKey = () => 'gang-alkmaar-beast-body-v1';
  return m;
}

/** Sheen + subsurface tints for a body colour. */
export function applyBodyColour(m: THREE.MeshPhysicalMaterial, fu: FaceUniforms, colour: THREE.Color): void {
  m.color.copy(colour);
  const hsl = { h: 0, s: 0, l: 0 };
  colour.getHSL(hsl);
  // velvet rim: a lighter, slightly desaturated version of the body colour
  m.sheenColor.setHSL(hsl.h, Math.min(1, hsl.s * 0.75), Math.min(0.92, 0.45 + hsl.l * 0.7)).multiplyScalar(0.75);
  // subsurface: a deeper, more saturated tint (warmer for light colours)
  fu.uSSSColor.value.setHSL(hsl.h, Math.min(1, hsl.s * 1.15 + 0.1), Math.min(0.6, hsl.l * 0.9 + 0.12)).multiplyScalar(1.25);
  // brow/lash ink: very dark, faintly tinted with the body colour
  fu.uBrowCol.value.setHSL(hsl.h, Math.min(0.5, hsl.s * 0.5), 0.035);
}

// ---------------------------------------------------------------------------------------------
// costume (vertex colours + per-vertex surface + patterns)
// ---------------------------------------------------------------------------------------------

const COSTUME_FRAG_PARS = /* glsl */ `
varying vec4 vPmap;
varying vec3 vColor2;
varying vec4 vSurf;
float cpBand(float x, float duty, float fw) {
  // 1 inside the first 'duty' fraction of every period (centred band), anti-aliased with the
  // given screen-space width fw of x
  float w = max(fw, 1e-4) * 0.75;
  float f = fract(x);
  float c = duty * 0.5;
  float d = min(abs(f - c), 1.0 - abs(f - c)) - c;
  return 1.0 - smoothstep(-w, w, d);
}
// sine with its amplitude faded out once it gets finer than a pixel (no shimmer at distance)
float cpSinW(float x, float fw) { return sin(x) * clamp(1.5 - fw * 0.5, 0.0, 1.0); }
// period P snapped so that a whole number of periods fits around a piece of arc radius R
// (seamless wrap of the around-coordinate); R = 0: planar, unchanged
float cpPer(float P, float R) {
  if (R <= 0.0) return P;
  float L = 6.2831853 * R;
  return L / max(1.0, floor(L / P + 0.5));
}
// Pattern in 2D coordinates q (around / along, metres) with screen derivatives fq.
float cpPat2(vec2 q, vec2 fq, vec3 p, float id, float R) {
  if (id < 1.5) return cpBand(q.y / 0.05, 0.5, fq.y / 0.05);         // horizontal stripes
  if (id < 2.5) {                                                    // gingham
    float P = cpPer(0.034, R);
    return 0.5 * (cpBand(q.x / P, 0.5, fq.x / P) + cpBand(q.y / 0.034, 0.5, fq.y / 0.034));
  }
  if (id < 3.5) {                                                    // polka dots
    float P = cpPer(0.05, R);
    vec2 g = vec2(q.x / P, q.y / 0.05);
    g.x += 0.5 * step(0.5, fract(g.y * 0.5));
    float d = length(fract(g) - 0.5) - 0.24;
    float w = max(max(fq.x / P, fq.y / 0.05), 1e-4);
    return 1.0 - smoothstep(-w, w, d);
  }
  if (id < 4.5) {                                                    // straw weave
    float k = 6.2831853 / cpPer(6.2831853 / 260.0, R);
    float a = cpSinW(q.x * k, fq.x * k) * cpSinW(q.y * 260.0, fq.y * 260.0);
    float ring = sin(length(p.xz) * 520.0 + p.y * 180.0) * 0.6;
    return clamp(0.5 + 0.35 * a + 0.25 * ring, 0.0, 1.0) * 0.8;
  }
  if (id < 5.5) {                                                    // denim twill
    float k = 6.2831853 / cpPer(6.2831853 / 900.0, R);
    float t = cpSinW(q.x * k + q.y * 900.0, fq.x * k + fq.y * 900.0);
    return clamp(0.45 + 0.4 * t, 0.0, 1.0) * 0.55;
  }
  if (id < 6.5) {                                                    // lace
    float P = cpPer(0.016, R);
    vec2 g = vec2(q.x / P, q.y / 0.016);
    g.x += 0.5 * step(0.5, fract(g.y * 0.5));
    float d = length(fract(g) - 0.5) - 0.2;
    float w = max(max(fq.x / P, fq.y / 0.016), 1e-4);
    float far = clamp(2.0 - w * 3.0, 0.0, 1.0);
    return mix(0.2, (1.0 - smoothstep(-w, w, d)) * 0.85, far);
  }
  if (id < 7.5) {                                                    // vertical stripes
    float P = cpPer(0.04, R);
    return cpBand(q.x / P, 0.5, fq.x / P);
  }
  if (id < 8.5) {                                                    // small check
    float P = cpPer(0.045, R);
    return abs(cpBand(q.x / P, 0.5, fq.x / P) - cpBand(q.y / 0.045, 0.5, fq.y / 0.045));
  }
  float k = 6.2831853 / cpPer(6.2831853 / 700.0, R);               // knit rib
  return clamp(0.5 + 0.5 * cpSinW(q.x * k, fq.x * k), 0.0, 1.0) * 0.35;
}
// m.xyz: pattern position (relative to the piece's own axis: body axis for torso items, the limb
// axis for sleeves / trouser legs), m.w: arc radius of the around-coordinate. Near-horizontal
// surfaces (hat tops, the underside of the trousers) switch to planar x/z coordinates, so the
// pattern never converges into a starburst at a pole. Derivatives of the around-coordinate are
// computed analytically, so there is no seam where atan wraps.
float cpPattern(vec4 m, float id) {
  if (id < 0.5) return 0.0;
  vec3 p = m.xyz;
  vec3 dx = dFdx(p), dy = dFdy(p);
  vec3 n = normalize(cross(dx, dy) + vec3(0.0, 1e-7, 0.0));
  float hz = smoothstep(0.62, 0.86, abs(n.y));
  float r2 = max(dot(p.xz, p.xz), 1e-6);
  float dux = m.w * (p.z * dx.x - p.x * dx.z) / r2;
  float duy = m.w * (p.z * dy.x - p.x * dy.z) / r2;
  vec2 fqc = vec2(abs(dux) + abs(duy), abs(dx.y) + abs(dy.y));
  vec2 fqp = vec2(abs(dx.x) + abs(dy.x), abs(dx.z) + abs(dy.z));
  float cyl = cpPat2(vec2(atan(p.x, p.z) * m.w, p.y), fqc, p, id, m.w);
  float pla = cpPat2(p.xz, fqp, p, id, 0.0);
  return mix(cyl, pla, hz);
}
`;

export function createCostumeMaterial(bu: BeastUniforms): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(1, 1, 1),
    side: THREE.DoubleSide,
  });
  m.name = 'beast_costume';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, bu);
    patchVertex(shader, true);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COSTUME_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vColor2, cpPattern(vPmap, vSurf.w));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = vSurf.x;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = vSurf.y;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor = vSurf.z * mix(diffuseColor.rgb, vec3(1.0), 0.35);\n#endif`);
  };
  m.customProgramCacheKey = () => 'gang-alkmaar-beast-costume-v2';
  return m;
}
