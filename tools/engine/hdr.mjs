// Minimal Radiance .hdr (RGBE) reader / writer for the engine tools.
// Only the common "-Y <h> +X <w>" orientation is supported (what Poly Haven ships).
// Pure data conversion: never executes anything from the file.

/**
 * Decodes an RGBE .hdr file.
 * @param {Uint8Array} buf
 * @returns {{ width: number, height: number, data: Float32Array }} RGB float data, row 0 = top.
 */
export function readHdr(buf) {
  let pos = 0;
  const readLine = () => {
    let s = '';
    while (pos < buf.length && buf[pos] !== 0x0a) s += String.fromCharCode(buf[pos++]);
    pos++; // skip \n
    return s;
  };
  const magic = readLine();
  if (!magic.startsWith('#?')) throw new Error('not a Radiance HDR file');
  let format = '';
  for (;;) {
    const line = readLine();
    if (line === '') break;
    if (line.startsWith('FORMAT=')) format = line.slice(7).trim();
    if (pos >= buf.length) throw new Error('unexpected end of header');
  }
  if (format && format !== '32-bit_rle_rgbe') throw new Error(`unsupported HDR format ${format}`);
  const res = readLine().trim().split(/\s+/);
  if (res.length !== 4 || res[0] !== '-Y' || res[2] !== '+X') throw new Error(`unsupported orientation ${res.join(' ')}`);
  const height = Number(res[1]);
  const width = Number(res[3]);
  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);

  for (let y = 0; y < height; y++) {
    const rle = width >= 8 && width < 0x8000 && buf[pos] === 2 && buf[pos + 1] === 2 && !(buf[pos + 2] & 0x80);
    if (rle) {
      const w = (buf[pos + 2] << 8) | buf[pos + 3];
      if (w !== width) throw new Error('bad scanline width');
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let count = buf[pos++];
          if (count > 128) {
            count -= 128;
            const v = buf[pos++];
            for (let k = 0; k < count; k++) scan[(x++) * 4 + c] = v;
          } else {
            for (let k = 0; k < count; k++) scan[(x++) * 4 + c] = buf[pos++];
          }
        }
      }
    } else {
      // flat (uncompressed) scanline
      for (let i = 0; i < width * 4; i++) scan[i] = buf[pos++];
    }
    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3];
      const o = (y * width + x) * 3;
      if (e === 0) {
        data[o] = data[o + 1] = data[o + 2] = 0;
      } else {
        const f = Math.pow(2, e - 136); // 2^(e-128) / 256
        data[o] = (scan[x * 4] + 0.5) * f;
        data[o + 1] = (scan[x * 4 + 1] + 0.5) * f;
        data[o + 2] = (scan[x * 4 + 2] + 0.5) * f;
      }
    }
  }
  return { width, height, data };
}

function toRgbe(r, g, b, out, o) {
  const m = Math.max(r, g, b);
  if (m < 1e-32) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  let e = Math.ceil(Math.log2(m));
  let f = 256 / Math.pow(2, e);
  // guard against rounding up to 256
  if (m * f >= 255.5) { e += 1; f *= 0.5; }
  out[o] = Math.min(255, Math.floor(r * f));
  out[o + 1] = Math.min(255, Math.floor(g * f));
  out[o + 2] = Math.min(255, Math.floor(b * f));
  out[o + 3] = e + 128;
}

/** Run-length encodes one channel of a scanline (new-style RLE). */
function encodeChannel(src, width, parts) {
  let x = 0;
  const out = [];
  while (x < width) {
    // find a run of >= 4 equal values
    let runStart = x;
    let runLen = 0;
    while (runStart < width) {
      runLen = 1;
      while (runStart + runLen < width && runLen < 127 && src[runStart + runLen] === src[runStart]) runLen++;
      if (runLen >= 4) break;
      runStart += runLen;
    }
    if (runLen < 4) runStart = width;
    // literals before the run
    while (x < runStart) {
      const n = Math.min(128, runStart - x);
      out.push(n);
      for (let k = 0; k < n; k++) out.push(src[x + k]);
      x += n;
    }
    if (runStart < width) {
      out.push(128 + runLen, src[runStart]);
      x = runStart + runLen;
    }
  }
  parts.push(Uint8Array.from(out));
}

/**
 * Encodes RGB float data (row 0 = top) as an RLE .hdr file.
 * @returns {Uint8Array}
 */
export function writeHdr(width, height, data) {
  const parts = [];
  const header = `#?RADIANCE\n# Alkmaar Drive (tools/engine)\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  parts.push(new TextEncoder().encode(header));
  const rgbe = new Uint8Array(width * 4);
  const ch = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      toRgbe(data[o], data[o + 1], data[o + 2], rgbe, x * 4);
    }
    parts.push(Uint8Array.from([2, 2, (width >> 8) & 0xff, width & 0xff]));
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < width; x++) ch[x] = rgbe[x * 4 + c];
      encodeChannel(ch, width, parts);
    }
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
