// WUPS wire protocol v1 — browser implementation.
//
// Mirrors Web3-Pi-UPS/common/protocol.h (canonical spec) and the Rust
// implementation in Web3-Pi-UPS-Service/src/proto/. Frame format (UBX-style):
//
//   AA 55 [DST][SRC][CLASS][OP][FLAGS][SEQ][LEN_L][LEN_H] [payload..LEN] [CK_A][CK_B] 55 AA
//
// Fletcher-8 covers DST..LEN_H + payload. All multi-byte payload fields are
// little-endian.

export const SYNC1 = 0xaa;
export const SYNC2 = 0x55;
export const END1 = 0x55;
export const END2 = 0xaa;
export const MAX_PAYLOAD = 240;
export const PROTO_VERSION = 1;

export const ADDR = {
  NULL: 0x00,
  RPI: 0x01, // the seat this page occupies on the bus
  RP2040: 0x02,
  CH32X: 0x03,
  ESP32: 0x04,
  INTERNAL: 0x05,
  BROADCAST: 0xff,
};

export const CLASS = { SYSTEM: 0x01, POWER: 0x02, NET: 0x03, HOST: 0x04, UI: 0x05 };

export const OP = {
  SYSTEM: { PING: 0x01, HELLO: 0x02, STATUS_QUERY: 0x03, LOG: 0x04 },
  POWER: { STATUS: 0x01, ENABLE: 0x02, DISABLE: 0x03, CYCLE: 0x04, RESET: 0x05, EVENT: 0x10 },
  NET: { STATUS: 0x01, PUBLISH: 0x02, DOWNLINK: 0x10, TIME_SYNC: 0x20, CONFIG: 0x21 },
  UI: { BUTTON_EVENT: 0x01, SET_SCREEN: 0x02, BEEP: 0x03, DISPLAY_MSG: 0x04 },
};

export const FLAG = { REQ: 0x01, RESP: 0x02, EVENT: 0x04, NEED_ACK: 0x80 };

export const NET_CONFIG_ITEM = { HTTP_URL: 0x01, DEVICE_ID: 0x02 };

export const POWER_EVENT_NAMES = {
  1: 'MAINS LOST',
  2: 'MAINS RESTORED',
  3: 'CHARGE LOW',
  4: 'CHARGE FULL',
  5: 'FAULT',
};

export const PWR2_FLAG = {
  DC_IN_EN: 1 << 0,
  VBUS_OUT_EN: 1 << 1,
  BATT_PRESENT: 1 << 2,
  POWER_GOOD: 1 << 3,
  USB_C_ATTACH: 1 << 4,
};

export const CHARGE_STATE_NAMES = ['not charging', 'pre-charge', 'charging', 'full'];

export const NODE_NAMES = { 0x01: 'RPi', 0x02: 'RP2040', 0x03: 'CH32X', 0x04: 'ESP32', 0x05: 'INT', 0xff: 'BCAST' };

// ---------------------------------------------------------------- checksum

export function fletcher8(bytes) {
  let a = 0;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) & 0xff;
    b = (b + a) & 0xff;
  }
  return [a, b];
}

// ---------------------------------------------------------------- framing

let seqCounter = 0;
export function nextSeq() {
  seqCounter = (seqCounter + 1) & 0xff;
  return seqCounter;
}

/** Build a complete wire frame as Uint8Array. */
export function buildFrame({ dst, src = ADDR.RPI, cls, op, flags, seq = nextSeq(), payload = new Uint8Array(0) }) {
  if (payload.length > MAX_PAYLOAD) throw new Error('payload too long');
  const frame = new Uint8Array(14 + payload.length);
  frame[0] = SYNC1;
  frame[1] = SYNC2;
  frame[2] = dst;
  frame[3] = src;
  frame[4] = cls;
  frame[5] = op;
  frame[6] = flags;
  frame[7] = seq;
  frame[8] = payload.length & 0xff;
  frame[9] = (payload.length >> 8) & 0xff;
  frame.set(payload, 10);
  const [ckA, ckB] = fletcher8(frame.subarray(2, 10 + payload.length));
  frame[10 + payload.length] = ckA;
  frame[11 + payload.length] = ckB;
  frame[12 + payload.length] = END1;
  frame[13 + payload.length] = END2;
  return frame;
}

