// workers/detect.js
// AprilTag 25h9 detection worker.
// Loads wasm/apriltag.wasm via WXWebAssembly (base library >= 2.15.0 in workers).
// Receives camera RGBA frames, returns detected tags.

var MAX_DETS = 32;
var OUT_FLOATS = 1 + MAX_DETS * 11; // count + per-det {id,cx,cy,p0..p3}
var WASM_PATH = '/wasm/apriltag.wasm';

var ex = null;        // wasm exports
var ready = false;
var inPtr = 0, inCap = 0;
var outPtr = 0;

function makeImports() {
  return {
    env: {
      emscripten_notify_memory_growth: function () {}
    },
    wasi_snapshot_preview1: {
      clock_time_get: function (id, precision, outTimePtr) {
        // write 0ns (i64); timeprofile stats are unused
        if (ex && outTimePtr) {
          var m = new DataView(ex.memory.buffer);
          m.setUint32(outTimePtr, 0, true);
          m.setUint32(outTimePtr + 4, 0, true);
        }
        return 0;
      },
      fd_write: function (fd, iovs, iovsLen, nwrittenPtr) {
        // pretend to consume everything (stdout/stderr from debug_print)
        if (!ex) return 0;
        var m = new DataView(ex.memory.buffer);
        var total = 0;
        for (var i = 0; i < iovsLen; i++) {
          total += m.getUint32(iovs + i * 8 + 4, true);
        }
        m.setUint32(nwrittenPtr, total, true);
        return 0;
      },
      fd_read: function () { return 0; },
      fd_close: function () { return 0; },
      fd_seek: function (fd, offset, whence, newoffsetPtr) {
        if (ex && newoffsetPtr) {
          var m = new DataView(ex.memory.buffer);
          m.setUint32(newoffsetPtr, 0, true);
          m.setUint32(newoffsetPtr + 4, 0, true);
        }
        return 0;
      }
    }
  };
}

function ensureInCapacity(bytes) {
  if (bytes <= inCap) return;
  if (inPtr) ex.free(inPtr);
  inPtr = ex.malloc(bytes);
  inCap = bytes;
}

function initWasm() {
  if (typeof WXWebAssembly === 'undefined') {
    worker.postMessage({
      type: 'error',
      message: 'WXWebAssembly 不可用（需基础库 >= 2.15.0）'
    });
    return;
  }
  WXWebAssembly.instantiate(WASM_PATH, makeImports())
    .then(function (result) {
      var inst = result.instance || result; // WX returns {instance, module}
      ex = inst.exports;
      if (typeof ex._initialize === 'function') ex._initialize();
      var rc = ex.wxat_init();
      if (rc !== 0) {
        worker.postMessage({ type: 'error', message: 'wxat_init 失败 rc=' + rc });
        return;
      }
      outPtr = ex.malloc(OUT_FLOATS * 4);
      ready = true;
      worker.postMessage({ type: 'ready' });
    })
    .catch(function (e) {
      worker.postMessage({
        type: 'error',
        message: 'WASM 加载失败: ' + (e && e.message ? e.message : e)
      });
    });
}

function runDetect(msg) {
  var w = msg.width, h = msg.height;
  var bytes = w * h * 4;
  ensureInCapacity(bytes);

  // copy RGBA frame into wasm heap (fresh view: memory may have grown)
  new Uint8Array(ex.memory.buffer, inPtr, bytes).set(new Uint8Array(msg.data));

  var rc = ex.wxat_detect_rgba(inPtr, w, h, outPtr, MAX_DETS);
  if (rc !== 0) {
    worker.postMessage({ type: 'error', message: 'detect rc=' + rc });
    return;
  }

  var f32 = new Float32Array(ex.memory.buffer, outPtr, OUT_FLOATS);
  var n = f32[0] | 0;
  var dets = [];
  for (var i = 0; i < n; i++) {
    var o = 1 + i * 11;
    dets.push({
      id: f32[o] | 0,
      c: [f32[o + 1], f32[o + 2]],
      p: [
        [f32[o + 3], f32[o + 4]],
        [f32[o + 5], f32[o + 6]],
        [f32[o + 7], f32[o + 8]],
        [f32[o + 9], f32[o + 10]]
      ]
    });
  }

  worker.postMessage({
    type: 'dets',
    frameId: msg.frameId,
    width: w,
    height: h,
    detections: dets
  });
}

worker.onMessage(function (msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'frame') {
    if (ready) runDetect(msg);
    return;
  }
  if (msg.type === 'shutdown') {
    ready = false;
    try {
      if (ex) {
        ex.wxat_shutdown();
        if (inPtr) ex.free(inPtr);
        if (outPtr) ex.free(outPtr);
      }
    } catch (e) {}
    inPtr = 0; inCap = 0; outPtr = 0;
    return;
  }
});

initWasm();