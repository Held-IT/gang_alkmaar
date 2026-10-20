// Spatial hash of every moving traffic participant (AI cars, cyclists, pedestrians, the player),
// rebuilt once per frame. Typed arrays + linked cell lists: no allocations after construction.

export const KIND_CAR = 0;
export const KIND_BIKE = 1;
export const KIND_PED = 2;
export const KIND_PLAYER = 3;

export class AgentGrid {
  readonly capacity: number;
  count = 0;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** unit heading vector */
  readonly dx: Float32Array;
  readonly dz: Float32Array;
  /** speed along the heading (m/s) */
  readonly v: Float32Array;
  readonly halfLen: Float32Array;
  readonly halfW: Float32Array;
  readonly kind: Uint8Array;
  /** owner-defined reference (agent object index) */
  readonly ref: Int32Array;
  private readonly next: Int32Array;
  private readonly head: Int32Array;
  private readonly mask: number;
  private readonly inv: number;

  constructor(capacity: number, cellSize = 8, hashBits = 12) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.dx = new Float32Array(capacity);
    this.dz = new Float32Array(capacity);
    this.v = new Float32Array(capacity);
    this.halfLen = new Float32Array(capacity);
    this.halfW = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.ref = new Int32Array(capacity);
    this.next = new Int32Array(capacity);
    this.head = new Int32Array(1 << hashBits).fill(-1);
    this.mask = (1 << hashBits) - 1;
    this.inv = 1 / cellSize;
  }

  private cell(cx: number, cz: number): number {
    return (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) & this.mask;
  }

  clear(): void {
    this.head.fill(-1);
    this.count = 0;
  }

  /** Adds an agent; returns its slot or -1 when full. */
  add(kind: number, ref: number, x: number, z: number, dx: number, dz: number, v: number, halfLen: number, halfW: number): number {
    const i = this.count;
    if (i >= this.capacity) return -1;
    this.count++;
    this.x[i] = x;
    this.z[i] = z;
    this.dx[i] = dx;
    this.dz[i] = dz;
    this.v[i] = v;
    this.halfLen[i] = halfLen;
    this.halfW[i] = halfW;
    this.kind[i] = kind;
    this.ref[i] = ref;
    const c = this.cell(Math.floor(x * this.inv), Math.floor(z * this.inv));
    this.next[i] = this.head[c];
    this.head[c] = i;
    return i;
  }

  /** Collects slots in cells touching the circle (x, z, r) into out; returns the count. */
  query(x: number, z: number, r: number, out: Int32Array): number {
    const inv = this.inv;
    const cx0 = Math.floor((x - r) * inv);
    const cx1 = Math.floor((x + r) * inv);
    const cz0 = Math.floor((z - r) * inv);
    const cz1 = Math.floor((z + r) * inv);
    let n = 0;
    const max = out.length;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        let i = this.head[this.cell(cx, cz)];
        while (i >= 0) {
          // hash collisions can bring far cells: cheap reject
          const ddx = this.x[i] - x;
          const ddz = this.z[i] - z;
          if (ddx * ddx + ddz * ddz <= (r + 6) * (r + 6) && n < max) out[n++] = i;
          i = this.next[i];
        }
      }
    }
    return n;
  }
}