/**
 * Streaming deframer. Feed arbitrary chunks; emits {frame} or {error} via the
 * callbacks. Non-frame bytes (the RP2040 also prints ASCII debug between
 * frames) are skipped silently — same behaviour as the Rust agent.
 */
export class Deframer {
  constructor(onFrame, onError = () => {}) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.reset();
  }

  reset() {
    this.state = 'sync1';
    this.header = new Uint8Array(8);
    this.headerFill = 0;
    this.payload = null;
    this.payloadFill = 0;
    this.trailer = new Uint8Array(4);
    this.trailerFill = 0;
  }

  feed(chunk) {
    for (const byte of chunk) this.#feedByte(byte);
  }

  #feedByte(byte) {
    switch (this.state) {
      case 'sync1':
        if (byte === SYNC1) this.state = 'sync2';
        break;
      case 'sync2':
        if (byte === SYNC2) {
          this.state = 'header';
          this.headerFill = 0;
        } else if (byte !== SYNC1) {
          this.state = 'sync1';
        }
        break;
      case 'header':
        this.header[this.headerFill++] = byte;
        if (this.headerFill === 8) {
          const len = this.header[6] | (this.header[7] << 8);
          if (len > MAX_PAYLOAD) {
            this.onError('length');
            this.reset();
            break;
          }
          this.payload = new Uint8Array(len);
          this.payloadFill = 0;
          this.trailerFill = 0;
          this.state = len > 0 ? 'payload' : 'trailer';
        }
        break;
      case 'payload':
        this.payload[this.payloadFill++] = byte;
        if (this.payloadFill === this.payload.length) this.state = 'trailer';
        break;
      case 'trailer':
        this.trailer[this.trailerFill++] = byte;
        if (this.trailerFill === 4) {
          this.#finish();
          this.reset();
        }
        break;
    }
  }

  #finish() {
    const covered = new Uint8Array(8 + this.payload.length);
    covered.set(this.header, 0);
    covered.set(this.payload, 8);
    const [ckA, ckB] = fletcher8(covered);
    if (ckA !== this.trailer[0] || ckB !== this.trailer[1]) {
      this.onError('checksum');
      return;
    }
    if (this.trailer[2] !== END1 || this.trailer[3] !== END2) {
      this.onError('end-marker');
      return;
    }
    this.onFrame({
      dst: this.header[0],
      src: this.header[1],
      cls: this.header[2],
      op: this.header[3],
      flags: this.header[4],
      seq: this.header[5],
      payload: this.payload,
    });
  }
}

// ---------------------------------------------------------------- payload codecs

const dv = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** power.status v2 — 40 bytes, payload[0] == 2. */
export function decodePowerStatusV2(p) {
  if (p.length !== 40 || p[0] !== 2) return null;
  const d = dv(p);
  return {
    flags: p[1],
    chargeState: p[2],
    vbusInMv: d.getUint16(4, true),
    pdInMv: d.getUint16(6, true),
    pdInMa: d.getUint16(8, true),
    vbusOutMv: d.getUint16(10, true),
    voutSetMv: d.getUint16(12, true),
    voutReadMv: d.getUint16(14, true),
    ioutLimitMa: d.getUint16(16, true),
    pdOutMv: d.getUint16(18, true),
    pdOutMa: d.getUint16(20, true),
    vbatMv: d.getUint16(22, true),
    ichgMa: d.getInt16(24, true),
    vsysMv: d.getUint16(26, true),
    iinMa: d.getUint16(28, true),
    tempLmDc: d.getInt16(30, true),
    tempMpDc: d.getInt16(32, true),
    faults: d.getUint16(34, true),
    uptimeS: d.getUint32(36, true),
  };
}

