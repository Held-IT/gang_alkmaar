// Shape parameters of the procedural car bodies (one BodyDesign per CarSpec id).
//
// Vehicle-local axes: +z forward, +x LEFT, +y up, origin on the ground halfway between the axles.
// All values in metres. "Side view" curves are [z, y] pairs. Section profiles are control
// polylines [yNorm, d] from the bottom edge (yNorm 0) to the shoulder (yNorm 1); d is the offset
// from the plan outline along its outward normal (negative = inward).
import type { CarSpec } from '../../contracts';

export type P2 = readonly [number, number];

/** A side window (daylight opening) in greenhouse coordinates (z, f): f = 0 at the belt, 1 at the roof corner. */
export interface WindowDef {
  /** corners: rear-bottom, rear-top, front-top, front-bottom as [z, f] */
  pts: [P2, P2, P2, P2];
  /** corner rounding radius (m) */
  radius: number;
}

export type RimStyle = 'vspoke5' | 'turbine10' | 'holes5' | 'yspoke5' | 'steelcap' | 'spoke5' | 'aero5';
export type FrontStyle = 'hatch' | 'estate' | 'city' | 'sport' | 'van' | 'ev';
export type RearLampStyle = 'split' | 'vertical' | 'round' | 'bar' | 'van';

export interface BodyDesign {
  /** distance from the front axle to the front tip (rear overhang follows from the length) */
  frontOverhang: number;
  // --- plan view -------------------------------------------------------------------------------
  /** half width of the plan outline (widest profile point), excluding flares */
  halfWidth: number;
  /** z length of the front corner rounding and its superellipse power (2 round .. 5 boxy) */
  noseDepth: number;
  nosePow: number;
  tailDepth: number;
  tailPow: number;
  // --- heights -----------------------------------------------------------------------------------
  /** side sill bottom height */
  sillY: number;
  frontBottomY: number;
  rearBottomY: number;
  /** shoulder / belt / hood-edge line in side view, [z, y], rear to front */
  shoulder: P2[];
  /** section profiles (same number of control points each) */
  sideProfile: P2[];
  frontProfile: P2[];
  rearProfile: P2[];
  /** extra inward roll of the section top (fender top / shoulder) along z: [z, metres] */
  shoulderInset?: P2[];
  /** backward sweep of the front face vs normalised height [yN, metres] and forward lean of the tail */
  noseLean: P2[];
  tailLean: P2[];
  /** hood centre rise above the hood edges, trunk lid crown */
  hoodCrown: number;
  deckCrown: number;
  // --- greenhouse --------------------------------------------------------------------------------
  cowlZ: number;
  roofFrontZ: number;
  roofRearZ: number;
  rearBaseZ: number;
  /** greenhouse centre line [z, y] from rearBaseZ to cowlZ (cowl height is replaced by the hood) */
  topLine: P2[];
  /** inward lean of the side glass (dx per dy) */
  tumblehome: number;
  /** roof crown (centre rise over the roof edge) and roof-edge radius */
  roofCrown: number;
  roofEdgeR: number;
  /** outward bow of the side glass at mid height (m per m of glass height) */
  glassBow: number;
  /** extra inset of the roof rail in plan view near the windshield / rear (m) */
  roofTaperF: number;
  roofTaperR: number;
  /** side windows (DLO) in (z, f) */
  windows: WindowDef[];
  /** B-pillar is gloss black (modern) or body colour */
  blackPillars: boolean;
  /** A-pillar width (m of arc) */
  aPillarW: number;
  /** body-coloured C/D pillar arc width around the rear window */
  rearPillarW: number;
  /**
   * half width (|x|, m) of the rear window at its base and at its top. The tailgate glass of a
   * hatch is much narrower than the greenhouse: the body-coloured C-pillars frame it from behind.
   * Omitted: the glass reaches out to the pillar edge (saloon-style wide rear screen).
   */
  rearGlassHW?: [number, number];
  // --- wheels & arches ---------------------------------------------------------------------------
  archGap: number;
  flare: number;
  haunch: number;
  /** black plastic cladding on arches and sills (crossover) */
  cladding: boolean;
  rim: RimStyle;
  /** rim diameter in inches */
  rimInch: number;
  rimColor: string;
  caliperColor: string;
  // --- details -------------------------------------------------------------------------------------
  front: FrontStyle;
  rearLamp: RearLampStyle;
  /** feature (character) line: height at rear and front of the body side, and strength */
  charLine: { yRear: number; yFront: number; depth: number } | null;
  roofRails: boolean;
  exhaust: 'none' | 'left' | 'twin' | 'hidden';
  spoiler: boolean;
  /** cargo van: no rear side windows, sliding door, twin rear doors */
  van: boolean;
  /** side doors per side: 1 (three-door body) or 2 (default) */
  doors?: 1 | 2;
  /** sedan trunk lid instead of a hatch */
  trunk: boolean;
  /** badge shape for the fictional brand */
  badge: 'ring' | 'rhomb' | 'oval' | 'shield' | 'hex' | 'wave';
  /** brand initials drawn on the tailgate */
  brandText: string;
  modelText: string;
}

