// web/console.js — 大厅（房间总览）页面逻辑。
// 大厅口令已临时取消（服务端 BC_CONSOLE_OPEN=1）：进入即自动连接 /console，
// 免口令直接看房间总览 + 建房。若服务端重新启用口令，连接返回『口令错误』则
// 自动回落到口令门户。建房成功后重定向到 /room/:code?token=... 。
// 口令存 localStorage('bc_console_pw')，失效时清除并回到门户。

const $ = (id) => document.getElementById(id);
const ENVELOPE = (t, p) => JSON.stringify({ t, ...p });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

const PW_KEY = 'bc_console_pw';
const PHASE_CN = { lobby: '大厅', binding: '绑定中', armed: '就绪', playing: '对战中', ended: '已结束' };
const FAC_CN = { red: '红', blue: '蓝' };

let ws = null;
let pollTimer = null;
let closed = false;   // true：用户主动退出或口令失败，停止自动重连

function main() {
  // 进入按钮仅在输入非空时可用（服务端要求口令的还原场景仍可用）
  $('pwInput').addEventListener('input', () => {
    $('btnPwEnter').disabled = !($('pwInput').value.trim());
  });
  $('btnPwEnter').onclick = () => enterWithPw();
  $('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterWithPw(); });

  const stored = localStorage.getItem(PW_KEY) || '';
  if (stored) {
    $('pwInput').value = stored;
    $('btnPwEnter').disabled = false;
  }
  // 大厅口令已临时取消（服务端 BC_CONSOLE_OPEN=1）：始终尝试直接进入；
  // 若服务端仍要求口令，连接会返回『口令错误』并自动回落到门户要求输入。
  connectOverview();
}

function enterWithPw() {
  const pw = ($('pwInput').value || '').trim();
  if (!pw) { $('pwErr').textContent = '请输入口令'; $('pwInput').focus(); return; }
  localStorage.setItem(PW_KEY, pw);
  $('pwErr').textContent = '';
  connectOverview();
}

function showGate() {
  $('pwGate').hidden = false;
  $('overviewPanel').hidden = true;
  $('createPanel').hidden = true;
}
function hideGate() {
  $('pwGate').hidden = true;
  $('overviewPanel').hidden = false;
  $('createPanel').hidden = false;
}

function connectOverview() {
  const pw = (localStorage.getItem(PW_KEY) || '').trim();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(`${proto}//${location.host}/console${pw ? `?pw=${encodeURIComponent(pw)}` : ''}`);
  ws.onopen = () => {
    $('setupErr').textContent = '';
    hideGate();
    send('room:list');
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (ws && ws.readyState === 1) send('room:list'); }, 2000);
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'room:list') renderOverview(m.rooms);
    else if (m.t === 'room:created') onCreated(m);
    else if (m.t === 'room:error') {
      if (/口令/.test(m.message)) {
        // 口令错误：清除本地口令并回到门户
        localStorage.removeItem(PW_KEY);
        closed = true;
        $('pwErr').textContent = m.message + '（已清除本地口令，请重新输入）';
        showGate();
        $('pwInput').value = '';
        $('pwInput').focus();
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
  // 建房成功后自动跳转到该房间页（location.href 同页导航在所有设备可靠，不依赖弹窗）。
  location.href = `/room/${encodeURIComponent(m.code)}?token=${encodeURIComponent(m.hostToken)}`;
}

function renderOverview(rooms) {
  const tbody = $('roomsTable').querySelector('tbody');
  tbody.innerHTML = '';
  $('ovEmpty').hidden = rooms.length > 0;
  $('ovCount').textContent = rooms.length ? `共 ${rooms.length} 间` : '';
  if (!rooms.length) return;
  const now = Date.now();
  for (const r of rooms) {
    const tr = document.createElement('tr');
    const age = Math.max(0, Math.round((now - r.lastActivity) / 1000));
    const ageTxt = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
    const started = r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : '-';
    tr.innerHTML = `
      <td><span class="mono">${esc(r.code)}</span></td>
      <td>${PHASE_CN[r.phase] ?? r.phase}</td>
      <td>${r.playerCount}</td>
      <td>${r.onlineCount}</td>
      <td>${esc(r.hostName ?? '-')}${r.hasHost ? '' : ' <span class="muted-sm">(离线)</span>'}</td>
      <td>${r.hasHost ? '●' : '—'}</td>
      <td>${ageTxt}</td>
      <td>${started}</td>
      <td>${r.winner ? (FAC_CN[r.winner] ?? r.winner) : '-'}</td>
      <td><a class="btn btn-ghost btn-sm" href="/gate/${esc(r.code)}" target="_blank" rel="noopener">进入</a></td>
    `;
    tbody.appendChild(tr);
  }
}

$('btnRefreshRooms') && ($('btnRefreshRooms').onclick = () => { if (ws && ws.readyState === 1) send('room:list'); });

$('btnCreate').onclick = () => {
  const hostName = $('hostName').value.trim() || '房主';
  const codeHint = $('codeHint').value.trim() || undefined;
  $('setupErr').textContent = '';
  send('room:create', { hostName, code: codeHint });
};

main();
