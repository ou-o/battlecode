// web/room.js — 房间页（房主控制台）。
// 从 /room/:code 读取房间号；从 URL ?token= 或 localStorage 读取房主 6 位验证码。
// 口令已在大厅输入并保存在 localStorage('bc_console_pw')，无需在此重复输入。
// 无验证码时跳转 /gate/:code 校验页输入；带码则经 /console (pw+code+token) 连接展示。
// 顶部展示重进验证码，提供「复制验证码」按钮，供房主保存以便重进。

const $ = (id) => document.getElementById(id);
const ENVELOPE = (t, p) => JSON.stringify({ t, ...p });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

const PHASE_CN = { lobby: '准备', binding: '绑定中', armed: '就绪', playing: '对战中', ended: '已结束' };
const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };
const FAC_CN = { red: '红', blue: '蓝' };

// ---- 解析路径 / 查询参数 ----
const pathParts = location.pathname.split('/').filter(Boolean);
const code = decodeURIComponent(pathParts[pathParts.length - 1] || '');
const params = new URLSearchParams(location.search);
const urlToken = params.get('token') || '';

const PW_KEY = 'bc_console_pw';
const TOKEN_KEY = (c) => `bc_room_${c}_token`;

let ws = null;
let closed = false;          // true：收到 room:closed 后停止重连
let pw = '';
let token = '';

function main() {
  const valid = /^\d{3}$/.test(code);

  if (!valid) {
    $('errText').textContent = '房间号不合法（需三位数字），3 秒后返回大厅。';
    setTimeout(() => { location.href = '/hall.html'; }, 3000);
    return;
  }

  // 口令来自大厅（本地已保存）；此处不重复输入。
  pw = localStorage.getItem(PW_KEY) || '';
  token = urlToken || localStorage.getItem(TOKEN_KEY(code)) || '';

  // 从未在大厅输入过口令 → 回大厅完成口令验证。
  if (!pw) { location.href = '/hall.html'; return; }

  // 无验证码 → 跳校验页让房主输入 6 位验证码。
  if (!token) { location.href = `/gate/${encodeURIComponent(code)}`; return; }

  // 展示重进验证码 + 复制按钮
  updateCredentialUI();

  $('btnCopyRaw').onclick = () => copyToken();

  connect(pw, token);
}

function updateCredentialUI() {
  $('tokenField').value = token;
  $('btnCopyRaw').disabled = false;
}