// Shared profile building blocks -------------------------------------------------------------------
// Section profiles: [yNorm, offset]; every profile has 9 control points (index 5 = character line).

/** modern body side: tucked sill, widest at the character line, rolled shoulder */
const SIDE_MODERN: P2[] = [
  [0.0, -0.06],
  [0.05, -0.04],
  [0.13, -0.024],
  [0.3, -0.01],
  [0.5, -0.002],
  [0.7, 0.0],
  [0.84, -0.006],
  [0.93, -0.03],
  [1.0, -0.06],
];

/** rounder city-car side */
const SIDE_CITY: P2[] = [
  [0.0, -0.075],
  [0.05, -0.052],
  [0.13, -0.032],
  [0.3, -0.013],
  [0.5, -0.003],
  [0.7, 0.0],
  [0.84, -0.01],
  [0.93, -0.036],
  [1.0, -0.066],
];

/** slab-sided van */
const SIDE_VAN: P2[] = [
  [0.0, -0.04],
  [0.05, -0.024],
  [0.13, -0.012],
  [0.3, -0.004],
  [0.5, 0.0],
  [0.7, 0.0],
  [0.84, -0.002],
  [0.93, -0.008],
  [1.0, -0.018],
];

const FRONT_MODERN: P2[] = [
  [0.0, -0.06],
  [0.05, -0.03],
  [0.15, -0.008],
  [0.34, 0.0],
  [0.54, -0.004],
  [0.7, -0.012],
  [0.83, -0.022],
  [0.94, -0.034],
  [1.0, -0.05],
];

const FRONT_CITY: P2[] = [
  [0.0, -0.075],
  [0.05, -0.04],
  [0.15, -0.012],
  [0.34, 0.0],
  [0.54, -0.006],
  [0.7, -0.018],
  [0.83, -0.032],
  [0.94, -0.05],
  [1.0, -0.07],
];

const REAR_MODERN: P2[] = [
  [0.0, -0.07],
  [0.05, -0.035],
  [0.15, -0.012],
  [0.3, 0.0],
  [0.48, -0.003],
  [0.64, -0.008],
  [0.8, -0.018],
  [0.93, -0.036],
  [1.0, -0.06],
];

const REAR_VAN: P2[] = [
  [0.0, -0.035],
  [0.05, -0.018],
  [0.15, -0.006],
  [0.3, 0.0],
  [0.48, 0.0],
  [0.64, 0.0],
  [0.8, -0.003],
  [0.93, -0.008],
  [1.0, -0.016],
];

// Nose / tail sweep (z offsets towards the cabin vs normalised height of the face) ----------------

/** compact / estate: chin tucked under, face swept back to the hood edge */
const NOSE_HATCH: P2[] = [
  [0.0, 0.16],
  [0.12, 0.05],
  [0.3, 0.004],
  [0.45, 0.01],
  [0.62, 0.04],
  [0.78, 0.08],
  [0.9, 0.11],
  [1.0, 0.13],
];

/** sports saloon: low sharp nose, long bonnet */
const NOSE_SPORT: P2[] = [
  [0.0, 0.16],
  [0.12, 0.05],
  [0.3, 0.0],
  [0.45, 0.006],
  [0.62, 0.03],
  [0.78, 0.065],
  [0.9, 0.1],
  [1.0, 0.13],
];

/** city car: round, friendly face */
const NOSE_CITY: P2[] = [
  [0.0, 0.13],
  [0.12, 0.045],
  [0.3, 0.006],
  [0.45, 0.0],
  [0.62, 0.03],
  [0.78, 0.085],
  [0.9, 0.14],
  [1.0, 0.19],
];

