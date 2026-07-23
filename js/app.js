// App glue: transports → deframer → state → DOM.

import {
  ADDR, CLASS, OP, FLAG, PWR2_FLAG, NET_CONFIG_ITEM, NODE_NAMES,
  CHARGE_STATE_NAMES, POWER_EVENT_NAMES, Deframer, frameSeq, req,
  decodePowerStatusV2, decodeSysLog, decodeSysPong, decodePowerEvent, decodeNetConfigResult,
} from './wups.js';
import { SerialTransport, DemoTransport } from './transport.js';
import { SeriesStore, TimelineChart, Sparkline, renderTable, SERIES_COLORS } from './charts.js';
import { initFirmware } from './firmware.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state

let transport = null;
let mode = 'disconnected'; // disconnected | connected | demo
let framesOk = 0;
let framesErr = 0;
let reconnectTimer = null;
let manualDisconnect = false; // suppresses auto-reconnect after user-initiated disconnect
let connecting = false; // in-flight connect guard — one attempt at a time
const pending = new Map(); // seq -> {label, resolve, timer}

const voltStore = new SeriesStore(['Vout', 'Vin', 'Vbat']);
let voltChart = null;
let iinSpark = null;
let tableVisible = false;
let firmware = null; // Firmware card controller (firmware.js)

// ---------------------------------------------------------------- helpers

