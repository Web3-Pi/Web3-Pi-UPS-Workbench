// Plain-node test for the net.fw_xfer codec (js/wups.js) and js/md5.js —
// run with: node tools/test-wups-fw.mjs
// Byte-literal assertions against Web3-Pi-UPS/common/protocol.h:
//   WUPS_OP_NET_FW_XFER_BEGIN 0x23  wups_net_fw_xfer_begin_v1_t (40 B)
//   WUPS_OP_NET_FW_XFER_DATA  0x24  u32 offset LE + raw bytes
//   WUPS_OP_NET_FW_XFER_END   0x25  wups_net_fw_xfer_end_v1_t (4 B)
//   WUPS_FW_XFER_CHUNK = WUPS_MAX_PAYLOAD - 4 = 236
// No dependencies, no test framework (same pattern as test-uf2.mjs).

import { createHash } from 'node:crypto';
import {
  OP, ADDR, CLASS, FLAG, MAX_PAYLOAD, FW_TARGET, FW_XFER_CHUNK, FW_XFER_OK,
  FW_XFER_RESULT_NAMES, req, fletcher8, decodeFwXferResult, Deframer,
} from '../js/wups.js';
import { md5Hex } from '../js/md5.js';

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

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: got ${actual}, expected ${expected}`);
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

/** Common frame envelope checks; returns the payload as Uint8Array. */
function checkEnvelope(frame, op, payloadLen) {
  assertEq(frame.length, 14 + payloadLen, 'frame length');
  assertEq(frame[0], 0xaa, 'SYNC1');
  assertEq(frame[1], 0x55, 'SYNC2');
  assertEq(frame[2], 0x04, 'DST (WUPS_ADDR_ESP32)');
  assertEq(frame[3], 0x01, 'SRC (WUPS_ADDR_RPI)');
  assertEq(frame[4], 0x03, 'CLASS (WUPS_CLASS_NET)');
  assertEq(frame[5], op, 'OP');
  assertEq(frame[6], 0x01, 'FLAGS (WUPS_FLAG_REQ)');
  assertEq(frame[8], payloadLen & 0xff, 'LEN_L');
  assertEq(frame[9], (payloadLen >> 8) & 0xff, 'LEN_H');
  const [ckA, ckB] = fletcher8(frame.subarray(2, 10 + payloadLen));
  assertEq(frame[10 + payloadLen], ckA, 'CK_A');
  assertEq(frame[11 + payloadLen], ckB, 'CK_B');
  assertEq(frame[12 + payloadLen], 0x55, 'END1');
  assertEq(frame[13 + payloadLen], 0xaa, 'END2');
  return frame.subarray(10, 10 + payloadLen);
}

// ------------------------------------------------------------ constants

console.log('protocol constants:');
test('op codes match protocol.h', () => {
  assertEq(OP.NET.FW_XFER_BEGIN, 0x23, 'WUPS_OP_NET_FW_XFER_BEGIN');
  assertEq(OP.NET.FW_XFER_DATA, 0x24, 'WUPS_OP_NET_FW_XFER_DATA');
  assertEq(OP.NET.FW_XFER_END, 0x25, 'WUPS_OP_NET_FW_XFER_END');
});
test('targets and chunk size match protocol.h', () => {
  assertEq(FW_TARGET.ESP32, 1, 'WUPS_FW_TARGET_ESP32');
  assertEq(FW_TARGET.RP2040, 2, 'WUPS_FW_TARGET_RP2040');
  assertEq(MAX_PAYLOAD, 240, 'WUPS_MAX_PAYLOAD');
  assertEq(FW_XFER_CHUNK, 236, 'WUPS_FW_XFER_CHUNK (MAX_PAYLOAD - 4)');
});
test('result codes match protocol.h', () => {
  assertEq(FW_XFER_OK, 0, 'WUPS_FW_XFER_OK');
  assertEq(FW_XFER_RESULT_NAMES[1], 'BAD_REQ', 'WUPS_FW_XFER_BAD_REQ');
  assertEq(FW_XFER_RESULT_NAMES[2], 'BUSY', 'WUPS_FW_XFER_BUSY');
  assertEq(FW_XFER_RESULT_NAMES[3], 'SEQ_MISMATCH', 'WUPS_FW_XFER_SEQ_MISMATCH');
  assertEq(FW_XFER_RESULT_NAMES[4], 'FLASH_ERR', 'WUPS_FW_XFER_FLASH_ERR');
  assertEq(FW_XFER_RESULT_NAMES[5], 'VERIFY_FAIL', 'WUPS_FW_XFER_VERIFY_FAIL');
});

// ------------------------------------------------------------ encoders

console.log('fw_xfer_begin:');
test('40-byte payload, exact field offsets', () => {
  const sha = Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + i);
  const frame = req.fwXferBegin(FW_TARGET.ESP32, 0x00123456, sha);
  const p = checkEnvelope(frame, 0x23, 40);
  assertEq(p[0], 0x01, 'version');
  assertEq(p[1], 0x01, 'target (ESP32)');
  assertEq(p[2], 0x00, 'reserved[0]');
  assertEq(p[3], 0x00, 'reserved[1]');
  // image_len u32 LE at offset 4
  assertEq(p[4], 0x56, 'image_len byte 0');
  assertEq(p[5], 0x34, 'image_len byte 1');
  assertEq(p[6], 0x12, 'image_len byte 2');
  assertEq(p[7], 0x00, 'image_len byte 3');
  // raw sha256[32] at offset 8
  for (let i = 0; i < 32; i += 1) assertEq(p[8 + i], 0xc0 + i, `sha256[${i}]`);
});
test('RP2040 target byte', () => {
  const p = checkEnvelope(req.fwXferBegin(FW_TARGET.RP2040, 1, new Uint8Array(32)), 0x23, 40);
  assertEq(p[1], 0x02, 'target (RP2040)');
});
test('rejects a non-raw sha256', () =>
  assertThrows(() => req.fwXferBegin(FW_TARGET.ESP32, 1, new Uint8Array(64)), /32 raw bytes/, 'hex-length sha'));

console.log('fw_xfer_data:');
test('u32 offset LE + raw bytes', () => {
  const frame = req.fwXferData(0x11223344, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
  const p = checkEnvelope(frame, 0x24, 8);
  assertEq(p[0], 0x44, 'offset byte 0');
  assertEq(p[1], 0x33, 'offset byte 1');
  assertEq(p[2], 0x22, 'offset byte 2');
  assertEq(p[3], 0x11, 'offset byte 3');
  assertEq(p[4], 0xde, 'data[0]');
  assertEq(p[7], 0xef, 'data[3]');
});
test('max chunk fills the payload to WUPS_MAX_PAYLOAD', () => {
  const frame = req.fwXferData(0, new Uint8Array(FW_XFER_CHUNK).fill(0x5a));
  const p = checkEnvelope(frame, 0x24, 240);
  assertEq(frame.length, 254, 'WUPS_MAX_FRAME');
  assertEq(p[4 + FW_XFER_CHUNK - 1], 0x5a, 'last data byte');
});
test('rejects an oversized chunk', () =>
  assertThrows(() => req.fwXferData(0, new Uint8Array(FW_XFER_CHUNK + 1)), /236/, 'chunk 237'));
test('rejects an empty chunk', () =>
  assertThrows(() => req.fwXferData(0, new Uint8Array(0)), /1\.\.236/, 'chunk 0'));

console.log('fw_xfer_end:');
test('commit=1', () => {
  const p = checkEnvelope(req.fwXferEnd(1), 0x25, 4);
  assertEq(p[0], 0x01, 'version');
  assertEq(p[1], 0x01, 'commit');
  assertEq(p[2], 0x00, 'reserved[0]');
  assertEq(p[3], 0x00, 'reserved[1]');
});
test('commit=0 (abort)', () => {
  const p = checkEnvelope(req.fwXferEnd(0), 0x25, 4);
  assertEq(p[1], 0x00, 'commit');
});

// ------------------------------------------------------------ decoder + roundtrip

console.log('fw_xfer RESP decode:');
test('result byte and names', () => {
  assertEq(decodeFwXferResult(Uint8Array.of(0)).name, 'OK', 'OK');
  assertEq(decodeFwXferResult(Uint8Array.of(5)).name, 'VERIFY_FAIL', 'VERIFY_FAIL');
  assertEq(decodeFwXferResult(Uint8Array.of(9)).name, 'result 9', 'unknown code');
  assertEq(decodeFwXferResult(new Uint8Array(0)), null, 'empty payload');
});
test('encoded BEGIN survives the streaming deframer', () => {
  const sha = new Uint8Array(32).fill(0xab);
  const sent = req.fwXferBegin(FW_TARGET.ESP32, 0xdeadbe, sha);
  let got = null;
  const d = new Deframer((f) => { got = f; }, (e) => { throw new Error(`deframe error ${e}`); });
  d.feed(sent.subarray(0, 11)); // split mid-payload
  d.feed(sent.subarray(11));
  assert(got, 'no frame emitted');
  assertEq(got.cls, CLASS.NET, 'class');
  assertEq(got.op, OP.NET.FW_XFER_BEGIN, 'op');
  assertEq(got.dst, ADDR.ESP32, 'dst');
  assertEq(got.flags, FLAG.REQ, 'flags');
  assertEq(got.payload.length, 40, 'payload length');
  assertEq(new DataView(got.payload.buffer, got.payload.byteOffset).getUint32(4, true), 0xdeadbe, 'image_len');
});

// ------------------------------------------------------------ md5 (esptool verify)

console.log('md5 (RFC 1321 vectors):');
const MD5_VECTORS = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
];
for (const [input, expected] of MD5_VECTORS) {
  test(`md5("${input.length > 24 ? `${input.slice(0, 21)}…` : input}")`, () =>
    assertEq(md5Hex(new TextEncoder().encode(input)), expected, 'digest'));
}
test('md5 of binary buffers matches node:crypto', () => {
  const cases = [
    new Uint8Array(0x6000).fill(0xff), // the NVS-erase block flashed by fw-esp32-usb.js
    Uint8Array.from({ length: 100000 }, (_, i) => (i * 7 + (i >> 3)) & 0xff),
    new Uint8Array(56), // padding edge: length ≡ 56 (mod 64)
    new Uint8Array(64), // padding edge: exact block
  ];
  for (const bytes of cases) {
    const expected = createHash('md5').update(bytes).digest('hex');
    assertEq(md5Hex(bytes), expected, `buffer[${bytes.length}]`);
  }
});

// ------------------------------------------------------------------ summary

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
