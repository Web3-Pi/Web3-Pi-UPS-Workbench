// Transports: Web Serial (real UPS) and Demo (synthetic stream).
//
// Both expose the same surface: connect(), disconnect(), write(bytes),
// and emit raw byte chunks through onData. The app layer never knows
// which one is active.

import { buildFrame, ADDR, CLASS, OP, FLAG, PROTO_VERSION } from './wups.js';

/** USB identity of the RP2040 CDC (firmware-rp2040/platformio.ini). */
export const UPS_USB_FILTER = { usbVendorId: 0x2e8a, usbProductId: 0x000a };

export class SerialTransport {
  constructor({ onData, onStateChange }) {
    this.onData = onData;
    this.onStateChange = onStateChange;
    this.port = null;
    this.reader = null;
    this.keepReading = false;
  }

  static supported() {
    return 'serial' in navigator;
  }

  /** Reuse a previously granted port if there is exactly one UPS. */
  async tryReconnect() {
    if (!SerialTransport.supported()) return false;
    const ports = await navigator.serial.getPorts();
    const ups = ports.filter((p) => {
      const i = p.getInfo();
      return i.usbVendorId === UPS_USB_FILTER.usbVendorId && i.usbProductId === UPS_USB_FILTER.usbProductId;
    });
    if (ups.length !== 1) return false;
    return this.#open(ups[0]);
  }

  /** Must be called from a user gesture — shows the browser port chooser. */
  async connect() {
    const port = await navigator.serial.requestPort({ filters: [UPS_USB_FILTER] });
    return this.#open(port);
  }

  async #open(port) {
    // USB-CDC ignores the baud rate; 115200 matches the RP2040 side.
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.keepReading = true;
    this.onStateChange('connected');
    this.#readLoop(); // intentionally not awaited
    // Chrome reuses SerialPort objects across sessions — scope the listener
    // to this connection or they accumulate over connect/disconnect cycles.
    this.abort = new AbortController();
    port.addEventListener('disconnect', () => this.#onGone(), { signal: this.abort.signal });
    return true;
  }

  async #readLoop() {
    while (this.keepReading && this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) this.onData(value);
        }
      } catch (e) {
        // stream error — brief backoff, then the outer while retries while
        // the port is still readable; physical removal lands in #onGone
        console.warn('serial read error', e);
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    // Fatal stream loss without a `disconnect` event (readable gone but the
    // OS device lingers): surface it instead of leaving the UI "Connected".
    if (this.keepReading) this.#onGone();
  }

  #onGone() {
    if (!this.keepReading && !this.port) return; // already torn down
    this.keepReading = false;
    this.abort?.abort();
    this.port = null;
    this.onStateChange('disconnected');
  }

  async write(bytes) {
    if (!this.port?.writable) throw new Error('not connected');
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect() {
    this.keepReading = false;
    this.abort?.abort();
    try {
      await this.reader?.cancel();
    } catch {
      /* already closed */
    }
    try {
      // A write wedged against a dead device holds the writer lock and makes
      // close() reject — abort the writable side first.
      await this.port?.writable?.abort();
    } catch {
      /* already closed */
    }
    try {
      await this.port?.close();
    } catch {
      /* already closed */
    }
    this.port = null;
    this.onStateChange('disconnected');
  }
}

// ---------------------------------------------------------------- demo

/**
 * Synthetic UPS: emits real WUPS frames (power.status v2 at 1 Hz, periodic
 * system.log lines, occasional power.event) so the whole app — deframer
 * included — runs the same code paths as against hardware. Also answers
 * ping and net.config requests like the firmware would.
 */
export class DemoTransport {
  constructor({ onData, onStateChange }) {
    this.onData = onData;
    this.onStateChange = onStateChange;
    this.timer = null;
    this.t = 0;
    this.mains = true;
    this.uptime = 6120;
  }

  async connect() {
    this.onStateChange('demo');
    this.timer = setInterval(() => this.#tick(), 1000);
    this.#emitLog('demo: synthetic UPS stream started');
    return true;
  }

  async disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.onStateChange('disconnected');
  }

