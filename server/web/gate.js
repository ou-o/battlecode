// web/gate.js — 大厅 → 房间页 之间的校验页。
// 口令已在大厅本地保存（bc_console_pw），这里只需房主 6 位验证码。
// 连接 /console?pw&code&token 由服务端校验；返回 state 即通过 → 跳转
// /room/:code?token=... 自动进入；返回 room:error 则提示（口令/验证码错误）。

const $ = (id) => document.getElementById(id);
const PW_KEY = 'bc_console_pw';

const pathParts = location.pathname.split('/').filter(Boolean);
const code = decodeURIComponent(pathParts[pathParts.length - 1] || '');

let ws = null;

function main() {
  $('gateCode').textContent = /^\d{3}$/.test(code) ? code : '—';

  if (!/^\d{3}$/.test(code)) {
    $('gateErr').textContent = '房间号不合法（需三位数字），3 秒后返回大厅。';
    $('codeInput').disabled = true;
    $('btnEnter').disabled = true;
    setTimeout(() => { location.href = '/hall.html'; }, 3000);
    return;
  }

  const pw = localStorage.getItem(PW_KEY) || '';
  if (!pw) {
    // 从未在大厅输入过口令 → 先回大厅完成口令验证。
    $('gateErr').textContent = '请先在大厅输入口令，再进入房间。';
    $('codeInput').disabled = true;
    $('btnEnter').disabled = true;
    setTimeout(() => { location.href = '/hall.html'; }, 1600);
    return;
  }

  $('codeInput').addEventListener('input', () => {
    $('btnEnter').disabled = !/^\d{6}$/.test($('codeInput').value.trim());
    $('gateErr').textContent = '';
  });
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
  $('btnEnter').onclick = enter;

  // 聚焦便于直接输入
  $('codeInput').focus();
}

function enter() {
  const token = ($('codeInput').value || '').trim();
  if (!/^\d{6}$/.test(token)) { $('gateErr').textContent = '请输入 6 位数字验证码'; $('codeInput').focus(); return; }
  const pw = localStorage.getItem(PW_KEY) || '';
  $('gateErr').textContent = '';
  $('btnEnter').disabled = true;

  // 服务端校验：口令 + 房间存在 + token 匹配。
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(`${proto}//${location.host}/console?pw=${encodeURIComponent(pw)}&code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`);

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'state') {
      // 校验通过 → 跳转房间页（带 token，房间页自动进入）
      location.href = `/room/${encodeURIComponent(code)}?token=${encodeURIComponent(token)}`;
    } else if (m.t === 'room:error') {
      $('gateErr').textContent = m.message;
      $('btnEnter').disabled = false;
      try { ws.close(); } catch {}
      ws = null;
    }
  };
  ws.onclose = () => { ws = null; };
  ws.onerror = () => {};
}

main();