const fmtV = (mv) => (mv / 1000).toFixed(2);
const fmtA = (ma) => (ma / 1000).toFixed(2);
const fmtT = (dc) => (dc === -32768 ? 'n/a' : `${(dc / 10).toFixed(1)}°C`);
const fmtUptime = (s) =>
  `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

function badge(el, kind, text) {
  el.className = `badge ${kind}`;
  el.textContent = text;
}

function logLine(cls, src, text) {
  const host = $('log');
  const div = document.createElement('div');
  div.className = `log-line ${cls}`;
  // mirror the toggle-handler rule: err/event lines stay visible in PD-only mode
  if (cls === '' && $('log-pd-only').checked && !text.startsWith('PD:')) div.hidden = true;
  const now = new Date();
  const stamp = now.toTimeString().slice(0, 8);
  div.innerHTML = `<span class="t">${stamp}</span><span class="src">[${src}]</span><span class="msg"></span>`;
  div.querySelector('.msg').textContent = text;
  host.append(div);
  while (host.childElementCount > 250) host.firstElementChild.remove();
  host.scrollTop = host.scrollHeight;
}

// ---------------------------------------------------------------- frame handling

const deframer = new Deframer(onFrame, () => { framesErr += 1; });

function onFrame(frame) {
  framesOk += 1;

  if (frame.flags & FLAG.RESP) {
    const waiter = pending.get(frame.seq);
    if (waiter) {
      pending.delete(frame.seq);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
  }

  if (frame.cls === CLASS.POWER && frame.op === OP.POWER.STATUS) {
    const s = decodePowerStatusV2(frame.payload);
    if (s) renderStatus(s);
  } else if (frame.cls === CLASS.SYSTEM && frame.op === OP.SYSTEM.LOG) {
    const l = decodeSysLog(frame.payload);
    if (l) logLine(l.text.startsWith('PD:') ? 'pd' : '', NODE_NAMES[frame.src] ?? '?', l.text);
  } else if (frame.cls === CLASS.POWER && frame.op === OP.POWER.EVENT) {
    const e = decodePowerEvent(frame.payload);
    if (e) {
      const name = POWER_EVENT_NAMES[e.event] ?? `event ${e.event}`;
      logLine('event', NODE_NAMES[frame.src] ?? '?', `⚡ ${name}`);
      toast(`UPS: ${name}`, e.event === 2 || e.event === 4 ? 'ok' : 'err');
    }
  }
}

function sendExpectingResp(frame, label, timeoutMs = 2500) {
  if (!transport) return Promise.reject(new Error('not connected'));
  return new Promise((resolve, reject) => {
    const seq = frameSeq(frame);
    const timer = setTimeout(() => {
      pending.delete(seq);
      reject(new Error(`${label}: timeout`));
    }, timeoutMs);
    pending.set(seq, { label, resolve, timer });
    transport.write(frame).catch((e) => {
      clearTimeout(timer);
      pending.delete(seq);
      reject(e);
    });
  });
}

// ---------------------------------------------------------------- rendering

function renderStatus(s) {
  const f = s.flags;
  const railOn = f & PWR2_FLAG.VBUS_OUT_EN;
  const mains = f & PWR2_FLAG.POWER_GOOD;
  const battPresent = f & PWR2_FLAG.BATT_PRESENT;

  $('t-vout').innerHTML = `${fmtV(s.voutReadMv)}<small>V</small>`;
  $('t-vout-sub').textContent = s.pdOutMv
    ? `PD ${fmtV(s.pdOutMv)} V / ${fmtA(s.pdOutMa)} A · limit ${fmtA(s.ioutLimitMa)} A`
    : 'no PD contract';
  badge($('b-rail'), railOn ? 'good' : 'crit', railOn ? 'ON' : 'OFF');

  $('t-vin').innerHTML = `${fmtV(s.vbusInMv)}<small>V</small>`;
  $('t-vin-sub').textContent = s.pdInMv ? `PD ${fmtV(s.pdInMv)} V / ${fmtA(s.pdInMa)} A` : 'no input contract';
  badge($('b-mains'), mains ? 'good' : 'crit', mains ? 'MAINS' : 'ON BATTERY');

  $('t-vbat').innerHTML = `${fmtV(s.vbatMv)}<small>V</small>`;
  $('t-vbat-sub').textContent = `${CHARGE_STATE_NAMES[s.chargeState] ?? '?'} · ${s.ichgMa} mA`;
  badge($('b-batt'), battPresent ? (s.chargeState === 3 ? 'good' : 'warn') : 'crit',
    battPresent ? (CHARGE_STATE_NAMES[s.chargeState] ?? '?') : 'MISSING');

  $('t-iin').innerHTML = `${fmtA(s.iinMa)}<small>A</small>`;
  iinSpark?.push(s.iinMa / 1000);

  const hotter = s.tempMpDc === -32768 ? s.tempLmDc : Math.max(s.tempLmDc, s.tempMpDc);
  $('t-temp').innerHTML = `${fmtT(s.tempLmDc).replace('°C', '')}<small>°C</small>`;
  $('t-temp-sub').textContent = `charger ${fmtT(s.tempMpDc)}`;
  badge($('b-temp'), hotter >= 950 ? 'crit' : hotter >= 850 ? 'warn' : 'good',
    hotter >= 950 ? 'HOT' : hotter >= 850 ? 'WARM' : 'OK');

  badge($('b-fault'), s.faults ? 'crit' : 'good', s.faults ? `0x${s.faults.toString(16).toUpperCase()}` : 'NONE');
  $('t-uptime').textContent = fmtUptime(s.uptimeS);

  voltStore.push([s.voutReadMv / 1000, s.vbusInMv / 1000, s.vbatMv / 1000]);
  voltChart?.update();
  if (tableVisible) renderTable($('table-volt'), voltStore);
}

function setMode(next) {
  mode = next;
  const pill = $('conn-pill');
  pill.dataset.state = next;
  $('conn-label').textContent = next === 'connected' ? 'Connected' : next === 'demo' ? 'Demo mode' : 'Disconnected';
  const live = next !== 'disconnected';
  $('gate').hidden = live;
  for (const id of ['live', 'chart-card', 'log-card', 'info-card']) $(id).hidden = !live;
  $('btn-connect').hidden = live;
  $('btn-demo').hidden = live;
  $('btn-disconnect').hidden = !live;
  for (const id of ['cmd-ping', 'cmd-beep', 'cmd-pwr-enable', 'cmd-pwr-cycle', 'cmd-pwr-disable', 'cmd-ups-reset', 'cfg-apply-url'])
    $(id).disabled = !live;
  if (!live) $('info-body').textContent = '';
  firmware?.setSerialConnected(next === 'connected'); // BOOTSEL reboot needs the real link
}

// ---------------------------------------------------------------- connect / disconnect

function makeCallbacks() {
  return {
    onData: (chunk) => deframer.feed(chunk),
    onStateChange: (state) => {
      if (state === 'disconnected') {
        deframer.reset();
        setMode('disconnected');
        if (manualDisconnect) {
          manualDisconnect = false;
          return; // the user asked for this — no error line, no auto-reconnect
        }
        logLine('err', 'link', 'serial link lost');
        scheduleReconnect();
      } else {
        setMode(state);
      }
    },
  };
}

async function connectSerial({ interactive }) {
  if (!SerialTransport.supported()) {
    $('gate-unsupported').hidden = false;
    if (interactive) toast('Web Serial not available in this browser', 'err');
    return;
  }
  if (connecting || mode !== 'disconnected') return;
  connecting = true;
  const t = new SerialTransport(makeCallbacks());
  try {
    deframer.reset();
    const ok = interactive ? await t.connect() : await t.tryReconnect();
    if (ok) {
      transport = t; // publish only a successfully opened transport
      clearInterval(reconnectTimer);
      logLine('', 'link', 'connected');
      pingAll().catch(() => {});
    }
  } catch (e) {
    if (interactive && e.name !== 'NotFoundError') toast(`Connect failed: ${e.message}`, 'err');
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  // After "power-cycle output" the CDC drops and re-enumerates once the PD
  // contract (and DR_Swap) re-establish — quietly re-attach to the granted port.
  clearInterval(reconnectTimer);
  const pill = $('conn-pill');
  pill.dataset.state = 'reconnecting';
  $('conn-label').textContent = 'Reconnecting…';
  let attempts = 0;
  reconnectTimer = setInterval(async () => {
    attempts += 1;
    if (mode !== 'disconnected' || attempts > 20) {
      clearInterval(reconnectTimer);
      if (mode === 'disconnected') setMode('disconnected'); // restore pill text
      return;
    }
    await connectSerial({ interactive: false });
  }, 2000);
}

async function disconnect() {
  clearInterval(reconnectTimer);
  manualDisconnect = true;
  await transport?.disconnect();
  transport = null;
  setMode('disconnected');
}

// ---------------------------------------------------------------- commands

async function pingAll() {
  const lines = [];
  for (const dst of [ADDR.RP2040, ADDR.CH32X, ADDR.ESP32]) {
    const name = NODE_NAMES[dst];
    const t0 = performance.now();
    try {
      const resp = await sendExpectingResp(req.ping(dst), `ping ${name}`, 1500);
      const pong = decodeSysPong(resp.payload);
      const rtt = (performance.now() - t0).toFixed(0);
      const fw = pong
        ? (pong.fwStr ?? `${pong.fwVersion >> 8}.${pong.fwVersion & 0xff}`)
        : null;
      lines.push(pong
        ? `${name.padEnd(7)} fw ${fw}  up ${fmtUptime(Math.floor(pong.uptimeMs / 1000))}  rtt ${rtt} ms`
        : `${name.padEnd(7)} pong (unparsed)  rtt ${rtt} ms`);
    } catch {
      lines.push(`${name.padEnd(7)} no response`);
    }
    $('info-body').textContent = lines.join('\n');
  }
  return lines;
}

function wireCommands() {
  $('cmd-ping').onclick = async () => {
    $('cmd-result').textContent = 'pinging…';
    const lines = await pingAll();
    $('cmd-result').textContent = lines.join('\n');
  };

  $('cmd-beep').onclick = async () => {
    try {
      await transport.write(req.uiBeep(1000, 150));
      $('cmd-result').textContent = 'beep sent';
    } catch (e) {
      $('cmd-result').textContent = `beep failed: ${e.message}`;
    }
  };

  const confirmAnd = (question, frameFn, label) => async () => {
    if (!window.confirm(question)) return;
    try {
      await transport.write(frameFn());
      $('cmd-result').textContent = `${label} sent`;
      toast(label, 'ok');
    } catch (e) {
      $('cmd-result').textContent = `${label} failed: ${e.message}`;
    }
  };

  $('cmd-pwr-enable').onclick = confirmAnd('Enable the output rail?', req.powerEnable, 'output enable');
  $('cmd-pwr-disable').onclick = confirmAnd(
    'Turn the output OFF? This computer will switch to its own battery and the link will drop.',
    req.powerDisable, 'output disable');
  $('cmd-pwr-cycle').onclick = confirmAnd(
    'Power-cycle the output (1.5 s off)? The link will drop and auto-reconnect.',
    () => req.powerCycle(1500), 'power-cycle');
  $('cmd-ups-reset').onclick = confirmAnd(
    'Reset the UPS power MCU (CH32X)? Output may glitch during re-init.',
    req.powerReset, 'UPS MCU reset');
}

// ---------------------------------------------------------------- HTTP config

function wireConfig() {
  const apply = (item, value, label) => async () => {
    const btn = $('cfg-apply-url');
    btn.disabled = true;
    $('cfg-result').textContent = `${label}: sending…`;
    try {
      const resp = await sendExpectingResp(req.netConfig(item, value()), label, 4000);
      const r = decodeNetConfigResult(resp.payload);
      if (r && r.result === 0) {
        $('cfg-result').textContent = `${label}: stored in NVS ✓`;
        toast(`${label} saved`, 'ok');
      } else {
        $('cfg-result').textContent = `${label}: device returned error ${r ? r.result : '?'}`;
        toast(`${label} rejected by device`, 'err');
      }
    } catch (e) {
      $('cfg-result').textContent = `${label}: ${e.message} — is the device in reach and the M.2 module fitted?`;
    } finally {
      btn.disabled = mode === 'disconnected';
    }
  };

  $('cfg-apply-url').onclick = apply(NET_CONFIG_ITEM.HTTP_URL, () => $('cfg-url').value.trim(), 'HTTP URL');
}

// ---------------------------------------------------------------- boot

function boot() {
  voltChart = new TimelineChart($('chart-volt'), voltStore, { unit: ' V' });
  iinSpark = new Sparkline($('spark-iin'), { color: SERIES_COLORS[1], fmt: (v) => `${v.toFixed(2)} A` });

  $('btn-connect').onclick = () => connectSerial({ interactive: true });
  $('btn-disconnect').onclick = disconnect;
  $('btn-demo').onclick = async () => {
    if (connecting || mode !== 'disconnected') return;
    clearInterval(reconnectTimer);
    deframer.reset();
    const t = new DemoTransport(makeCallbacks());
    await t.connect();
    transport = t;
    pingAll().catch(() => {});
  };

  $('btn-table').onclick = () => {
    tableVisible = !tableVisible;
    $('btn-table').setAttribute('aria-pressed', String(tableVisible));
    $('table-volt').hidden = !tableVisible;
    $('chart-volt').hidden = tableVisible;
    if (tableVisible) renderTable($('table-volt'), voltStore);
  };

  $('log-pd-only').onchange = () => {
    const only = $('log-pd-only').checked;
    for (const line of $('log').children) {
      const isPd = line.classList.contains('pd') || line.classList.contains('event') || line.classList.contains('err');
      line.hidden = only && !isPd;
    }
  };

  wireCommands();
  wireConfig();
  firmware = initFirmware({
    isSerialConnected: () => mode === 'connected',
    closeSerial: disconnect,
    toast,
    sendExpectingResp, // ESP32-via-link firmware transfer rides the session
  });

  if (!SerialTransport.supported()) {
    // Capability-based, not UA sniffing: navigator.serial is the one thing
    // that matters. The message just adapts for the phone/tablet case.
    $('gate-unsupported').hidden = false;
    $('btn-connect').hidden = true;
    const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
    if (mobile) {
      $('unsupported-title').textContent = 'Phones and tablets are not supported';
      $('unsupported-text').innerHTML =
        'Mobile browsers do not expose the Web Serial API. Open this page on a <b>computer</b> in one of:';
    }
  } else {
    connectSerial({ interactive: false }); // silent re-attach to a granted port
  }
}

boot();
