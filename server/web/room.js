// web/room.js — single-room host panel. Reads ?token= from query string,
// connects to /console?code=<>&token=<>, drives bunkers / start / close.

const $ = (id) => document.getElementById(id);
const ENVELOPE = (t, p) => JSON.stringify({ t, ...p });

const pathParts = location.pathname.split('/');
const code = decodeURIComponent(pathParts[pathParts.length - 1] || '');
const params = new URLSearchParams(location.search);
const token = params.get('token') || localStorage.getItem(`bc_room_${code}_token`) || '';

if (token) localStorage.setItem(`bc_room_${code}_token`, token);
if (!code || !/^\d{3}$/.test(code)) {
  $('errText').textContent = '房间号不合法';
} else if (!token) {
  // No token in URL nor storage: prompt for it.
  const entered = prompt(`进入房间 ${code} 需要 hostToken，请粘贴：`);
  if (!entered) { $('errText').textContent = '未提供 hostToken，无法管理房间。'; }
  else {
    localStorage.setItem(`bc_room_${code}_token`, entered.trim());
    connect(entered.trim());
  }
} else {
  connect(token);
}

let ws = null;
function connect(tok) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/console?code=${encodeURIComponent(code)}&token=${encodeURIComponent(tok)}`);
  ws.onopen = () => console.log('room ws open', code);
  ws.onmessage = (ev) => onServer(JSON.parse(ev.data));
  ws.onclose = () => {
    $('errText').textContent = '连接断开，1.5 秒后重连…';
    setTimeout(() => connect(tok), 1500);
  };
  ws.onerror = () => {};
}
function send(t, p = {}) { if (ws && ws.readyState === 1) ws.send(ENVELOPE(t, p)); }

function onServer(m) {
  switch (m.t) {
    case 'state':
      $('errText').textContent = '';
      render(m.snapshot);
      break;
    case 'event':
      appendEvent(m);
      break;
    case 'room:closed':
      alert(`房间 ${m.code} 已关闭：${m.reason}`);
      location.href = '/hall.html';
      break;
    case 'room:error':
      $('errText').textContent = m.message;
      if (/token|不存在/.test(m.message)) {
        localStorage.removeItem(`bc_room_${code}_token`);
      }
      break;
  }
}

$('btnBindBunkers').onclick = () => {
  const raw = $('bunkerIds').value.trim();
  const ids = raw.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n) && n >= 24 && n <= 33);
  if (!ids.length) { alert('请填入 24-33 范围内掩体 ID'); return; }
  send('host:bunkers', { ids });
};
$('btnStart').onclick = () => send('host:start');
$('btnClose').onclick = () => { if (confirm('关闭房间？所有玩家会被踢出。')) send('host:close'); };

const PHASE_CN = { lobby: '大厅', binding: '绑定中', armed: '就绪', playing: '对战中', ended: '已结束' };
const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };

function render(s) {
  $('code').textContent = s.code;
  $('phase').textContent = PHASE_CN[s.phase] ?? s.phase;

  let snapshot = s;
  const tbody = $('players').querySelector('tbody');
  tbody.innerHTML = '';
  for (const p of s.players) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(p.name)}</td><td>${p.online ? '●' : '○'}</td><td>${p.faction ?? '-'}</td><td>${p.role ? ROLE_CN[p.role] : '-'}</td><td>${p.tagId ?? '-'}</td>`;
    tbody.appendChild(tr);
  }

  const bunkers = s.units.filter((u) => u.kind === 'bunker');
  $('bunkers').innerHTML = bunkers.map((u) => `<span class="tag" title="hp ${u.hp}">id${u.id} ${u.destroyed ? '❌' : '✓'}</span>`).join(' ');

  setBar('red', s.units.find((u) => u.kind === 'base' && u.faction === 'red'));
  setBar('blue', s.units.find((u) => u.kind === 'base' && u.faction === 'blue'));

  const playerUnits = s.units.filter((u) => u.kind === 'player');
  $('units').innerHTML = playerUnits.map((u) => {
    const pct = (u.hp / u.maxHp) * 100;
    const fac = u.faction === 'red' ? 'red' : 'blue';
    return `<div class="unit">
      <span class="id">id${u.id}</span>
      <span class="name">${esc(u.name ?? '?')}</span>
      <span class="fac ${fac}"></span>${ROLE_CN[u.role ?? 'assault']}
      <div class="bar"><div class="fill ${fac}" style="width:${pct}%"></div><span>${u.hp}/${u.maxHp} ${u.alive ? '' : '💀'}</span></div>
    </div>`;
  }).join('');
}

function setBar(side, base) {
  if (!base) return;
  const pct = (base.hp / base.maxHp) * 100;
  $(side + 'Hp').style.width = pct + '%';
  $(side + 'HpText').textContent = `${base.hp} / ${base.maxHp}`;
  if (base.hp === 0) $(side + 'HpText').textContent = '已毁灭';
}

function appendEvent(env) {
  const e = env.e;
  const ts = new Date(env.ts).toLocaleTimeString();
  const li = document.createElement('li');
  li.innerHTML = `<span class="ts">${ts}</span> ${fmtEvent(e)}`;
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
}

function fmtEvent(e) {
  switch (e.t) {
    case 'hit': return `<span class="hit">id${e.src} → id${e.tgt} -${e.dmg}</span>`;
    case 'kill': return `<span class="kill">id${e.src} 击杀 id${e.tgt}</span>`;
    case 'playerDown': return `<span class="kill">id${e.id} 阵亡</span>`;
    case 'playerRevive': return `<span class="revive">id${e.id} 复活</span>`;
    case 'bunkerDestroyed': return `<span class="bunker">掩体 id${e.id} 摧毁 (由 ${e.src === null ? '-' : 'id' + e.src})</span>`;
    case 'baseHit': return `<span class="hit">基地 id${e.id} 被击 剩余 ${e.hp}</span>`;
    case 'gameOver': return `<span class="kill">游戏结束 胜者 ${e.winner}</span>`;
    default: return JSON.stringify(e);
  }
}

function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }