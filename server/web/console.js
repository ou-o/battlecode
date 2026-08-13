// web/console.js — host web console logic. Connects to /console with the
// hostToken (auto-created or supplied), drives room/create + bunkers + start.

const $ = (id) => document.getElementById(id);
const ENVELOPE = (t, p) => JSON.stringify({ t, ...p });

let ws = null;
let code = null;
let token = null;
let snapshot = null;

function connect(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}${path}`);
  ws.onopen = () => console.log('ws open', path);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    onServer(m);
  };
  ws.onclose = () => {
    console.warn('ws closed; retry in 1s');
    setTimeout(() => {
      if (code && token) connect(`/console?code=${code}&token=${token}`);
    }, 1000);
  };
}

function send(t, p = {}) { if (ws && ws.readyState === 1) ws.send(ENVELOPE(t, p)); }

function onServer(m) {
  switch (m.t) {
    case 'room:created':
      code = m.code; token = m.hostToken;
      $('code').textContent = code;
      $('token').textContent = token;
      enterPanel();
      break;
    case 'room:joined':
      // console reconnecting into existing room
      break;
    case 'state':
      snapshot = m.snapshot;
      render(snapshot);
      break;
    case 'event':
      appendEvent(m);
      break;
    case 'room:error':
      $('setupErr').textContent = m.message;
      alert(m.message);
      break;
  }
}

// ---- Setup / connect handlers ------------------------------------------
$('btnCreate').onclick = () => {
  const hostName = $('hostName').value.trim() || '房主';
  const codeHint = $('codeHint').value.trim() || undefined;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/console`);
  ws.onopen = () => send('room:create', { hostName, code: codeHint });
  ws.onmessage = (ev) => onServer(JSON.parse(ev.data));
  ws.onclose = () => {
    console.warn('ws closed; retry in 1s');
    if (code && token) setTimeout(() => connect(`/console?code=${code}&token=${token}`), 1000);
  };
};

$('btnReconnect').onclick = () => {
  code = $('reconnectCode').value.trim();
  token = $('reconnectToken').value.trim();
  if (!/^\d{3}$/.test(code)) { $('setupErr').textContent = '房间号需为三位数字'; return; }
  connect(`/console?code=${code}&token=${token}`);
  enterPanel();
};

$('btnBindBunkers').onclick = () => {
  const raw = $('bunkerIds').value.trim();
  const ids = raw.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n) && n >= 24 && n <= 33);
  if (!ids.length) { alert('请填入 24-33 范围内掩体 ID'); return; }
  send('host:bunkers', { ids });
};

$('btnStart').onclick = () => send('host:start');
$('btnClose').onclick = () => { if (confirm('关闭房间？')) send('host:close'); };

function enterPanel() { $('setup').hidden = true; $('panel').hidden = false; }

// ---- Rendering ----------------------------------------------------------
const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };
const PHASE_CN = { lobby: '大厅', binding: '绑定中', armed: '就绪', playing: '对战中', ended: '已结束' };

function render(s) {
  $('code').textContent = s.code;
  $('phase').textContent = PHASE_CN[s.phase] ?? s.phase;

  // players
  const tbody = $('players').querySelector('tbody');
  tbody.innerHTML = '';
  for (const p of s.players) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(p.name)}</td><td>${p.online ? '●' : '○'}</td><td>${p.faction ?? '-'}</td><td>${p.role ? ROLE_CN[p.role] : '-'}</td><td>${p.tagId ?? '-'}</td>`;
    tbody.appendChild(tr);
  }

  // bunkers
  const bunkers = s.units.filter((u) => u.kind === 'bunker');
  $('bunkers').innerHTML = bunkers.map((u) => `<span class="tag" title="hp ${u.hp}">id${u.id} ${u.destroyed ? '❌' : '✓'}</span>`).join(' ');

  // bases
  setBar('red', s.units.find((u) => u.kind === 'base' && u.faction === 'red'));
  setBar('blue', s.units.find((u) => u.kind === 'base' && u.faction === 'blue'));

  // player units (live hp during game)
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