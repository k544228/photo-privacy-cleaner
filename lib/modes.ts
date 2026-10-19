import type { Strength, Style } from './image';

export type Mode = { name: string; style: Style; emoji: string; strength: Strength; precise: boolean };

const KEY = 'ppc-modes-v1';
const MAX_MODES = 10;

export function loadModes(): Mode[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((m) => m && typeof m.name === 'string').slice(0, MAX_MODES) : [];
  } catch {
    return [];
  }
}

export function saveModes(m: Mode[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m.slice(-MAX_MODES)));
  } catch {
    /* 儲存失敗就略過 */
  }
}