  async write(bytes) {
    // Parse just enough of the request to answer like the firmware.
    const dst = bytes[2];
    const cls = bytes[4];
    const op = bytes[5];
    const seq = bytes[7];
    setTimeout(() => {
      if (cls === CLASS.SYSTEM && op === OP.SYSTEM.PING) {
        const p = new Uint8Array(8);
        p[0] = PROTO_VERSION;
        const d = new DataView(p.buffer);
        d.setUint16(2, (1 << 8) | 4, true); // fw 1.4
        d.setUint32(4, this.uptime * 1000, true);
        this.#emit(buildFrame({ dst: ADDR.RPI, src: dst, cls, op, flags: FLAG.RESP, seq, payload: p }));
      } else if (cls === CLASS.NET && op === OP.NET.CONFIG) {
        const p = new Uint8Array(4);
        p[0] = PROTO_VERSION;
        p[1] = bytes[11]; // echo item (payload[1])
        p[2] = 0; // ok
        this.#emit(buildFrame({ dst: ADDR.RPI, src: ADDR.ESP32, cls, op, flags: FLAG.RESP, seq, payload: p }));
        this.#emitLog('w3http: config stored to NVS (demo)');
      } else if (cls === CLASS.POWER && (op === OP.POWER.CYCLE || op === OP.POWER.DISABLE)) {
        this.#emitLog('PD: disconnect (demo power drop)');
      } else if (cls === CLASS.UI && op === OP.UI.BEEP) {
        this.#emitLog('ui: beep (demo)');
      }
    }, 60);
  }

  #tick() {
    this.t += 1;
    this.uptime += 1;
    // A little theatre: mains drops for 20 s every 2 minutes.
    if (this.t % 120 === 100) {
      this.mains = false;
      this.#emitPowerEvent(1);
    }
    if (this.t % 120 === 0 && !this.mains) {
      this.mains = true;
      this.#emitPowerEvent(2);
    }
    this.#emit(this.#statusFrame());
    if (this.t % 5 === 0) {
      this.#emitLog(
        this.mains
          ? 'HUSB att=1 Vin=15000mV Iin=3000mA v=4 i=A resp=1'
          : 'PD: running on battery',
      );
    }
  }

  #statusFrame() {
    const n = (base, amp) => Math.round(base + amp * Math.sin(this.t / 9) + amp * (Math.random() - 0.5));
    const p = new Uint8Array(40);
    const d = new DataView(p.buffer);
    p[0] = 2;
    // flags: DC_IN|VBUS_OUT|BATT|POWER_GOOD|USB_C on mains; VBUS_OUT|BATT on battery
    p[1] = this.mains ? 0b11111 : 0b00110;
    p[2] = this.mains ? 3 : 0;
    d.setUint16(4, this.mains ? n(14650, 90) : n(150, 30), true); // vbus_in
    d.setUint16(6, this.mains ? 15000 : 0, true);
    d.setUint16(8, this.mains ? 3000 : 0, true);
    d.setUint16(10, n(15010, 60), true); // vbus_out
    d.setUint16(12, 15000, true);
    d.setUint16(14, n(14980, 50), true);
    d.setUint16(16, 1900, true);
    d.setUint16(18, 15000, true);
    d.setUint16(20, 1800, true);
    d.setUint16(22, this.mains ? n(7920, 25) : n(7650 - this.t % 120, 20), true); // vbat
    d.setInt16(24, 0, true);
    d.setUint16(26, n(8230, 40), true);
    d.setUint16(28, this.mains ? n(1400, 350) : 0, true);
    d.setInt16(30, n(590, 12), true);
    d.setInt16(32, n(910, 18), true);
    d.setUint16(34, 0, true);
    d.setUint32(36, this.uptime, true);
    return buildFrame({
      dst: ADDR.RPI, // matches the real CDC stream (RP2040 forwards to the host seat)
      src: ADDR.CH32X,
      cls: CLASS.POWER,
      op: OP.POWER.STATUS,
      flags: FLAG.EVENT,
      payload: p,
    });
  }

  #emitLog(text) {
    const bytes = new TextEncoder().encode(text);
    const p = new Uint8Array(4 + bytes.length);
    p[0] = PROTO_VERSION;
    p[1] = 2; // info
    p[2] = bytes.length;
    p.set(bytes, 4);
    this.#emit(
      buildFrame({ dst: ADDR.BROADCAST, src: ADDR.CH32X, cls: CLASS.SYSTEM, op: OP.SYSTEM.LOG, flags: FLAG.EVENT, payload: p }),
    );
  }

  #emitPowerEvent(event) {
    const p = new Uint8Array([PROTO_VERSION, event]);
    this.#emit(
      buildFrame({ dst: ADDR.BROADCAST, src: ADDR.CH32X, cls: CLASS.POWER, op: OP.POWER.EVENT, flags: FLAG.EVENT, payload: p }),
    );
  }

  #emit(frame) {
    // Deliver in two chunks to exercise the streaming deframer.
    const cut = Math.min(7, frame.length);
    this.onData(frame.subarray(0, cut));
    this.onData(frame.subarray(cut));
  }
}
