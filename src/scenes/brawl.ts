// Gang Alkmaar — the game: loading screen → city (loadWorld) + physics + beast system → lobby
// (live preview beast in front of De Waag) → match: arena, human + bots, countdown, fight, outs,
// winner zoom, cheese-wheel scoreboard, next round, match winner celebration → lobby.
//
// URL parameters (testing / screenshots):
//   ?autostart=1&arena=<kaasmarkt|rondvaartboot|molen>&bots=<1-5>&difficulty=<makkelijk|normaal|moeilijk>&wins=<1-10>
//   &name=<naam>&colour=<hex>   player for autostart        &world=0   skip the city (fast dev)
//   &fallback=all|physics,visual,arenas,ai   force the placeholders     &quality=<level> (engine)
// window.__debug: { state, match, beasts, arena, camera, startMatch(opts), forceWin(i), pause(), resume(), lobby() }
import * as THREE from 'three';
import type { SceneEntry } from '../contracts';
import { createPhysics } from '../physics/physics';
import { loadWorld } from '../world/world';
import type { WorldExt } from '../world/types';
import { h } from '../ui/dom';
import '../brawl/ui/style.css';
import type { ArenaId, BeastExpression, BeastInput, BeastVisual, BotDifficulty } from '../brawl/contracts';
import type { ArenaExt, BeastExt, Fighter, GamePhase, LobbyChoices, MatchOptions } from '../brawl/types';
import { loadBrawlModules } from '../brawl/modules';
import { createFallbackArena } from '../brawl/fallback/arena';
import { createLoadingScreen, type LoadingScreen } from '../brawl/ui/loading';
import { createNav } from '../brawl/ui/nav';
import { createMenus } from '../brawl/ui/menus';
import { createLobby } from '../brawl/ui/lobby';
import { createHud } from '../brawl/ui/hud';
import { createPadReader, PAD } from '../brawl/pad';
import { createHumanInput } from '../brawl/input';
import { createBrawlCamera, IGNORE_TAG } from '../brawl/camera';
import { createBrawlAudio } from '../brawl/audio';
import { BOT_NAMES, koMessage, MIN_ROUND_TIME, outMessage, RoundJudge } from '../brawl/match';
import { DEFAULT_SETTINGS, DIFFICULTIES, loadJson, sanitizeChoices, saveJson, type BrawlSettings } from '../brawl/prefs';
import { animateIdle, RigPose } from '../brawl/pose';
import { clearTreeCut, setTreeCut } from '../brawl/treeCut';

const WINNER_ZOOM = 3.2;
const SCOREBOARD = 4.5;
const CELEBRATION = 9;
/** time scale of the slow motion while the round-deciding beast falls off */
const SLOWMO = 0.3;
/** controls reminder during the first countdown (full list: Besturing in the lobby / pause menu) */
const KEY_HINT = [['WASD', 'lopen'], ['Spatie', 'springen'], ['Muisknoppen', 'stoten / grijpen'], ['Shift', 'optillen'], ['F', 'schoppen'], ['C', 'bukken']] as const;
const PAD_HINT = [['Stick', 'lopen'], ['A', 'springen'], ['LT / RT', 'stoten / grijpen'], ['Y', 'optillen'], ['X', 'schoppen'], ['B', 'bukken']] as const;
/** lobby preview spot without the city (far from every arena) */
const DEV_SPOT = new THREE.Vector3(200, 0, 200);

