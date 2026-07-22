// UF2 firmware-container parsing + validation (RP2040 target).
//
// Everything is validated up front so the flasher never has to touch USB
// with a questionable image: block magics, 512-byte structure, payload
// sizes, blockNo/numBlocks sequencing, family ID, flash address window,
// alignment and ordering. Any violation throws with a precise message.
//
// Format spec: https://github.com/microsoft/uf2 (README.md, "File format")
// and the RP2040-side mirror in pico-sdk
// src/common/boot_uf2_headers/include/boot/uf2.h.

// Block layout — https://github.com/microsoft/uf2/blob/master/README.md:
//   0  u32 magicStart0  0x0A324655 ("UF2\n")
//   4  u32 magicStart1  0x9E5D5157
//   8  u32 flags
//  12  u32 targetAddr
//  16  u32 payloadSize  (number of bytes used in data, often 256)
//  20  u32 blockNo      (sequential, starts at 0)
//  24  u32 numBlocks    (total number of blocks in file)
//  28  u32 fileSize / familyID
//  32  u8[476] data (zero padded)
// 508  u32 magicEnd     0x0AB16F30
export const UF2_BLOCK_SIZE = 512;
export const UF2_DATA_MAX = 476;
export const UF2_MAGIC_START0 = 0x0a324655;
export const UF2_MAGIC_START1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;

// Flags — https://github.com/microsoft/uf2/blob/master/README.md ("Flags"):
export const UF2_FLAG = {
  NOT_MAIN_FLASH: 0x00000001,
  FILE_CONTAINER: 0x00001000,
  FAMILY_ID_PRESENT: 0x00002000,
  MD5_PRESENT: 0x00004000,
  EXTENSION_TAGS_PRESENT: 0x00008000,
};

// Family IDs — https://github.com/microsoft/uf2/blob/master/utils/uf2families.json
// (same values in pico-sdk boot/uf2.h).
export const RP2040_FAMILY_ID = 0xe48bff56;
export const FAMILY_NAMES = {
  0xe48bff55: 'CYW43 firmware',
  0xe48bff56: 'RP2040',
  0xe48bff57: 'RP2XXX absolute',
  0xe48bff58: 'RP2XXX data partition',
  0xe48bff59: 'RP2350 Arm-S',
  0xe48bff5a: 'RP2350 RISC-V',
  0xe48bff5b: 'RP2350 Arm-NS',
};

// RP2040 flash window: XIP_BASE 0x10000000 (pico-sdk
// src/rp2040/hardware_regs/include/hardware/regs/addressmap.h), end of the
// mapped flash region 0x11000000 (picotool model/addresses.h FLASH_START /
// FLASH_END_RP2040).
export const FLASH_START = 0x10000000;
export const FLASH_END = 0x11000000;

// The RP2040 BOOTSEL flash geometry the PICOBOOT host must respect:
// 256-byte program pages, 4096-byte erase sectors (picotool
// picoboot_connection/picoboot_connection.h PAGE_SIZE / FLASH_SECTOR_ERASE_SIZE).
export const FLASH_PAGE_SIZE = 256;
export const FLASH_SECTOR_SIZE = 4096;

const hex = (v) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/**
 * Parse and validate a UF2 file for RP2040 flashing.
 *
 * @param {ArrayBuffer|Uint8Array} input raw file contents
 * @returns {{
 *   totalBlocks: number, flashBlocks: number, skippedBlocks: number,
 *   familyId: number, familyName: string,
 *   segments: {addr: number, data: Uint8Array}[],
 *   byteCount: number, minAddr: number, endAddr: number,
 * }} `segments` are contiguous, page-aligned, strictly ascending runs of
 *     flash data (usually exactly one).
 * @throws {Error} on any structural or semantic violation.
 */
