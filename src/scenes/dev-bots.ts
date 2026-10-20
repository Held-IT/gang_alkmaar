// Bots test scene (bots module). ?scene=dev-bots
//
// Bots-only free-for-all in a real arena (the city is loaded with loadWorld unless city=0), with the
// real beast physics and createBotController. Last beast standing wins the round; outs are judged
// like the game (arena.isOut(chest) or > 4 m below the floor) and get a cause:
//   gegooid (thrown by a beast < 3 s before), gevaar (hit by a hazard < 2.5 s before),
//   geraakt (punched / kicked < 3 s before), gesleept (dragged < 2 s before), zelf (walked off).
//
// Params:
//   arena=kaasmarkt|rondvaartboot|molen   bots=2..8 (4)   difficulty=makkelijk|normaal|moeilijk|mix|<a>,<b>,...
//   rounds=N      fast simulation of N rounds (fixed 1/60 steps, several per rendered frame, city
//                 hidden unless show=1); logs "[dev-bots] ROUND {...}" and "[dev-bots] SUMMARY {...}"
//   rounds=0      (default) live, real time, endless rounds with a framing camera + plan HUD
//   speed=K       sim steps per frame in fast mode (default: adaptive, ~40 ms of work per frame)
//   maxtime=s     round time limit (150)    city=0    visual=fallback    hud=0    hazard=1 (arenas)
//   camdist=m     camera distance override  view=frame|top
//   dummy=1       the last beast gets no controller (passive target): round ends when it is out
//   ai.<difficulty>.<field>=<n>   override a BOT_PROFILES number for tuning experiments
// window.__debug: rounds, summary(), done, waitDone(), progress(), bots(), info(), fighters, system,
//   arena, physics, sense, force(i, 'prop'|'taunt'|'wobble'), setSpeed(k), restart(), grid(step)
import * as THREE from 'three';
import type { SceneEntry } from '../contracts';
import type { ArenaId, BotDifficulty } from '../brawl/contracts';
import { createPhysics } from '../physics/physics';
import { createArena } from '../arenas';
import { createBeastSystem, type BeastExt } from '../beast/physics';
import { BOT_PROFILES, createBotController, getSense, type BotControllerExt, type BotPlan } from '../beast/ai';
import type { WorldExt } from '../world/types';

const COLOURS = ['#f2a03d', '#4f9be8', '#e8505b', '#66c45a', '#b07ce0', '#f4d548', '#5ad1c8', '#f08fc0'];
const NAMES = ['Kees', 'Truus', 'Henk', 'Bep', 'Joop', 'Ans', 'Sjaak', 'Mien'];
const COSTUMES = ['kaasdrager', 'tourist', 'kaasdrager', 'tourist', 'kaasdrager', 'tourist', 'kaasdrager', 'tourist'];
const DIFFS: BotDifficulty[] = ['makkelijk', 'normaal', 'moeilijk'];
const IDLE_PLANS: BotPlan[] = ['idle', 'wander', 'taunt', 'wobble', 'cheer'];

type Cause = 'gegooid' | 'gevaar' | 'geraakt' | 'gesleept' | 'zelf' | 'tijd';

interface Fighter {
  name: string;
  diff: BotDifficulty;
  beast: BeastExt;
  bot: BotControllerExt | null;
  out: boolean;
  outT: number;
  cause: Cause | null;
  by: string | null;
  hitT: number;
  hitBy: string | null;
  hazT: number;
  liftT: number;
  liftBy: string | null;
  heldT: number;
  heldBy: string | null;
  // stuck check
  checkP: THREE.Vector3;
  checkT: number;
  stuck: number;
  trace: string[];
  kod: number;
  grabbed: number;
  wasHeld: boolean;
  traceT: number;
  alive: number;
  idle: number;
}

interface RoundStat {
  round: number;
  arena: ArenaId;
  t: number;
  winner: string | null;
  winnerDiff: BotDifficulty | null;
  timeUp: boolean;
  outs: { name: string; t: number; cause: Cause; by: string | null }[];
  /** finishing place per difficulty (1 = winner) */
  places: { diff: BotDifficulty; place: number }[];
  perDiff: Record<string, { n: number; kod: number; kos: number; thr: number; hits: number; punch: number; alive: number; grabbed: number }>;
  kos: number;
  hits: number;
  throws: number;
  punches: number;
  kicks: number;
  climbs: number;
  dodges: number;
  shelters: number;
  taunts: number;
  propThrows: number;
  stuckBot: number;
  stuckScene: number;
  stuckBy: Record<string, number>;
  idlePct: number;
  botMs: number;
  botMsMax: number;
}

