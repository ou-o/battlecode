// tools/test_lifecycle.mjs — room lifecycle: create, join, leave, host-handoff,
// empty-close, host:close, idle reap, console room:list. Requires `npm run dev`.
import WebSocket from "ws";

const URL = process.env.BC_URL || "ws://127.0.0.1:3000";
let nextNum = 1;
function sock(path) {
  const ws = new WebSocket(URL + path);
  ws._logTag = "#" + nextNum++;
  return ws;
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function onMsg(ws, cb) {
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    cb(m);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function expect(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`  ok: ${label}`);
}
function step(label) { console.log(`\n== ${label}`); }

let failures = 0;
let passes = 0;
function check(cond, label) {
  if (cond) { passes++; console.log(`  pass: ${label}`); }
  else { failures++; console.error(`  FAIL: ${label}`); }
}

// ---------------- console: room:list returns [] when empty ----------------
step("console overview returns empty list initially");
{
  const c = sock("/console");
  const got = new Promise((res) => onMsg(c, (m) => { if (m.t === "room:list") res(m); }));
  await new Promise((r) => c.once("open", r));
  send(c, { t: "room:list" });
  const m = await Promise.race([got, wait(1000).then(() => null)]);
  check(m !== null, "got room:list response");
  check(m.rooms.length === 0, "initial list is empty");
  c.close();
}

// ---------------- create room via console -> list shows it ---------------
step("create room -> console overview shows 1 room");
const hostWs = sock("/console");
let code, token;
{
  await new Promise((r) => hostWs.once("open", r));
  const ev = new Promise((res) => onMsg(hostWs, (m) => m.t === "room:created" && res(m)));
  send(hostWs, { t: "room:create", hostName: "alice-host", code: "365" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  check(m !== null, "host got room:created");
  code = m.code; token = m.hostToken;
  check(code === "365", "code = 365");
}
{
  // Spinner: list should now show 1 room, 0 players, host alice-host.
  const ev = new Promise((res) => onMsg(hostWs, (m) => m.t === "room:list" && res(m)));
  send(hostWs, { t: "room:list" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  check(m?.rooms?.length === 1, "list shows 1 room");
  check(m.rooms[0].code === "365" && m.rooms[0].playerCount === 0, "summary field correct");
  check(m.rooms[0].hostName === "alice-host", "hostName carried through");
}

// ---------------- player joins ----------------
step("player bob joins");
const bobWs = sock("/socket");
{
  await new Promise((r) => bobWs.once("open", r));
  const ev = new Promise((res) => onMsg(bobWs, (m) => m.t === "room:joined" && res(m)));
  send(bobWs, { t: "room:join", code, name: "bob" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  check(m !== null, "bob got room:joined");
  check(m.snapshot.code === "365", "bob's snapshot.code = 365");
}

// ---------------- overview shows 1 player ----------------
step("console list shows 1 online player");
{
  const ev = new Promise((res) => onMsg(hostWs, (m) => m.t === "room:list" && res(m)));
  send(hostWs, { t: "room:list" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  check(m.rooms[0].playerCount === 1, "playerCount=1");
  check(m.rooms[0].onlineCount === 1, "onlineCount=1");
}

// ---------------- host disconnects but room persists (bob still in) ----------------
step("host ws disconnects; bob keeps room alive");
{
  hostWs.close();
  await wait(300);
  const ev = new Promise((res) => onMsg(bobWs, (m) => m.t === "state" && res(m)));
  // trigger a state via bob joining (re-join triggers broadcast).
  send(bobWs, { t: "faction", faction: "red" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  check(m !== null, "bob still gets state after host dc");
}

// ---------------- bob leaves -> room auto-closes (empty) -----------------
step("last player leaves -> room:auto-closed");
{
  const ev = new Promise((res) => onMsg(bobWs, (m) => m.t === "room:left" && res(m)));
  send(bobWs, { t: "room:leave" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  check(m !== null, "bob got room:left");
  // bob will NOT get room:closed (he left explicitly; no other members).
  // We verify by waiting briefly and asserting no further message.
  let extra = null;
  bobWs.on("message", (raw) => { extra = JSON.parse(raw.toString()); });
  await wait(300);
  check(extra === null || extra.t !== "room:closed", "leaver gets no room:closed");
}

// ---------------- overview empty again ----------------
step("overview empty after auto-close");
{
  const c = sock("/console");
  const ev = new Promise((res) => onMsg(c, (m) => m.t === "room:list" && res(m)));
  await new Promise((r) => c.once("open", r));
  send(c, { t: "room:list" });
  const m = await Promise.race([ev, wait(500).then(() => null)]);
  check(m?.rooms?.length === 0, "list empty after auto-close");
  c.close();
}
// bob already got `room:left` (he left explicitly) and the server closed the
// room because it was empty; no `room:closed` should land on bob's socket.
// Server-side: dissolveRoom broadcasts only to other members (none here).

// ---------------- host:close broadcasts room:closed to members ----------------
step("host:close broadcasts room:closed to all members");
{
  const h = sock("/console");
  await new Promise((r) => h.once("open", r));
  const ev = new Promise((res) => onMsg(h, (m) => m.t === "room:created" && res(m)));
  send(h, { t: "room:create", hostName: "host2", code: "481" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  const code2 = m.code;

  const p1 = sock("/socket");
  await new Promise((r) => p1.once("open", r));
  send(p1, { t: "room:join", code: code2, name: "carol" });

  const closedEv = new Promise((res) => onMsg(p1, (m) => m.t === "room:closed" && res(m)));
  // wait a bit, then close.
  await wait(200);
  send(h, { t: "host:close" });
  const cm = await Promise.race([closedEv, wait(1000).then(() => null)]);
  check(cm?.t === "room:closed", "carol got room:closed via host:close");

  // host should also be cleared (we don't have a way to check here though).
  h.close(); p1.close();
}

// ---------------- player leave with multiple players -> host handoff? ------
step("non-host player leaves; others stay");
{
  const h = sock("/console");
  await new Promise((r) => h.once("open", r));
  const ev = new Promise((res) => onMsg(h, (m) => m.t === "room:created" && res(m)));
  send(h, { t: "room:create", hostName: "host3", code: "222" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  const c3 = m.code;

  const p1 = sock("/socket");
  await new Promise((r) => p1.once("open", r));
  send(p1, { t: "room:join", code: c3, name: "dave" });

  const p2 = sock("/socket");
  await new Promise((r) => p2.once("open", r));
  send(p2, { t: "room:join", code: c3, name: "eve" });

  // wait for both joins
  await wait(300);

  const evt = new Promise((res) => onMsg(p1, (mm) => mm.t === "state" && res(mm)));
  send(p2, { t: "room:leave" });
  const st = await Promise.race([evt, wait(800).then(() => null)]);
  check(st?.t === "state", "dave still receives state updates after eve leaves");
  check(st?.snapshot?.players?.length === 1, "dave sees only 1 player (himself)");

  // close cleanup
  send(p1, { t: "room:leave" });
  await wait(200);
  h.close(); p1.close(); p2.close();
}

// ---------------- duplicate-host token reconnect path ----------------
step("console reconnect via ?code&token overrides room:hostSocketId");
{
  const h = sock("/console");
  await new Promise((r) => h.once("open", r));
  const ev = new Promise((res) => onMsg(h, (m) => m.t === "room:created" && res(m)));
  send(h, { t: "room:create", hostName: "rh", code: "777" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  const code4 = m.code; const tok = m.hostToken;

  const p = sock("/socket");
  await new Promise((r) => p.once("open", r));
  send(p, { t: "room:join", code: code4, name: "frank" });
  await wait(200);

  // Reconnect a new host socket using the token
  const h2 = sock(`/console?code=${code4}&token=${tok}`);
  const stEv = new Promise((res) => onMsg(h2, (mm) => mm.t === "state" && res(mm)));
  await new Promise((r) => h2.once("open", r));
  const st = await Promise.race([stEv, wait(1000).then(() => null)]);
  check(st?.t === "state", "reconnect host gets state");
  check(st?.snapshot?.code === code4, "reconnect sees room 777");

  send(h2, { t: "host:close" });
  await wait(200);
  h.close(); h2.close(); p.close();
}

// ---------------- leave twice should error gracefully ----------------
step("leave without joining returns room:error");
{
  const p = sock("/socket");
  const ev = new Promise((res) => onMsg(p, (m) => m.t === "room:error" && res(m)));
  await new Promise((r) => p.once("open", r));
  send(p, { t: "room:leave" });
  const m = await Promise.race([ev, wait(500).then(() => null)]);
  check(m?.t === "room:error", "leave with no room returns room:error");
  p.close();
}

console.log(`\n=== result: ${passes} pass, ${failures} fail ===`);
process.exit(failures ? 1 : 0);