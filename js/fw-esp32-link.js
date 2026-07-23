// Firmware card, "ESP32 (through UPS link)" mode: push an ESP32 app image
// into the ESP32's passive OTA slot over the normal Web Serial session using
// the net.fw_xfer_* ops (protocol.h 0x23/0x24/0x25). The RP2040 hub only
// routes the frames; the ESP32 stages the image, verifies SHA-256 at
// END(commit=1), flips the boot partition and reboots.
//
// STRICTLY stop-and-wait per the protocol: every REQ waits for its RESP
// before the next one goes out (the receiver stalls its UART RX while
// erasing/programming flash — pipelined frames would be lost). That also
// means a RESP can take a while during erase bursts; hence the 5 s DATA
// timeout, and a longer one for BEGIN (a full-slot erase can exceed 5 s)
// and END(commit=1) (SHA verify + partition flip + reboot).

import {
  req, FW_TARGET, FW_XFER_CHUNK, FW_XFER_OK, FW_XFER_SEQ_MISMATCH, decodeFwXferResult,
} from './wups.js';

const $ = (id) => document.getElementById(id);

const APP_IMAGE_MAGIC = 0xe9; // ESP-IDF app image header byte
const APP_MAX_BYTES = 0x180000; // 1.5 MB — the ota_0/ota_1 slot size
const RESP_TIMEOUT_MS = 5000; // per-DATA-chunk
// BEGIN can erase the whole 1.5 MB slot before RESPing and END(commit=1)
// runs the SHA verify + partition flip; give both the receiver's own idle
// budget (WUPS_FW_XFER_IDLE_TIMEOUT_S = 30 s).
const RESP_TIMEOUT_LONG_MS = 30000;
const fmtKb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** A decoded non-OK result byte from the device — never retried. */
class XferResultError extends Error {
  constructor(label, name) {
    super(`${label}: device reported ${name}`);
    this.name = 'XferResultError';
  }
}

