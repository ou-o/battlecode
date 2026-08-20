// web/console.js — room overview page logic. Connects to /console (no
// code/token) in overview mode, polls room:list, drives room:create, and
// redirects to /room/:code?token=... on success.
//
// Console password gate: reads/writes localStorage('bc_console_pw'); prompts
// if missing, connects with ?pw=, clears on auth failure.

const $ = (id) => document.getElementById(id);
const ENVELOPE = (t, p) => JSON.stringify({ t, ...p });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
})[c]);

const PW_KEY = 'bc_console_pw';
const PHASE_CN = { lobby: '大厅', binding: '绑定中', armed: '就绪', playing: '对战中', ended: '已结束' };
const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };

let ws = null;
let pollTimer = null;
let closed = false;        // true when user-initiated / explicit auth failure
let pw = '';

function main() {
  pw = localStorage.getItem(PW_KEY) || '';
  if (!pw) {
    pw = (prompt('进入控制台需要口令：') || '').trim();
    if (!pw) {
      $('setupErr').textContent = '未提供口令，无法进入控制台。';
      return;
    }
    localStorage.setItem(PW_KEY, pw);
  }
  connectOverview();
}

function connectOverview() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/console?pw=${encodeURIComponent(pw)}`);
  ws.onopen = () => {
    $('setupErr').textContent = '';
    send('room:list');
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (ws && ws.readyState === 1) send('room:list'); }, 2000);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'room:list') renderOverview(m.rooms);
    else if (m.t === 'room:created') onCreated(m);
    else if (m.t === 'room:error') {
      // Auth failure: clear pw and stop; user must refresh & re-enter.
      if (/口令/.test(m.message)) {
        localStorage.removeItem(PW_KEY);
        closed = true;
        $('setupErr').textContent = m.message + '（已清空本地口令，请刷新重试）';
        try { ws.close(); } catch {}
      } else {
        $('setupErr').textContent = m.message;
      }
    }
  };
  ws.onclose = () => {
    if (pollTimer) clearInterval(pollTimer);
    if (closed) return;
    setTimeout(connectOverview, 1500);
  };
  ws.onerror = () => {};
}
function send(t, p = {}) { if (ws && ws.readyState === 1) ws.send(ENVELOPE(t, p)); }

function onCreated(m) {
  // Carry the pw to the room page via localStorage (already there); pass the
  // per-room token in the URL so room.js can pick it up immediately.
  location.href = `/room/${encodeURIComponent(m.code)}?token=${encodeURIComponent(m.hostToken)}`;
}

function renderOverview(rooms) {
  const tbody = $('roomsTable').querySelector('tbody');
  tbody.innerHTML = '';
  $('ovEmpty').hidden = rooms.length > 0;
  if (!rooms.length) return;
  const now = Date.now();
  for (const r of rooms) {
    const tr = document.createElement('tr');
    const age = Math.max(0, Math.round((now - r.lastActivity) / 1000));
    const ageTxt = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
    const started = r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : '-';
    tr.innerHTML = `
      <td><b>${esc(r.code)}</b></td>
      <td>${PHASE_CN[r.phase] ?? r.phase}</td>
      <td>${r.playerCount}</td>
      <td>${r.onlineCount}</td>
      <td>${esc(r.hostName ?? '-')}${r.hasHost ? '' : ' <span class="muted">(离线)</span>'}</td>
      <td>${r.hasHost ? '✓' : '—'}</td>
      <td>${ageTxt}</td>
      <td>${started}</td>
      <td>${r.winner ?? '-'}</td>
      <td>
        <button class="enterBtn" data-code="${esc(r.code)}">进入</button>
        <button class="joinBtn" data-code="${esc(r.code)}">玩家加入提示</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  for (const b of tbody.querySelectorAll('.enterBtn')) {
    b.onclick = () => { location.href = `/room/${encodeURIComponent(b.dataset.code)}`; };
  }
  for (const b of tbody.querySelectorAll('.joinBtn')) {
    b.onclick = () => { alert(`请提示玩家从微信小程序用房间号 ${b.dataset.code} 加入。`); };
  }
}

$('btnRefreshRooms').onclick = () => { if (ws && ws.readyState === 1) send('room:list'); };

$('btnCreate').onclick = () => {
  const hostName = $('hostName').value.trim() || '房主';
  const codeHint = $('codeHint').value.trim() || undefined;
  $('setupErr').textContent = '';
  send('room:create', { hostName, code: codeHint });
};

main();