/** van: upright bumper, sloped short bonnet edge */
const NOSE_VAN: P2[] = [
  [0.0, 0.07],
  [0.12, 0.018],
  [0.3, 0.0],
  [0.45, 0.02],
  [0.62, 0.06],
  [0.78, 0.12],
  [0.9, 0.17],
  [1.0, 0.21],
];

/** crossover: tall face, tucked chin */
const NOSE_EV: P2[] = [
  [0.0, 0.16],
  [0.12, 0.05],
  [0.3, 0.0],
  [0.45, 0.01],
  [0.62, 0.04],
  [0.78, 0.085],
  [0.9, 0.12],
  [1.0, 0.15],
];

const TAIL_HATCH: P2[] = [
  [0.0, 0.06],
  [0.15, 0.012],
  [0.32, 0.0],
  [0.6, 0.008],
  [0.85, 0.03],
  [1.0, 0.06],
];

const TAIL_SEDAN: P2[] = [
  [0.0, 0.08],
  [0.15, 0.02],
  [0.32, 0.0],
  [0.6, 0.0],
  [0.85, 0.012],
  [1.0, 0.035],
];

const TAIL_VAN: P2[] = [
  [0.0, 0.03],
  [0.15, 0.005],
  [0.32, 0.0],
  [0.6, 0.0],
  [0.85, 0.004],
  [1.0, 0.012],
];

const TAIL_EV: P2[] = [
  [0.0, 0.08],
  [0.15, 0.02],
  [0.32, 0.0],
  [0.6, 0.01],
  [0.85, 0.04],
  [1.0, 0.08],
];

/** Front / rear axle and tip positions from the spec and the front overhang. */
function ends(s: CarSpec, fo: number): { zF: number; zR: number } {
  const zF = s.wheelbase / 2 + fo;
  return { zF, zR: zF - s.length };
}

// Designs ------------------------------------------------------------------------------------------

/** Compact five-door hatchback (Golf / Astra / 308 class). */
function hatchback(s: CarSpec): BodyDesign {
  const fo = 0.87;
  const { zF, zR } = ends(s, fo);
  return {
    frontOverhang: fo,
    halfWidth: s.width / 2 - 0.012,
    noseDepth: 0.36,
    nosePow: 3.7,
    tailDepth: 0.26,
    tailPow: 4.2,
    sillY: 0.2,
    frontBottomY: 0.23,
    rearBottomY: 0.28,
    shoulder: [
      [zR, 0.975],
      [zR + 0.3, 1.03],
      [-1.2, 1.04],
      [-0.4, 1.012],
      [0.3, 0.98],
      [0.9, 0.94],
      [1.5, 0.885],
      [1.85, 0.84],
      [2.05, 0.795],
      [zF, 0.738],
    ],
    sideProfile: SIDE_MODERN,
    frontProfile: FRONT_MODERN,
    rearProfile: REAR_MODERN,
    shoulderInset: [
      [-1.4, 0.0],
      [-0.4, 0.015],
      [0.3, 0.035],
      [0.85, 0.085],
      [1.3, 0.1],
      [zF, 0.09],
    ],
    noseLean: NOSE_HATCH,
    tailLean: TAIL_HATCH,
    hoodCrown: 0.035,
    deckCrown: 0.02,
    cowlZ: 0.9,
    roofFrontZ: 0.12,
    roofRearZ: -1.58,
    rearBaseZ: zR + 0.23,
    topLine: [
      [-1.78, 1.15],
      [-1.66, 1.305],
      [-1.6, 1.36],
      [-1.4, 1.398],
      [-0.9, 1.435],
      [-0.4, 1.458],
      [0.0, 1.45],
      [0.14, 1.425],
      [0.35, 1.31],
      [0.65, 1.13],
    ],
    tumblehome: 0.42,
    roofCrown: 0.035,
    roofEdgeR: 0.06,
    glassBow: 0.03,
    roofTaperF: 0.02,
    roofTaperR: 0.06,
    windows: [
      // front door
      { pts: [[-0.06, 0.03], [-0.06, 0.86], [0.32, 0.86], [0.8, 0.03]], radius: 0.05 },
      // rear door: its rear edge slants forward into the thick C-pillar
      { pts: [[-1.22, 0.03], [-0.97, 0.82], [-0.16, 0.86], [-0.16, 0.03]], radius: 0.05 },
    ],
    blackPillars: true,
    aPillarW: 0.08,
    rearPillarW: 0.12,
    rearGlassHW: [0.53, 0.46],
    archGap: 0.035,
    flare: 0.016,
    haunch: 0.014,
    cladding: false,
    rim: 'vspoke5',
    rimInch: 17,
    rimColor: '#c4c8cc',
    caliperColor: '#3a3d40',
    front: 'hatch',
    rearLamp: 'split',
    charLine: { yRear: 0.88, yFront: 0.83, depth: 0.007 },
    roofRails: false,
    exhaust: 'hidden',
    spoiler: true,
    van: false,
    trunk: false,
    badge: 'ring',
    brandText: 'OSTWALD',
    modelText: 'LUMEN',
  };
}

