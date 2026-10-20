// Small loading helpers: fetch with an XMLHttpRequest fallback (file:// in Electron), and a
// concurrency-limited task pool so hundreds of chunk files load in parallel without flooding.
import { DATA_URL } from '../../config';

function xhr(url: string, type: 'arraybuffer' | 'text'): Promise<ArrayBuffer | string> {
  return new Promise((resolve, reject) => {
    const r = new XMLHttpRequest();
    r.open('GET', url);
    r.responseType = type;
    r.onload = () => {
      // status 0 = file:// success
      if (r.status === 0 || (r.status >= 200 && r.status < 300)) resolve(r.response as ArrayBuffer | string);
      else reject(new Error(`${url}: HTTP ${r.status}`));
    };
    r.onerror = () => reject(new Error(`${url}: netwerkfout`));
    r.send();
  });
}

/** Loads a file from public/data as ArrayBuffer. */
export async function loadDataBuffer(file: string): Promise<ArrayBuffer> {
  const url = DATA_URL + file;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (e) {
    if (e instanceof TypeError) return (await xhr(url, 'arraybuffer')) as ArrayBuffer;
    throw e;
  }
}

/** Loads and parses a JSON file from public/data. */
export async function loadDataJson<T>(file: string): Promise<T> {
  const url = DATA_URL + file;
  let text: string;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    text = (await xhr(url, 'text')) as string;
  }
  return JSON.parse(text) as T;
}

/** Like loadDataJson but resolves to null when the file is missing or invalid. */
export async function loadDataJsonOptional<T>(file: string): Promise<T | null> {
  try {
    return await loadDataJson<T>(file);
  } catch (e) {
    console.warn(`[world] ${file} niet geladen:`, e);
    return null;
  }
}

/**
 * Runs `fn` over `items` with at most `concurrency` promises in flight. Errors of single items
 * are passed to `onError` (the loop keeps going) so one broken chunk does not stop the city.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  onError: (item: T, err: unknown) => void,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (e) {
        onError(items[i], e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Yields to the event loop (lets the loading screen repaint during long synchronous work). */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
