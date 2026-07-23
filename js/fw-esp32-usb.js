// Firmware card, "ESP32 (direct USB)" mode: full esptool-js flow over Web
// Serial to the ESP32-S3's built-in USB-Serial-JTAG on the M.2 module's own
// USB port. Reproduces the documented one-time OTA-layout migration
// (firmware-ESP32-LTE-M README) entirely in the browser: app @0x10000,
// optional bootloader @0x0 / partition table @0x8000 / otadata @0xd000,
// plus an "erase old NVS region" step (0x9000, 0x6000).
//
// NEVER a full chip erase: the per-device `prov` partition at 0x310000 must
// survive (README: "Never use erase_flash on a provisioned unit — it wipes
// the per-device prov partition at 0x310000").

import { ESPLoader, Transport } from './vendor/esptool-js/bundle.js';
import { md5Hex } from './md5.js';

const $ = (id) => document.getElementById(id);

/** ESP32-S3 built-in USB-Serial-JTAG (Espressif VID/PID). */
export const ESP32S3_USB_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };

const APP_IMAGE_MAGIC = 0xe9;
// Flash map — firmware-ESP32-LTE-M partitions.csv (OTA-1 layout):
const APP_OFFSET = 0x10000; // ota_0
const APP_MAX_BYTES = 0x180000; // 1.5 MB slot
const BOOTLOADER_OFFSET = 0x0;
const BOOTLOADER_MAX_BYTES = 0x8000; // up to the partition table
const PTABLE_OFFSET = 0x8000;
const PTABLE_MAX_BYTES = 0x1000;
const PTABLE_ENTRY_MAGIC = [0xaa, 0x50]; // ESP-IDF partition entry magic
const OTADATA_OFFSET = 0xd000;
const OTADATA_BYTES = 0x2000; // ota_data_initial.bin is exactly 8 KB
const NVS_OFFSET = 0x9000;
const NVS_OLD_SIZE = 0x6000; // the OLD factory-layout nvs region

const fmtKb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const hex = (v) => `0x${v.toString(16)}`;

// Per-file validators — light-touch, enough to stop an obviously wrong file
// from reaching flash. Each returns an error string or null.
const CHECKS = {
  app: (b) => (b[0] !== APP_IMAGE_MAGIC ? `first byte 0x${b[0].toString(16).toUpperCase()} — not an ESP32 app image (expected 0xE9)`
    : b.length > APP_MAX_BYTES ? `${fmtKb(b.length)} exceeds the ${fmtKb(APP_MAX_BYTES)} OTA slot` : null),
  boot: (b) => (b[0] !== APP_IMAGE_MAGIC ? `first byte 0x${b[0].toString(16).toUpperCase()} — not an ESP32 bootloader image (expected 0xE9)`
    : b.length > BOOTLOADER_MAX_BYTES ? `${fmtKb(b.length)} exceeds the ${fmtKb(BOOTLOADER_MAX_BYTES)} bootloader region` : null),
  ptable: (b) => (b[0] !== PTABLE_ENTRY_MAGIC[0] || b[1] !== PTABLE_ENTRY_MAGIC[1] ? 'no 0xAA 0x50 partition-entry magic — not a partition-table binary'
    : b.length > PTABLE_MAX_BYTES ? `${fmtKb(b.length)} exceeds the ${fmtKb(PTABLE_MAX_BYTES)} table region` : null),
  otadata: (b) => (b.length !== OTADATA_BYTES ? `${b.length} bytes — ota_data_initial.bin is exactly ${OTADATA_BYTES} bytes` : null),
};

