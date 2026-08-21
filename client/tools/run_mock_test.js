// run_mock_test.js — 用 mock 微信运行时实测 client 的 app.js + utils/ws.js
// 对真实服务端(需已启动,缺省 ws://127.0.0.1:3000)的完整链路:
//   console 内嵌口令直连 → 无 ping 心跳 → 加入拿 token → 模拟断网 →
//   自动重连带 token 重入并恢复阵营/角色/标签 → 攻击命中。
// 跑之前先启动服务端(server): npm run build && npm start
//
// 用法: 从 client/tools 目录: node run_mock_test.js
//       或指定服务器地址: BC_URL=ws://<host>:3000 node run_mock_test.js
const path = require('path');
const { buildMockEnv, RealWS } = require('./mock_miniprogram.js');
const env = buildMockEnv();
const { store, outbound, connectedUrls } = env;

const SERVER_URL = process.env.BC_URL || 'ws://127.0.0.1:3000';
const CONSOLE_PW = process.env.BC_CONSOLE_PW || 'ismism';   // 必须与服务端一致
const PWP = '?pw=' + CONSOLE_PW;
const CLI = path.resolve(__dirname, '..');                  // client/
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passes = 0, failures = 0;
const check = (c, l) => { if (c) { passes++; console.log('  pass: ' + l); } else { failures++; console.error('  FAIL: ' + l); } };
const step = (l) => console.log('\n== ' + l);

async function createRoom(pw) {
  const h = new RealWS(SERVER_URL + '/console' + pw);
  await new Promise((r) => h.once('open', r));
  const ev = new Promise((res) => h.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'room:created') res(m); }));
  const code = String(Math.floor(Math.random() * 900) + 100);
  let m;
  for (let i = 0; i < 5; i++) {
    h.send(JSON.stringify({ t: 'room:create', hostName: 'mockhost', code }));
    m = await Promise.race([ev, wait(800).then(() => null)]);
    if (m) break;
  }
  return { code, token: m.hostToken, h };
}

(async () => {
  step('加载 client/app.js + utils/ws.js');
  store['bc_server'] = SERVER_URL;
  require(CLI + '/app.js');
  const wsApi = require(CLI + '/utils/ws.js');
  check(typeof wsApi.send === 'function' && typeof wsApi.on === 'function', 'ws 桥 API 就绪');

  const { code, h: host } = await createRoom(PWP);

  step('连接走 /console 内嵌口令,且不发 ping 心跳');
  wsApi.getWs();
  const openP = new Promise((res) => wsApi.on('_open', () => res(true)));
  const e1 = await Promise.race([openP, wait(3000)]);
  check(e1 === true, 'socket 连上');
  check(connectedUrls.length === 1 && connectedUrls[0].includes('/console?pw='), '连接 URL 为 /console?pw=…');
  check(connectedUrls[0].split('pw=')[1] === CONSOLE_PW, '口令与 BC_CONSOLE_PW 一致');
  await wait(2500);
  const pings = outbound.filter((s) => /"t":"ping"/.test(s) || /"t":"pong"/.test(s));
  check(pings.length === 0, '无 ping/pong 心跳消息发出');
  const preErrs = outbound.filter((s) => /未加入房间/.test(s));
  check(preErrs.length === 0, '未加入房间前不触发“未加入房间”错误');

  step('加入房间并绑定身份');
  let token;
  {
    const jp = new Promise((res) => wsApi.on('room:joined', res));
    wsApi.send('room:join', { code, name: 'mockplayer' });
    const j = await Promise.race([jp, wait(3000)]);
    check(!!j && j.snapshot.code === code, '收到 room:joined,进入房间 ' + code);
    token = j.me && j.me.token;
    check(token && token.length >= 6, '拿到玩家 token: ' + token);
    wsApi.send('faction', { faction: 'red' });
    wsApi.send('role', { role: 'sniper' });
    wsApi.send('bindTag', { tagId: 3 });
    await wait(400);
  }

  step('模拟断网 → 自动重连 → 带 token 重入并恢复绑定');
  const rejoinP = new Promise((res) => wsApi.on('room:joined', (m) => { if (m.me && m.me.token === token) res(m); }));
  env.real.close(1000);                       // 底层断开 → onClose → scheduleReconnect
  const rj = await Promise.race([rejoinP, wait(6500).then(() => null)]);
  check(!!rj, '断线后自动重连并重入同一房间');
  check(rj && rj.me.token === token, '重连后 token 保持一致: ' + (rj && rj.me.token));
  check(rj && rj.me.faction === 'red' && rj.me.role === 'sniper' && rj.me.tagId === 3,
    '重连后 faction/role/tagId 恢复');
  check(connectedUrls.length >= 2, '重连确实新建了连接(共 ' + connectedUrls.length + ' 次)');
  const g = env.appGlobal;
  check(g && g.code === code && g.me && g.me.token === token, 'globalData 同步为新连接身份(code/me/token)');

  step('重连后新身份可攻击');
  host.send(JSON.stringify({ t: 'host:start' }));   // 进入 playing 战斗阶段
  await wait(200);
  {
    const hitP = new Promise((res) => wsApi.on('event', (m) => m.e && m.e.t === 'hit' && res(m)));
    wsApi.send('attack', { ids: [35] });          // 敌对蓝基地
    const hh = await Promise.race([hitP, wait(3000).then(() => null)]);
    check(hh && hh.e && hh.e.t === 'hit', '重连后攻击命中(拿到 hit 事件)');
  }

  host.send(JSON.stringify({ t: 'host:close' }));
  await wait(200);
  console.log('\n=== result: ' + passes + ' pass, ' + failures + ' fail ===');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('UNHANDLED', e); process.exit(1); });