/** Mid-size estate (V60 / Passat Variant class): long roof, D-pillar, roof rails. */
function estate(s: CarSpec): BodyDesign {
  const fo = 0.9;
  const { zF, zR } = ends(s, fo);
  return {
    frontOverhang: fo,
    halfWidth: s.width / 2 - 0.012,
    noseDepth: 0.32,
    nosePow: 4.0,
    tailDepth: 0.24,
    tailPow: 4.6,
    sillY: 0.21,
    frontBottomY: 0.23,
    rearBottomY: 0.3,
    shoulder: [
      [zR, 1.0],
      [zR + 0.3, 1.04],
      [-1.6, 1.045],
      [-0.5, 1.01],
      [0.3, 0.975],
      [0.85, 0.945],
      [1.5, 0.915],
      [1.95, 0.88],
      [2.17, 0.835],
      [zF, 0.78],
    ],
    sideProfile: SIDE_MODERN,
    frontProfile: FRONT_MODERN,
    rearProfile: REAR_MODERN,
    shoulderInset: [
      [-1.8, 0.0],
      [-0.6, 0.015],
      [0.3, 0.035],
      [0.85, 0.085],
      [1.3, 0.1],
      [zF, 0.09],
    ],
    noseLean: NOSE_HATCH,
    tailLean: TAIL_HATCH,
    hoodCrown: 0.035,
    deckCrown: 0.015,
    cowlZ: 0.85,
    roofFrontZ: 0.08,
    roofRearZ: -1.98,
    rearBaseZ: zR + 0.19,
    topLine: [
      [-2.16, 1.17],
      [-2.05, 1.33],
      [-1.98, 1.385],
      [-1.8, 1.41],
      [-1.0, 1.43],
      [-0.3, 1.44],
      [-0.02, 1.435],
      [0.1, 1.41],
      [0.3, 1.3],
      [0.6, 1.12],
    ],
    tumblehome: 0.34,
    roofCrown: 0.035,
    roofEdgeR: 0.06,
    glassBow: 0.03,
    roofTaperF: 0.02,
    roofTaperR: 0.04,
    windows: [
      { pts: [[-0.1, 0.03], [-0.1, 0.86], [0.25, 0.86], [0.75, 0.03]], radius: 0.05 },
      { pts: [[-1.0, 0.03], [-0.95, 0.86], [-0.2, 0.86], [-0.2, 0.03]], radius: 0.05 },
      // rear quarter window, its rear edge forms the slanted D-pillar
      { pts: [[-2.0, 0.03], [-1.8, 0.84], [-1.1, 0.86], [-1.1, 0.03]], radius: 0.06 },
    ],
    blackPillars: true,
    aPillarW: 0.08,
    rearPillarW: 0.12,
    archGap: 0.035,
    flare: 0.016,
    haunch: 0.012,
    cladding: false,
    rim: 'turbine10',
    rimInch: 18,
    rimColor: '#b9bec4',
    caliperColor: '#3a3d40',
    front: 'estate',
    rearLamp: 'vertical',
    charLine: { yRear: 0.9, yFront: 0.84, depth: 0.006 },
    roofRails: true,
    exhaust: 'hidden',
    spoiler: true,
    van: false,
    trunk: false,
    badge: 'hex',
    brandText: 'NORRVIK',
    modelText: 'FJARD',
  };
}

