// Fight HUD: colour name tags above the beasts (fading), outs/KO feed, round + score strip,
// countdown, "UIT!" stamps, winner banners, spectator hint, the cheese-wheel scoreboard and
// confetti for the match winner.
import * as THREE from 'three';
import { fromHTML, h } from '../../ui/dom';
import type { Fighter } from '../types';
import { cheeseWheelSvg } from './icons';

export interface Hud {
  show(): void;
  hide(): void;
  setFighters(fighters: Fighter[], round: number, arenaName: string): void;
  refreshStrip(): void;
  /** `visible` (optional) hides tags of beasts behind walls (head position given). */
  updateTags(
    camera: THREE.PerspectiveCamera,
    mode: 'altijd' | 'vervagen' | 'uit',
    roundTime: number,
    visible?: (f: Fighter, head: THREE.Vector3) => boolean,
  ): void;
  feed(text: string, colour: string): void;
  countdown(text: string, go: boolean): void;
  stamp(text: string, world: THREE.Vector3, camera: THREE.PerspectiveCamera): void;
  banner(main: string, sub?: string, colour?: string): void;
  clearBanner(): void;
  spectate(text: string | null): void;
  scoreboard(fighters: Fighter[], winsToWin: number, winner: Fighter | null, title: string, footer: string): void;
  setScoreFooter(text: string): void;
  hideScoreboard(): void;
  confetti(on: boolean): void;
  /** Hide the feed + name tags (winner zoom, scoreboard, celebration). */
  setQuiet(on: boolean): void;
  /** Controls hint bar at the bottom ([key, action] pairs), null hides it. */
  hint(items: readonly (readonly [string, string])[] | null): void;
  /** Flash a fighter's name tag (got hit). */
  ping(f: Fighter): void;
  /** Pulsing hazard warning under the score strip (e.g. a low bridge); null hides it. */
  warn(text: string | null): void;
}

