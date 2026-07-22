// Minimal PICOBOOT client over WebUSB — talks to an RP2040 in BOOTSEL mode.
//
// Protocol structures come from pico-sdk
// src/common/boot_picoboot_headers/include/boot/picoboot.h; the transfer
// sequencing (command → data → opposite-direction ACK, stall + CMD_STATUS +
// interface-reset recovery) mirrors picotool
// picoboot_connection/picoboot_connection.c, the reference host
// implementation. RP2040 datasheet §2.8 describes the same interface.

import { FLASH_SECTOR_SIZE } from './uf2.js';

/** USB identity of the RP2040 ROM bootloader
 *  (picotool picoboot_connection/picoboot_connection.h:
 *  VENDOR_ID_RASPBERRY_PI 0x2e8a, PRODUCT_ID_RP2040_USBBOOT 0x0003). */
export const BOOTROM_USB_FILTER = { vendorId: 0x2e8a, productId: 0x0003 };

// pico-sdk boot/picoboot.h — all values verified against the header:
const PICOBOOT_MAGIC = 0x431fd10b;
const IF_RESET = 0x41; // control OUT, size 0 — un-stall EPs and reset
const IF_CMD_STATUS = 0x42; // control IN, size 16 — status of the last command
const CMD = {
  EXCLUSIVE_ACCESS: 0x01,
  REBOOT: 0x02,
  FLASH_ERASE: 0x03,
  READ: 0x84, // top bit set = data flows device→host
  WRITE: 0x05,
  EXIT_XIP: 0x06,
};
// enum picoboot_exclusive_type (pico-sdk boot/picoboot.h)
const EXCLUSIVE = 1; // disable USB mass-storage writes while we flash
// enum picoboot_status (pico-sdk boot/picoboot.h)
const STATUS_NAMES = {
  0: 'ok',
  1: 'unknown cmd',
  2: 'invalid cmd length',
  3: 'invalid transfer length',
  4: 'invalid address',
  5: 'bad alignment',
  6: 'interleaved write',
  7: 'rebooting',
  8: 'unknown error',
};

const CHUNK = FLASH_SECTOR_SIZE; // 4 KB per bulk write/read command

export class PicobootError extends Error {
  constructor(message, statusCode = null) {
    super(message);
    this.name = 'PicobootError';
    this.statusCode = statusCode;
  }
}

export class PicobootDevice {
  constructor(usbDevice) {
    this.device = usbDevice;
    this.interfaceNumber = null;
    this.epOut = null;
    this.epIn = null;
    this.token = 1;
  }

  static supported() {
    return 'usb' in navigator;
  }

  /** Must be called from a user gesture — shows the browser device chooser. */
  static async request() {
    const device = await navigator.usb.requestDevice({ filters: [BOOTROM_USB_FILTER] });
    return new PicobootDevice(device);
  }

  /** Open the device and claim the PICOBOOT vendor interface.
   *  Interface discovery matches picotool picoboot_connection.c: the
   *  vendor-specific (class 0xff) interface with exactly two bulk endpoints,
   *  OUT first, IN second. The mass-storage interface stays with the OS. */
  async open() {
    const d = this.device;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    for (const iface of d.configuration.interfaces) {
      const alt = iface.alternates[0];
      if (alt.interfaceClass !== 0xff || alt.endpoints.length !== 2) continue;
      const out = alt.endpoints.find((e) => e.direction === 'out');
      const inn = alt.endpoints.find((e) => e.direction === 'in');
      if (!out || !inn) continue;
      this.interfaceNumber = iface.interfaceNumber;
      this.epOut = out.endpointNumber;
      this.epIn = inn.endpointNumber;
      break;
    }
    if (this.interfaceNumber === null) {
      await d.close().catch(() => {});
      throw new PicobootError('no PICOBOOT interface found on this device');
    }
    await d.claimInterface(this.interfaceNumber);
    // "do a device reset in case it was left in a bad state" — picotool
    // issues PICOBOOT_IF_RESET on every connect (picoboot_connection_cxx.h
    // constructor). Without it, a command interrupted mid-data-phase (e.g.
    // the tab was closed during a write) leaves the bootrom waiting for the
    // rest of the transfer, and our first command packet would be swallowed
    // as write data. IF_RESET on an idle interface is a harmless no-op.
    await this.reset();
  }

  get opened() {
    return this.device.opened && this.interfaceNumber !== null;
  }

  async close() {
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch { /* gone already */ }
    try {
      await this.device.close();
    } catch { /* gone already */ }
  }

  // ---------------------------------------------------------- USB plumbing

