// web/room.js — single-room host panel.
// Reads ?token= and code from /room/:code; prompts for the console password
// (kept in localStorage) and host token. Connects to /console with code,
// token and pw. Drives bunkers / start / close. No reconnect-after-close.

const $ = (id) => document.getElementById(id);
const ENVELOPE = (t, p) => JSON.stringify({ t, ...p });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
})[c]);

const PHASE_CN = { lobby: '大厅', binding: '绑定中', armed: '就绪', playing: '对战中', ended: '已结束' };
const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };

// ---- Parse path / query ------------------------------------------------
const pathParts = location.pathname.split('/').filter(Boolean);
const code = decodeURIComponent(pathParts[pathParts.length - 1] || '');
const params = new URLSearchParams(location.search);
const urlToken = params.get('token') || '';

const PW_KEY = 'bc_console_pw';
const TOKEN_KEY = (c) => `bc_room_${c}_token`;

let ws = null;
let closed = false;          // true after room:closed — stop reconnecting
let wsConnectedOnce = false; // guard to suppress the initial-connect error banner

function main() {
  $('gateCode').textContent = /^\d{3}$/.test(code) ? code : '—';

  if (!/^\d{3}$/.test(code)) {
    $('gateErr').textContent = '房间号不合法';
    $('pwInput').disabled = true;
    $('tokenInput').disabled = true;
    $('btnEnter').disabled = true;
    return;
  }

  // Pre-fill from storage / URL.
  const storedPw = localStorage.getItem(PW_KEY) || '';
  const storedToken = localStorage.getItem(TOKEN_KEY(code)) || '';
  $('pwInput').value = storedPw;
  $('tokenInput').value = urlToken || storedToken;

  // Auto-enter if both are present (e.g. coming from hall after create).
  if (storedPw && (urlToken || storedToken)) {
    enter();
  } else {
    showGate();
  }

  // Enter button handler.
  $('btnEnter').onclick = enter;
  $('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('tokenInput').focus(); });
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
}

function showGate() {
  $('gate').hidden = false;
  document.querySelector('main').hidden = true;
  document.querySelector('aside').hidden = true;
}

function hideGate() {
  $('gate').hidden = true;
  document.querySelector('main').hidden = false;
  document.querySelector('aside').hidden = false;
}

function enter() {
  const pw = ($('pwInput').value || '').trim();
  const tok = ($('tokenInput').value || '').trim();
  $('gateErr').textContent = '';
  if (!pw) { $('gateErr').textContent = '请输入口令'; $('pwInput').focus(); return; }
  if (!tok) { $('gateErr').textContent = '请输入房主 token'; $('tokenInput').focus(); return; }
  localStorage.setItem(PW_KEY, pw);
  localStorage.setItem(TOKEN_KEY(code), tok);
  connect(pw, tok);
}

function connect(pw, tok) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/console?pw=${encodeURIComponent(pw)}&code=${encodeURIComponent(code)}&token=${encodeURIComponent(tok)}`;
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(url);

  ws.onopen = () => { wsConnectedOnce = true; $('errText').textContent = ''; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    onServer(m);
  };
  ws.onclose = () => {
    if (closed) return;                     // expected close after room:closed
    $('errText').textContent = '连接断开，2 秒后重连…';
    setTimeout(() => connect(pw, tok), 2000);
  };
  ws.onerror = () => {};
}

function send(t, p = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(ENVELOPE(t, p));
}

function onServer(m) {
  switch (m.t) {
    case 'state':
      hideGate();
      $('errText').textContent = '';
      render(m.snapshot);
      break;
    case 'event':
      appendEvent(m);
      break;
    case 'room:closed':
      closed = true;
      alert(`房间 ${m.code} 已关闭：${m.reason}`);
      location.href = '/hall.html';
      break;
    case 'room:error':
      // On auth failures, clear the bad credential and surface back to the gate.
      if (/口令/.test(m.message)) {
        localStorage.removeItem(PW_KEY);
        $('gateErr').textContent = m.message;
        showGate();
        $('pwInput').focus();
      } else if (/token|不存在/.test(m.message)) {
        localStorage.removeItem(TOKEN_KEY(code));
        $('gateErr').textContent = m.message;
        showGate();
        $('tokenInput').focus();
      } else {
        $('errText').textContent = m.message;
      }
      break;
  }
}

// ---- UI hooks ----------------------------------------------------------
$('btnBindBunkers').onclick = () => {
  const raw = $('bunkerIds').value.trim();
  if (!raw) { $('bunkerIds').focus(); return; }
  const ids = raw.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n) && n >= 24 && n <= 33);
  if (!ids.length) { alert('请填入 24–33 范围内掩体 ID'); return; }
  send('host:bunkers', { ids });
};
$('btnStart').onclick = () => send('host:start');
$('btnClose').onclick = () => { if (confirm('关闭房间？所有玩家会被踢出。')) send('host:close'); };

// ---- Render ------------------------------------------------------------
function render(s) {
  $('code').textContent = s.code;
  $('phase').textContent = PHASE_CN[s.phase] ?? s.phase;

  const tbody = $('players').querySelector('tbody');
  tbody.innerHTML = '';
  for (const p of s.players) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(p.name)}</td>` +
      `<td>${p.online ? '●' : '○'}</td>` +
      `<td>${p.faction ?? '-'}</td>` +
      `<td>${p.role ? (ROLE_CN[p.role] ?? p.role) : '-'}</td>` +
      `<td>${p.tagId ?? '-'}</td>`;
    tbody.appendChild(tr);
  }

  const bunkers = s.units.filter((u) => u.kind === 'bunker');
  $('bunkers').innerHTML = bunkers.length
    ? bunkers.map((u) => `<span class="tag" title="hp ${u.hp}/${u.maxHp}">id${u.id} ${u.destroyed ? '❌' : '✓'}</span>`).join('')
    : '<span class="muted">尚未录入掩体</span>';

  setBar('red', s.units.find((u) => u.kind === 'base' && u.faction === 'red'));
  setBar('blue', s.units.find((u) => u.kind === 'base' && u.faction === 'blue'));

  const playerUnits = s.units.filter((u) => u.kind === 'player');
  $('units').innerHTML = playerUnits.length
    ? playerUnits.map((u) => {
        const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
        const fac = u.faction === 'red' ? 'red' : 'blue';
        return `<div class="unit">
          <span class="id">id${u.id}</span>
          <span class="name">${esc(u.name ?? '?')}</span>
          <span class="fac ${fac}"></span>${esc(ROLE_CN[u.role ?? 'assault'])}
          <div class="bar"><div class="fill ${fac}" style="width:${pct}%"></div><span>${u.hp}/${u.maxHp}${u.alive ? '' : ' 💀'}</span></div>
        </div>`;
      }).join('')
    : '<span class="muted">尚无玩家绑定标签</span>';
}

