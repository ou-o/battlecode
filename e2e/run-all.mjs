// run-all.mjs — BattleCode e2e. miniprogram-automator drives the WeChat client
// as a player via mp.evaluate (page-method invocation), because page-level
// element/tap RPC hangs on this DevTools build while app-level evaluate works.
// A Node ws harness acts as host (/console) + extra combatants (/socket).
//
// DevTools lifecycle:
//   1. The IDE must already be running and exposing its HTTP API. We talk to
//      it via the WeChat "HTTP V2" interface on port <HTTP_PORT> (33287 unless
//      overridden by the BC_HTTP_PORT env var): /v2/open refreshes/opens the
//      client project.
//   2. `cli auto --auto-port <port> --project <path>` enabled against that IDE
//      (we pass `--port <HTTP_PORT>` so it reuses the existing IDE). The
//      resulting automator WS on <autoPort> is what miniprogram-automator
//      connects to.
import automator from 'miniprogram-automator';
import http from 'http';
import { connect, SERVER, assert, sleep } from './lib/ws.mjs';

const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PROJECT = '/Users/ruihanzhang/GitHub/battlecode/client';
const HTTP_PORT = Number(process.env.BC_HTTP_PORT || 33287);
const AUTO_PORT = Number(process.env.BC_AUTO_PORT || 9426);
const TAG_ME = 5, TAG_BOB = 1, TAG_CAROL = 2;
const BUNKERS = [23, 24];
const BASE_RED = 33, BASE_BLUE = 34;
const RESPAWN_MS = 30000;

let step = 'init';
const log = (m) => process.stdout.write('[' + step + '] ' + m + '\n');
const fail = (m) => { process.stdout.write('FAIL(' + step + '): ' + m + '\n'); process.exit(1); };
const set = (s) => { step = s; process.stdout.write('>>> ' + s + '\n'); };
let wd = null;
function armWatchdog(ms) { if (wd) clearInterval(wd); wd = setInterval(() => { process.stdout.write('!!WD stuck@' + step + '\n'); process.exit(2); }, ms); wd.unref?.(); }
armWatchdog(120000);

// app-level helpers (work)
const ev = (fn, ...a) => mp.evaluate(fn, ...a);
async function pageData() { return ev(() => { const ps = getCurrentPages(); const p = ps[ps.length - 1]; return p ? p.data : null; }); }
async function curPath() { return ev(() => { const ps = getCurrentPages(); return ps.length ? ps[ps.length - 1].route : null; }); }
async function waitForPath(target, timeout = 10000) {
  for (let i = 0; i < timeout / 150; i++) { const r = await curPath(); if (r === target) return true; await sleep(150); }
  return false;
}

let mp;
async function waitForServer() {
  for (let i = 0; i < 30; i++) { try { const h = await connect(SERVER + '/socket'); h.close(); return; } catch { await sleep(500); } }
  fail('server unreachable');
}

