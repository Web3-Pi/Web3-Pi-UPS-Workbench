// MD5 (RFC 1321) over a byte array — needed for the esptool-js flash verify:
// the ESP32 ROM/stub reports flash digests as MD5 (ESP_SPI_FLASH_MD5) and
// Web Crypto's crypto.subtle deliberately does not implement MD5. Not used
// for anything security-relevant — integrity check of a just-written flash
// region only. Tested against the RFC 1321 vectors in tools/test-wups-fw.mjs.

// Per-round left-rotate amounts (RFC 1321 §3.4).
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(|sin(i+1)| * 2^32) — the RFC's T table.
const K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

/**
 * MD5 digest of a byte array.
 * @param {Uint8Array} bytes input
 * @returns {string} 32-char lowercase hex digest
 */
export function md5Hex(bytes) {
  // Pad: 0x80, zeros to 56 mod 64, then the bit length as u64 LE.
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((Math.floor((bytes.length + 8) / 64) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  // JS bit length fits in 2^53; split into low/high u32 for the LE u64.
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j += 1) m[j] = dv.getUint32(off + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[i] + m[g]) >>> 0, S[i])) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  // Digest = A,B,C,D as little-endian bytes, hex-encoded.
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return Array.from(out, (v) => v.toString(16).padStart(2, '0')).join('');
}
