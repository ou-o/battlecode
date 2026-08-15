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
  console.log('ws connecting', _url, 'serverUrl=', app.globalData.serverUrl);
  const ws = wx.connectSocket({
    url: _url,
    fail: (e) => {
      console.warn('ws connect fail', e);
      emit('_error', e);
    },
  });
  if (!ws) {
    console.error('wx.connectSocket returned undefined for', _url);
    emit('_error', { errMsg: 'wx.connectSocket 返回 undefined，URL 不合法或被拒绝: ' + _url });
    scheduleReconnect();
    return null;
  }

  ws.onOpen(() => {
    // flush queued messages
    while (_queued.length) ws.send({ data: _queued.shift() });
    // heartbeat
    if (_pingTimer) clearInterval(_pingTimer);
    _pingTimer = setInterval(() => {
      if (ws.readyState === 1) ws.send({ data: JSON.stringify({ t: 'ping' }) });
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
    // Only reconnect if this is still the active socket AND not a manual close.
    // An orphaned socket (superseded by setServerUrl) must NOT steal the singleton.
    if (ws === _ws && !_manualClose) scheduleReconnect();
  });

  ws.onError((e) => {
    console.warn('ws error', e);
    emit('_error', e);
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
  if (_ws && _ws.readyState === 1) _ws.send({ data: msg });
  else _queued.push(msg);
}

function setServerUrl(url) {
  if (url && !String(url).startsWith('ws://') && !String(url).startsWith('wss://')) url = 'ws://' + url;
  app.globalData.serverUrl = url;
  wx.setStorageSync('bc_server', url);
  close();
  _ws = createWs();
}

function close() {
  _manualClose = true;
  if (_pingTimer) clearInterval(_pingTimer);
  // Force-close regardless of readyState so a still-connecting orphan can't
  // linger and later steal the singleton via scheduleReconnect.
  if (_ws) { try { _ws.close({ code: 1000 }); } catch (e) {} }
  _ws = null;
}

module.exports = { getWs, createWs, on, off, once, send, setServerUrl, close };