const entry: SceneEntry = async (engine, params) => {
  const arenaId = (params.get('arena') ?? 'kaasmarkt') as ArenaId;
  const nBots = Math.max(2, Math.min(8, Number(params.get('bots') ?? 4) | 0));
  const diffParam = params.get('difficulty') ?? 'normaal';
  const rounds = Math.max(0, Number(params.get('rounds') ?? 0) | 0);
  const fast = rounds > 0;
  const maxTime = Number(params.get('maxtime') ?? 150);
  const useCity = params.get('city') !== '0';
  const speedParam = params.get('speed');
  const dummy = params.get('dummy') === '1';
  let speed = speedParam ? Math.max(1, Number(speedParam)) : 0;
  // profile overrides for tuning experiments: ai.<difficulty>.<field>=<number>
  for (const [k, v] of params) {
    const m = /^ai\.(makkelijk|normaal|moeilijk)\.(\w+)$/.exec(k);
    if (!m) continue;
    const prof = BOT_PROFILES[m[1] as BotDifficulty] as unknown as Record<string, number | boolean>;
    if (m[2] in prof) prof[m[2]] = v === 'true' ? true : v === 'false' ? false : Number(v);
    console.info(`[dev-bots] profiel ${m[1]}.${m[2]} = ${v}`);
  }
  const physics = await createPhysics();
  engine.start();
  let world: WorldExt | null = null;
  if (useCity) {
    const { loadWorld } = await import('../world/world');
    world = await loadWorld(engine, physics, undefined, {});
  }
  const arena = (await createArena(arenaId, { engine, physics, world })) as Awaited<ReturnType<typeof createArena>> & { reset?(): void; floorY?: number };
  if (!arena.root.parent) engine.scene.add(arena.root);
  if (world) await world.warmUp([arena.root], 6000);
  const system = await createBeastSystem(engine, physics, { world, visual: params.get('visual') === 'fallback' ? 'fallback' : 'auto' });
  const floorY = typeof arena.floorY === 'number' ? arena.floorY : Math.min(...arena.spawnPoints.map((s) => s.position.y));
  const hide = fast && params.get('show') !== '1';
  if (hide) {
    if (world) world.root.visible = false;
    arena.root.visible = false;
  }

  // ---------------------------------------------------------------- round state
  const fighters: Fighter[] = [];
  const stats: RoundStat[] = [];
  let round = 0;
  let simT = 0;
  let roundT = 0;
  let settle = -1;
  let over = false;
  let overT = 0;
  let kos = 0;
  let hits = 0;
  let done = false;
  const log = (s: string) => console.info(`[dev-bots] ${s}`);
  const byBeast = new Map<number, Fighter>();
  const stuckPlans: Record<string, number> = {};
  const hazTmp = new THREE.Vector3();
  // like the game: the physics has stepped before the bots look around (Rapier answers ray casts after a step)
  physics.step(1 / 60);
  const sense = getSense(arena, physics);

  system.on({
    onHit(target, attacker, strength) {
      const f = byBeast.get(target.id);
      if (!f) return;
      if (attacker) {
        hits++;
        f.hitT = roundT;
        f.hitBy = attacker.options.name;
      } else if (strength > 0.3) {
        if (sense.warning > 0.4 || sense.hazardTime(target.position, hazTmp) < 0.4) f.hazT = roundT;
      }
    },
    onKnockout(target) {
      kos++;
      const f = byBeast.get(target.id);
      if (f) f.kod++;
    },
  });

  function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startRound(): void {
    for (const f of fighters) {
      f.bot?.dispose();
      system.remove(f.beast);
    }
    fighters.length = 0;
    byBeast.clear();
    arena.reset?.();
    physics.resetAccumulator();
    round++;
    roundT = 0;
    settle = -1;
    over = false;
    kos = 0;
    hits = 0;
    const spawns = shuffle([...arena.spawnPoints]);
    for (let i = 0; i < nBots; i++) {
      const sp = spawns[i % spawns.length];
      const at = sp.position.clone();
      if (i >= spawns.length) at.x += 0.6;
      at.y += 0.05;
      const list = (diffParam === 'mix' ? DIFFS : diffParam.split(',')).filter((x): x is BotDifficulty => DIFFS.includes(x as BotDifficulty));
      const diff: BotDifficulty = list.length ? list[i % list.length] : 'normaal';
      const name = `${NAMES[i]}${list.length > 1 ? '-' + diff[0].toUpperCase() : ''}`;
      const beast = system.spawn({ name, colour: COLOURS[i], costume: COSTUMES[i], isBot: true }, at, sp.facing);
      const f: Fighter = {
        name, diff, beast, bot: null, out: false, outT: 0, cause: null, by: null,
        hitT: -99, hitBy: null, hazT: -99, liftT: -99, liftBy: null, heldT: -99, heldBy: null,
        checkP: beast.position.clone(), checkT: 0, stuck: 0, trace: [], traceT: 0, kod: 0, grabbed: 0, wasHeld: false, alive: 0, idle: 0,
      };
      fighters.push(f);
      byBeast.set(beast.id, f);
    }
    for (const f of fighters) {
      // dummy=1: the last beast stands still (no controller) = a passive human, to measure how fast bots finish one off
      if (dummy && f === fighters[fighters.length - 1]) continue;
      f.bot = createBotController(f.beast, { system, arena, difficulty: f.diff, physics });
    }
  }

  function causeOf(f: Fighter): { cause: Cause; by: string | null } {
    const t = roundT;
    if (t - f.liftT < 3) return { cause: 'gegooid', by: f.liftBy };
    if (t - f.hazT < 2.5) return { cause: 'gevaar', by: null };
    if (t - f.hitT < 3) return { cause: 'geraakt', by: f.hitBy };
    if (t - f.heldT < 2) return { cause: 'gesleept', by: f.heldBy };
    return { cause: 'zelf', by: null };
  }

  const chest = new THREE.Vector3();
  function judge(dt: number): void {
    if (over) return;
    for (const f of fighters) {
      if (f.out) continue;
      const b = f.beast;
      f.alive += dt;
      const plan = f.bot?.plan;
      if (plan && IDLE_PLANS.includes(plan)) f.idle += dt;
      // who holds / lifts it
      if (b.heldBy.length > 0 && !f.wasHeld) f.grabbed++;
      f.wasHeld = b.heldBy.length > 0;
      if (b.heldBy.length > 0) {
        const h = fighters.find((o) => o.beast.id === b.heldBy[0]);
        if (h) {
          f.heldT = roundT;
          f.heldBy = h.name;
          if (h.beast.isLifting) {
            f.liftT = roundT;
            f.liftBy = h.name;
          }
        }
      }
      // stuck (scene view): < 1 m in 15 s while awake
      if (roundT - f.checkT > 15) {
        if (b.position.distanceTo(f.checkP) < 1 && b.mode !== 'ko') {
          f.stuck++;
          const k = `${f.bot?.plan}/${b.mode}`;
          stuckPlans[k] = (stuckPlans[k] ?? 0) + 1;
        }
        f.checkP.copy(b.position);
        f.checkT = roundT;
      }
      if (roundT - f.traceT >= 0.25) {
        f.traceT = roundT;
        f.trace.push(`${roundT.toFixed(1)} ${f.bot?.plan}/${b.mode} e${arena.edgeDistance(b.position).toFixed(2)} hp${Math.round(b.health)} y${b.position.y.toFixed(2)}`);
        if (f.trace.length > 14) f.trace.shift();
      }
      b.partPosition('chest', chest);
      if (arena.isOut(chest) || chest.y < floorY - 4) {
        const c = causeOf(f);
        f.out = true;
        f.outT = roundT;
        f.cause = c.cause;
        f.by = c.by;
        if (c.cause === 'zelf') log(`SELF ${f.name} r${round}: ${f.trace.join(' | ')}`);
        f.bot?.dispose();
        b.eliminate();
      }
    }
    roundT += dt;
    let alive = 0;
    for (const f of fighters) if (!f.out) alive++;
    if (settle < 0) {
      if ((alive <= 1 || (dummy && fighters[fighters.length - 1].out)) && roundT >= 2) settle = 0;
      else if (roundT >= maxTime) finishRound(true);
    }
    if (settle >= 0) {
      settle += dt;
      if (settle >= 1) finishRound(false);
    }
  }

  function finishRound(timeUp: boolean): void {
    over = true;
    overT = 0;
    const left = fighters.filter((f) => !f.out);
    const w = !timeUp && left.length === 1 ? left[0] : null;
    let throws = 0, punches = 0, kicks = 0, climbs = 0, dodges = 0, shelters = 0, taunts = 0, propThrows = 0, stuckBot = 0, stuckScene = 0;
    let alive = 0, idle = 0, ms = 0, msMax = 0;
    const stuckBy: Record<string, number> = {};
    for (const f of fighters) {
      const s = f.bot?.stats;
      if (s) {
        throws += s.throws;
        punches += s.punches;
        kicks += s.kicks;
        climbs += s.climbs;
        dodges += s.dodges;
        shelters += s.shelters;
        taunts += s.taunts;
        propThrows += s.propThrows;
        stuckBot += s.stuck;
        for (const k in s.stuckBy) stuckBy[k] = (stuckBy[k] ?? 0) + s.stuckBy[k];
      }
      ms += f.bot?.ms ?? 0;
      msMax = Math.max(msMax, f.bot?.msMax ?? 0);
      stuckScene += f.stuck;
      alive += f.alive;
      idle += f.idle;
    }
    const st: RoundStat = {
      round,
      arena: arenaId,
      t: +roundT.toFixed(1),
      winner: w ? w.name : null,
      winnerDiff: w ? w.diff : null,
      timeUp,
      outs: fighters.filter((f) => f.out).sort((a, b) => a.outT - b.outT).map((f) => ({ name: f.name, t: +f.outT.toFixed(1), cause: f.cause ?? 'zelf', by: f.by })),
      places: [...fighters].sort((a, b) => (a.out ? a.outT : 1e9) - (b.out ? b.outT : 1e9)).reverse().map((f, i) => ({ diff: f.diff, place: i + 1 })),
      perDiff: (() => {
        const r: RoundStat['perDiff'] = {};
        for (const f of fighters) {
          const e = (r[f.diff] ??= { n: 0, kod: 0, kos: 0, thr: 0, hits: 0, punch: 0, alive: 0, grabbed: 0 });
          e.n++;
          e.kod += f.kod;
          e.kos += f.bot?.stats.kosDealt ?? 0;
          e.thr += f.bot?.stats.throws ?? 0;
          e.hits += f.bot?.stats.hitsDealt ?? 0;
          e.punch += f.bot?.stats.punches ?? 0;
          e.alive += f.alive;
          e.grabbed += f.grabbed;
        }
        return r;
      })(),
      kos,
      hits,
      throws,
      punches,
      kicks,
      climbs,
      dodges,
      shelters,
      taunts,
      propThrows,
      stuckBot,
      stuckScene,
      stuckBy,
      idlePct: alive > 0 ? Math.round((idle / alive) * 100) : 0,
      botMs: +(ms / Math.max(1, fighters.length)).toFixed(3),
      botMsMax: +msMax.toFixed(3),
    };
    stats.push(st);
    log(`ROUND ${JSON.stringify(st)}`);
    if (fast && stats.length >= rounds) {
      done = true;
      log(`SUMMARY ${JSON.stringify(summary())}`);
    }
  }

  function summary() {
    const n = stats.length || 1;
    const causes: Record<string, number> = {};
    const wins: Record<string, number> = {};
    let t = 0, outs = 0, kosS = 0, hitsS = 0, throws = 0, stuckB = 0, stuckS = 0, idle = 0, timeUps = 0, ms = 0, dodges = 0, shelters = 0, climbs = 0, taunts = 0, props = 0;
    const durs: number[] = [];
    for (const s of stats) {
      t += s.t;
      durs.push(s.t);
      outs += s.outs.length;
      for (const o of s.outs) causes[o.cause] = (causes[o.cause] ?? 0) + 1;
      const wk = s.winnerDiff ?? (s.timeUp ? 'tijd' : 'gelijk');
      wins[wk] = (wins[wk] ?? 0) + 1;
      kosS += s.kos;
      hitsS += s.hits;
      throws += s.throws;
      stuckB += s.stuckBot;
      stuckS += s.stuckScene;
      idle += s.idlePct;
      timeUps += s.timeUp ? 1 : 0;
      ms += s.botMs;
      dodges += s.dodges;
      shelters += s.shelters;
      climbs += s.climbs;
      taunts += s.taunts;
      props += s.propThrows;
    }
    durs.sort((a, b) => a - b);
    const place: Record<string, number[]> = {};
    for (const s of stats) for (const pl of s.places) (place[pl.diff] ??= []).push(pl.place);
    const avgPlace: Record<string, number> = {};
    for (const k in place) avgPlace[k] = +(place[k].reduce((a, b) => a + b, 0) / place[k].length).toFixed(2);
    return {
      arena: arenaId,
      bots: nBots,
      difficulty: diffParam,
      rounds: stats.length,
      avgT: +(t / n).toFixed(1),
      medianT: durs.length ? durs[Math.floor(durs.length / 2)] : 0,
      minT: durs[0] ?? 0,
      maxT: durs[durs.length - 1] ?? 0,
      timeUps,
      outsByCause: causes,
      selfOutPct: outs ? Math.round(((causes.zelf ?? 0) / outs) * 100) : 0,
      winsByDifficulty: wins,
      perDiff: (() => {
        const r: Record<string, Record<string, number>> = {};
        for (const s of stats) for (const k in s.perDiff) {
          const e = (r[k] ??= {});
          const v = s.perDiff[k] as unknown as Record<string, number>;
          for (const m in v) e[m] = (e[m] ?? 0) + v[m];
        }
        for (const k in r) { const n = r[k].n; for (const m in r[k]) if (m !== 'n') r[k][m] = +(r[k][m] / n).toFixed(1); }
        return r;
      })(),
      avgPlace,
      perRound: {
        kos: +(kosS / n).toFixed(1),
        hits: +(hitsS / n).toFixed(1),
        throws: +(throws / n).toFixed(1),
        dodges: +(dodges / n).toFixed(1),
        shelters: +(shelters / n).toFixed(1),
        climbs: +(climbs / n).toFixed(1),
        taunts: +(taunts / n).toFixed(1),
        propThrows: +(props / n).toFixed(1),
      },
      stuckBot: stuckB,
      stuckPlans,
      stuckScene: stuckS,
      idlePct: Math.round(idle / n),
      botMsPerFrame: +(ms / n).toFixed(3),
      botMsWorst: Math.max(0, ...stats.map((s) => s.botMsMax)),
      simSeconds: +simT.toFixed(0),
      wallSeconds: +((performance.now() - wallStart) / 1000).toFixed(0),
    };
  }

  // ---------------------------------------------------------------- simulation step
  let elapsed = 0;
  function simStep(dt: number): void {
    if (!over) for (const f of fighters) if (!f.out) f.bot?.update(dt);
    judge(dt);
    elapsed += dt;
    arena.update(dt, elapsed);
    physics.step(dt);
    system.update(dt);
    simT += dt;
    if (over) {
      overT += dt;
      if (overT > (fast ? 0.5 : 3) && !done) startRound();
    }
  }

  startRound();
  const STEP = 1 / 60;
  let stepsLast = 0;
  let wallStart = performance.now();
  if (fast) {
    engine.onUpdate(() => {
      if (done) return;
      const t0 = performance.now();
      let k = 0;
      const maxK = speed > 0 ? speed : 40;
      while (k < maxK) {
        simStep(STEP);
        k++;
        if (speed === 0 && performance.now() - t0 > 38) break;
        if (done) break;
      }
      stepsLast = k;
    }, 5);
  } else {
    engine.onUpdate((dt) => simStep(Math.min(dt, 1 / 20)), 5);
  }
  if (world) {
    const w = world;
    engine.onUpdate((dt) => w.update(dt, engine.camera.position), 40);
  }

  // ---------------------------------------------------------------- camera
  const fr = arena.camera;
  const view = params.get('view') ?? 'frame';
  const camDist = params.get('camdist');
  const camTarget = fr.target.clone();
  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let camYaw = NaN;
  engine.onUpdate((dt) => {
    const cam = engine.camera;
    tmp.set(0, 0, 0);
    let c = 0;
    for (const f of fighters) {
      if (f.out) continue;
      tmp.add(f.beast.position);
      c++;
    }
    if (c) tmp.multiplyScalar(1 / c).lerp(fr.target, 0.35);
    else tmp.copy(fr.target);
    let spread = 0;
    for (const f of fighters) if (!f.out) spread = Math.max(spread, f.beast.position.distanceTo(tmp));
    camTarget.lerp(tmp, 1 - Math.exp(-dt * (fast ? 8 : 2.5)));
    if (view === 'top') {
      cam.position.set(camTarget.x, camTarget.y + 40, camTarget.z + 0.01);
      cam.lookAt(camTarget);
    } else {
      const d = camDist ? Number(camDist) : THREE.MathUtils.clamp(spread * 1.5 + 7, fr.minDistance * 0.8, fr.maxDistance);
      let yaw = fr.yaw;
      if (sense.hasSails) {
        // molen: look at the fighters from outside the stage ring (the mill body would hide them)
        const mp = (sense as unknown as { millPos: THREE.Vector3 }).millPos;
        const want = Math.atan2(mp.x - camTarget.x, mp.z - camTarget.z);
        camYaw = Number.isFinite(camYaw) ? camYaw + Math.atan2(Math.sin(want - camYaw), Math.cos(want - camYaw)) * (1 - Math.exp(-dt * 1.5)) : want;
        yaw = camYaw;
      }
      dir.set(Math.sin(yaw) * Math.cos(fr.pitch), -Math.sin(fr.pitch), Math.cos(yaw) * Math.cos(fr.pitch));
      cam.position.copy(camTarget).addScaledVector(dir, -d);
      cam.lookAt(camTarget);
    }
    engine.setFocus(camTarget);
  }, 50);

  // ---------------------------------------------------------------- HUD
  let hud: HTMLDivElement | null = null;
  if (params.get('hud') !== '0') {
    hud = document.createElement('div');
    hud.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:20;font:12px/1.35 monospace;color:#fff;background:rgba(0,0,0,.55);padding:6px 8px;border-radius:4px;pointer-events:none;white-space:pre';
    document.body.appendChild(hud);
    let hudT = 0;
    engine.onUpdate((dt) => {
      hudT += dt;
      if (hudT < 0.2 || !hud) return;
      hudT = 0;
      const lines = [`${arena.name}  ronde ${round}  ${roundT.toFixed(1)} s  ${fast ? `x${stepsLast}` : ''}`];
      if (sense.boatFrame) lines.push(`brugwaarschuwing ${sense.warning.toFixed(2)}`);
      for (const f of fighters) {
        const b = f.beast;
        const st = f.out ? `AF (${f.cause}${f.by ? ' door ' + f.by : ''})` : `${(f.bot?.plan ?? '-').padEnd(8)} ${b.mode.padEnd(5)} -> ${f.bot?.targetName ?? '-'}`;
        lines.push(`${f.name.padEnd(8)} ${f.diff.slice(0, 4)} ${st}`);
      }
      if (stats.length) {
        const s = stats[stats.length - 1];
        lines.push(`vorige: ${s.t} s, winnaar ${s.winner ?? '-'}`);
      }
      hud.textContent = lines.join('\n');
    }, 60);
  }

  // ---------------------------------------------------------------- debug
  window.__debug = {
    arena,
    world,
    physics,
    system,
    sense,
    fighters,
    rounds: stats,
    summary,
    get done() {
      return done;
    },
    waitDone: () =>
      new Promise((res) => {
        const iv = setInterval(() => {
          if (done) {
            clearInterval(iv);
            res(summary());
          }
        }, 500);
      }),
    progress: () => ({ round, roundT: +roundT.toFixed(1), simT: +simT.toFixed(0), wall: +((performance.now() - wallStart) / 1000).toFixed(0), steps: stepsLast, done }),
    bots: () =>
      fighters.map((f) => ({
        name: f.name,
        diff: f.diff,
        out: f.out,
        plan: f.bot?.plan,
        target: f.bot?.targetName,
        mode: f.beast.mode,
        hp: Math.round(f.beast.health),
        edge: +arena.edgeDistance(f.beast.position).toFixed(2),
        p: [f.beast.position.x, f.beast.position.y, f.beast.position.z].map((v) => +v.toFixed(2)),
        ms: f.bot ? +f.bot.ms.toFixed(3) : 0,
        haz: +Math.min(99, sense.hazardTime(f.beast.position, tmp)).toFixed(2),
        br: +Math.min(99, sense.bridgeTime(f.beast.position)).toFixed(2),
      })),
    force(i: number, kind: 'prop' | 'taunt' | 'wobble') {
      (fighters[i]?.bot as unknown as { forceSilly?(k: string): void })?.forceSilly?.(kind);
    },
    info: () => fighters.map((f) => (f.bot as unknown as { debugInfo?: string })?.debugInfo ?? '-'),
    setSpeed(k: number) {
      speed = k;
    },
    restart() {
      wallStart = performance.now();
      startRound();
    },
    grid: (step = 1) => {
      const c = sense.centre;
      const rows: string[] = [];
      for (let z = c.z - 14; z <= c.z + 14; z += step) {
        let r = '';
        for (let x = c.x - 14; x <= c.x + 14; x += step) r += '.#~o'[sense.cellAt(x, z)];
        rows.push(r);
      }
      return { ok: sense.gridOk, rows };
    },
  };
  window.__ready = true;
};

export default entry;
