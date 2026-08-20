import WebSocket from 'ws';

// RAW ws helpers — used by the Node harness to act as host (/console) and as
// extra player sockets (/socket) alongside the automator-driven miniprogram.

// Console password (mirrors server CONSOLE_PASSWORD). Override via env.
export const CONSOLE_PW = process.env.BC_CONSOLE_PW || 'ismism';

// Ensure a /console URL carries the ?pw= query the server now requires.
function withPw(url) {
  if (!url.includes('/console')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + (url.includes('pw=') ? '' : sep + 'pw=' + encodeURIComponent(CONSOLE_PW));
}

function mkWs(url) {
  const ws = new WebSocket(withPw(url));
  return ws;
}

export function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = mkWs(url);
    const handlers = new Map();
    const onceArr = [];
    let ready = false;
    const send = (t, p = {}) => ws.send(JSON.stringify({ t, ...p }));
    ws.on('open', () => { ready = true; resolve(api); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'pong') return;
      const set = handlers.get(m.t);
      if (set) for (const fn of set) try { fn(m); } catch (e) { console.error(e); }
      onceArr.splice(0).forEach((o, i) => { if (o.t === m.t) { try { o.fn(m); } catch (e) { console.error(e); } } });
    });
    ws.on('error', (e) => { if (!ready) reject(e); });
    ws.on('close', () => {});
    const api = {
      ws,
      send,
      on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); return () => handlers.get(t).delete(fn); },
      once(t, fn) { onceArr.push({ t, fn }); },
      wait(t, timeout = 8000) {
        return new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeout);
          onceArr.push({ t, fn: (m) => { clearTimeout(to); resolve(m); } });
        });
      },
      close: () => ws.close(),
    };
    return api;
  });
}

export const SERVER = 'ws://127.0.0.1:3000';
export const SERVER_HTTP = 'http://127.0.0.1:3000';

export function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAIL: ' + msg); }
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }