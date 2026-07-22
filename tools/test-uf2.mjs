// Plain-node test for js/uf2.js — run with: node tools/test-uf2.mjs
// Uses the real RP2040 build artifact when present, plus synthesized
// positive/negative cases. No dependencies, no test framework.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseUf2, UF2_BLOCK_SIZE, UF2_MAGIC_START0, UF2_MAGIC_START1, UF2_MAGIC_END,
  UF2_FLAG, RP2040_FAMILY_ID, FLASH_START, FLASH_PAGE_SIZE,
} from '../js/uf2.js';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}

function assertThrows(fn, pattern, msg) {
  try {
    fn();
  } catch (e) {
    assert(pattern.test(e.message), `${msg}: threw "${e.message}", expected match ${pattern}`);
    return;
  }
  throw new Error(`${msg}: did not throw`);
}

/** Build one 512-byte UF2 block; overrides patch individual header fields. */
function mkBlock({
  blockNo, numBlocks, addr,
  payloadSize = FLASH_PAGE_SIZE,
  flags = UF2_FLAG.FAMILY_ID_PRESENT,
  family = RP2040_FAMILY_ID,
  magic0 = UF2_MAGIC_START0, magic1 = UF2_MAGIC_START1, magicEnd = UF2_MAGIC_END,
  fill = blockNo & 0xff,
}) {
  const b = new Uint8Array(UF2_BLOCK_SIZE);
  const d = new DataView(b.buffer);
  d.setUint32(0, magic0, true);
  d.setUint32(4, magic1, true);
  d.setUint32(8, flags, true);
  d.setUint32(12, addr, true);
  d.setUint32(16, payloadSize, true);
  d.setUint32(20, blockNo, true);
  d.setUint32(24, numBlocks, true);
  d.setUint32(28, family, true);
  b.fill(fill, 32, 32 + Math.min(payloadSize, 476));
  d.setUint32(508, magicEnd, true);
  return b;
}

function mkFile(blocks) {
  const out = new Uint8Array(blocks.length * UF2_BLOCK_SIZE);
  blocks.forEach((b, i) => out.set(b, i * UF2_BLOCK_SIZE));
  return out;
}

/** N valid contiguous blocks starting at FLASH_START. */
function validBlocks(n, base = FLASH_START) {
  return Array.from({ length: n }, (_, i) =>
    mkBlock({ blockNo: i, numBlocks: n, addr: base + i * FLASH_PAGE_SIZE }));
}

// ------------------------------------------------------------ real artifact

console.log('real firmware image:');
const realCandidates = [
  '/Users/cmd0s/data/repos/Web3-Pi-UPS-Mono-Repo/Web3-Pi-UPS/firmware-rp2040/.pio/build/pico/firmware.uf2',
  '/Users/cmd0s/data/repos/Web3-Pi-UPS-Mono-Repo/Web3-Pi-UPS/firmware-rp2040/.pio/build/pico_swd/firmware.uf2',
  join(here, 'firmware.uf2'), // allow dropping a copy next to the test
];
const realPath = realCandidates.find((p) => existsSync(p));

if (realPath) {
  const raw = readFileSync(realPath);
  test(`parses ${realPath}`, () => {
    const img = parseUf2(new Uint8Array(raw));
    assert(img.totalBlocks === raw.length / UF2_BLOCK_SIZE, 'block count mismatch');
    assert(img.familyId === RP2040_FAMILY_ID, 'family must be RP2040');
    assert(img.segments.length === 1, `expected one contiguous segment, got ${img.segments.length}`);
    assert(img.minAddr === FLASH_START, `image must start at XIP base, got 0x${img.minAddr.toString(16)}`);
    assert(img.byteCount === img.flashBlocks * FLASH_PAGE_SIZE, 'byte count mismatch');
    assert(img.endAddr === img.minAddr + img.byteCount, 'end address mismatch');
    console.log(`        ${img.totalBlocks} blocks, ${img.byteCount} bytes @ 0x${img.minAddr.toString(16)}`);
  });
  test('real image roundtrip: payload bytes preserved', () => {
    const img = parseUf2(new Uint8Array(raw));
    // block 0 payload must equal segment head
    const first = new Uint8Array(raw.buffer, raw.byteOffset + 32, FLASH_PAGE_SIZE);
    assert(img.segments[0].data.subarray(0, FLASH_PAGE_SIZE).every((v, i) => v === first[i]), 'payload mismatch');
  });
} else {
  console.log('  skip  no build artifact found — synthesized cases only');
}

// ------------------------------------------------------------ positive cases

console.log('synthesized valid images:');
test('minimal 2-block image', () => {
  const img = parseUf2(mkFile(validBlocks(2)));
  assert(img.totalBlocks === 2 && img.flashBlocks === 2 && img.skippedBlocks === 0, 'counts');
  assert(img.segments.length === 1 && img.byteCount === 512, 'single 512-byte segment');
  assert(img.segments[0].data[0] === 0 && img.segments[0].data[256] === 1, 'payload order');
});

