// utils/detectWorker.js — 全局唯一的 AprilTag 检测 worker 单例。
//
// 背景：微信里 wx.createWorker('workers/detect.js') 是单例——整个小程序同一
// 时刻只能存在这一个 worker。战斗页(index)、直接识别页(scan) 各自 createWorker
// 再反复 terminate()，但已实例化过 wasm 的 worker 的 terminate 并不可靠：worker
// 线程没被真正销毁、'ready' 已经被前一页消费掉；战斗页再 createWorker 拿回的是
// 同一个 worker，onMessage 被后建的页面覆盖，却永远等不到 ready → 卡在加载中。
// 这就是真机上看到的「worker 被占用、进战斗页后无法识别」。
//
// 解法：全应用只创建一个 worker，页面通过 subscribe() 订阅消息、退出时取消订阅，
// 不重建不 terminate。已 ready 的 worker 对新订阅者立即补发一次 ready，保证任何
// 页面进入（含战斗中途）都不会傻等状态。

var worker = null;
var ready = false;       // worker 内 wasm 是否已就绪
var fatalError = null;   // 若有致命错误，保留并播报给后续订阅者
var subs = [];           // 订阅者回调集合（各页面）

function dispatch(res) {
  for (var i = 0; i < subs.length; i++) {
    try { subs[i](res); } catch (e) {}
  }
}

function fail(msg) {
  if (!fatalError) fatalError = msg;
  dispatch({ type: 'error', message: msg });
  return null;
}

function ensureWorker() {
  if (worker) return worker;
  var w;
  try {
    w = wx.createWorker('workers/detect.js');
  } catch (e) {
    return fail('Worker 创建失败: ' + e.message);
  }
  if (!w) {
    return fail('Worker 未注册，请确认 app.json 的 workers 字段后重新编译');
  }
  worker = w;
  worker.onMessage(function (res) {
    if (res && res.type === 'ready') ready = true;
    if (res && res.type === 'error' && !fatalError) fatalError = res.message;
    dispatch(res);
  });
  return worker;
}

// 订阅 worker 消息。返回取消订阅函数。若已 ready，先立即补发一次 {type:'ready'}。
function subscribe(fn) {
  ensureWorker();
  if (!worker) return function () {};
  subs.push(fn);
  if (ready) {
    try { fn({ type: 'ready' }); } catch (e) {}
  } else if (fatalError) {
    try { fn({ type: 'error', message: fatalError }); } catch (e) {}
  }
  return function unsubscribe() {
    var i = subs.indexOf(fn);
    if (i >= 0) subs.splice(i, 1);
  };
}

// 向 worker 投递一帧或消息（惰性创建）。对所有消费者复用同一个实例。
function post(msg) {
  var w = ensureWorker();
  if (w) { try { w.postMessage(msg); } catch (e) {} }
}

module.exports = { subscribe: subscribe, post: post };