export function parseUf2(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new Error('empty file');
  if (bytes.length % UF2_BLOCK_SIZE !== 0) {
    throw new Error(`file size ${bytes.length} is not a multiple of ${UF2_BLOCK_SIZE} — not a UF2 file`);
  }
  const totalBlocks = bytes.length / UF2_BLOCK_SIZE;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const runs = [];
  let familyId = null;
  let flashBlocks = 0;
  let skippedBlocks = 0;
  let prevEnd = 0; // exclusive end of the previous flash block

  for (let i = 0; i < totalBlocks; i += 1) {
    const off = i * UF2_BLOCK_SIZE;
    const at = (msg) => new Error(`block ${i}: ${msg}`);

    const magic0 = view.getUint32(off + 0, true);
    const magic1 = view.getUint32(off + 4, true);
    const magicEnd = view.getUint32(off + 508, true);
    if (magic0 !== UF2_MAGIC_START0) throw at(`bad start magic ${hex(magic0)} (expected ${hex(UF2_MAGIC_START0)})`);
    if (magic1 !== UF2_MAGIC_START1) throw at(`bad second magic ${hex(magic1)} (expected ${hex(UF2_MAGIC_START1)})`);
    if (magicEnd !== UF2_MAGIC_END) throw at(`bad end magic ${hex(magicEnd)} (expected ${hex(UF2_MAGIC_END)})`);

    const flags = view.getUint32(off + 8, true);
    const targetAddr = view.getUint32(off + 12, true);
    const payloadSize = view.getUint32(off + 16, true);
    const blockNo = view.getUint32(off + 20, true);
    const numBlocks = view.getUint32(off + 24, true);
    const family = view.getUint32(off + 28, true);

    if (blockNo !== i) throw at(`blockNo ${blockNo} out of sequence (expected ${i})`);
    if (numBlocks !== totalBlocks) throw at(`numBlocks ${numBlocks} does not match file block count ${totalBlocks}`);
    if (payloadSize === 0 || payloadSize > UF2_DATA_MAX) {
      throw at(`payloadSize ${payloadSize} outside 1..${UF2_DATA_MAX}`);
    }

    if (flags & UF2_FLAG.NOT_MAIN_FLASH) {
      skippedBlocks += 1; // comment/debug block — validated but not flashed
      continue;
    }
    if (flags & UF2_FLAG.FILE_CONTAINER) {
      throw at('file-container UF2 (flag 0x1000) — not a firmware image');
    }
    if (!(flags & UF2_FLAG.FAMILY_ID_PRESENT)) {
      throw at('no family ID (flag 0x2000 missing) — refusing to flash an untargeted image');
    }
    if (family !== RP2040_FAMILY_ID) {
      const name = FAMILY_NAMES[family] ?? 'unknown family';
      throw at(`family ${hex(family)} (${name}) — this device is an RP2040 (${hex(RP2040_FAMILY_ID)})`);
    }
    if (familyId !== null && family !== familyId) throw at('family ID changes mid-file');
    familyId = family;

    // The RP2040 bootrom programs 256-byte pages; every SDK/arduino-pico UF2
    // uses payloadSize 256 at 256-aligned flash addresses.
    if (payloadSize !== FLASH_PAGE_SIZE) {
      throw at(`payloadSize ${payloadSize} (RP2040 UF2 blocks must carry exactly ${FLASH_PAGE_SIZE} bytes)`);
    }
    if (targetAddr % FLASH_PAGE_SIZE !== 0) {
      throw at(`targetAddr ${hex(targetAddr)} not ${FLASH_PAGE_SIZE}-byte aligned`);
    }
    if (targetAddr < FLASH_START || targetAddr + payloadSize > FLASH_END) {
      throw at(`targetAddr ${hex(targetAddr)} outside the RP2040 flash window ${hex(FLASH_START)}..${hex(FLASH_END)}`);
    }
    if (targetAddr < prevEnd) {
      throw at(`targetAddr ${hex(targetAddr)} overlaps or precedes earlier data (blocks must be ascending)`);
    }

    const data = bytes.subarray(off + 32, off + 32 + payloadSize);
    const run = runs[runs.length - 1];
    if (run && targetAddr === run.addr + run.size) {
      run.parts.push(data); // contiguous — extend the current segment
      run.size += payloadSize;
    } else {
      runs.push({ addr: targetAddr, parts: [data], size: payloadSize });
    }
    prevEnd = targetAddr + payloadSize;
    flashBlocks += 1;
  }

  if (flashBlocks === 0) throw new Error('no flashable blocks (every block is flagged not-main-flash)');

  // Join each contiguous run into one flat segment buffer.
  const segments = runs.map((run) => {
    const data = new Uint8Array(run.size);
    let fill = 0;
    for (const part of run.parts) {
      data.set(part, fill);
      fill += part.length;
    }
    return { addr: run.addr, data };
  });
  const byteCount = segments.reduce((n, s) => n + s.data.length, 0);
  return {
    totalBlocks,
    flashBlocks,
    skippedBlocks,
    familyId,
    familyName: FAMILY_NAMES[familyId],
    segments,
    byteCount,
    minAddr: segments[0].addr,
    endAddr: prevEnd,
  };
}