// HTTP V2 helper — talks to the WeChat devtools HTTP server on HTTP_PORT.
// Handles the async-task redirect pattern: /v2/open & friends return 303 to
// /v2/taskresult/<id> while the task is pending; poll that URL until it 200s.
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: HTTP_PORT, path }, (res) => {
      let body = ''; res.on('data', (d) => body += d); res.on('end', () => resolve({ status: res.statusCode, body, location: res.headers.location }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('http timeout')));
  });
}
async function httpGet(path) {
  let r = await rawGet(path);
  // Follow one redirect to the taskresult URL.
  if ((r.status === 303 || r.status === 302) && r.location) {
    const loc = r.location.startsWith('http') ? r.location : r.location;
    let p = loc;
    for (let i = 0; i < 100; i++) {
      const rr = await rawGet(p);
      if (rr.status === 200) return { status: 200, body: rr.body };
      if ((rr.status === 303 || rr.status === 302) && rr.location) { p = rr.location; await sleep(300); continue; }
      return { status: rr.status, body: rr.body };
    }
    return { status: r.status, body: 'task poll timeout' };
  }
  return { status: r.status, body: r.body };
}
async function waitForHttpApi() {
  for (let i = 0; i < 60; i++) {
    try { const r = await httpGet('/v2/islogin'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  fail('devtools HTTP API not reachable on : ' + HTTP_PORT);
}
async function openProjectViaHttp() {
  // Reset to a clean project window: close first (also frees any automator WS
  // that a previous run may have left bound). /v2/close has a 3s confirm
  // grace, so we let it settle. We deliberately do NOT /v2/open here: opening
  // via HTTP leaves the project in a state where the following automator.launch
  // (which itself opens the project via `cli auto`) hangs waiting for its WS.
  try { await httpGet('/v2/close?project=' + encodeURIComponent(PROJECT)); } catch {}
  await sleep(5000);
  log('project closed; letting automator.launch reopen');
}
const makeHost = () => connect(SERVER + '/console');
async function makePlayer({ code, name, faction, role, tagId }) {
  const p = await connect(SERVER + '/socket');
  const state = { snap: null, events: [], winner: null };
  p.on('state', (m) => { state.snap = m.snapshot; state.phase = m.snapshot.phase; });
  p.on('event', (m) => { state.events.push(m.e); if (m.e.t === 'gameOver') state.winner = m.e.winner; });
  p.send('room:join', { code, name });
  await p.wait('room:joined');
  p.send('faction', { faction }); await sleep(150);
  p.send('role', { role }); await sleep(150);
  p.send('bindTag', { tagId }); await sleep(150);
  return { p, state };
}

(async () => {
  set('server'); await waitForServer(); log('up');
  set('http-api'); await waitForHttpApi(); log('devtools HTTP API up on ' + HTTP_PORT);
  set('launch');
  await openProjectViaHttp();
  mp = await automator.launch({ cliPath: CLI, projectPath: PROJECT, wsPort: AUTO_PORT, args: ['--port', String(HTTP_PORT)], trustProject: true, timeout: 120000 });
  log('launched'); await sleep(2500);
  if (!(await waitForPath('pages/lobby/lobby', 8000))) fail('lobby not loaded');
  log('lobby loaded');

  set('host-create');
  const host = await makeHost();
  let code = null, token = null;
  host.on('room:created', (m) => { code = m.code; token = m.hostToken; });
  host.send('room:create', { hostName: 'e2e-host' });
  for (let i = 0; i < 40 && !code; i++) await sleep(100);
  if (!code) fail('no room'); log('room ' + code);

  set('server-url');
  await ev((u) => { getCurrentPages()[0].onServerInput({ detail: { value: u } }); }, 'ws://127.0.0.1:3000');
  await sleep(800);
  const su = await ev(() => getApp().globalData.serverUrl);
  assert(su === 'ws://127.0.0.1:3000', 'serverUrl set: ' + su);
  log('server url=' + su);

  set('inputs');
  await ev(() => getCurrentPages()[0].onInput({ currentTarget: { dataset: { k: 'name' } }, detail: { value: 'TestAlice' } }));
  await ev((c) => getCurrentPages()[0].onInput({ currentTarget: { dataset: { k: 'code' } }, detail: { value: c } }), code);
  await sleep(200);
  let d = await pageData(); assert(d.name === 'TestAlice' && d.code === code, 'inputs');
  log('name/code set');

  set('join');
  await ev(() => getCurrentPages()[0].joinRoom());
  let joined = false;
  for (let i = 0; i < 60; i++) { d = await pageData(); if (d.joined) { joined = true; break; } await sleep(150); }
  if (!joined) fail('not joined'); d = await pageData();
  assert(d.snapshot.code === code, 'joined code');
  log('joined ' + d.snapshot.code);

  set('facrole');
  await ev(() => getCurrentPages()[0].onFactionTap({ currentTarget: { dataset: { fac: 'red' } } }));
  await sleep(150);
  await ev(() => getCurrentPages()[0].onRoleTap({ currentTarget: { dataset: { role: 'assault' } } }));
  await sleep(200);
  d = await pageData(); assert(d.faction === 'red' && d.role === 'assault', 'fac/role');
  log('red/assault');

  set('bind');
  // manual id path (skip camera/worker — not available in simulator)
  await ev(() => getCurrentPages()[0].bindInput({ detail: { value: '5' } }));
  await sleep(150);
  d = await pageData(); assert(d.bindInput === '5', 'bindInput set');
  await ev(() => getCurrentPages()[0].submitBind());
  let bound = false;
  for (let i = 0; i < 30; i++) { d = await pageData(); if (d.me && d.me.tagId === TAG_ME) { bound = true; break; } await sleep(100); }
  if (!bound) { d = await pageData(); fail('me.tagId not bound; me=' + JSON.stringify(d.me) + ' err=' + d.err); }
  log('bound tag ' + TAG_ME);

  set('enemies');
  const bob = await makePlayer({ code, name: 'Bob', faction: 'blue', role: 'sniper', tagId: TAG_BOB });
  const carol = await makePlayer({ code, name: 'Carol', faction: 'blue', role: 'engineer', tagId: TAG_CAROL });
  await sleep(400);
  log('bob+carol joined');

  set('start');
  host.send('host:bunkers', { ids: BUNKERS }); await sleep(300);
  host.send('host:start');
  let playing = false;
  for (let i = 0; i < 60; i++) { d = await pageData(); if (d.phase === 'playing') { playing = true; break; } await sleep(150); }
  if (!playing) fail('not playing');
  if (!(await waitForPath('pages/index/index', 8000))) fail('did not go to battle page');
  log('battle page');

  set('battle-data');
  d = await pageData();
  assert(d.myUnit && d.myUnit.id === TAG_ME && d.myUnit.faction === 'red', 'myUnit');
  assert(d.enemies.some((u) => u.id === TAG_BOB), 'bob enemy');
  assert(d.enemies.some((u) => u.id === TAG_CAROL), 'carol enemy');
  assert(d.redBase && d.blueBase && d.redBase.id === BASE_RED && d.blueBase.id === BASE_BLUE, 'bases');
  assert(d.bunkers.length === BUNKERS.length, 'bunkers');
  log('battle data ok');

  set('attack-bob');
  await ev((id) => { const ps = getCurrentPages(); const p = ps[ps.length - 1]; p._trackers[String(id)] = { id, count: 99, misses: 0, visible: true, lastDet: { id, c: [100, 100], p: [[80, 80], [120, 80], [120, 120], [80, 120]] } }; }, TAG_BOB);
  const bobHp = async () => { const dd = await pageData(); return dd.enemies.find((u) => u.id === TAG_BOB); };
  let bu = await bobHp(); assert(bu && bu.alive && bu.hp === 100, 'bob 100');
  for (let i = 0; i < 12; i++) { await ev(() => { const ps = getCurrentPages(); ps[ps.length - 1].attack(); }); await sleep(60); }
  let bobDead = false;
  for (let i = 0; i < 40; i++) { bu = await bobHp(); if (bu && !bu.alive) { bobDead = true; break; } await sleep(120); }
  if (!bobDead) fail('bob not dead');
  d = await pageData(); log('bob dead; banner=' + d.bannerText);

  set('get-killed');
  for (let i = 0; i < 12; i++) { carol.p.send('attack', { ids: [TAG_ME] }); await sleep(40); }
  let meDead = false;
  for (let i = 0; i < 60; i++) { d = await pageData(); if (d.myUnit && !d.myUnit.alive) { meDead = true; break; } await sleep(120); }
  if (!meDead) fail('player not killed');
  d = await pageData(); assert(d.respawnRemain > 0, 'respawn cd'); log('player dead remain=' + d.respawnRemain);

  set('wait-respawn'); armWatchdog(70000);
  log('waiting ~30s for respawn');
  let ready = false;
  for (let i = 0; i < (RESPAWN_MS / 1000) + 30; i++) { d = await pageData(); if (d.respawnReady === true) { ready = true; break; } await sleep(1000); }
  if (!ready) fail('respawn not ready'); log('respawn ready');

  set('revive'); armWatchdog(30000);
  await ev(() => { const ps = getCurrentPages(); ps[ps.length - 1].respawnAtBase(); });
  let revived = false;
  for (let i = 0; i < 40; i++) { d = await pageData(); if (d.myUnit && d.myUnit.alive && d.myUnit.hp > 0) { revived = true; break; } await sleep(120); }
  if (!revived) fail('not revived');
  d = await pageData(); assert(d.bannerText === '已复活', 'revive banner'); log('revived hp=' + d.myUnit.hp);

  set('win'); armWatchdog(90000);
  // Re-inject the base tracker each iteration: by this point in a run the
  // camera/wasm pipeline is warm, so _updateTrackers([]) drops an injected
  // tracker after _DROP frames (~150 ms). Re-injecting every tick keeps the
  // target visible so each attack() actually emits a hit on the base.
  d = await pageData(); log('pre-win myUnit=' + JSON.stringify({alive:d.myUnit?.alive, canAttack:d.myUnit?.canAttack, hp:d.myUnit?.hp, fac:d.myUnit?.faction}) + ' blueBase=' + JSON.stringify({hp:d.blueBase?.hp, alive:d.blueBase?.alive}));
  for (let i = 0; i < 60; i++) {
    await ev((id) => { const ps = getCurrentPages(); const p = ps[ps.length - 1]; p._trackers[String(id)] = { id, count: 99, misses: 0, visible: true, lastDet: { id, c: [200, 200], p: [[180, 180], [220, 180], [220, 220], [180, 220]] } }; p.attack(); }, BASE_BLUE);
    await sleep(30);
  }
  d = await pageData(); log('post-attack blueBase hp=' + d.blueBase?.hp + ' endedOverlay=' + d.endedOverlay);
  let ended = false;
  for (let i = 0; i < 60; i++) { d = await pageData(); if (d.endedOverlay) { ended = true; break; } await sleep(200); }
  if (!ended) fail('no end overlay');
  d = await pageData(); assert(d.winnerText && d.winnerText.indexOf('红方') === 0, 'winner red');
  log('GAME OVER ' + d.winnerText);

  set('result');
  const redErr = await ev(() => { try { const ps = getCurrentPages(); ps[ps.length - 1].returnToResult(); return 'ok'; } catch (e) { return 'ERR:' + (e && e.message); } });
  if (redErr !== 'ok') fail('returnToResult threw: ' + redErr);
  if (!(await waitForPath('pages/result/result', 8000))) {
    const pp = await ev(() => getCurrentPages().map((p) => p.route));
    fail('not result page; current=' + JSON.stringify(pp));
  }
  d = await pageData(); assert(d.snapshot && d.stats && d.stats.length > 0, 'stats');
  assert(d.winnerText.indexOf('红方') === 0, 'result winner red');
  log('result stats=' + d.stats.length);

  set('cleanup'); host.send('host:close'); await sleep(400);
  clearInterval(wd);
  process.stdout.write('\n=== ALL E2E ASSERTS PASSED ===\n');
  try { await mp.close(); } catch (e) {}
  try { bob.p.close(); carol.p.close(); host.ws.close(); } catch (e) {}
  process.exit(0);
})().catch((e) => { process.stdout.write('E2E ERROR@' + step + ': ' + (e && e.stack || e) + '\n'); try { process.exit(1); } catch {} });