/** Dutch taxi: the estate body (dark paint, taxi sign and plate are added by the model). */
function taxi(s: CarSpec): BodyDesign {
  return { ...estate(s), rim: 'spoke5', rimInch: 17, rimColor: '#a7acb2' };
}

/** City car (500 / up! class): short nose, upright tall cabin, round lamps, three doors. */
function cityCar(s: CarSpec): BodyDesign {
  const fo = 0.64;
  const { zF, zR } = ends(s, fo);
  return {
    frontOverhang: fo,
    halfWidth: s.width / 2 - 0.012,
    noseDepth: 0.36,
    nosePow: 2.8,
    tailDepth: 0.3,
    tailPow: 3.0,
    sillY: 0.21,
    frontBottomY: 0.22,
    rearBottomY: 0.28,
    shoulder: [
      [zR, 0.97],
      [zR + 0.25, 1.0],
      [-0.9, 1.0],
      [-0.2, 0.98],
      [0.35, 0.96],
      [0.75, 0.94],
      [1.2, 0.91],
      [1.5, 0.875],
      [1.68, 0.83],
      [zF, 0.775],
    ],
    sideProfile: SIDE_CITY,
    frontProfile: FRONT_CITY,
    rearProfile: REAR_MODERN,
    shoulderInset: [
      [-1.2, 0.0],
      [-0.3, 0.015],
      [0.3, 0.04],
      [0.7, 0.07],
      [1.1, 0.08],
      [zF, 0.07],
    ],
    noseLean: NOSE_CITY,
    tailLean: TAIL_HATCH,
    hoodCrown: 0.04,
    deckCrown: 0.02,
    cowlZ: 0.72,
    roofFrontZ: -0.04,
    roofRearZ: -1.38,
    rearBaseZ: zR + 0.22,
    topLine: [
      [-1.5, 1.16],
      [-1.42, 1.36],
      [-1.38, 1.42],
      [-1.2, 1.46],
      [-0.6, 1.485],
      [-0.15, 1.485],
      [-0.04, 1.465],
      [0.15, 1.36],
      [0.45, 1.16],
    ],
    tumblehome: 0.3,
    roofCrown: 0.04,
    roofEdgeR: 0.07,
    glassBow: 0.035,
    roofTaperF: 0.02,
    roofTaperR: 0.04,
    windows: [
      // long door window
      { pts: [[-0.55, 0.03], [-0.55, 0.86], [-0.02, 0.86], [0.62, 0.03]], radius: 0.05 },
      // fixed rear quarter window
      { pts: [[-1.3, 0.05], [-1.12, 0.8], [-0.66, 0.84], [-0.66, 0.05]], radius: 0.07 },
    ],
    blackPillars: false,
    aPillarW: 0.085,
    rearPillarW: 0.12,
    archGap: 0.035,
    flare: 0.02,
    haunch: 0.01,
    cladding: false,
    rim: 'holes5',
    rimInch: 15,
    rimColor: '#cfd2d5',
    caliperColor: '#3a3d40',
    front: 'city',
    rearLamp: 'round',
    charLine: null,
    roofRails: false,
    exhaust: 'left',
    spoiler: true,
    van: false,
    doors: 1,
    trunk: false,
    badge: 'oval',
    brandText: 'LUCCIOLA',
    modelText: 'BIMBA',
  };
}