export function initEsp32Usb({ log, toast }) {
  const files = { app: null, boot: null, ptable: null, otadata: null };
  let transport = null; // esptool-js Transport while connected
  let loader = null;
  let busy = false;

  function refresh() {
    $('fwu-connect').disabled = busy || !('serial' in navigator) || !!loader;
    $('fwu-flash').disabled = busy || !files.app || !loader;
  }

  function setBar(pct) {
    $('fwu-bar').style.width = `${pct.toFixed(1)}%`;
  }

  function dropConnection() {
    transport = null;
    loader = null;
    $('fwu-chip').textContent = '';
    refresh();
  }

  // ------------------------------------------------------------ file inputs

  function wireFile(inputId, key, label, check) {
    $(inputId).onchange = async () => {
      const file = $(inputId).files[0];
      const info = $(`${inputId}-info`);
      files[key] = null;
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const err = bytes.length === 0 ? 'empty file' : check(bytes);
        if (err) {
          info.className = 'note err-text';
          info.textContent = `Rejected: ${err}.`;
          log('err', `${label} rejected — ${err}`);
        } else {
          files[key] = { bytes, fileName: file.name };
          info.className = 'note';
          info.textContent = `${file.name} · ${fmtKb(bytes.length)}`;
        }
      } else {
        info.className = 'note';
        info.textContent = key === 'app' ? 'No file selected.' : 'Not selected — region untouched.';
      }
      refresh();
    };
  }

  // ------------------------------------------------------------ connect

  async function onConnect() {
    busy = true;
    refresh();
    let t = null; // declared outside the try so a failed handshake can release the port
    try {
      const port = await navigator.serial.requestPort({ filters: [ESP32S3_USB_FILTER] });
      t = new Transport(port, false);
      const l = new ESPLoader({
        transport: t,
        baudrate: 921600, // ignored by USB-Serial-JTAG (native USB), harmless
        romBaudrate: 115200,
        terminal: {
          clean() {},
          writeLine: (text) => { if (!text.startsWith('Writing at 0x')) log('', text); },
          write: () => {}, // partial writes are progress spam — the bar covers it
        },
      });
      log('', 'connecting (USB-Serial-JTAG reset into download mode)…');
      const chip = await l.main('default_reset');
      if (!/ESP32-S3/i.test(chip)) {
        throw new Error(`connected chip is "${chip}" — the M.2 module is an ESP32-S3, refusing to flash`);
      }
      transport = t;
      loader = l;
      t.setDeviceLostCallback(() => {
        log('err', 'ESP32 USB device lost');
        dropConnection();
      });
      $('fwu-chip').textContent = chip;
      log('event', `connected: ${chip} — flasher stub running`);
      if (!files.app) log('', 'select an app .bin to enable flashing');
    } catch (e) {
      // Transport.connect() opens the port before main() syncs; on any failure
      // past that point (sync/stub upload/non-S3 chip) the port would stay open
      // and every retry would hit "port already open" until a page reload —
      // always release it. `!loader` keeps a live connection untouched.
      if (t && !loader) await t.disconnect().catch(() => {});
      if (e.name === 'NotFoundError') log('', 'port selection cancelled');
      else log('err', `ESP32 connect failed: ${e.message}`);
    } finally {
      busy = false;
      refresh();
    }
  }

  // ------------------------------------------------------------ flash

  function buildFileArray() {
    // Address order matters: the erase-NVS 0xFF block (0x9000–0xEFFF, the
    // OLD 6-sector nvs span) overlaps the new otadata region @0xd000, so
    // otadata must be written after it. esptool-js flashes entries in array
    // order, erase+write+MD5 per region.
    const out = [];
    if (files.boot) out.push({ data: files.boot.bytes, address: BOOTLOADER_OFFSET, name: `bootloader @ ${hex(BOOTLOADER_OFFSET)}` });
    if (files.ptable) out.push({ data: files.ptable.bytes, address: PTABLE_OFFSET, name: `partition table @ ${hex(PTABLE_OFFSET)}` });
    if ($('fwu-erase-nvs').checked) {
      // esptool-js has no erase_region command; writing 0xFF over the range
      // is byte-identical to `esptool.py erase_region 0x9000 0x6000` (NOR
      // erased state = 0xFF) and gets MD5-verified like every other region.
      out.push({ data: new Uint8Array(NVS_OLD_SIZE).fill(0xff), address: NVS_OFFSET, name: `NVS erase @ ${hex(NVS_OFFSET)} (${hex(NVS_OLD_SIZE)})` });
    }
    if (files.otadata) out.push({ data: files.otadata.bytes, address: OTADATA_OFFSET, name: `otadata @ ${hex(OTADATA_OFFSET)}` });
    out.push({ data: files.app.bytes, address: APP_OFFSET, name: `app @ ${hex(APP_OFFSET)}` });
    return out;
  }

  async function onFlash() {
    const fileArray = buildFileArray();
    const summary = fileArray.map((f) => `${f.name} · ${fmtKb(f.data.length)}`).join('\n');
    if (!window.confirm(
      `Flash the ESP32-S3 (M.2 module)?\n\n${summary}\n\n` +
      'No full erase is ever issued — the prov partition at 0x310000 stays intact.',
    )) return;
    busy = true;
    refresh();
    $('fwu-progress').hidden = false;
    const n = fileArray.length;
    let current = -1;
    try {
      await loader.writeFlash({
        fileArray,
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (i, written, total) => {
          if (i !== current) {
            current = i;
            log('', `writing ${fileArray[i].name}`);
          }
          $('fwu-phase').textContent = `Region ${i + 1}/${n}: ${fileArray[i].name}`;
          setBar(total ? (100 * (i + written / total)) / n : (100 * i) / n);
        },
        // esptool-js reads the region's MD5 back from flash after each write
        // and throws on mismatch — this is the verify step.
        calculateMD5Hash: (image) => md5Hex(image),
      });
      setBar(100);
      $('fwu-phase').textContent = 'Done — resetting the ESP32';
      log('event', `flash complete ✓ — ${n} region(s) written and MD5-verified`);
      await loader.after('hard_reset');
      await transport.disconnect().catch(() => {});
      dropConnection();
      log('', 'ESP32 reset into the new firmware — reconnect to flash again');
      toast('ESP32 flashed ✓', 'ok');
    } catch (e) {
      log('err', `flash failed: ${e.message}`);
      $('fwu-phase').textContent = 'Failed — see log below';
      toast('ESP32 flash failed', 'err');
    } finally {
      busy = false;
      refresh();
    }
  }

  // ------------------------------------------------------------------ boot

  wireFile('fwu-app', 'app', 'app image', CHECKS.app);
  wireFile('fwu-boot', 'boot', 'bootloader', CHECKS.boot);
  wireFile('fwu-ptable', 'ptable', 'partition table', CHECKS.ptable);
  wireFile('fwu-otadata', 'otadata', 'otadata', CHECKS.otadata);
  $('fwu-connect').onclick = onConnect;
  $('fwu-flash').onclick = onFlash;
  if (!('serial' in navigator)) $('fwu-unsupported').hidden = false;
  refresh();
}
