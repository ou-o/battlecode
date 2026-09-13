// workers/detect.js
// AprilTag 25h9 detection worker.
// Loads wasm/apriltag.wasm via WXWebAssembly (base library >= 2.15.0 in workers).
// Receives camera RGBA frames, returns detected tags.
//
// 健壮性约定：任何一帧的处理都必须以一条回包结束（dets 或 error），
// 否则页面侧 _workerBusy 永不复位，识别会静默停摆。

var MAX_DETS = 32;
var OUT_FLOATS = 1 + MAX_DETS * 11; // count + per-det {id,cx,cy,p0..p3}
var WASM_PATH = '/wasm/apriltag.wasm';
var SLOW_MS = 600; // 检测耗时超过该值 → 下一帧降采样 2x2
var FAST_MS = 400; // 降采样后耗时低于该值 → 恢复全分辨率

var ex = null;        // wasm exports
var ready = false;
var inPtr = 0, inCap = 0;
var outPtr = 0;
var halfRes = false;  // 当前是否降采样跑（慢设备如无 wasm JIT 的鸿蒙）
var lastMs = 0;       // 上一帧 wasm 检测耗时

// 微信在 worker 线程注入全局 worker（onMessage/postMessage，大写 M）。
// 若运行时没注入，这里不抛异常 —— 主线程的判活 ping 会超时报错，
// 比 worker 加载即崩的完全静默要好排查。
var W = (typeof worker !== 'undefined' && worker) ? worker : null;

function post2main(obj) {
  if (!W) return;
  try { W.postMessage(obj); } catch (e) {}
}

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
    post2main({
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
        post2main({ type: 'error', message: 'wxat_init 失败 rc=' + rc });
        return;
      }
      outPtr = ex.malloc(OUT_FLOATS * 4);
      ready = true;
      post2main({ type: 'ready' });
    })
    .catch(function (e) {
      post2main({
        type: 'error',
        message: 'WASM 加载失败: ' + (e && e.message ? e.message : e)
      });
    });
}

// 全分辨率直拷（inCap 已保证 >= w*h*4）
function copyFull(data, w, h) {
  new Uint8Array(ex.memory.buffer, inPtr, w * h * 4).set(new Uint8Array(data));
  return { w: w, h: h };
}

// 2x2 降采样拷贝：每 2 行取 1 行、每 2 列取 1 列，输出紧密排列 RGBA
function copyHalf(data, w, h) {
  var w2 = w >> 1, h2 = h >> 1;
  var src = new Uint8Array(data);
  var dst = new Uint8Array(ex.memory.buffer, inPtr, w2 * h2 * 4);
  for (var y = 0; y < h2; y++) {
    var sRow = (y * 2) * w * 4;
    var dRow = y * w2 * 4;
    for (var x = 0; x < w2; x++) {
      var s = sRow + x * 8;
      var d = dRow + x * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }
  return { w: w2, h: h2 };
}

function runDetect(msg) {
  var w = msg.width, h = msg.height;
  var bytes = w * h * 4;
  var data = msg.data;
  // 帧数据校验：字节长度不符（如 NV21 / 带行对齐的帧）时明确报错，
  // 否则 Uint8Array.set 会抛 RangeError 且无回包。
  if (!data || typeof data.byteLength !== 'number' || data.byteLength !== bytes) {
    var actual = (data && typeof data.byteLength === 'number') ? data.byteLength : -1;
    post2main({
      type: 'error',
      message: '帧数据异常: ' + w + 'x' + h + ' 期望 ' + bytes + ' 字节, 实际 ' + actual
    });
    return;
  }
  ensureInCapacity(bytes);

  // 慢设备自适应：上帧太慢则降采样，降采样后够快则恢复
  var dims = halfRes ? copyHalf(data, w, h) : copyFull(data, w, h);
  var t0 = Date.now();
  var rc = ex.wxat_detect_rgba(inPtr, dims.w, dims.h, outPtr, MAX_DETS);
  lastMs = Date.now() - t0;
  if (!halfRes && lastMs > SLOW_MS) halfRes = true;
  else if (halfRes && lastMs <= FAST_MS) halfRes = false;

  if (rc !== 0) {
    post2main({ type: 'error', message: 'detect rc=' + rc });
    return;
  }

  var f32 = new Float32Array(ex.memory.buffer, outPtr, OUT_FLOATS);
  var n = f32[0] | 0;
  var dets = [];
  var kx = w / dims.w, ky = h / dims.h; // 检测坐标映射回原始帧像素
  for (var i = 0; i < n; i++) {
    var o = 1 + i * 11;
    dets.push({
      id: f32[o] | 0,
      c: [f32[o + 1] * kx, f32[o + 2] * ky],
      p: [
        [f32[o + 3] * kx, f32[o + 4] * ky],
        [f32[o + 5] * kx, f32[o + 6] * ky],
        [f32[o + 7] * kx, f32[o + 8] * ky],
        [f32[o + 9] * kx, f32[o + 10] * ky]
      ]
    });
  }

  var out = {
    type: 'dets',
    frameId: msg.frameId,
    width: w,
    height: h,
    ms: lastMs,
    raw: n,
    detections: dets
  };
  // 每隔一帧附一张输入缩略图：真机上直接看到 wasm 收到的画面——
  // 花屏/条纹=帧格式错，横竖颠倒/镜像=朝向错，全黑=帧内容异常。
  if (msg.frameId % 2 === 0) {
    try { out.thumb = buildThumb(data, w, h); } catch (e) {}
  }
  post2main(out);
}

// 从原始 RGBA 帧抽 ~120px 宽的小图（nearest 采样），用于真机诊断
function buildThumb(data, w, h) {
  var tw = 120;
  var th = Math.max(1, Math.round(h * tw / w));
  var src = new Uint8Array(data);
  var out = new Uint8Array(tw * th * 4);
  for (var ty = 0; ty < th; ty++) {
    var srow = Math.min(h - 1, Math.floor(ty * h / th)) * w * 4;
    var drow = ty * tw * 4;
    for (var tx = 0; tx < tw; tx++) {
      var s = srow + Math.min(w - 1, Math.floor(tx * w / tw)) * 4;
      var d = drow + tx * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = 255;
    }
  }
  return { w: tw, h: th, data: out.buffer };
}

// 尽早上报 boot：主线程以此判断 worker 脚本已成功执行（区别于 wasm 初始化慢）。
post2main({ type: 'boot' });

if (W) {
  W.onMessage(function (msg) {
    if (!msg || !msg.type) return;
    try {
      if (msg.type === 'ping') {
        post2main({ type: 'pong' });
        return;
      }
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
    } catch (e) {
      // 必须回包，否则页面 _workerBusy 永久锁死（识别静默停摆）
      post2main({ type: 'error', message: 'worker 异常: ' + (e && e.message ? e.message : e) });
    }
  });
}

initWasm();