function copyToken() {
  const btn = $('btnCopyRaw');
  const done = () => {
    const orig = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = orig; }, 1800);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(token).then(done).catch(() => fallbackCopy(token, done));
  } else {
    fallbackCopy(token, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  done();
}

function connect(p, t) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/console?pw=${encodeURIComponent(p)}&code=${encodeURIComponent(code)}&token=${encodeURIComponent(t)}`;
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(url);

  ws.onopen = () => { $('errText').textContent = ''; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    onServer(m);
  };
  ws.onclose = () => {
    if (closed) return;
    $('errText').textContent = '连接断开，2 秒后重连…';
    setTimeout(() => connect(p, t), 2000);
  };
  ws.onerror = () => {};
}

function send(t, p = {}) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(ENVELOPE(t, p)); }

function onServer(m) {
  switch (m.t) {
    case 'state':
      $('errText').textContent = '';
      showConsole();
      render(m.snapshot);
      break;
    case 'event':
      appendEvent(m);
      break;
    case 'room:closed':
      closed = true;
      renderClosed(m.reason);
      break;
    case 'room:error':
      if (/口令/.test(m.message)) {
        localStorage.removeItem(PW_KEY);
        location.href = '/hall.html';
      } else if (/token|不存在|不匹配/.test(m.message)) {
        localStorage.removeItem(TOKEN_KEY(code));
        location.href = `/gate/${encodeURIComponent(code)}`;
      } else {
        $('errText').textContent = m.message;
      }
      break;
  }
}

function showConsole() {
  document.querySelector('main').hidden = false;
  document.querySelector('aside').hidden = false;
}

function renderClosed(reason) {
  // 房间已关闭：清空本地验证码，提示并返回大厅。
  localStorage.removeItem(TOKEN_KEY(code));
  $('errText').textContent = `房间 ${code} 已关闭：${reason}`;
  closed = true;
  setTimeout(() => { location.href = '/hall.html'; }, 3200);
}

// ---- UI hooks ----
$('btnBindBunkers').onclick = () => {
  const raw = $('bunkerIds').value.trim();
  if (!raw) { $('bunkerIds').focus(); return; }
  const ids = raw.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n) && n >= 23 && n <= 32);
  if (!ids.length) { $('errText').textContent = '请填入 23–32 范围内的掩体 ID'; return; }
  send('host:bunkers', { ids });
};
$('btnStart').onclick = () => send('host:start');
$('btnClose').onclick = () => { if (confirm('关闭房间？所有玩家会被踢出。')) send('host:close'); };

// ---- Render ----
function render(s) {
  $('code').textContent = s.code;
  $('phase').textContent = PHASE_CN[s.phase] ?? s.phase;
  $('phaseNo').textContent = 'SEC.' + String(s.code);
  // 正确显示房主昵称（快照 hostName），不再写死“房主控制台”。
  $('hostName').textContent = s.hostName ?? '房主';
  // 已识别为房主，解锁操作
  $('btnStart').disabled = false;
  $('btnClose').disabled = false;

  // 玩家表：按阵营分红/蓝两个表渲染（含血量血槽，血槽占满单元格）
  const unitBySocket = {};
  for (const u of s.units) if (u.kind === 'player' && u.socketId) unitBySocket[u.socketId] = u;
  const red = [], blue = [], none = [];
  for (const p of s.players) {
    if (p.faction === 'red') red.push(p);
    else if (p.faction === 'blue') blue.push(p);
    else none.push(p);
  }
  fillPlayers($('playersRed'), red, unitBySocket);
  fillPlayers($('playersBlue'), blue, unitBySocket);
  const noneBox = $('playersNone');
  if (none.length) {
    noneBox.innerHTML = '<h3 class="sub-title">未分配</h3><span class="muted-sm">' +
      none.map((p) => esc(p.name)).join('、') + '</span>';
  } else {
    noneBox.innerHTML = '';
  }

  // 掩体：游戏中显示血量
  const inPlay = s.phase === 'playing' || s.phase === 'armed' || s.phase === 'ended';
  const bunkers = s.units.filter((u) => u.kind === 'bunker');
  $('bunkers').innerHTML = bunkers.length
    ? bunkers.map((u) => {
        const hpTxt = inPlay ? ` <span class="mono">${u.hp}/${u.maxHp}</span>` : '';
        return `<span class="tag" title="hp ${u.hp}/${u.maxHp}">id${u.id}${hpTxt} ${u.destroyed ? '✕' : '✓'}</span>`;
      }).join('')
    : '<span class="muted-sm">尚未录入掩体</span>';

  setBar('red', s.units.find((u) => u.kind === 'base' && u.faction === 'red'));
  setBar('blue', s.units.find((u) => u.kind === 'base' && u.faction === 'blue'));
}

function fillPlayers(tbody, players, unitBySocket) {
  tbody.innerHTML = '';
  for (const p of players) {
    const u = unitBySocket[p.socketId];
    const pct = u ? Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100)) : 0;
    const fac = (u && (u.faction || p.faction)) || null;
    const fillCls = fac === 'red' ? 'red' : fac === 'blue' ? 'blue' : 'gray';
    const hpText = u ? (u.alive ? `${u.hp}/${u.maxHp}` : 'DOWN') : '未绑定';
    const hpCell = u
      ? `<div class="hpbar"><div class="fill ${fillCls}" style="width:${pct}%"></div><span>${hpText}</span></div>`
      : '<span class="muted-sm">未绑定</span>';
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(p.name)}</td>` +
      `<td>${p.online ? '<span style="color:var(--green)">●</span>' : '<span class="muted">○</span>'}</td>` +
      `<td>${p.role ? (ROLE_CN[p.role] ?? p.role) : '-'}</td>` +
      `<td><span class="mono">${p.tagId ?? '-'}</span></td>` +
      `<td>${hpCell}</td>`;
    tbody.appendChild(tr);
  }
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
  while (log.children.length > 500) log.removeChild(log.firstChild);
}

function fmtEvent(e) {
  switch (e.t) {
    case 'hit': return `<span class="hit">id${e.src} → id${e.tgt} -${e.dmg}</span>`;
    case 'kill': return `<span class="kill">id${e.src} 击杀 id${e.tgt}</span>`;
    case 'playerDown': return `<span class="kill">id${e.id} 阵亡</span>`;
    case 'playerRevive': return `<span class="revive">id${e.id} 复活</span>`;
    case 'bunkerDestroyed': return `<span class="bunker">掩体 id${e.id} 摧毁${e.src === null ? '' : ' (由 id' + e.src + ')'}</span>`;
    case 'baseHit': return `<span class="hit">基地 id${e.id} 被击 剩余 ${e.hp}</span>`;
    case 'gameOver': return `<span class="kill">游戏结束 胜者 ${FAC_CN[e.winner] ?? e.winner}</span>`;
    default: return esc(JSON.stringify(e));
  }
}

main();