const brawl: SceneEntry = async (engine, params) => {
  const uiRoot = document.getElementById('ui-root') ?? document.body;
  const root = h('div', 'ga-root');
  uiRoot.appendChild(root);
  const attribution = 'Kaartdata © OpenStreetMap-bijdragers (ODbL) · Gebouwen: 3D BAG (CC BY 4.0)';
  let loading: LoadingScreen | null = createLoadingScreen(root, attribution);
  loading.set(0.01, 'Opstarten');
  engine.start();

  // ---------------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------------
  const useWorld = params.get('world') !== '0';
  const physics = await createPhysics();
  loading.set(0.03, 'Kaartgegevens laden');
  let world: WorldExt | null = null;
  if (useWorld) {
    world = await loadWorld(engine, physics, (f, label) => loading?.set(0.03 + f * 0.8, label));
  } else addDevGround(engine.scene, physics);
  loading.set(0.85, 'Vechters wakker schudden');
  const mods = await loadBrawlModules(params);
  // all costume geometry up front (~130 ms), so the first spawn of a new costume does not hitch
  mods.prewarmVisuals();
  const system = await mods.createBeastSystem(engine, physics, { world });
  const audio = createBrawlAudio();
  const settings: BrawlSettings = loadJson('settings', { ...DEFAULT_SETTINGS });
  audio.setVolume(settings.volume, settings.music);

  // ---------------------------------------------------------------------------------------------
  // Lobby preview beast (in front of De Waag) — warmed up under the loading screen
  // ---------------------------------------------------------------------------------------------
  const defaults: LobbyChoices = {
    name: 'Speler',
    colour: mods.colours[0]?.hex ?? '#f2c230',
    costume: (mods.costumes.find((c) => c.id === 'kaasdrager') ?? mods.costumes[1] ?? mods.costumes[0])?.id ?? 'geen',
    arena: 'kaasmarkt',
    bots: 3,
    difficulty: 'normaal',
    wins: 3,
  };
  const choices = sanitizeChoices(loadJson<Partial<LobbyChoices>>('lobby', {}), mods.arenas.map((a) => a.id), defaults);
  const preview = createPreview(choices.colour, choices.costume);
  engine.scene.add(preview.group);
  if (world) {
    loading.set(0.9, 'Kazen opwrijven');
    await world.warmUp([preview.group], 6000);
  }

  // ---------------------------------------------------------------------------------------------
  // UI + input
  // ---------------------------------------------------------------------------------------------
  const nav = createNav();
  const click = () => audio.footstep(0.6);
  const menus = createMenus(root, nav, engine, settings, (s) => {
    saveJson('settings', s);
    audio.setVolume(s.volume, s.music);
  }, click);
  const hud = createHud(root);
  const pad = createPadReader();
  const input = createHumanInput(engine.canvas, pad);
  const camera = createBrawlCamera(engine, physics);
  const lobby = createLobby(root, nav, menus, mods, choices, {
    onChange: (c) => {
      saveJson('lobby', c);
      preview.visual.setColour(c.colour);
      preview.visual.setCostume(c.costume);
      preview.hop();
    },
    onStart: (c) => {
      audio.resume();
      click();
      saveJson('lobby', c);
      void startMatch(optionsFromChoices(c));
    },
    onQuit: () => quitGame(),
    onClick: click,
  });

  // ---------------------------------------------------------------------------------------------
  // Match state
  // ---------------------------------------------------------------------------------------------
  let phase: GamePhase = 'loading';
  let paused = false;
  let options: MatchOptions | null = null;
  let fighters: Fighter[] = [];
  let arena: ArenaExt | null = null;
  let arenaId: ArenaId | null = null;
  let judge: RoundJudge | null = null;
  let round = 0;
  let phaseT = 0;
  let countdownStep = 0;
  let roundWinner: Fighter | null = null;
  let matchWinner: Fighter | null = null;
  let token = 0;
  let skip = false;
  let elapsed = 0;
  // slow motion (the round-deciding fall): physics, beasts and the arena run at timeScale
  let timeScale = 1;
  let slowT = 0;
  let slowUsed = false;
  const lastSplash = new Map<Fighter, number>();
  const stepDist = new Map<Fighter, number>();
  const lastPos = new Map<Fighter, THREE.Vector3>();
  const subjectPts: THREE.Vector3[] = [];
  const subjectW: number[] = [];
  const tmp = new THREE.Vector3();
  const autostart = params.get('autostart') === '1';

  const human = () => fighters.find((f) => !f.isBot) ?? null;
  const arenaName = () => mods.arenas.find((a) => a.id === arenaId)?.name ?? arena?.name ?? '';

  function optionsFromChoices(c: LobbyChoices): MatchOptions {
    return {
      arena: c.arena,
      bots: c.bots,
      difficulty: c.difficulty,
      wins: c.wins,
      player: { name: c.name, colour: c.colour, costume: c.costume },
    };
  }

  function makeFighters(o: MatchOptions): Fighter[] {
    const list: Fighter[] = [];
    const mk = (index: number, name: string, colour: string, costume: string, isBot: boolean): Fighter => ({
      index, name, colour, costume, isBot, voice: 0.78 + Math.random() * 0.55, wins: 0, beast: null, bot: null, out: false, outAt: 0,
    });
    list.push(mk(0, o.player.name, o.player.colour, o.player.costume, false));
    const names = shuffle(BOT_NAMES.filter((n) => n.toLowerCase() !== o.player.name.toLowerCase()));
    const colours = shuffle(mods.colours.filter((c) => c.hex.toLowerCase() !== o.player.colour.toLowerCase()));
    for (let i = 0; i < o.bots; i++) {
      const costume = mods.costumes[Math.floor(Math.random() * mods.costumes.length)]?.id ?? o.player.costume;
      list.push(mk(i + 1, names[i % names.length], colours[i % colours.length]?.hex ?? '#888888', costume, true));
    }
    return list;
  }

  async function ensureArena(id: ArenaId, my: number): Promise<boolean> {
    if (arena && arenaId === id) {
      if (arena.reset) {
        arena.reset();
        return true;
      }
      disposeArena();
    } else disposeArena();
    const ctx = { engine, physics, world };
    let a: ArenaExt;
    try {
      a = (await mods.createArena(id, ctx)) as ArenaExt;
    } catch (e) {
      console.warn('[brawl] arena kon niet gebouwd worden, placeholder gebruikt:', e);
      a = await createFallbackArena(id, ctx);
    }
    if (my !== token) {
      a.dispose();
      return false;
    }
    if (!a.root.parent) engine.scene.add(a.root);
    arena = a;
    arenaId = id;
    if (world) await world.warmUp([a.root], 5000);
    return my === token;
  }

  function disposeArena(): void {
    if (!arena) return;
    arena.dispose();
    arena.root.removeFromParent();
    arena = null;
    arenaId = null;
  }

  function clearBeasts(): void {
    for (const f of fighters) {
      f.bot?.dispose();
      f.bot = null;
      if (f.beast) system.remove(f.beast);
      f.beast = null;
    }
    for (const b of [...system.beasts]) system.remove(b);
  }

  async function startMatch(o: MatchOptions): Promise<void> {
    options = { ...o, bots: Math.max(1, Math.min(5, o.bots)), wins: Math.max(1, Math.min(10, o.wins)) };
    lobby.hide();
    menus.closePause();
    paused = false;
    clearBeasts();
    fighters = makeFighters(options);
    round = 0;
    matchWinner = null;
    await startRound();
  }

  async function startRound(): Promise<void> {
    if (!options) return;
    const my = ++token;
    phase = 'starting';
    round++;
    hud.hideScoreboard();
    hud.clearBanner();
    hud.confetti(false);
    hud.spectate(null);
    hud.setQuiet(false);
    camera.release();
    if (!arena || arenaId !== options.arena || !arena.reset) {
      if (!loading) loading = createLoadingScreen(root, attribution);
      loading.set(0.5, 'Arena opbouwen');
    }
    audio.setMusic(false);
    preview.group.visible = false;
    const ok = await ensureArena(options.arena, my);
    if (!ok || !arena) return;
    clearBeasts();
    const spawns = shuffle([...arena.spawnPoints]);
    fighters.forEach((f, i) => {
      f.out = false;
      f.outAt = 0;
      const sp = spawns[i % spawns.length];
      tmp.copy(sp.position);
      if (i >= spawns.length) tmp.x += 0.6 * Math.floor(i / spawns.length);
      tmp.y += 0.05;
      f.beast = system.spawn({ name: f.name, colour: f.colour, costume: f.costume, isBot: f.isBot }, tmp, sp.facing) as BeastExt;
      lastPos.set(f, f.beast.position.clone());
      stepDist.set(f, 0);
    });
    for (const f of fighters) {
      if (f.isBot && f.beast) f.bot = mods.createBotController(f.beast, { system, arena, difficulty: options.difficulty, physics });
    }
    judge = new RoundJudge(fighters, arena, world, {
      onOut: (f, reason, at) => onOut(f, reason, at),
      onFalling: (f) => onFalling(f),
      onRoundOver: (w, timeUp) => onRoundOver(w, timeUp),
    });
    camera.setFrame(arena.camera);
    const ar = arena;
    camera.setEdgeTest((p) => ar.edgeDistance(p));
    camera.release();
    updateSubjects();
    camera.snap();
    hud.setFighters(fighters, round, arenaName());
    hud.show();
    physics.resetAccumulator();
    if (loading) {
      const l = loading;
      loading = null;
      await l.hide();
      if (my !== token) return;
    }
    audio.setAmbience(options.arena);
    if (round === 1 && options.arena === 'kaasmarkt') audio.carillon();
    if (round === 1 && options.arena === 'rondvaartboot') audio.horn();
    phase = 'countdown';
    phaseT = 0;
    countdownStep = 0;
    slowUsed = false;
    if (round === 1) hud.hint(input.usingGamepad ? PAD_HINT : KEY_HINT);
    window.__ready = true;
  }

  function onFalling(f: Fighter): void {
    audio.grunt(f.voice, 'scared');
    // this fall decides the round (at most one beast left standing): play it in slow motion
    if (judge && judge.alive.filter((x) => x !== f && !judge!.isFalling(x)).length <= 1) decidingMoment(f);
  }

  /** Slow motion + whoosh + punch-in for the fall / out that decides the round (once). */
  function decidingMoment(f: Fighter): void {
    if (!judge || slowUsed || judge.time < MIN_ROUND_TIME) return;
    slowUsed = true;
    slowT = 1.25;
    audio.whoosh();
    if (f.beast) {
      f.beast.partPosition('chest', tmp);
      camera.punchIn(tmp, 0.7);
    }
  }

  function onOut(f: Fighter, reason: 'water' | 'fall', at: THREE.Vector3): void {
    if (!options) return;
    if (judge && judge.alive.length <= 1) decidingMoment(f);
    hud.feed(outMessage(f.name, options.arena, reason), f.colour);
    hud.stamp('UIT!', at, engine.camera);
    hud.refreshStrip();
    if (reason === 'water') {
      if (elapsed - (lastSplash.get(f) ?? -9) > 1.5) audio.splash(1);
    } else audio.thud(0.9);
    if (options.arena === 'kaasmarkt') audio.ooh();
    camera.punchIn(at, 0.5);
    const me = human();
    if (me === f && judge && judge.alive.length >= 2) hud.spectate('Je ligt eruit! Even kijken wie er wint…');
  }

  function onRoundOver(winner: Fighter | null, timeUp: boolean): void {
    if (!options) return;
    hud.hint(null);
    roundWinner = winner;
    hud.spectate(null);
    hud.setQuiet(true);
    if (winner) {
      winner.wins++;
      hud.refreshStrip();
      const me = !winner.isBot;
      hud.banner(me ? 'Jij wint de ronde!' : `${winner.name} wint de ronde!`, me ? 'Lekker bezig!' : undefined, winner.colour);
      if (winner.beast) {
        winner.beast.partPosition('chest', tmp);
        camera.focus(tmp, winner.beast.facing, 3.3);
      }
      winner.bot?.dispose();
      winner.bot = null;
      audio.cheer(1);
      audio.grunt(winner.voice, 'yay');
      if (options.arena === 'kaasmarkt') audio.carillon();
      if (options.arena === 'rondvaartboot') audio.horn();
    } else {
      hud.banner(timeUp ? 'Tijd is op!' : 'Gelijkspel!', 'Niemand krijgt een kaas');
      audio.ooh();
    }
    phase = 'winnerZoom';
    phaseT = 0;
  }

  function showScoreboard(): void {
    if (!options) return;
    hud.clearBanner();
    matchWinner = fighters.find((f) => f.wins >= options!.wins) ?? null;
    hud.scoreboard(
      fighters,
      options.wins,
      roundWinner,
      matchWinner ? 'Eindstand' : 'Tussenstand',
      matchWinner ? 'Enter / A: verder' : `Volgende ronde over ${Math.ceil(SCOREBOARD)} s · Enter / A: verder`,
    );
    phase = 'scoreboard';
    phaseT = 0;
  }

  function startCelebration(): void {
    if (!matchWinner) return;
    hud.hideScoreboard();
    const me = !matchWinner.isBot;
    hud.banner(me ? 'Jij wint de wedstrijd!' : `${matchWinner.name} wint de wedstrijd!`, 'Kaaskampioen van Alkmaar', matchWinner.colour);
    hud.confetti(true);
    audio.fanfare();
    audio.cheer(1);
    if (matchWinner.beast) {
      matchWinner.beast.partPosition('chest', tmp);
      camera.orbit(tmp, 4.4);
    }
    phase = 'celebration';
    phaseT = 0;
  }

  function endMatch(): void {
    token++;
    clearBeasts();
    disposeArena();
    fighters = [];
    judge = null;
    options = null;
    paused = false;
    menus.closePause();
    hud.hide();
    audio.setPaused(false);
  }

  function showLobby(): void {
    endMatch();
    phase = 'lobby';
    camera.setManual(true);
    preview.group.visible = true;
    lobby.show();
    audio.setAmbience(null);
    audio.setMusic(true);
    window.__ready = true;
  }

  function quitGame(): void {
    window.close();
    // In a normal browser tab window.close() is ignored.
    setTimeout(() => {
      if (phase !== 'lobby') showLobby();
    }, 250);
  }

  const canPause = () => phase === 'countdown' || phase === 'fight' || phase === 'winnerZoom' || phase === 'scoreboard' || phase === 'celebration';

  function pause(): void {
    if (paused || !canPause()) return;
    paused = true;
    audio.setPaused(true);
    menus.openPause({
      resume: () => resume(),
      restart: () => {
        if (!options) return;
        const o = options;
        resume();
        void startMatch(o);
      },
      lobby: () => showLobby(),
      quit: () => quitGame(),
    });
  }

  function resume(): void {
    if (!paused) return;
    paused = false;
    menus.closePause();
    audio.setPaused(false);
    physics.resetAccumulator();
  }

  // Esc / Start toggles the pause menu (when no menu has the keyboard)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && nav.depth === 0 && canPause()) {
      e.preventDefault();
      pause();
    }
    if ((e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') && nav.depth === 0) skip = true;
  });
  window.addEventListener('blur', () => {
    if (!autostart && (phase === 'fight' || phase === 'countdown')) pause();
  });

  // ---------------------------------------------------------------------------------------------
  // Hit / KO / grab events → sound, camera, HUD
  // ---------------------------------------------------------------------------------------------
  const byBeast = (b: unknown) => fighters.find((f) => f.beast === b) ?? null;
  system.on({
    onHit(target, attacker, strength, point) {
      if (phase === 'lobby') return;
      const ft = byBeast(target);
      audio.punch(strength);
      if (ft && Math.random() < 0.45 + strength * 0.5) audio.grunt(ft.voice, 'hit');
      const fa = byBeast(attacker);
      if (fa && Math.random() < 0.2) audio.grunt(fa.voice, 'effort');
      if (settings.shake) {
        const involvesMe = (ft && !ft.isBot) || (fa && !fa.isBot);
        camera.shake(strength * (involvesMe ? 0.5 : 0.22));
      }
      if (ft) hud.ping(ft);
      if (strength > 0.75 && options?.arena === 'kaasmarkt' && Math.random() < 0.5) audio.ooh();
      void point;
    },
    onKnockout(target) {
      const f = byBeast(target);
      if (!f || f.out || phase !== 'fight') return;
      hud.feed(koMessage(f.name), f.colour);
      audio.grunt(f.voice, 'ko');
      target.partPosition('chest', tmp);
      camera.punchIn(tmp, f.isBot ? 0.55 : 0.9);
    },
    onGrab(grabber, target) {
      const f = byBeast(grabber);
      if (f && target && Math.random() < 0.5) audio.grunt(f.voice, 'effort');
    },
    onSplash(target, point) {
      const f = byBeast(target);
      if (f) lastSplash.set(f, elapsed);
      audio.splash(0.9);
      void point;
    },
  });

  function setExpression(f: Fighter, e: BeastExpression): void {
    const b = f.beast;
    if (!b) return;
    if ('expressionOverride' in b) b.expressionOverride = e;
    else if (b.setExpression) b.setExpression(e);
    else b.visual?.setExpression(e);
  }

  // name tags of beasts hidden behind walls (the mill body, houses) fade out; 5 Hz ray per beast
  const tagVis = new Map<Fighter, { t: number; vis: boolean }>();
  const rayDir = new THREE.Vector3();
  function tagVisible(f: Fighter, head: THREE.Vector3): boolean {
    let e = tagVis.get(f);
    if (!e) tagVis.set(f, (e = { t: Math.random() * 0.2, vis: true }));
    e.t -= 1 / 60;
    if (e.t > 0) return e.vis;
    e.t = 0.2;
    const cam = engine.camera.position;
    rayDir.subVectors(head, cam);
    const len = rayDir.length();
    if (len < 0.5) return (e.vis = true);
    rayDir.multiplyScalar(1 / len);
    const hit = physics.raycast(cam, rayDir, len - 0.4);
    e.vis = !hit || (!!hit.tag && IGNORE_TAG.test(hit.tag));
    return e.vis;
  }

  function updateSubjects(): void {
    subjectPts.length = 0;
    subjectW.length = 0;
    const me = human();
    for (const f of fighters) {
      if (f.out || !f.beast) continue;
      subjectPts.push(f.beast.position);
      subjectW.push(f === me ? 2 : 1);
    }
    if (subjectPts.length === 0 && arena) {
      subjectPts.push(arena.camera.target);
      subjectW.push(1);
    }
    camera.setSubjects(subjectPts, subjectW);
    camera.setPrimary(me && !me.out && me.beast ? me.beast.position : null);
  }

  // ---------------------------------------------------------------------------------------------
  // Frame loop (priorities: input -10/0, bots 5, arena 9, physics 10, beasts 20, game 30,
  // world 40, camera 50, ui 60)
  // ---------------------------------------------------------------------------------------------
  engine.onUpdate((dt) => {
    // slow motion: ease into SLOWMO fast, back to real time gently
    slowT = phase === 'fight' ? Math.max(0, slowT - dt) : 0;
    const goal = slowT > 0 ? SLOWMO : 1;
    timeScale += (goal - timeScale) * (1 - Math.exp(-(slowT > 0 ? 12 : 2.5) * dt));
    if (Math.abs(timeScale - goal) < 0.002) timeScale = goal;
    pad.poll(dt);
    if (pad.pressed(PAD.START)) {
      if (paused) resume();
      else if (canPause() && nav.depth === 0) pause();
    }
    if (nav.depth > 0) nav.update(pad);
    else if (pad.pressed(PAD.A)) skip = true;
  }, -10);

  // winner celebration: arms up + a little hop (the human keeps control and cheers when idle)
  const cheerIn: BeastInput = { moveX: 0, moveZ: 0, jump: false, duck: false, lift: false, kick: false, grabLeft: false, grabRight: false };
  function cheerInput(t: number): BeastInput {
    // empty-handed lift = both arms straight up (beast-physics); pump them and hop now and then
    const ph = t % 2.1;
    cheerIn.lift = ph < 0.8 || (ph > 1.0 && ph < 1.7);
    cheerIn.jump = ph > 1.75 && ph < 1.87;
    return cheerIn;
  }
  const idle = (i: BeastInput) => Math.hypot(i.moveX, i.moveZ) < 0.05 && !i.jump && !i.duck && !i.lift && !i.kick && !i.grabLeft && !i.grabRight;

  engine.onUpdate(() => {
    const me = human();
    const celebrating = !paused && (phase === 'winnerZoom' || phase === 'celebration');
    const winner = phase === 'celebration' ? matchWinner : roundWinner;
    input.setEnabled((phase === 'fight' && !paused) || (celebrating && winner === me));
    if (me?.beast && !me.out) {
      let inp = input.read(engine.camera);
      if (celebrating && winner === me && idle(inp) && phaseT > 0.5) inp = cheerInput(phaseT);
      me.beast.setInput(inp);
    }
    if (celebrating && winner && winner !== me && winner.beast && !winner.out) winner.beast.setInput(cheerInput(phaseT + 0.4));
  }, 0);

  engine.onUpdate((dt) => {
    if (paused || phase !== 'fight') return;
    // bot timers are in game seconds: slow motion slows the bots down with the physics
    for (const f of fighters) if (f.bot && !f.out) f.bot.update(dt * timeScale);
  }, 5);

  engine.onUpdate((dt) => {
    if (paused || !arena) return;
    elapsed += dt * timeScale;
    arena.update(dt * timeScale, elapsed);
  }, 9);

  engine.onUpdate((dt) => {
    if (!paused) physics.step(dt * timeScale);
  }, 10);

  engine.onUpdate((dt) => {
    if (!paused) system.update(dt * timeScale);
  }, 20);

  engine.onUpdate((dt) => {
    if (paused) return;
    phaseT += dt;
    switch (phase) {
      case 'countdown': {
        const steps = ['3', '2', '1', 'Vechten!'];
        if (countdownStep < 4 && phaseT >= countdownStep * 0.9 + 0.35) {
          hud.countdown(steps[countdownStep], countdownStep === 3);
          audio.beep(countdownStep === 3);
          countdownStep++;
          if (countdownStep === 4) {
            phase = 'fight';
            phaseT = 0;
            if (options?.arena === 'kaasmarkt') audio.cheer(0.6);
          }
        }
        break;
      }
      case 'fight':
        if (phaseT > 5 && phaseT - dt <= 5) hud.hint(null);
        judge?.update(dt * timeScale);
        break;
      case 'winnerZoom':
        if (roundWinner) {
          setExpression(roundWinner, 'happy');
          if (roundWinner.beast) {
            roundWinner.beast.partPosition('chest', tmp);
            camera.focus(tmp, roundWinner.beast.facing, 3.3);
          }
        }
        if (phaseT >= WINNER_ZOOM || (skip && phaseT > 0.8)) showScoreboard();
        break;
      case 'scoreboard':
        if (!matchWinner) hud.setScoreFooter(`Volgende ronde over ${Math.max(1, Math.ceil(SCOREBOARD - phaseT))} s · Enter / A: verder`);
        if (phaseT >= (matchWinner ? 6 : SCOREBOARD) || (skip && phaseT > 0.6)) {
          if (matchWinner) startCelebration();
          else void startRound();
        }
        break;
      case 'celebration':
        if (matchWinner) {
          setExpression(matchWinner, 'happy');
          if (matchWinner.beast) {
            matchWinner.beast.partPosition('chest', tmp);
            camera.orbit(tmp, 4.4);
          }
        }
        if (phaseT >= CELEBRATION || (skip && phaseT > 1.5)) showLobby();
        break;
    }
    skip = false;
    // rondvaartboot: low-bridge warning, and a flatter camera so fighters under the deck stay visible
    if (arena) {
      const warnLevel = (arena as { warning?: number }).warning ?? 0;
      hud.warn(phase === 'fight' && warnLevel > 0.5 ? 'Lage brug! Bukken!' : null);
      let base = basePitch.get(arena);
      if (base === undefined) basePitch.set(arena, (base = arena.camera.pitch));
      arena.camera.pitch = base - 0.28 * warnLevel;
      bridgeOver = warnLevel > 0.3;
    }
    // footsteps
    if (phase === 'fight' || phase === 'countdown') {
      for (const f of fighters) {
        const b = f.beast;
        if (!b || f.out || b.state !== 'active') continue;
        const lp = lastPos.get(f);
        if (!lp) continue;
        const d = Math.hypot(b.position.x - lp.x, b.position.z - lp.z);
        lp.copy(b.position);
        const acc = (stepDist.get(f) ?? 0) + d;
        if (acc > 0.65) {
          audio.footstep(Math.min(1, d / dt / 4));
          stepDist.set(f, 0);
        } else stepDist.set(f, acc);
      }
    }
    if (phase !== 'lobby' && phase !== 'loading') updateSubjects();
  }, 30);

  engine.onUpdate((dt) => {
    world?.update(dt, engine.camera.position);
  }, 40);

  const cutPts: THREE.Vector3[] = [];
  /** arena camera pitch as designed (the boat flattens it while a bridge passes) */
  const basePitch = new WeakMap<object, number>();
  /** a bridge is over the boat: city surfaces get the cut-outs too (see the cut below) */
  let bridgeOver = false;
  engine.onUpdate((dt) => {
    if (phase === 'lobby' || phase === 'loading') {
      preview.update(dt);
      clearTreeCut();
      return;
    }
    camera.update(dt);
    // tree crowns in front of a fighter are dithered away (see brawl/treeCut.ts)
    cutPts.length = 0;
    for (const f of fighters) if (f.beast && (!f.out || phase !== 'fight')) cutPts.push(f.beast.position);
    setTreeCut(engine.camera, cutPts, 1.7, engine.camera.position.distanceTo(camera.target) * 0.55, bridgeOver);
  }, 50);

  engine.onUpdate((dt) => {
    if (phase !== 'lobby' && phase !== 'loading' && phase !== 'starting') {
      hud.updateTags(engine.camera, settings.tags, judge?.time ?? 0, tagVisible);
    }
    audio.update(dt);
  }, 60);

  // ---------------------------------------------------------------------------------------------
  // Debug hooks
  // ---------------------------------------------------------------------------------------------
  window.__debug = {
    ...(window.__debug ?? {}),
    world,
    physics,
    system,
    modules: mods.real,
    menus,
    cam: camera,
    audio,
    get timeScale() {
      return timeScale;
    },
    get state() {
      return paused ? `${phase} (pauze)` : phase;
    },
    get match() {
      return options
        ? {
            options,
            round,
            time: judge?.time ?? 0,
            fighters: fighters.map((f) => ({
              name: f.name, bot: f.isBot, wins: f.wins, out: f.out, state: f.beast?.state ?? null,
              pos: f.beast ? f.beast.position.toArray().map((v) => +v.toFixed(2)) : null,
            })),
          }
        : null;
    },
    get beasts() {
      return system.beasts;
    },
    get arena() {
      return arena;
    },
    get camera() {
      const d = camera.debug;
      return { mode: camera.mode, target: d.target.toArray().map((v) => +v.toFixed(2)), distance: +d.distance.toFixed(2), clearance: +d.clearance.toFixed(2), yaw: +d.yaw.toFixed(2), yawOffset: +d.yawOffset.toFixed(2), pitchOffset: +d.pitchOffset.toFixed(2), crowns: d.crowns };
    },
    startMatch: (o: Partial<MatchOptions> = {}) =>
      startMatch({ ...optionsFromChoices(choices), ...o, player: { ...optionsFromChoices(choices).player, ...(o.player ?? {}) } }),
    forceWin: (i = 0) => {
      if (!judge || phase !== 'fight') return false;
      for (const f of fighters) if (f.index !== i && !f.out) judge.knockOut(f, 'water');
      return true;
    },
    /** Knock fighter i out of the round (test the "Uit!" feedback). */
    eliminate: (i = 1) => {
      const f = fighters[i];
      if (!judge || !f || f.out) return false;
      judge.knockOut(f, 'water');
      return true;
    },
    /** Screenshot helper: show the loading screen at fraction f for `ms`. */
    showLoading: (f = 0.42, label = 'Grachten vullen', ms = 4000) => {
      const l = createLoadingScreen(root, attribution);
      l.set(f, label);
      window.setTimeout(() => void l.hide(), ms);
    },
    pause: () => pause(),
    resume: () => resume(),
    lobby: () => showLobby(),
    skip: () => {
      skip = true;
    },
    input: () => human()?.beast ?? null,
  };

  // ---------------------------------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------------------------------
  loading.set(1, 'Klaar');
  if (autostart) {
    const ids = mods.arenas.map((a) => a.id);
    const a = params.get('arena') as ArenaId | null;
    const diff = params.get('difficulty') as BotDifficulty | null;
    const colour = params.get('colour');
    const o: MatchOptions = {
      arena: a && ids.includes(a) ? a : choices.arena,
      bots: clampInt(params.get('bots'), 1, 5, choices.bots),
      difficulty: diff && DIFFICULTIES.some((d) => d.id === diff) ? diff : choices.difficulty,
      wins: clampInt(params.get('wins'), 1, 10, choices.wins),
      player: { name: params.get('name') ?? choices.name, colour: colour ? `#${colour.replace('#', '')}` : choices.colour, costume: choices.costume },
    };
    await startMatch(o);
  } else {
    const l = loading;
    loading = null;
    await l.hide();
    showLobby();
  }

  // ---------------------------------------------------------------------------------------------
  // Lobby preview (closure helpers)
  // ---------------------------------------------------------------------------------------------
  function createPreview(colour: string, costume: string) {
    const group = new THREE.Group();
    group.name = 'lobby-preview';
    const visual: BeastVisual = mods.createBeastVisual({ colour, costume });
    const spin = new THREE.Group();
    spin.add(visual.root);
    group.add(spin);
    const pose = new RigPose();
    // spot on the Waagplein in front of De Waag (its +z model axis faces the square)
    const waag = world?.osmMeta.landmarks.find((l) => l.id === 'waag') ?? { x: 0, z: 0 };
    const out = new THREE.Vector3(Math.sin(2.5536), 0, Math.cos(2.5536));
    const spot = world ? new THREE.Vector3(waag.x + out.x * 30, 0, waag.z + out.z * 30) : DEV_SPOT.clone();
    spot.y = world ? world.heightAt(spot.x, spot.z) : 0;
    group.position.copy(spot);
    // the beast looks at the camera; the camera looks back towards De Waag
    const camDir = out.clone();
    let t = 0;
    let hopT = 0;
    let yaw = Math.atan2(camDir.x, camDir.z);
    const look = new THREE.Vector3();
    const right = new THREE.Vector3();
    return {
      group,
      visual,
      hop() {
        hopT = 0.7;
      },
      update(dt: number) {
        t += dt;
        hopT = Math.max(0, hopT - dt);
        const lift = animateIdle(pose, t, hopT > 0 ? 'cheer' : 'idle');
        pose.position.set(0, lift, 0);
        pose.solve();
        pose.apply(visual.parts);
        visual.update(dt);
        // slow turntable swing toward the camera
        yaw = Math.atan2(camDir.x, camDir.z) + Math.sin(t * 0.45) * 0.9;
        spin.rotation.y = yaw;
        // camera: in front of the beast, the beast on the right third of the screen
        const cam = engine.camera;
        if (cam.fov !== 40) {
          cam.fov = 40;
          cam.updateProjectionMatrix();
        }
        right.set(-camDir.z, 0, camDir.x).multiplyScalar(-1); // screen right when looking along -camDir
        cam.position.copy(spot).addScaledVector(camDir, 4.3 + Math.sin(t * 0.21) * 0.15).addScaledVector(right, -0.2);
        cam.position.y += 1.25 + Math.sin(t * 0.3) * 0.05;
        look.copy(spot).addScaledVector(right, -1.25);
        look.y += 0.95;
        cam.lookAt(look);
        engine.setFocus(spot);
      },
    };
  }
};

function addDevGround(scene: THREE.Scene, physics: { addStaticBox(c: THREE.Vector3, h: THREE.Vector3, r?: number, tag?: string): void }): void {
  const g = new THREE.Mesh(new THREE.CircleGeometry(8, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a8f7a, roughness: 0.95 }));
  g.receiveShadow = true;
  g.position.set(DEV_SPOT.x, -0.002, DEV_SPOT.z);
  scene.add(g);
  physics.addStaticBox(new THREE.Vector3(DEV_SPOT.x, -0.5, DEV_SPOT.z), new THREE.Vector3(8, 0.5, 8), 0, 'ground');
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clampInt(v: string | null, lo: number, hi: number, d: number): number {
  const n = v === null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
}

export default brawl;