test('NOT_MAIN_FLASH blocks are skipped but counted', () => {
  const blocks = [
    mkBlock({ blockNo: 0, numBlocks: 3, addr: FLASH_START }),
    mkBlock({ blockNo: 1, numBlocks: 3, addr: 0x20000000, flags: UF2_FLAG.NOT_MAIN_FLASH }),
    mkBlock({ blockNo: 2, numBlocks: 3, addr: FLASH_START + 256 }),
  ];
  const img = parseUf2(mkFile(blocks));
  assert(img.totalBlocks === 3 && img.flashBlocks === 2 && img.skippedBlocks === 1, 'counts');
  assert(img.segments.length === 1 && img.byteCount === 512, 'flash blocks stay one segment');
});

test('gap between blocks makes two segments', () => {
  const blocks = [
    mkBlock({ blockNo: 0, numBlocks: 2, addr: FLASH_START }),
    mkBlock({ blockNo: 1, numBlocks: 2, addr: FLASH_START + 0x10000 }),
  ];
  const img = parseUf2(mkFile(blocks));
  assert(img.segments.length === 2, 'expected 2 segments');
  assert(img.endAddr === FLASH_START + 0x10000 + 256, 'end address');
});

// ------------------------------------------------------------ negative cases

console.log('rejections:');
test('empty file', () => assertThrows(() => parseUf2(new Uint8Array(0)), /empty/, 'empty'));

test('size not a multiple of 512', () =>
  assertThrows(() => parseUf2(mkFile(validBlocks(1)).subarray(0, 500)), /multiple of 512/, 'truncated'));

test('corrupt start magic', () => {
  const blocks = validBlocks(2);
  blocks[1] = mkBlock({ blockNo: 1, numBlocks: 2, addr: FLASH_START + 256, magic0: 0xdeadbeef });
  assertThrows(() => parseUf2(mkFile(blocks)), /block 1: bad start magic/, 'magic0');
});

test('corrupt end magic', () => {
  const blocks = validBlocks(1);
  blocks[0] = mkBlock({ blockNo: 0, numBlocks: 1, addr: FLASH_START, magicEnd: 0 });
  assertThrows(() => parseUf2(mkFile(blocks)), /bad end magic/, 'magicEnd');
});

test('wrong family (RP2350)', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: FLASH_START, family: 0xe48bff59 })];
  assertThrows(() => parseUf2(mkFile(blocks)), /family 0xE48BFF59.*RP2040/, 'family');
});

test('family flag missing', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: FLASH_START, flags: 0 })];
  assertThrows(() => parseUf2(mkFile(blocks)), /no family ID/, 'family flag');
});

test('file-container flag', () => {
  const blocks = [mkBlock({
    blockNo: 0, numBlocks: 1, addr: FLASH_START,
    flags: UF2_FLAG.FILE_CONTAINER | UF2_FLAG.FAMILY_ID_PRESENT,
  })];
  assertThrows(() => parseUf2(mkFile(blocks)), /file-container/, 'container');
});

test('inconsistent numBlocks', () => {
  const blocks = validBlocks(2);
  blocks[1] = mkBlock({ blockNo: 1, numBlocks: 7, addr: FLASH_START + 256 });
  assertThrows(() => parseUf2(mkFile(blocks)), /numBlocks 7 does not match/, 'numBlocks');
});

test('blockNo out of sequence', () => {
  const blocks = validBlocks(2);
  blocks[1] = mkBlock({ blockNo: 5, numBlocks: 2, addr: FLASH_START + 256 });
  assertThrows(() => parseUf2(mkFile(blocks)), /blockNo 5 out of sequence/, 'blockNo');
});

test('payloadSize 0', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: FLASH_START, payloadSize: 0 })];
  assertThrows(() => parseUf2(mkFile(blocks)), /payloadSize 0 outside/, 'payload 0');
});

test('payloadSize over 476', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: FLASH_START, payloadSize: 500 })];
  assertThrows(() => parseUf2(mkFile(blocks)), /payloadSize 500 outside/, 'payload 500');
});

test('payloadSize not the RP2040 page size', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: FLASH_START, payloadSize: 128 })];
  assertThrows(() => parseUf2(mkFile(blocks)), /must carry exactly 256/, 'payload 128');
});

test('address below the flash window', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: 0x08000000 })];
  assertThrows(() => parseUf2(mkFile(blocks)), /outside the RP2040 flash window/, 'low addr');
});

test('address beyond the flash window', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: 0x11000000 })];
  assertThrows(() => parseUf2(mkFile(blocks)), /outside the RP2040 flash window/, 'high addr');
});

test('unaligned target address', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: FLASH_START + 128 })];
  assertThrows(() => parseUf2(mkFile(blocks)), /not 256-byte aligned/, 'unaligned');
});

test('descending / overlapping addresses', () => {
  const blocks = [
    mkBlock({ blockNo: 0, numBlocks: 2, addr: FLASH_START + 256 }),
    mkBlock({ blockNo: 1, numBlocks: 2, addr: FLASH_START }),
  ];
  assertThrows(() => parseUf2(mkFile(blocks)), /overlaps or precedes/, 'ordering');
});

test('image with only not-main-flash blocks', () => {
  const blocks = [mkBlock({ blockNo: 0, numBlocks: 1, addr: FLASH_START, flags: UF2_FLAG.NOT_MAIN_FLASH })];
  assertThrows(() => parseUf2(mkFile(blocks)), /no flashable blocks/, 'nothing to flash');
});

// ------------------------------------------------------------------ summary

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
