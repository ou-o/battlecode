// utils/ws.js — thin WeChat WebSocket bridge with JSON envelope {t, ...payload}.
// Singleton accessible via require('../../utils/ws.js').getWs().

const app = getApp();

let _ws = null;
let _url = null;
let _handlers = {};       // t -> Set<fn>
let _onceHandlers = {};   // t -> Set<fn>
let _pingTimer = null;
let _reconnectTimer = null;
let _manualClose = false;
let _queued = [];

function getWs() {
  if (_ws) return _ws;
  _ws = createWs();
  return _ws;
}

function createWs() {
  _url = app.globalData.serverUrl + '/socket';
  _manualClose = false;
  const ws = wx.connectSocket({ url: _url, fail: (e) => console.warn('ws connect fail', e) });

  ws.onOpen(() => {
    // flush queued messages
    while (_queued.length) ws.send(_queued.shift());
    // heartbeat
    if (_pingTimer) clearInterval(_pingTimer);
    _pingTimer = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' }));
    }, 10000);
    emit('_open');
  });

  ws.onMessage((res) => {
    let m;
    try { m = JSON.parse(res.data); } catch { return; }
    if (m.t === 'pong') return;
    emit(m.t, m);
    // one-shot handlers
    if (_onceHandlers[m.t]) {
      const arr = _onceHandlers[m.t];
      delete _onceHandlers[m.t];
      for (const fn of arr) try { fn(m); } catch (e) { console.error(e); }
    }
  });

  ws.onClose(() => {
    if (_pingTimer) clearInterval(_pingTimer);
    emit('_close');
    if (!_manualClose) scheduleReconnect();
  });

  ws.onError((e) => {
    console.warn('ws error', e);
  });

  return ws;
}

function scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _ws = createWs();
  }, 1500);
}

function emit(t, payload) {
  const set = _handlers[t];
  if (set) for (const fn of set) try { fn(payload); } catch (e) { console.error(e); }
}

function on(t, fn) {
  if (!_handlers[t]) _handlers[t] = new Set();
  _handlers[t].add(fn);
  return () => off(t, fn);
}

function off(t, fn) {
  const s = _handlers[t];
  if (s) s.delete(fn);
}

function once(t, fn) {
  if (!_onceHandlers[t]) _onceHandlers[t] = [];
  _onceHandlers[t].push(fn);
}

function send(t, payload = {}) {
  const msg = JSON.stringify({ t, ...payload });
  if (_ws && _ws.readyState === 1) _ws.send(msg);
  else _queued.push(msg);
}

function setServerUrl(url) {
  app.globalData.serverUrl = url;
  wx.setStorageSync('bc_server', url);
}

function close() {
  _manualClose = true;
  if (_pingTimer) clearInterval(_pingTimer);
  if (_ws && _ws.readyState === 1) _ws.close({ code: 1000 });
  _ws = null;
}

module.exports = { getWs, createWs, on, off, once, send, setServerUrl, close };