/** Sports saloon (3-series / A4 class): long bonnet, short deck, fast rear screen, RWD stance. */
function sedan(s: CarSpec): BodyDesign {
  const fo = 0.8;
  const { zF, zR } = ends(s, fo);
  return {
    frontOverhang: fo,
    halfWidth: s.width / 2 - 0.012,
    noseDepth: 0.3,
    nosePow: 4.2,
    tailDepth: 0.26,
    tailPow: 4.6,
    sillY: 0.19,
    frontBottomY: 0.2,
    rearBottomY: 0.27,
    shoulder: [
      [zR, 0.985],
      [zR + 0.3, 1.0],
      [-1.6, 1.0],
      [-0.6, 0.98],
      [0.3, 0.955],
      [0.8, 0.935],
      [1.4, 0.9],
      [1.85, 0.855],
      [2.08, 0.8],
      [zF, 0.72],
    ],
    sideProfile: SIDE_MODERN,
    frontProfile: FRONT_MODERN,
    rearProfile: REAR_MODERN,
    shoulderInset: [
      [-2.0, 0.0],
      [-0.6, 0.015],
      [0.3, 0.04],
      [0.8, 0.085],
      [1.3, 0.1],
      [zF, 0.09],
    ],
    noseLean: NOSE_SPORT,
    tailLean: TAIL_SEDAN,
    hoodCrown: 0.03,
    deckCrown: 0.02,
    cowlZ: 0.8,
    roofFrontZ: -0.03,
    roofRearZ: -1.15,
    rearBaseZ: -1.86,
    topLine: [
      [-1.7, 1.1],
      [-1.45, 1.25],
      [-1.15, 1.37],
      [-0.8, 1.415],
      [-0.3, 1.435],
      [-0.05, 1.42],
      [0.15, 1.33],
      [0.45, 1.15],
    ],
    tumblehome: 0.38,
    roofCrown: 0.035,
    roofEdgeR: 0.055,
    glassBow: 0.03,
    roofTaperF: 0.02,
    roofTaperR: 0.05,
    windows: [
      { pts: [[-0.12, 0.03], [-0.12, 0.88], [0.15, 0.88], [0.66, 0.03]], radius: 0.05 },
      { pts: [[-1.0, 0.03], [-0.9, 0.86], [-0.2, 0.88], [-0.2, 0.03]], radius: 0.05 },
      // small fixed glass in the C-pillar
      { pts: [[-1.42, 0.06], [-1.2, 0.6], [-1.08, 0.66], [-1.08, 0.06]], radius: 0.04 },
    ],
    blackPillars: true,
    aPillarW: 0.075,
    rearPillarW: 0.12,
    archGap: 0.03,
    flare: 0.02,
    haunch: 0.022,
    cladding: false,
    rim: 'yspoke5',
    rimInch: 19,
    rimColor: '#5d6166',
    caliperColor: '#1f4fa8',
    front: 'sport',
    rearLamp: 'split',
    charLine: { yRear: 0.86, yFront: 0.8, depth: 0.008 },
    roofRails: false,
    exhaust: 'twin',
    spoiler: false,
    van: false,
    trunk: true,
    badge: 'shield',
    brandText: 'FELDHAUS',
    modelText: 'ARKON',
  };
}

/** Panel van (Transporter / Trafic class): short sloped nose, tall flat sides, sliding door. */
function van(s: CarSpec): BodyDesign {
  const fo = 0.92;
  const { zF, zR } = ends(s, fo);
  return {
    frontOverhang: fo,
    halfWidth: s.width / 2 - 0.012,
    noseDepth: 0.32,
    nosePow: 3.6,
    tailDepth: 0.12,
    tailPow: 6,
    sillY: 0.3,
    frontBottomY: 0.28,
    rearBottomY: 0.38,
    shoulder: [
      [zR, 1.08],
      [zR + 0.2, 1.1],
      [-1.0, 1.1],
      [0.5, 1.1],
      [1.2, 1.1],
      [1.65, 1.1],
      [1.95, 1.07],
      [2.2, 1.02],
      [2.34, 0.97],
      [zF, 0.92],
    ],
    sideProfile: SIDE_VAN,
    frontProfile: FRONT_MODERN,
    rearProfile: REAR_VAN,
    shoulderInset: [
      [1.4, 0.0],
      [1.75, 0.04],
      [2.1, 0.05],
      [zF, 0.05],
    ],
    noseLean: NOSE_VAN,
    tailLean: TAIL_VAN,
    hoodCrown: 0.03,
    deckCrown: 0.0,
    cowlZ: 1.7,
    roofFrontZ: 0.95,
    roofRearZ: zR + 0.08,
    rearBaseZ: zR + 0.04,
    topLine: [
      [zR + 0.05, 1.7],
      [zR + 0.08, 1.93],
      [zR + 0.3, 1.965],
      [0.0, 1.97],
      [0.8, 1.96],
      [0.95, 1.93],
      [1.2, 1.7],
      [1.45, 1.42],
    ],
    tumblehome: 0.07,
    roofCrown: 0.04,
    roofEdgeR: 0.09,
    glassBow: 0.01,
    roofTaperF: 0.03,
    roofTaperR: 0.0,
    windows: [
      // cab door
      { pts: [[0.62, 0.03], [0.62, 0.88], [1.05, 0.88], [1.55, 0.03]], radius: 0.05 },
    ],
    blackPillars: false,
    aPillarW: 0.09,
    rearPillarW: 0.1,
    archGap: 0.045,
    flare: 0.012,
    haunch: 0.0,
    cladding: false,
    rim: 'steelcap',
    rimInch: 16,
    rimColor: '#a9adb1',
    caliperColor: '#2c2e30',
    front: 'van',
    rearLamp: 'van',
    charLine: { yRear: 0.78, yFront: 0.78, depth: 0.008 },
    roofRails: false,
    exhaust: 'left',
    spoiler: false,
    van: true,
    trunk: false,
    badge: 'rhomb',
    brandText: 'ARNOUX',
    modelText: 'NAVETTE',
  };
}

