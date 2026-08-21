// utils/ws.js — thin WeChat WebSocket bridge with JSON envelope {t, ...payload}.
// Singleton accessible via require('../../utils/ws.js').getWs().
//
// 连接走 /console 并带上内嵌的控制台口令，使小程序无需手动输口令即可建房/建房控；
// 玩家侧的 join/attack/bindTag 等动作对 console socket 同样适用。口令值必须与
// 服务端 BC_CONSOLE_PW（缺省 'ismism'）一致，部署改了要同步改这里。

// 控制台口令（内嵌，不下发到任何提交信息）。服务端缺省 'ismism'。
const CONSOLE_PW = 'ismism';

const app = getApp();

let _ws = null;
let _url = null;
let _handlers = {};       // t -> Set<fn>
let _onceHandlers = {};   // t -> Set<fn>
let _reconnectTimer = null;
let _manualClose = false;
let _queued = [];
let _joinIntent = null;   // {code, name} — 最近一次 room:join 意图
let _session = null;      // {code, name, token} — 已加入房间的持久身份，用于重连重入

function getWs() {
  if (_ws) return _ws;
  _ws = createWs();
  return _ws;
}

function createWs() {
  _url = app.globalData.serverUrl + '/console?pw=' + CONSOLE_PW;
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
    // 断线重连后自动重入之前的房间并恢复绑定（token 由服务端换回原身份）。
    if (_session && _session.token && _session.code) {
      const msg = JSON.stringify({ t: 'room:join', code: _session.code, name: _session.name, token: _session.token });
      if (ws.readyState === 1) ws.send({ data: msg });
      else _queued.push(msg);
    }
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
    // 持久身份 / 全局会话记账（无论当前在哪个页面都保证 globalData 正确，
    // 覆盖「战斗页置顶时断线重连」的场景）。
    if (m.t === 'room:joined') {
      _session = { code: m.snapshot.code, name: (_joinIntent && _joinIntent.name) || m.me.name, token: m.me.token };
      const a = getApp();
      a.globalData.code = m.snapshot.code;
      a.globalData.room = m.snapshot;
      a.globalData.me = m.me;
    } else if (m.t === 'room:left' || m.t === 'room:closed') {
      _session = null;
      const a = getApp();
      a.globalData.code = null;
      a.globalData.room = null;
      a.globalData.me = null;
    }
  });

  ws.onClose(() => {
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
  if (t === 'room:join') _joinIntent = { code: payload.code, name: payload.name };
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
  // Force-close regardless of readyState so a still-connecting orphan can't
  // linger and later steal the singleton via scheduleReconnect.
  if (_ws) { try { _ws.close({ code: 1000 }); } catch (e) {} }
  _ws = null;
  _session = null;
  _joinIntent = null;
}

module.exports = { getWs, createWs, on, off, once, send, setServerUrl, close };