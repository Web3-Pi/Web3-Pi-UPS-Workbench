// Firmware section: UF2 upload → 1200-baud BOOTSEL reboot → WebUSB flash.
// UI glue only — UF2 parsing lives in uf2.js, the PICOBOOT protocol in
// picoboot.js. The serial side reuses the app's transport/session.

import { parseUf2 } from './uf2.js';
import { PicobootDevice, flashImage } from './picoboot.js';
import { UPS_USB_FILTER } from './transport.js';

const $ = (id) => document.getElementById(id);

const hex = (v) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
const fmtKb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHASE_LABELS = { erase: 'Erasing', write: 'Writing', verify: 'Verifying', reboot: 'Rebooting' };
// phase → [bar %, bar %] so one bar sweeps 0..100 across the whole job
const PHASE_WINDOW = { erase: [0, 20], write: [20, 75], verify: [75, 100], reboot: [100, 100] };

/**
 * Wire up the Firmware card. `isSerialConnected` reports the app's Web
 * Serial session state, `closeSerial` performs a clean manual disconnect
 * (no auto-reconnect), `toast` is the app's notifier.
 */
export function initFirmware({ isSerialConnected, closeSerial, toast }) {
  let image = null; // parsed UF2 (+ fileName/fileSize) once a file validates
  let boot = null; // PicobootDevice while the bootloader is connected
  let busy = false; // a reboot/flash operation is in flight
  let phase = 'erase';
  let expectGone = false; // set before the post-flash reboot detaches the device

  function fwLog(cls, text) {
    const host = $('fw-log');
    host.hidden = false;
    const div = document.createElement('div');
    div.className = `log-line ${cls}`;
    const stamp = new Date().toTimeString().slice(0, 8);
    div.innerHTML = `<span class="t">${stamp}</span><span class="msg"></span>`;
    div.querySelector('.msg').textContent = text;
    host.append(div);
    while (host.childElementCount > 200) host.firstElementChild.remove();
    host.scrollTop = host.scrollHeight;
  }

  function setStep(n, state) {
    const step = $(`fw-step-${n}`);
    step.dataset.state = state;
    step.querySelector('.step-no').textContent = state === 'done' ? '✓' : String(n);
  }

  function refreshButtons() {
    $('fw-reboot').disabled = busy || !('serial' in navigator) || !isSerialConnected();
    $('fw-connect').disabled = busy || !PicobootDevice.supported();
    $('fw-flash').disabled = busy || !image || !boot?.opened;
  }

  function setBar(done, total) {
    const [from, to] = PHASE_WINDOW[phase];
    const pct = total ? from + ((to - from) * done) / total : from;
    $('fw-bar').style.width = `${pct.toFixed(1)}%`;
  }

  // ------------------------------------------------------------ file input

  async function onFileChange() {
    const file = $('fw-file').files[0];
    const info = $('fw-file-info');
    image = null;
    if (file) {
      try {
        const parsed = parseUf2(await file.arrayBuffer());
        image = { ...parsed, fileName: file.name, fileSize: file.size };
        const skipped = parsed.skippedBlocks ? ` (+${parsed.skippedBlocks} skipped)` : '';
        info.className = 'note';
        info.textContent =
          `${file.name} · ${fmtKb(file.size)} · ${parsed.flashBlocks} blocks${skipped} · ` +
          `${parsed.familyName} · ${hex(parsed.minAddr)}–${hex(parsed.endAddr)}`;
        setStep(3, boot?.opened ? 'active' : '');
      } catch (e) {
        info.className = 'note err-text';
        info.textContent = `Rejected: ${e.message}`;
        fwLog('err', `UF2 rejected — ${e.message}`);
      }
    } else {
      info.className = 'note';
      info.textContent = 'No file selected.';
    }
    refreshButtons();
  }

  // ------------------------------------------------- step 1: BOOTSEL reboot

  const isUpsPort = (p) => {
    const i = p.getInfo();
    return i.usbVendorId === UPS_USB_FILTER.usbVendorId && i.usbProductId === UPS_USB_FILTER.usbProductId;
  };

  async function onReboot() {
    busy = true;
    refreshButtons();
    try {
      // Grab the granted CDC port before the session closes, then perform
      // the classic 1200-baud touch: open at 1200 baud, close — the
      // arduino-pico core reboots the RP2040 into the ROM bootloader.
      const granted = (await navigator.serial.getPorts()).filter(isUpsPort);
      fwLog('', 'closing the telemetry session');
      await closeSerial();
      const port = granted.length === 1
        ? granted[0]
        : await navigator.serial.requestPort({ filters: [UPS_USB_FILTER] });
      fwLog('', 'tapping the CDC port at 1200 baud');
      await port.open({ baudRate: 1200 });
      await sleep(100);
      try {
        await port.close();
      } catch { /* the chip can drop off mid-close — that is the goal */ }
      fwLog('event', 'BOOTSEL reboot sent — wait a moment for “RP2 Boot”, then continue with step 2');
      setStep(1, 'done');
      setStep(2, 'active');
    } catch (e) {
      if (e.name === 'NotFoundError') fwLog('', 'port selection cancelled');
      else fwLog('err', `BOOTSEL reboot failed: ${e.message}`);
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  // --------------------------------------------- step 2: connect bootloader

  async function onConnect() {
    busy = true;
    refreshButtons();
    try {
      const dev = await PicobootDevice.request();
      await dev.open();
      boot = dev;
      fwLog('event', `bootloader connected (interface ${dev.interfaceNumber}, EP OUT ${dev.epOut} / IN ${dev.epIn})`);
      setStep(1, 'done');
      setStep(2, 'done');
      setStep(3, 'active');
      if (!image) fwLog('', 'select a .uf2 file to enable flashing');
    } catch (e) {
      if (e.name === 'NotFoundError') fwLog('', 'device selection cancelled');
      else fwLog('err', `bootloader connect failed: ${e.message}`);
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  // ------------------------------------------------------------ step 3: flash

  async function onFlash() {
    const details =
      `${image.fileName}\n${fmtKb(image.fileSize)} · ${image.flashBlocks} blocks · ${image.familyName}\n` +
      `flash range ${hex(image.minAddr)}–${hex(image.endAddr)}`;
    if (!window.confirm(`Flash this firmware to the RP2040?\n\n${details}\n\nThe UPS output stays powered during the update.`)) return;
    busy = true;
    refreshButtons();
    $('fw-file').disabled = true;
    $('fw-progress').hidden = false;
    try {
      await flashImage(boot, image, {
        onPhase: (p) => {
          phase = p;
          $('fw-phase').textContent = `${PHASE_LABELS[p]}…`;
          setBar(0, 1);
        },
        onProgress: (done, total) => setBar(done, total),
        onLog: (text) => fwLog('', text),
      });
      expectGone = true;
      $('fw-phase').textContent = 'Done — device is rebooting';
      $('fw-bar').style.width = '100%';
      setStep(3, 'done');
      fwLog('event', 'flash complete ✓ — the RP2040 is rebooting into the new firmware');
      toast('Firmware flashed ✓', 'ok');
      await boot.close().catch(() => {});
      boot = null;
    } catch (e) {
      fwLog('err', `flash failed: ${e.message}`);
      fwLog('err', 'the device is still in BOOTSEL — fix the issue and press Flash again');
      $('fw-phase').textContent = 'Failed — see log below';
      toast('Firmware flash failed', 'err');
    } finally {
      busy = false;
      $('fw-file').disabled = false;
      refreshButtons();
    }
  }

  // ------------------------------------------------------------------ boot

  $('fw-file').onchange = onFileChange;
  $('fw-reboot').onclick = onReboot;
  $('fw-connect').onclick = onConnect;
  $('fw-flash').onclick = onFlash;

  if (PicobootDevice.supported()) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (!boot || e.device !== boot.device) return;
      boot = null;
      if (expectGone) {
        expectGone = false;
        fwLog('', 'bootloader detached (reboot) — the UPS should be back on the serial link shortly');
      } else {
        fwLog('err', 'bootloader disconnected unexpectedly');
        setStep(2, '');
        setStep(3, '');
      }
      refreshButtons();
    });
  } else {
    // Same guidance pattern as the Web Serial gate: capability-based.
    $('fw-unsupported').hidden = false;
  }
  refreshButtons();

  return {
    setSerialConnected(connected) {
      if (connected && $('fw-step-1').dataset.state !== 'done') setStep(1, 'active');
      refreshButtons();
    },
  };
}