function setBar(side, base) {
  if (!base) {
    $(side + 'Hp').style.width = '0%';
    $(side + 'HpText').textContent = '—';
    return;
  }
  const pct = Math.max(0, Math.min(100, (base.hp / base.maxHp) * 100));
  $(side + 'Hp').style.width = pct + '%';
  $(side + 'HpText').textContent = base.hp === 0 ? '已毁灭' : `${base.hp} / ${base.maxHp}`;
}

function appendEvent(env) {
  const e = env.e;
  if (!e) return;
  const ts = new Date(env.ts).toLocaleTimeString();
  const li = document.createElement('li');
  li.innerHTML = `<span class="ts">${esc(ts)}</span> ${fmtEvent(e)}`;
  const log = $('log');
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
  // Cap the log length to avoid runaway DOM growth in long sessions.
  while (log.children.length > 500) log.removeChild(log.firstChild);
}

function fmtEvent(e) {
  switch (e.t) {
    case 'hit': return `<span class="hit">id${e.src} → id${e.tgt} -${e.dmg}</span>`;
    case 'kill': return `<span class="kill">id${e.src} 击杀 id${e.tgt}</span>`;
    case 'playerDown': return `<span class="kill">id${e.id} 阵亡</span>`;
    case 'playerRevive': return `<span class="revive">id${e.id} 复活</span>`;
    case 'bunkerDestroyed': return `<span class="bunker">掩体 id${e.id} 摧毁 (由 ${e.src === null ? '-' : 'id' + e.src})</span>`;
    case 'baseHit': return `<span class="hit">基地 id${e.id} 被击 剩余 ${e.hp}</span>`;
    case 'gameOver': return `<span class="kill">游戏结束 胜者 ${esc(e.winner)}</span>`;
    default: return esc(JSON.stringify(e));
  }
}

main();