  async #bulkOut(data) {
    const r = await this.device.transferOut(this.epOut, data);
    if (r.status !== 'ok') throw new PicobootError(`bulk OUT ${r.status}`);
    return r;
  }

  async #bulkIn(length) {
    const r = await this.device.transferIn(this.epIn, length);
    if (r.status !== 'ok') throw new PicobootError(`bulk IN ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  /** PICOBOOT_IF_CMD_STATUS — 16-byte picoboot_cmd_status via control IN.
   *  Works even while the bulk endpoints are stalled after a failure. */
  async cmdStatus() {
    const r = await this.device.controlTransferIn(
      { requestType: 'vendor', recipient: 'interface', request: IF_CMD_STATUS, value: 0, index: this.interfaceNumber },
      16,
    );
    if (r.status !== 'ok' || r.data.byteLength < 16) throw new PicobootError('CMD_STATUS failed');
    // struct picoboot_cmd_status: dToken u32, dStatusCode u32, bCmdId u8, bInProgress u8
    return {
      token: r.data.getUint32(0, true),
      statusCode: r.data.getUint32(4, true),
      cmdId: r.data.getUint8(8),
      inProgress: r.data.getUint8(9),
    };
  }

  /** Un-stall both endpoints and issue PICOBOOT_IF_RESET (picotool picoboot_reset). */
  async reset() {
    await this.device.clearHalt('in', this.epIn).catch(() => {});
    await this.device.clearHalt('out', this.epOut).catch(() => {});
    await this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'interface', request: IF_RESET, value: 0, index: this.interfaceNumber },
    );
  }

  /**
   * Run one PICOBOOT command: 32-byte picoboot_cmd on bulk OUT, then the
   * data phase (dTransferLength bytes IN or OUT), then the ACK packet in the
   * opposite direction. On error: fetch CMD_STATUS, reset the interface so
   * the connection stays usable, and throw with the decoded status.
   */
  async #command({ id, args = new Uint8Array(0), transferLength = 0, data = null, label }) {
    // struct picoboot_cmd (32 bytes, little-endian):
    //   dMagic u32, dToken u32, bCmdId u8, bCmdSize u8, _unused u16,
    //   dTransferLength u32, args u8[16]
    const cmd = new Uint8Array(32);
    const view = new DataView(cmd.buffer);
    view.setUint32(0, PICOBOOT_MAGIC, true);
    view.setUint32(4, this.token, true);
    this.token = (this.token + 1) >>> 0;
    cmd[8] = id;
    cmd[9] = args.length;
    view.setUint32(12, transferLength, true);
    cmd.set(args, 16);

    try {
      await this.#bulkOut(cmd);
      let result = null;
      if (transferLength > 0) {
        if (id & 0x80) result = await this.#bulkIn(transferLength);
        else await this.#bulkOut(data);
      }
      // ACK travels opposite to the data phase (picoboot.h: "device responds
      // on success with 0 length ACK packet set via OUT/IN"). picotool sends
      // a 1-byte dummy for the host→device ACK; the bootrom accepts it.
      if (id & 0x80) await this.#bulkOut(new Uint8Array(1));
      else await this.#bulkIn(64); // zero-length IN completes with 0 bytes
      return result;
    } catch (e) {
      // Same recovery picotool's wrap_call does: read the status while the
      // EPs are stalled, then reset so the next command can run.
      let detail = e.message;
      let code = null;
      try {
        const status = await this.cmdStatus();
        if (status.statusCode !== 0) {
          code = status.statusCode;
          detail = STATUS_NAMES[code] ?? `status ${code}`;
        }
      } catch { /* status unavailable — keep the transport error */ }
      await this.reset().catch(() => {});
      throw new PicobootError(`${label}: ${detail}`, code);
    }
  }

  // ---------------------------------------------------------- commands

  /** PC_EXCLUSIVE_ACCESS — block mass-storage writes while flashing. */
  async exclusiveAccess(exclusive = EXCLUSIVE) {
    await this.#command({ id: CMD.EXCLUSIVE_ACCESS, args: new Uint8Array([exclusive]), label: 'exclusive access' });
  }

  /** PC_EXIT_XIP — leave execute-in-place so flash can be erased/programmed. */
  async exitXip() {
    await this.#command({ id: CMD.EXIT_XIP, label: 'exit XIP' });
  }

  /** PC_FLASH_ERASE — addr and size must be 4 KB sector aligned. */
  async flashErase(addr, size) {
    await this.#command({
      id: CMD.FLASH_ERASE,
      args: rangeArgs(addr, size),
      label: `erase ${hex(addr)}`,
    });
  }

  /** PC_WRITE — addr page aligned, size a multiple of 256 (no auto-erase). */
  async write(addr, data) {
    await this.#command({
      id: CMD.WRITE,
      args: rangeArgs(addr, data.length),
      transferLength: data.length,
      data,
      label: `write ${hex(addr)}`,
    });
  }

  /** PC_READ — read back flash/ROM/RAM. */
  async read(addr, size) {
    return this.#command({
      id: CMD.READ,
      args: rangeArgs(addr, size),
      transferLength: size,
      label: `read ${hex(addr)}`,
    });
  }

  /** PC_REBOOT with dPC=0 — "reset into the regular boot path", i.e. run
   *  the freshly flashed application (picoboot.h picoboot_reboot_cmd). */
  async rebootToApp(delayMs = 500) {
    const args = new Uint8Array(12);
    const view = new DataView(args.buffer);
    view.setUint32(0, 0, true); // dPC = 0
    view.setUint32(4, 0, true); // dSP (ignored when dPC == 0)
    view.setUint32(8, delayMs, true); // dDelayMS
    await this.#command({ id: CMD.REBOOT, args, label: 'reboot' });
  }
}

// struct picoboot_range_cmd: dAddr u32, dSize u32 (pico-sdk boot/picoboot.h)
function rangeArgs(addr, size) {
  const args = new Uint8Array(8);
  const view = new DataView(args.buffer);
  view.setUint32(0, addr, true);
  view.setUint32(4, size, true);
  return args;
}

const hex = (v) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/**
 * Flash a parsed UF2 image (from uf2.js parseUf2) and reboot into it.
 * Sequence per picotool / RP2040 datasheet §2.8: exclusive access → exit
 * XIP → sector erase covering the image → 4 KB page-multiple writes →
 * full read-back verify → reboot.
 *
 * @param {PicobootDevice} dev an opened device
 * @param {{segments: {addr: number, data: Uint8Array}[]}} image
 * @param {{onPhase?: Function, onProgress?: Function, onLog?: Function}} hooks
 *   onPhase(name), onProgress(done, total) with byte counts (sectors for
 *   erase), onLog(text).
 */
export async function flashImage(dev, image, { onPhase = () => {}, onProgress = () => {}, onLog = () => {} } = {}) {
  // Union of 4 KB sectors touched by any segment — erase everything first,
  // then write, so a sector shared by two segments is never erased after
  // one of them has been written.
  const sectors = [];
  for (const seg of image.segments) {
    const first = Math.floor(seg.addr / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;
    const last = Math.floor((seg.addr + seg.data.length - 1) / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;
    for (let s = first; s <= last; s += FLASH_SECTOR_SIZE) {
      if (sectors[sectors.length - 1] !== s) sectors.push(s);
    }
  }

  onLog('claiming exclusive access (mass-storage writes disabled)');
  await dev.exclusiveAccess(EXCLUSIVE);
  onLog('exiting XIP');
  await dev.exitXip();

  onPhase('erase');
  for (let i = 0; i < sectors.length; i += 1) {
    await dev.flashErase(sectors[i], FLASH_SECTOR_SIZE);
    onProgress(i + 1, sectors.length);
  }
  onLog(`erased ${sectors.length} sectors (${(sectors.length * FLASH_SECTOR_SIZE) / 1024} KB)`);

  const total = image.segments.reduce((n, s) => n + s.data.length, 0);

  onPhase('write');
  let written = 0;
  for (const seg of image.segments) {
    for (let off = 0; off < seg.data.length; off += CHUNK) {
      const chunk = seg.data.subarray(off, Math.min(off + CHUNK, seg.data.length));
      await dev.write(seg.addr + off, chunk);
      written += chunk.length;
      onProgress(written, total);
    }
  }
  onLog(`wrote ${written} bytes`);

  onPhase('verify');
  let verified = 0;
  for (const seg of image.segments) {
    for (let off = 0; off < seg.data.length; off += CHUNK) {
      const chunk = seg.data.subarray(off, Math.min(off + CHUNK, seg.data.length));
      const back = await dev.read(seg.addr + off, chunk.length);
      for (let i = 0; i < chunk.length; i += 1) {
        if (back[i] !== chunk[i]) {
          throw new PicobootError(
            `verify FAILED at ${hex(seg.addr + off + i)}: read 0x${back[i].toString(16)}, expected 0x${chunk[i].toString(16)}`,
          );
        }
      }
      verified += chunk.length;
      onProgress(verified, total);
    }
  }
  onLog(`verified ${verified} bytes — flash matches the image`);

  onPhase('reboot');
  onLog('rebooting into the application');
  await dev.rebootToApp(500);
}
