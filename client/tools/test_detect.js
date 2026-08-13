#!/usr/bin/env node
// Node sanity test: renders synthetic 25h9 tag markers and verifies the
// compiled wasm/apriltag.wasm detects and decodes them. Only the 25h9 family
// is built in; no runtime family switching.
//
// Usage: node tools/test_detect.js [path/to/apriltag.wasm]

const fs = require('fs');
const path = require('path');

const WASM = process.argv[2] ||
  path.join(__dirname, '..', 'wasm', 'apriltag.wasm');

// 25h9 family metadata, mirrors wasm/wxat.c (only 25h9 compiled in).
// BIT_X/BIT_Y describe the active payload bit cells within a `total_width`
// by `total_width` grid. The +1 offset below moves (bit_x,bit_y) one cell
// inside the 1-cell wide black/white border that surrounds every marker.
// CODES is the apriltag library's per-id codedata for the family.
const FAM = {
  name: '25h9', total_width: 9, nbits: 25,
  idsToTest: [0, 1, 8, 12, 29],
  BIT_X: [1, 2, 3, 4, 2, 3, 5, 5, 5, 5, 4, 4, 5, 4, 3, 2, 4, 3, 1, 1, 1, 1, 2, 2, 3],
  BIT_Y: [1, 1, 1, 1, 2, 2, 1, 2, 3, 4, 2, 3, 5, 5, 5, 5, 4, 4, 5, 4, 3, 2, 4, 3, 3],
  CODES: [
    0x156f1f4, 0x1f28cd5, 0x16ce32c, 0x1ea379c, 0x1390f89, 0x34fad0,
    0x7dcdb5, 0x119ba95, 0x1ae9daa, 0xdf02aa, 0x82fc15, 0x465123,
    0xceee98, 0x1f17260, 0x14429cd, 0x17248a8, 0x16ad452, 0x9670ad,
    0x16f65b2, 0xb8322b, 0x5d715b, 0x1a1c7e7, 0xd7890d, 0x1813522,
    0x1c9c611, 0x99e4a4, 0x855234, 0x17b81c0, 0xc294bb, 0x89fae3,
    0x44df5f, 0x1360159, 0xec31e8, 0x1bcc0f6, 0xa64f8d
  ]
};

// --- Marker renderer (RGBA grayscale) ---------------------------------------
function renderTag(fam, id, imgW, imgH, cellPx) {
  const rgba = new Uint8Array(imgW * imgH * 4).fill(255);
  const tagPx = fam.total_width * cellPx;
  const ox = Math.floor((imgW - tagPx) / 2);
  const oy = Math.floor((imgH - tagPx) / 2);
  const code = BigInt(fam.CODES[id]);
  const setCell = new Set();
  for (let i = 0; i < fam.nbits; i++) {
    if (code & (1n << BigInt(fam.nbits - i - 1))) {
      setCell.add((fam.BIT_Y[i] + 1) * fam.total_width + (fam.BIT_X[i] + 1));
    }
  }
  const last = fam.total_width - 1;
  for (let cy = 0; cy < fam.total_width; cy++) {
    for (let cx = 0; cx < fam.total_width; cx++) {
      const isBorder = (cx === 0 || cx === last || cy === 0 || cy === last);
      const isPayloadBit = setCell.has(cy * fam.total_width + cx);
      const white = isBorder || isPayloadBit;
      const v = white ? 255 : 0;
      for (let py = 0; py < cellPx; py++) {
        for (let px = 0; px < cellPx; px++) {
          const o = ((oy + cy * cellPx + py) * imgW + (ox + cx * cellPx + px)) * 4;
          rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
          rgba[o + 3] = 255;
        }
      }
    }
  }
  return rgba;
}

// --- Run --------------------------------------------------------------------
const imports = {
  env: { emscripten_notify_memory_growth: () => {} },
  wasi_snapshot_preview1: {
    clock_time_get: () => 0,
    fd_write: () => 0,
    fd_read: () => 0,
    fd_close: () => 0,
    fd_seek: () => 0
  }
};

(async () => {
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(WASM), imports);
  const ex = instance.exports;
  if (typeof ex._initialize === 'function') ex._initialize();

  if (ex.wxat_init() !== 0) throw new Error('wxat_init failed');

  // Sanity: 25h9 is the only family; wxat_set_family must not be exported.
  if (typeof ex.wxat_set_family === 'function') {
    throw new Error('wxat_set_family should not be exported in 25h9-only build');
  }

  const W = 480, H = 360, CELL = 16;
  const inPtr = ex.malloc(W * H * 4);
  const outPtr = ex.malloc(4 * (1 + 32 * 11));

  let failed = 0;
  for (const tid of FAM.idsToTest) {
    const img = renderTag(FAM, tid, W, H, CELL);
    new Uint8Array(ex.memory.buffer, inPtr, W * H * 4).set(img);
    const t0 = Date.now();
    ex.wxat_detect_rgba(inPtr, W, H, outPtr, 32);
    const ms = Date.now() - t0;
    const f = new Float32Array(ex.memory.buffer, outPtr, 1 + 32 * 11);
    const n = f[0], decoded = n > 0 ? f[1] : -1;
    const ok = n === 1 && decoded === tid;
    if (!ok) failed++;
    console.log(`tag${FAM.name} ${tid}: detections=${n} decoded=${decoded} (${ms}ms) ${ok ? 'OK' : 'FAIL'}`);
  }

  ex.free(inPtr);
  ex.free(outPtr);
  ex.wxat_shutdown();

  if (failed) {
    console.log(`FAIL (${failed} tags)`);
    process.exit(1);
  }
  console.log('PASS');
})().catch(e => { console.error(e); process.exit(1); });