export function createHud(root: HTMLElement): Hud {
  const el = h('div', 'ga-hud ga-hidden');
  const tagsLayer = h('div', null);
  const strip = h('div', 'ga-strip');
  const feedEl = h('div', 'ga-feed');
  const centre = h('div', 'ga-center');
  const stampLayer = h('div', null);
  const bannerLayer = h('div', null);
  const spect = h('div', 'ga-spectate ga-hidden');
  const scoreLayer = h('div', null);
  const confettiLayer = h('div', 'ga-confetti ga-hidden');
  const hintEl = h('div', 'ga-hints ga-fight-hints ga-hint-off');
  const warnEl = h('div', 'ga-warn ga-hidden');
  let warnText = '';
  el.append(tagsLayer, stampLayer, strip, feedEl, centre, warnEl, bannerLayer, spect, scoreLayer, confettiLayer, hintEl);
  root.appendChild(el);

  type Tag = { f: Fighter; el: HTMLElement; ping: number; x: number; y: number; s: number; d: number; w: number; off: number };
  let tags: Tag[] = [];
  const placed: Tag[] = [];
  let chips: { f: Fighter; el: HTMLElement; wins: HTMLElement }[] = [];
  let scoreFoot: HTMLElement | null = null;
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();

  const proj = { x: 0, y: 0, ok: false, depth: 0 };
  function project(p: THREE.Vector3, camera: THREE.PerspectiveCamera, W = el.clientWidth, H = el.clientHeight) {
    w.copy(p).project(camera);
    proj.x = (w.x * 0.5 + 0.5) * W;
    proj.y = (-w.y * 0.5 + 0.5) * H;
    proj.ok = w.z < 1 && w.z > -1;
    proj.depth = camera.position.distanceTo(p);
    return proj;
  }

  const hud: Hud = {
    show() {
      el.classList.remove('ga-hidden');
    },
    hide() {
      el.classList.add('ga-hidden');
      el.classList.remove('ga-quiet');
      hud.clearBanner();
      hud.hideScoreboard();
      hud.confetti(false);
      hud.spectate(null);
      centre.replaceChildren();
      feedEl.replaceChildren();
      stampLayer.replaceChildren();
      hintEl.classList.add('ga-hint-off');
    },
    setFighters(list, round, arenaName) {
      tagsLayer.replaceChildren();
      tags = list.map((f) => {
        const t = h('div', `ga-tag${f.isBot ? '' : ' ga-me'}`, f.name);
        t.style.borderBottomColor = f.colour;
        if (!f.isBot) {
          // "Jij" marker above the human during the countdown and the first seconds of a round
          const m = h('span', 'ga-me-mark', 'Jij');
          m.style.background = f.colour;
          t.appendChild(m);
        }
        tagsLayer.appendChild(t);
        return { f, el: t, ping: 0, x: 0, y: 0, s: 1, d: 0, w: 0, off: 0 };
      });
      strip.replaceChildren(h('span', 'ga-strip-round', `Ronde ${round}`), h('span', null, arenaName));
      chips = list.map((f) => {
        const wins = h('span', null, String(f.wins));
        const dot = h('span', 'ga-dot');
        dot.style.background = f.colour;
        const svg = fromHTML<SVGSVGElement>(cheeseWheelSvg('ga-cheese-mini'));
        svg.setAttribute('style', 'width:1.35em;height:1em');
        const c = h('span', 'ga-chip', dot, h('span', null, f.name), svg, wins);
        strip.appendChild(c);
        return { f, el: c, wins };
      });
    },
    refreshStrip() {
      for (const c of chips) {
        c.wins.textContent = String(c.f.wins);
        c.el.classList.toggle('ga-out', c.f.out);
      }
    },
    updateTags(camera, mode, roundTime, visible) {
      const W = el.clientWidth;
      const H = el.clientHeight;
      for (const t of tags) {
        const b = t.f.beast;
        if (!b || mode === 'uit' || t.f.out) {
          t.el.style.opacity = '0';
          continue;
        }
        b.partPosition('head', v);
        if (visible && !visible(t.f, v)) {
          t.el.style.opacity = '0';
          continue;
        }
        v.y += 0.42;
        const p = project(v, camera, W, H);
        if (!p.ok) {
          t.el.style.opacity = '0';
          continue;
        }
        t.ping = Math.max(0, t.ping - 1 / 60);
        let o = 1;
        if (mode === 'vervagen') o = roundTime < 4 ? 1 : t.f.isBot ? 0.35 : 0.8;
        if (t.ping > 0) o = 1;
        const s = Math.max(t.f.isBot ? 0.6 : 0.85, Math.min(1.15, 9 / Math.max(1, p.depth)));
        if (!t.f.isBot) {
          const intro = roundTime < 3.5;
          if (intro !== t.el.classList.contains('ga-intro')) t.el.classList.toggle('ga-intro', intro);
        }
        t.el.style.opacity = o.toFixed(2);
        t.el.classList.toggle('ga-ko', b.state === 'knockedOut');
        t.x = p.x;
        t.y = p.y;
        t.s = s;
        t.d = p.depth;
        t.w = (t.f.name.length * 7 + 18) * s;
        placed.push(t);
      }
      // keep tags readable when beasts bunch up: nearer tags keep their spot, the others move up
      placed.sort((a, b) => a.d - b.d);
      for (let i = 0; i < placed.length; i++) {
        const a = placed[i];
        let lift = 0;
        for (let pass = 0; pass < 3; pass++) {
          let moved = false;
          for (let j = 0; j < i; j++) {
            const q = placed[j];
            const hgt = 19 * Math.max(a.s, q.s);
            const dy = q.y - q.off - (a.y - lift);
            if (Math.abs(a.x - q.x) < (a.w + q.w) / 2 && Math.abs(dy) < hgt) {
              lift += hgt - dy;
              moved = true;
            }
          }
          if (!moved) break;
        }
        a.off += (Math.min(lift, 80) - a.off) * 0.25;
        a.el.style.transform = `translate3d(${a.x.toFixed(1)}px, ${(a.y - a.off).toFixed(1)}px, 0) translate(-50%, -100%) scale(${a.s.toFixed(2)})`;
      }
      placed.length = 0;
    },
    hint(items) {
      if (!items) {
        hintEl.classList.add('ga-hint-off');
        return;
      }
      hintEl.replaceChildren(...items.map(([k, a]) => h('span', null, h('span', 'ga-key', k), a)));
      hintEl.classList.remove('ga-hint-off');
    },
    feed(text, colour) {
      const dot = h('span', 'ga-dot');
      dot.style.background = colour;
      const item = h('div', 'ga-feed-item', dot, text);
      feedEl.prepend(item);
      while (feedEl.children.length > 5) feedEl.lastElementChild?.remove();
      window.setTimeout(() => item.classList.add('ga-gone'), 4200);
      window.setTimeout(() => item.remove(), 4900);
    },
    countdown(text, go) {
      const c = h('div', `ga-count${go ? ' ga-go' : ''}`, text);
      centre.replaceChildren(c);
      window.setTimeout(() => c.remove(), go ? 1150 : 1000);
    },
    stamp(text, world, camera) {
      const p = project(world, camera);
      if (!p.ok) return;
      const s = h('div', 'ga-stamp', text);
      s.style.left = `${Math.max(80, Math.min(el.clientWidth - 80, p.x))}px`;
      s.style.top = `${Math.max(80, Math.min(el.clientHeight - 60, p.y))}px`;
      stampLayer.appendChild(s);
      window.setTimeout(() => s.remove(), 1600);
    },
    banner(main, sub, colour) {
      const m = h('div', 'ga-banner-main', main);
      if (colour) m.style.color = colour;
      const b = h('div', 'ga-banner', m, sub ? h('div', null, h('span', 'ga-banner-sub', sub)) : null);
      bannerLayer.replaceChildren(b);
    },
    clearBanner() {
      bannerLayer.replaceChildren();
    },
    warn(text) {
      if ((text ?? '') === warnText) return;
      warnText = text ?? '';
      warnEl.classList.toggle('ga-hidden', !text);
      if (text) warnEl.textContent = text;
    },
    spectate(text) {
      spect.classList.toggle('ga-hidden', !text);
      if (text) spect.textContent = text;
    },
    scoreboard(list, winsToWin, winner, title, footer) {
      const sorted = [...list].sort((a, b) => b.wins - a.wins || a.index - b.index);
      const rows = sorted.map((f, i) => {
        const dot = h('span', 'ga-dot');
        dot.style.background = f.colour;
        const cheeses = h('div', 'ga-cheeses');
        for (let k = 0; k < winsToWin; k++) {
          const filled = k < f.wins;
          const isNew = winner === f && k === f.wins - 1;
          cheeses.insertAdjacentHTML('beforeend', cheeseWheelSvg(`ga-cheese${filled ? '' : ' ga-empty'}${isNew ? ' ga-new' : ''}`));
        }
        const r = h(
          'div',
          `ga-score-row${winner === f ? ' ga-win' : ''}`,
          dot,
          h('div', 'ga-score-name', f.name, h('small', null, f.isBot ? 'Bot' : 'Jij')),
          cheeses,
        );
        r.style.animationDelay = `${0.08 * i}s`;
        return r;
      });
      scoreFoot = h('div', 'ga-score-foot', footer);
      const card = h('div', 'ga-score ga-card', h('div', 'ga-modal-title', title), ...rows, scoreFoot);
      scoreLayer.replaceChildren(card);
    },
    setScoreFooter(text) {
      if (scoreFoot) scoreFoot.textContent = text;
    },
    hideScoreboard() {
      scoreLayer.replaceChildren();
      scoreFoot = null;
    },
    confetti(on) {
      confettiLayer.classList.toggle('ga-hidden', !on);
      if (!on) {
        confettiLayer.replaceChildren();
        return;
      }
      const colours = ['#f6c343', '#d52b1e', '#ffffff', '#f07f1e', '#2f6fb5', '#4c9a3a'];
      for (let i = 0; i < 90; i++) {
        const c = document.createElement('i');
        c.style.left = `${Math.random() * 100}%`;
        c.style.background = colours[i % colours.length];
        c.style.animationDuration = `${2.6 + Math.random() * 2.8}s`;
        c.style.animationDelay = `${-Math.random() * 5}s`;
        c.style.setProperty('--dx', `${(Math.random() - 0.5) * 16}em`);
        c.style.setProperty('--rot', `${(Math.random() - 0.5) * 1440}deg`);
        c.style.transform = `scale(${0.6 + Math.random() * 0.7})`;
        confettiLayer.appendChild(c);
      }
    },
    setQuiet(on) {
      el.classList.toggle('ga-quiet', on);
      if (on) feedEl.replaceChildren();
    },
    ping(f) {
      const t = tags.find((x) => x.f === f);
      if (t) t.ping = 1.2;
    },
  };
  return hud;
}