/** system.log — header (version, level, text_len, reserved) + ASCII. */
export function decodeSysLog(p) {
  if (p.length < 4 || p[0] !== PROTO_VERSION) return null;
  const len = Math.min(p[2], p.length - 4);
  return { level: p[1], text: new TextDecoder().decode(p.subarray(4, 4 + len)) };
}

/** system.ping RESP (pong). An ASCII fw-version string may follow the 8-byte
 * struct (protocol.h optional tail, e.g. "esp32:0.6.3") — absent on older
 * firmware, in which case fwStr is null and the coarse u16 applies. */
export function decodeSysPong(p) {
  if (p.length < 8 || p[0] !== PROTO_VERSION) return null;
  const d = dv(p);
  let fwStr = null;
  if (p.length > 8) {
    const tail = p.subarray(8);
    if (tail.every((b) => b >= 0x20 && b <= 0x7e)) {
      fwStr = new TextDecoder().decode(tail);
    }
  }
  return { fwVersion: d.getUint16(2, true), uptimeMs: d.getUint32(4, true), fwStr };
}

/** power.event broadcast. */
export function decodePowerEvent(p) {
  if (p.length < 2 || p[0] !== PROTO_VERSION) return null;
  return { event: p[1] };
}

/** net.config RESP result. */
export function decodeNetConfigResult(p) {
  if (p.length < 3 || p[0] !== PROTO_VERSION) return null;
  return { item: p[1], result: p[2] };
}

// ---------------------------------------------------------------- request builders

export const req = {
  ping: (dst) => buildFrame({ dst, cls: CLASS.SYSTEM, op: OP.SYSTEM.PING, flags: FLAG.REQ }),

  powerEnable: () => buildFrame({ dst: ADDR.CH32X, cls: CLASS.POWER, op: OP.POWER.ENABLE, flags: FLAG.REQ }),
  powerDisable: () => buildFrame({ dst: ADDR.CH32X, cls: CLASS.POWER, op: OP.POWER.DISABLE, flags: FLAG.REQ }),
  powerReset: () => buildFrame({ dst: ADDR.CH32X, cls: CLASS.POWER, op: OP.POWER.RESET, flags: FLAG.REQ }),

  /** Note: current CH32X firmware ignores off_ms and hardcodes 1500 ms. */
  powerCycle: (offMs = 1500) => {
    const p = new Uint8Array(4);
    p[0] = PROTO_VERSION;
    new DataView(p.buffer).setUint16(2, offMs, true);
    return buildFrame({ dst: ADDR.CH32X, cls: CLASS.POWER, op: OP.POWER.CYCLE, flags: FLAG.REQ, payload: p });
  },

  uiBeep: (freqHz = 1000, durMs = 120) => {
    const p = new Uint8Array(6);
    p[0] = PROTO_VERSION;
    const d = new DataView(p.buffer);
    d.setUint16(2, freqHz, true);
    d.setUint16(4, durMs, true);
    return buildFrame({ dst: ADDR.RP2040, cls: CLASS.UI, op: OP.UI.BEEP, flags: FLAG.REQ, payload: p });
  },

  /** net.config → ESP32. `value` is an ASCII string (may be '' to clear). */
  netConfig: (item, value) => {
    const text = new TextEncoder().encode(value);
    // Firmware-side caps (esp32 http_cfg): URL 200, device-id 64.
    const max = item === NET_CONFIG_ITEM.DEVICE_ID ? 64 : 200;
    if (text.length > max) throw new Error(`value too long (max ${max} bytes for this item)`);
    const p = new Uint8Array(4 + text.length);
    p[0] = PROTO_VERSION;
    p[1] = item;
    p[2] = text.length;
    p.set(text, 4);
    return buildFrame({ dst: ADDR.ESP32, cls: CLASS.NET, op: OP.NET.CONFIG, flags: FLAG.REQ, payload: p });
  },
};

// Last SEQ used by buildFrame is readable off the frame itself (byte 7):
export const frameSeq = (frame) => frame[7];