export function initEsp32Link({ isSerialConnected, sendExpectingResp, log, toast }) {
  let image = null; // { bytes, fileName } once a file validates
  let busy = false;

  function refresh() {
    $('fwl-flash').disabled = busy || !image || !isSerialConnected();
    $('fwl-need-link').hidden = isSerialConnected();
  }

  function setBar(done, total) {
    $('fwl-bar').style.width = `${((100 * done) / total).toFixed(1)}%`;
  }

  function phase(text) {
    $('fwl-phase').textContent = text;
  }

  // ------------------------------------------------------------ file input

  async function onFileChange() {
    const file = $('fwl-file').files[0];
    const info = $('fwl-file-info');
    image = null;
    if (file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0) {
        info.className = 'note err-text';
        info.textContent = 'Rejected: empty file.';
      } else if (bytes[0] !== APP_IMAGE_MAGIC) {
        info.className = 'note err-text';
        info.textContent = `Rejected: first byte 0x${bytes[0].toString(16).toUpperCase()} — not an ESP32 app image (expected 0xE9).`;
      } else if (bytes.length > APP_MAX_BYTES) {
        info.className = 'note err-text';
        info.textContent = `Rejected: ${fmtKb(bytes.length)} exceeds the ${fmtKb(APP_MAX_BYTES)} OTA slot.`;
      } else {
        image = { bytes, fileName: file.name };
        info.className = 'note';
        info.textContent = `${file.name} · ${fmtKb(bytes.length)} · ${Math.ceil(bytes.length / FW_XFER_CHUNK)} frames`;
      }
    } else {
      info.className = 'note';
      info.textContent = 'No file selected.';
    }
    refresh();
  }

  // ------------------------------------------------------------ transfer

  /** One stop-and-wait exchange: REQ → RESP with the result byte checked.
   *  `build` returns a fresh frame (fresh SEQ) so a retry after a lost RESP
   *  is tracked correctly. Timeouts get exactly one retry; a decoded error
   *  result aborts immediately — with one exception: for DATA frames
   *  (`isData`), SEQ_MISMATCH on the retry means the FIRST copy of the chunk
   *  was applied and only its RESP got lost/corrupted — the receiver has
   *  advanced past our offset, and nothing else writes to the session, so the
   *  chunk is in fact staged and the transfer continues. A first-attempt
   *  SEQ_MISMATCH still aborts (real desync — protocol.h: restart from
   *  BEGIN). */
  async function xfer(build, label, { isData = false, timeoutMs = RESP_TIMEOUT_MS } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const resp = await sendExpectingResp(build(), label, timeoutMs);
        const r = decodeFwXferResult(resp.payload);
        if (!r) throw new XferResultError(label, 'empty RESP');
        if (r.result !== FW_XFER_OK) {
          if (isData && attempt >= 1 && r.result === FW_XFER_SEQ_MISMATCH) {
            log('', `${label}: SEQ_MISMATCH on retry — original chunk was applied (its RESP was lost), continuing`);
            return;
          }
          throw new XferResultError(label, r.name);
        }
        return;
      } catch (e) {
        if (e instanceof XferResultError) throw e;
        if (attempt >= 1) throw e;
        log('err', `${label}: ${e.message} — retrying once`);
      }
    }
  }

  async function onFlash() {
    if (!window.confirm(
      `Install this firmware on the ESP32 (M.2 module)?\n\n${image.fileName}\n${fmtKb(image.bytes.length)}\n\n` +
      'The image streams over the UPS link (a few minutes). On commit the ESP32 verifies it, reboots, and LTE drops briefly.',
    )) return;
    busy = true;
    refresh();
    $('fwl-file').disabled = true;
    $('fwl-progress').hidden = false;
    let began = false;
    try {
      phase('Hashing…');
      const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', image.bytes));
      const shaHex = Array.from(sha, (v) => v.toString(16).padStart(2, '0')).join('');
      log('', `SHA-256 ${shaHex}`);

      phase('Opening transfer session…');
      setBar(0, 1);
      await xfer(() => req.fwXferBegin(FW_TARGET.ESP32, image.bytes.length, sha), 'fw_xfer begin',
        { timeoutMs: RESP_TIMEOUT_LONG_MS });
      began = true;
      log('', `session open — sending ${fmtKb(image.bytes.length)} in ${FW_XFER_CHUNK}-byte chunks (stop-and-wait)`);

      const total = image.bytes.length;
      const t0 = performance.now();
      for (let off = 0; off < total; off += FW_XFER_CHUNK) {
        const chunk = image.bytes.subarray(off, Math.min(off + FW_XFER_CHUNK, total));
        await xfer(() => req.fwXferData(off, chunk), `fw_xfer data @${off}`, { isData: true });
        const sent = off + chunk.length;
        setBar(sent, total);
        const kbps = sent / 1024 / ((performance.now() - t0) / 1000);
        phase(`Uploading… ${fmtKb(sent)} / ${fmtKb(total)} (${kbps.toFixed(1)} KB/s)`);
      }
      log('', `upload done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);

      phase('Committing…');
      try {
        await xfer(() => req.fwXferEnd(1), 'fw_xfer end (commit)', { timeoutMs: RESP_TIMEOUT_LONG_MS });
      } catch (e) {
        if (e instanceof XferResultError) throw e; // decoded device error — a real failure
        // Timeout on END(commit=1): the ESP32 RESPs and then reboots straight
        // away, so a lost/late RESP here is indistinguishable from success.
        // Don't report a hard failure and don't fire END(commit=0) at a
        // possibly-rebooting device — say the outcome is unknown instead.
        began = false;
        phase('Commit outcome unknown — the ESP32 may be rebooting');
        log('err', `${e.message}`);
        log('', 'commit outcome UNKNOWN — the RESP was lost; the ESP32 may already be booting the new firmware. Verify with Ping in ~30 s before retrying.');
        toast('ESP32 commit outcome unknown — verify with Ping', 'err');
        return;
      }
      began = false; // session consumed — no abort needed past this point
      phase('Done — the ESP32 is rebooting into the new firmware');
      setBar(1, 1);
      log('event', 'commit accepted ✓ — SHA-256 verified, the ESP32 reboots into the new firmware now');
      log('', 'rollback safety: the new build boots pending-verify — if it fails to come up healthy, the previous slot is restored automatically');
      toast('ESP32 firmware installed ✓', 'ok');
    } catch (e) {
      log('err', `transfer failed: ${e.message}`);
      phase('Failed — see log below');
      toast('ESP32 firmware transfer failed', 'err');
      if (began) {
        // Best-effort session abort so a follow-up attempt starts clean
        // (BEGIN would implicitly abort too, and the receiver drops idle
        // sessions after 30 s — this just tidies up early).
        try {
          await sendExpectingResp(req.fwXferEnd(0), 'fw_xfer abort', 2000);
          log('', 'transfer session aborted');
        } catch { /* device unreachable — the idle timeout cleans up */ }
      }
    } finally {
      busy = false;
      $('fwl-file').disabled = false;
      refresh();
    }
  }

  // ------------------------------------------------------------------ boot

  $('fwl-file').onchange = onFileChange;
  $('fwl-flash').onclick = onFlash;
  refresh();

  return { setSerialConnected: refresh };
}