/** Electric crossover (ID.4 / Enyaq class): tall body, black cladding, closed nose, light bar. */
function ev(s: CarSpec): BodyDesign {
  const fo = 0.86;
  const { zF, zR } = ends(s, fo);
  return {
    frontOverhang: fo,
    halfWidth: s.width / 2 - 0.012,
    noseDepth: 0.32,
    nosePow: 3.6,
    tailDepth: 0.26,
    tailPow: 4.0,
    sillY: 0.27,
    frontBottomY: 0.28,
    rearBottomY: 0.33,
    shoulder: [
      [zR, 1.06],
      [zR + 0.3, 1.1],
      [-1.3, 1.1],
      [-0.3, 1.07],
      [0.4, 1.04],
      [0.95, 1.01],
      [1.5, 0.975],
      [1.9, 0.93],
      [2.1, 0.88],
      [zF, 0.82],
    ],
    sideProfile: SIDE_MODERN,
    frontProfile: FRONT_MODERN,
    rearProfile: REAR_MODERN,
    shoulderInset: [
      [-1.6, 0.0],
      [-0.5, 0.015],
      [0.4, 0.035],
      [0.95, 0.085],
      [1.4, 0.1],
      [zF, 0.09],
    ],
    noseLean: NOSE_EV,
    tailLean: TAIL_EV,
    hoodCrown: 0.035,
    deckCrown: 0.02,
    cowlZ: 0.95,
    roofFrontZ: 0.15,
    roofRearZ: -1.6,
    rearBaseZ: zR + 0.3,
    topLine: [
      [-1.85, 1.24],
      [-1.7, 1.47],
      [-1.6, 1.545],
      [-1.3, 1.58],
      [-0.5, 1.6],
      [0.0, 1.595],
      [0.15, 1.565],
      [0.4, 1.42],
      [0.7, 1.22],
    ],
    tumblehome: 0.32,
    roofCrown: 0.035,
    roofEdgeR: 0.06,
    glassBow: 0.03,
    roofTaperF: 0.02,
    roofTaperR: 0.06,
    windows: [
      { pts: [[-0.1, 0.03], [-0.1, 0.86], [0.35, 0.86], [0.84, 0.03]], radius: 0.05 },
      { pts: [[-0.95, 0.03], [-0.85, 0.86], [-0.2, 0.86], [-0.2, 0.03]], radius: 0.05 },
      { pts: [[-1.55, 0.06], [-1.35, 0.74], [-1.06, 0.8], [-1.06, 0.06]], radius: 0.05 },
    ],
    blackPillars: true,
    aPillarW: 0.08,
    rearPillarW: 0.12,
    archGap: 0.04,
    flare: 0.014,
    haunch: 0.012,
    cladding: true,
    rim: 'aero5',
    rimInch: 19,
    rimColor: '#2e3136',
    caliperColor: '#3a3d40',
    front: 'ev',
    rearLamp: 'bar',
    charLine: { yRear: 0.95, yFront: 0.88, depth: 0.006 },
    roofRails: true,
    exhaust: 'none',
    spoiler: true,
    van: false,
    trunk: false,
    badge: 'wave',
    brandText: 'STROM',
    modelText: 'ALVA',
  };
}

const DESIGNS: Record<string, (s: CarSpec) => BodyDesign> = {
  hatchback,
  stationwagen: estate,
  taxi,
  stadsauto: cityCar,
  sedan,
  bestelbus: van,
  ev,
};

export function getDesign(spec: CarSpec): BodyDesign {
  const f = DESIGNS[spec.id] ?? hatchback;
  return f(spec);
}
