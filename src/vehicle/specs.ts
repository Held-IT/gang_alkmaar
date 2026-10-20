// Car specifications for Alkmaar Drive. All brands and model names are fictional (no real
// trademarks); dimensions, masses and drivetrains are modelled on real modern European cars of the
// same class so the physics and the procedural models (src/vehicle/models) look and feel right.
//
// Gearing sanity check (used to choose finalDrive): v = rpm / (gear * finalDrive) / 60 * 2*pi*r.
// For every car the top speed is reached in one of the top two gears below the redline.
import type { CarSpec } from '../contracts';

export const CAR_SPECS: CarSpec[] = [
  {
    // Golf / Astra / Mégane class compact hatchback.
    id: 'hatchback',
    name: 'Ostwald Lumen 1.5 T',
    category: 'hatchback',
    description:
      'Compacte vijfdeurs hatchback met een levendige 1.5 turbomotor en voorwielaandrijving. ' +
      'Wendbaar in de smalle straatjes van de binnenstad en stabiel op de singels.',
    massKg: 1310,
    length: 4.28,
    width: 1.79,
    height: 1.46,
    wheelbase: 2.63,
    trackFront: 1.54,
    trackRear: 1.52,
    wheelRadius: 0.317, // 225/45 R17
    wheelWidth: 0.225,
    cgHeight: 0.53,
    frontWeight: 0.61,
    drivetrain: 'fwd',
    powerKw: 110,
    torqueNm: 250,
    idleRpm: 800,
    redlineRpm: 6500,
    gearRatios: [3.62, 2.12, 1.43, 1.08, 0.86, 0.71],
    reverseRatio: 3.45,
    finalDrive: 4.05, // 224 km/h at ~5400 rpm in 6th
    topSpeedKmh: 224,
    maxSteerDeg: 36,
    suspensionTravel: 0.16,
    paints: ['#7d858c', '#e8eaeb', '#1d2b45', '#8f1a1f', '#23262a', '#3f5a6b'],
  },
  {
    // V60 / Passat Variant class estate.
    id: 'stationwagen',
    name: 'Norrvik Fjärd Kombi',
    category: 'stationwagen',
    description:
      'Ruime Scandinavische stationwagen met 140 kW en achttraps automaat. ' +
      'Comfortabel, stil en met plek voor de hele familie plus de fietstassen.',
    massKg: 1660,
    length: 4.76,
    width: 1.85,
    height: 1.47,
    wheelbase: 2.87,
    trackFront: 1.58,
    trackRear: 1.57,
    wheelRadius: 0.334, // 235/45 R18
    wheelWidth: 0.235,
    cgHeight: 0.55,
    frontWeight: 0.58,
    drivetrain: 'fwd',
    powerKw: 140,
    torqueNm: 300,
    idleRpm: 750,
    redlineRpm: 6200,
    gearRatios: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67],
    reverseRatio: 3.3,
    finalDrive: 3.08, // 220 km/h at ~5400 rpm in 6th
    topSpeedKmh: 220,
    maxSteerDeg: 35,
    suspensionTravel: 0.17,
    paints: ['#2c3640', '#c9ccce', '#f0f0ee', '#4a5560', '#1b1d20', '#5c6b5a'],
  },
  {
    // 500 / up! class city car.
    id: 'stadsauto',
    name: 'Lucciola Bimba 1.0',
    category: 'stadsauto',
    description:
      'Italiaanse stadsauto: klein, vrolijk en zuinig. Met 51 kW geen raket, ' +
      'maar perfect om rond de Waag en over de grachtbruggetjes te scharrelen.',
    massKg: 940,
    length: 3.57,
    width: 1.63,
    height: 1.49,
    wheelbase: 2.3,
    trackFront: 1.41,
    trackRear: 1.4,
    wheelRadius: 0.292, // 185/55 R15
    wheelWidth: 0.185,
    cgHeight: 0.56,
    frontWeight: 0.62,
    drivetrain: 'fwd',
    powerKw: 51,
    torqueNm: 92,
    idleRpm: 850,
    redlineRpm: 6500,
    gearRatios: [3.91, 2.16, 1.48, 1.12, 0.92, 0.76],
    reverseRatio: 3.82,
    finalDrive: 4.3, // 167 km/h at ~6000 rpm in 5th
    topSpeedKmh: 167,
    maxSteerDeg: 38,
    suspensionTravel: 0.15,
    paints: ['#e9e4d8', '#b8d4d0', '#c22a2a', '#e8c34a', '#2e3b4e', '#9aa39f'],
  },
  {
    // 3-series / A4 class sports saloon, rear-wheel drive.
    id: 'sedan',
    name: 'Feldhaus Arkon 30',
    category: 'sedan',
    description:
      'Sportieve Duitse sedan met 190 kW en achterwielaandrijving. ' +
      'Strak onderstel en een gretige zescilinder-klank: de snelste auto in de garage.',
    massKg: 1560,
    length: 4.71,
    width: 1.83,
    height: 1.44,
    wheelbase: 2.85,
    trackFront: 1.58,
    trackRear: 1.6,
    wheelRadius: 0.331, // 225/40 R19
    wheelWidth: 0.245,
    cgHeight: 0.5,
    frontWeight: 0.51,
    drivetrain: 'rwd',
    powerKw: 190,
    torqueNm: 400,
    idleRpm: 750,
    redlineRpm: 7000,
    gearRatios: [5.25, 3.36, 2.17, 1.72, 1.32, 1.0, 0.82, 0.64],
    reverseRatio: 3.71,
    finalDrive: 2.81, // 250 km/h (begrensd) at ~4600 rpm in 7th
    topSpeedKmh: 250,
    maxSteerDeg: 34,
    suspensionTravel: 0.14,
    paints: ['#1f3a68', '#0f1012', '#e6e7e8', '#6e7378', '#7a1420', '#2f4a3a'],
  },
  {
    // Transporter / Trafic class panel van.
    id: 'bestelbus',
    name: 'Arnoux Navette L1H1',
    category: 'bestelbus',
    description:
      'Franse bestelbus met 2.0 diesel (110 kW, 350 Nm). Hoog en zwaar: ' +
      'denk aan je hoeken op de smalle grachten, maar laden en lossen gaat overal.',
    massKg: 1890,
    length: 4.9,
    width: 1.9,
    height: 1.97,
    wheelbase: 3.0,
    trackFront: 1.62,
    trackRear: 1.62,
    wheelRadius: 0.343, // 215/65 R16C
    wheelWidth: 0.215,
    cgHeight: 0.78,
    frontWeight: 0.58,
    drivetrain: 'fwd',
    powerKw: 110,
    torqueNm: 350,
    idleRpm: 750,
    redlineRpm: 4600,
    gearRatios: [3.73, 2.05, 1.32, 0.97, 0.76, 0.63],
    reverseRatio: 3.55,
    finalDrive: 4.0, // 180 km/h at ~3500 rpm in 6th
    topSpeedKmh: 180,
    maxSteerDeg: 38,
    suspensionTravel: 0.18,
    paints: ['#f2f2f0', '#d8dadb', '#9ea4a8', '#25476b', '#1e1f22'],
  },
  {
    // Dutch taxi: dark estate with light-blue taxi plate and a roof sign.
    id: 'taxi',
    name: 'Norrvik Fjärd Taxi',
    category: 'taxi',
    description:
      'Zwarte taxi-stationwagen met lichtblauw kenteken en daklicht. ' +
      'Hybride aandrijving, ruime achterbank en een chauffeur die de binnenstad op zijn duimpje kent.',
    massKg: 1720,
    length: 4.76,
    width: 1.85,
    height: 1.47,
    wheelbase: 2.87,
    trackFront: 1.58,
    trackRear: 1.57,
    wheelRadius: 0.334, // 235/45 R18
    wheelWidth: 0.235,
    cgHeight: 0.55,
    frontWeight: 0.58,
    drivetrain: 'fwd',
    powerKw: 140,
    torqueNm: 320,
    idleRpm: 750,
    redlineRpm: 6200,
    gearRatios: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67],
    reverseRatio: 3.3,
    finalDrive: 3.08,
    topSpeedKmh: 210,
    maxSteerDeg: 35,
    suspensionTravel: 0.17,
    paints: ['#0e0f11', '#16181b', '#22262b'],
  },
  {
    // ID.4 / Elroq class electric crossover (rear motor, single-speed reduction).
    id: 'ev',
    name: 'Ström Alva',
    category: 'crossover',
    description:
      'Elektrische crossover met 150 kW achterin. Stil, direct koppel vanaf stilstand ' +
      'en een hoge zit: ideaal om geruisloos langs de grachten te zoeven.',
    massKg: 2050,
    length: 4.49,
    width: 1.86,
    height: 1.62,
    wheelbase: 2.77,
    trackFront: 1.58,
    trackRear: 1.57,
    wheelRadius: 0.359, // 235/50 R19
    wheelWidth: 0.235,
    cgHeight: 0.56,
    frontWeight: 0.47,
    drivetrain: 'rwd',
    powerKw: 150,
    torqueNm: 310,
    idleRpm: 0,
    redlineRpm: 16000,
    gearRatios: [1.0],
    reverseRatio: 1.0,
    finalDrive: 11.0, // single reduction: 16000 rpm motor = 197 km/h, limited to 180
    topSpeedKmh: 180,
    maxSteerDeg: 37,
    suspensionTravel: 0.17,
    paints: ['#dfe3e4', '#3b4f5c', '#5e6e64', '#202326', '#a7aaa8', '#7c2b2b'],
    electric: true,
  },
];

/** The car the player starts with. */
export const DEFAULT_CAR_ID = 'hatchback';

/** Look up a spec by id. Falls back to the default car for unknown ids. */
export function getSpec(id: string): CarSpec {
  return CAR_SPECS.find((s) => s.id === id) ?? CAR_SPECS.find((s) => s.id === DEFAULT_CAR_ID)!;
}
