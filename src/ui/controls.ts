// Controls overview (keyboard + Xbox-style controller) shown in Instellingen › Besturing.
// Keep in sync with src/core/input.ts (Vehicle module) and the UI's own keys (M, F3).
import { h } from './dom';
import { padGlyph } from './icons';

type Pad = Parameters<typeof padGlyph>[0];

export const CONTROLS: { action: string; kb: string[]; pad: Pad[]; padNote?: string }[] = [
  { action: 'Gas geven', kb: ['W', '↑'], pad: ['RT'] },
  { action: 'Remmen / achteruit', kb: ['S', '↓'], pad: ['LT'] },
  { action: 'Sturen', kb: ['A', 'D', '←', '→'], pad: ['LS'] },
  { action: 'Handrem', kb: ['Spatie'], pad: ['A'] },
  { action: 'Opschakelen', kb: ['Shift'], pad: ['RB'] },
  { action: 'Terugschakelen', kb: ['Ctrl'], pad: ['LB'] },
  { action: 'Terug op de weg', kb: ['R'], pad: ['B'] },
  { action: 'Koplampen aan/uit', kb: ['L'], pad: ['X'] },
  { action: 'Claxon', kb: ['H'], pad: ['LS'], padNote: 'indrukken' },
  { action: 'Camera wisselen', kb: ['C'], pad: ['Y'] },
  { action: 'Stadskaart', kb: ['M'], pad: ['View'] },
  { action: 'Pauzemenu', kb: ['Esc'], pad: ['Menu'] },
  { action: 'Prestatiemeter', kb: ['F3'], pad: [] },
];

export function controlsTable(): HTMLElement {
  const table = h('div', 'ad-controls');
  table.append(
    h('div', 'ad-controls-head', h('span', null, 'Actie'), h('span', null, 'Toetsenbord'), h('span', null, 'Controller')),
  );
  for (const c of CONTROLS) {
    const kb = h('span', 'ad-controls-keys');
    c.kb.forEach((k) => kb.append(h('kbd', 'ad-key', k)));
    const pad = h('span', 'ad-controls-keys');
    pad.innerHTML = c.pad.length ? c.pad.map((p) => padGlyph(p)).join('') : '<span class="ad-dash">—</span>';
    if (c.padNote) pad.append(h('span', 'ad-pad-note', c.padNote));
    table.append(h('div', 'ad-controls-row', h('span', 'ad-controls-action', c.action), kb, pad));
  }
  return table;
}
