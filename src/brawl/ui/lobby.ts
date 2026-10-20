// Lobby: name, beast colour + costume (live preview beast rendered by the scene), arena cards,
// number of bots, difficulty, wins to win; keyboard + gamepad navigation through ./nav.
import { button, h } from '../../ui/dom';
import type { ArenaId } from '../contracts';
import { DIFFICULTIES } from '../prefs';
import type { BrawlModules, LobbyChoices } from '../types';
import { arenaArt, logoHtml } from './icons';
import type { Menus } from './menus';
import type { Nav, NavHandle, NavItem } from './nav';

export interface LobbyHandlers {
  onChange(c: LobbyChoices): void;
  onStart(c: LobbyChoices): void;
  onQuit(): void;
  onClick(): void;
}

export interface Lobby {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  readonly choices: LobbyChoices;
}

export function createLobby(
  root: HTMLElement,
  nav: Nav,
  menus: Menus,
  mods: BrawlModules,
  choices: LobbyChoices,
  handlers: LobbyHandlers,
): Lobby {
  let el: HTMLElement | null = null;
  let handle: NavHandle | null = null;
  const changed = () => handlers.onChange(choices);

  function stepper(get: () => string, sub: () => string, step: (d: number) => void) {
    const val = h('div', 'ga-step-value');
    const subEl = h('div', 'ga-step-sub');
    const l = button('ga-arrow', '◀');
    const r = button('ga-arrow', '▶');
    const sync = () => {
      val.textContent = get();
      subEl.textContent = sub();
    };
    l.addEventListener('click', () => (step(-1), sync(), handlers.onClick()));
    r.addEventListener('click', () => (step(1), sync(), handlers.onClick()));
    sync();
    const box = h('div', null, h('div', 'ga-stepper', l, val, r), subEl);
    return { el: box, left: () => (step(-1), sync()), right: () => (step(1), sync()), sync };
  }

  function build(): HTMLElement {
    const items: NavItem[] = [];
    const row = (label: string, control: HTMLElement, extra?: HTMLElement) => {
      const r = h('div', 'ga-row', h('div', 'ga-row-label', label), control);
      if (extra) r.appendChild(extra);
      return r;
    };
    // name
    const input = h('input', 'ga-input');
    input.maxLength = 14;
    input.value = choices.name;
    input.spellcheck = false;
    input.addEventListener('input', () => {
      choices.name = input.value.trim() || 'Speler';
      tagName.textContent = choices.name;
      changed();
    });
    const rName = row('Naam', input);
    items.push({ el: rName, row: 0, input });
    // colour
    const sw = h('div', 'ga-swatches');
    const swBtns = mods.colours.map((c) => {
      const b = button('ga-swatch');
      b.style.background = c.hex;
      b.title = c.name;
      b.addEventListener('click', () => {
        choices.colour = c.hex;
        syncSw();
        changed();
        handlers.onClick();
      });
      sw.appendChild(b);
      return b;
    });
    const colourName = h('div', 'ga-step-sub');
    const syncSw = () => {
      swBtns.forEach((b, i) => b.classList.toggle('ga-sel', mods.colours[i].hex.toLowerCase() === choices.colour.toLowerCase()));
      colourName.textContent = mods.colours.find((c) => c.hex.toLowerCase() === choices.colour.toLowerCase())?.name ?? '';
    };
    syncSw();
    const stepColour = (d: number) => {
      const n = mods.colours.length;
      let i = mods.colours.findIndex((c) => c.hex.toLowerCase() === choices.colour.toLowerCase());
      i = (Math.max(0, i) + d + n) % n;
      choices.colour = mods.colours[i].hex;
      syncSw();
      changed();
    };
    const rColour = row('Kleur', h('div', null, sw, colourName));
    items.push({ el: rColour, row: 1, left: () => stepColour(-1), right: () => stepColour(1) });
    // costume
    const costumeIdx = () => Math.max(0, mods.costumes.findIndex((c) => c.id === choices.costume));
    const cost = stepper(
      () => mods.costumes[costumeIdx()]?.name ?? '',
      () => mods.costumes[costumeIdx()]?.description ?? '',
      (d) => {
        const n = mods.costumes.length;
        choices.costume = mods.costumes[(costumeIdx() + d + n) % n].id;
        tagSub.textContent = mods.costumes[costumeIdx()]?.name ?? '';
        changed();
      },
    );
    const rCost = row('Kostuum', cost.el);
    items.push({ el: rCost, row: 2, left: cost.left, right: cost.right });
    // arena
    const cards = h('div', 'ga-arenas');
    const desc = h('div', 'ga-arena-desc');
    const cardEls = mods.arenas.map((a) => {
      const c = button('ga-arena');
      const img = new Image();
      img.alt = '';
      img.onerror = () => {
        img.remove();
        c.insertAdjacentHTML('afterbegin', arenaArt(a.id));
      };
      img.src = `assets/brawl/arena_${a.id}.jpg`;
      c.append(img, h('div', 'ga-arena-name', a.name));
      c.addEventListener('click', () => {
        choices.arena = a.id;
        syncArena();
        changed();
        handlers.onClick();
      });
      cards.appendChild(c);
      return c;
    });
    const syncArena = () => {
      cardEls.forEach((c, i) => c.classList.toggle('ga-sel', mods.arenas[i].id === choices.arena));
      desc.textContent = mods.arenas.find((a) => a.id === choices.arena)?.description ?? '';
    };
    syncArena();
    const stepArena = (d: number) => {
      const n = mods.arenas.length;
      const i = Math.max(0, mods.arenas.findIndex((a) => a.id === choices.arena));
      choices.arena = mods.arenas[(i + d + n) % n].id as ArenaId;
      syncArena();
      changed();
    };
    const rArena = row('Arena', cards, desc);
    items.push({ el: rArena, row: 3, left: () => stepArena(-1), right: () => stepArena(1) });
    // bots
    const bots = stepper(
      () => `${choices.bots} ${choices.bots === 1 ? 'bot' : 'bots'}`,
      () => (choices.bots >= 4 ? 'Lekker druk!' : choices.bots === 1 ? 'Eén tegen één' : 'Gezellig knokken'),
      (d) => {
        choices.bots = Math.max(1, Math.min(5, choices.bots + d));
        changed();
      },
    );
    const rBots = row('Tegenstanders', bots.el);
    items.push({ el: rBots, row: 4, left: bots.left, right: bots.right });
    // difficulty
    const seg = h('div', 'ga-seg');
    const segBtns = DIFFICULTIES.map((d) => {
      const b = button('', d.name);
      b.addEventListener('click', () => {
        choices.difficulty = d.id;
        syncSeg();
        changed();
        handlers.onClick();
      });
      seg.appendChild(b);
      return b;
    });
    const syncSeg = () => segBtns.forEach((b, i) => b.classList.toggle('ga-sel', DIFFICULTIES[i].id === choices.difficulty));
    syncSeg();
    const stepDiff = (d: number) => {
      const i = DIFFICULTIES.findIndex((x) => x.id === choices.difficulty);
      choices.difficulty = DIFFICULTIES[Math.max(0, Math.min(2, i + d))].id;
      syncSeg();
      changed();
    };
    const rDiff = row('Niveau', seg);
    items.push({ el: rDiff, row: 5, left: () => stepDiff(-1), right: () => stepDiff(1) });
    // wins
    const wins = stepper(
      () => `${choices.wins} ${choices.wins === 1 ? 'kaas' : 'kazen'}`,
      () => `Wie het eerst ${choices.wins === 1 ? 'één ronde' : `${choices.wins} rondes`} wint`,
      (d) => {
        choices.wins = Math.max(1, Math.min(10, choices.wins + d));
        changed();
      },
    );
    const rWins = row('Winnen met', wins.el);
    items.push({ el: rWins, row: 6, left: wins.left, right: wins.right });
    // actions
    const start = button('ga-btn ga-btn-big', 'Vechten!');
    start.addEventListener('click', () => handlers.onStart(choices));
    items.push({ el: start, row: 7, confirm: () => handlers.onStart(choices) });
    const small: [string, () => void][] = [
      ['Besturing', () => menus.openControls()],
      ['Instellingen', () => menus.openSettings()],
      ['Credits', () => menus.openCredits()],
      ['Afsluiten', () => handlers.onQuit()],
    ];
    const smallBtns = small.map(([label, fn]) => {
      const b = button('ga-btn', label);
      b.addEventListener('click', () => (handlers.onClick(), fn()));
      items.push({ el: b, row: 8, confirm: () => (handlers.onClick(), fn()) });
      return b;
    });
    const panel = h(
      'div',
      'ga-lobby-panel ga-card',
      rName,
      rColour,
      rCost,
      rArena,
      rBots,
      rDiff,
      rWins,
      h('div', 'ga-lobby-actions', start, h('div', 'ga-small-btns', ...smallBtns)),
    );
    const logo = h('div', 'ga-lobby-logo');
    logo.innerHTML = logoHtml();
    const tagName = h('div', 'ga-preview-name', choices.name);
    const tagSub = h('div', 'ga-preview-sub', mods.costumes[costumeIdx()]?.name ?? '');
    const hints = h('div', 'ga-hints');
    hints.innerHTML =
      `<span><span class="ga-key">↑↓</span>kiezen</span><span><span class="ga-key">←→</span>wijzigen</span>` +
      `<span><span class="ga-key">Enter</span>/ <span class="ga-key">A</span>bevestigen</span>` +
      `<span><span class="ga-key">Esc</span>/ <span class="ga-key">B</span>terug</span>`;
    const lobby = h('div', 'ga-lobby', logo, panel, h('div', 'ga-preview-tag', tagName, h('div', null, tagSub)), hints);
    handle = nav.push({ items, onMove: handlers.onClick }, 7);
    return lobby;
  }

  return {
    get visible() {
      return el !== null;
    },
    show() {
      if (el) return;
      el = build();
      root.appendChild(el);
    },
    hide() {
      handle?.close();
      handle = null;
      el?.remove();
      el = null;
    },
    get choices() {
      return choices;
    },
  };
}
