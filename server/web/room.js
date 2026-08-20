// web/room.js — 房间页（房主控制台）。
// 从 /room/:code 读取房间号；从 URL ?token= 或 localStorage 读取房主 TOKEN。
// 口令 + TOKEN 经 /console (pw + code + token) 由服务端校验；通过后展示实时状态。
// 顶部展示房主 TOKEN，提供「复制重进链接」/「复制 TOKEN」按钮，供房主保存以便重进房间。

const $ = (id) => document.getElementById(id);
const ENVELOPE = (t, p) => JSON.stringify({ t, ...p });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

const PHASE_CN = { lobby: '大厅', binding: '绑定中', armed: '就绪', playing: '对战中', ended: '已结束' };
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
let wsConnectedOnce = false;
let pw = '';
let token = '';

function main() {
  $('gateCode').textContent = /^\d{3}$/.test(code) ? code : '—';

  if (!/^\d{3}$/.test(code)) {
    $('gateErr').textContent = '房间号不合法（需三位数字）';
    $('pwInput').disabled = true;
    $('tokenInput').disabled = true;
    $('btnEnter').disabled = true;
    return;
  }

  // 预填（URL token 优先，其次 localStorage）
  pw = localStorage.getItem(PW_KEY) || '';
  token = urlToken || localStorage.getItem(TOKEN_KEY(code)) || '';
  $('pwInput').value = pw;
  $('tokenInput').value = token;

  // 自动进入（口令 + token 都在）
  if (pw && token) {
    enter();
  } else {
    showGate();
  }

  $('btnEnter').onclick = enter;
  $('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('tokenInput').focus(); });
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
  $('pwInput').addEventListener('input', () => { $('btnEnter').disabled = !($('pwInput').value.trim() && $('tokenInput').value.trim()); });
  $('tokenInput').addEventListener('input', () => { $('btnEnter').disabled = !($('pwInput').value.trim() && $('tokenInput').value.trim()); });

  // 复制按钮
  $('btnCopy').onclick = () => { copyText(reEntryUrl(), '已复制重进链接'); };
  $('btnCopyRaw').onclick = () => { copyText(token, '已复制 TOKEN'); };
}

function reEntryUrl() {
  return `${location.origin}/room/${encodeURIComponent(code)}?token=${encodeURIComponent(token)}`;
}

function copyText(text, okMsg) {
  const done = () => {
    $('copyHint').textContent = okMsg + ' ✓';
    setTimeout(() => { $('copyHint').textContent = '建房后房主应保存此链接；页面失联或重开浏览器后，用它能重新进入本房间（也可在下方面板粘贴 TOKEN）。'; }, 2500);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
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

function showGate() {
  $('gate').hidden = false;
  document.querySelector('main').hidden = true;
  document.querySelector('aside').hidden = true;
  $('roomBar').hidden = false;
}
function hideGate() {
  $('gate').hidden = true;
  document.querySelector('main').hidden = false;
  document.querySelector('aside').hidden = false;
}

function enter() {
  pw = ($('pwInput').value || '').trim();
  token = ($('tokenInput').value || '').trim();
  $('gateErr').textContent = '';
  if (!pw) { $('gateErr').textContent = '请输入口令'; $('pwInput').focus(); return; }
  if (!token) { $('gateErr').textContent = '请输入房主 TOKEN'; $('tokenInput').focus(); return; }
  localStorage.setItem(PW_KEY, pw);
  localStorage.setItem(TOKEN_KEY(code), token);
  // 展示 token + 复制按钮
  $('tokenField').value = token;
  $('btnCopy').disabled = false;
  $('btnCopyRaw').disabled = false;
  connect(pw, token);
}

function connect(p, t) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/console?pw=${encodeURIComponent(p)}&code=${encodeURIComponent(code)}&token=${encodeURIComponent(t)}`;
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(url);

  ws.onopen = () => { wsConnectedOnce = true; $('errText').textContent = ''; };
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
      hideGate();
      $('errText').textContent = '';
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
        $('gateErr').textContent = m.message;
        showGate(); $('pwInput').focus();
      } else if (/token|不存在|不匹配/.test(m.message)) {
        localStorage.removeItem(TOKEN_KEY(code));
        $('gateErr').textContent = m.message;
        showGate(); $('tokenInput').focus();
      } else {
        $('errText').textContent = m.message;
      }
      break;
  }
}

function renderClosed(reason) {
  // 房间已关闭：清空本地 token，提示并返回大厅。
  localStorage.removeItem(TOKEN_KEY(code));
  showGate();
  $('gateErr').textContent = `房间 ${code} 已关闭：${reason}`;
  $('pwInput').value = localStorage.getItem(PW_KEY) || '';
  $('tokenInput').value = '';
  closed = true;
  setTimeout(() => { location.href = '/hall.html'; }, 3200);
}

// ---- UI hooks ----
$('btnBindBunkers').onclick = () => {
  const raw = $('bunkerIds').value.trim();
  if (!raw) { $('bunkerIds').focus(); return; }
  const ids = raw.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n) && n >= 24 && n <= 33);
  if (!ids.length) { $('errText').textContent = '请填入 24–33 范围内的掩体 ID'; return; }
  send('host:bunkers', { ids });
};
$('btnStart').onclick = () => send('host:start');
$('btnClose').onclick = () => { if (confirm('关闭房间？所有玩家会被踢出。')) send('host:close'); };

// ---- Render ----
function render(s) {
  $('code').textContent = s.code;
  $('phase').textContent = PHASE_CN[s.phase] ?? s.phase;
  $('phaseNo').textContent = 'SEC.' + String(s.code);
  $('hostName').textContent = '房主控制台';
  // 已识别为房主，解锁操作
  $('btnStart').disabled = false;
  $('btnClose').disabled = false;

  const tbody = $('players').querySelector('tbody');
  tbody.innerHTML = '';
  for (const p of s.players) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(p.name)}</td>` +
      `<td>${p.online ? '<span style="color:var(--green)">●</span>' : '<span class="muted">○</span>'}</td>` +
      `<td>${p.faction ? (FAC_CN[p.faction] ?? p.faction) : '-'}</td>` +
      `<td>${p.role ? (ROLE_CN[p.role] ?? p.role) : '-'}</td>` +
      `<td><span class="mono">${p.tagId ?? '-'}</span></td>`;
    tbody.appendChild(tr);
  }

  const bunkers = s.units.filter((u) => u.kind === 'bunker');
  $('bunkers').innerHTML = bunkers.length
    ? bunkers.map((u) => `<span class="tag" title="hp ${u.hp}/${u.maxHp}">id${u.id} ${u.destroyed ? '✕' : '✓'}</span>`).join('')
    : '<span class="muted-sm">尚未录入掩体</span>';

  setBar('red', s.units.find((u) => u.kind === 'base' && u.faction === 'red'));
  setBar('blue', s.units.find((u) => u.kind === 'base' && u.faction === 'blue'));

  const playerUnits = s.units.filter((u) => u.kind === 'player').sort((a, b) => a.id - b.id);
  $('units').innerHTML = playerUnits.length
    ? playerUnits.map((u) => {
        const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
        const fac = u.faction === 'red' ? 'red' : 'blue';
        return `<div class="unit">
          <span class="id">id${u.id}</span>
          <span class="name">${esc(u.name ?? '?')}</span>
          <span class="fac ${fac}"></span><span class="role">${ROLE_CN[u.role ?? 'assault'] ?? u.role}</span>
          <div class="bar"><div class="fill ${fac}" style="width:${pct}%"></div><span>${u.hp}/${u.maxHp}${u.alive ? '' : ' ✕ DOWN'}</span></div>
        </div>`;
      }).join('')
    : '<span class="muted-sm">尚无玩家绑定标签</span>';
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
