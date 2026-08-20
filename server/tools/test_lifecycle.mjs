// tools/test_lifecycle.mjs — room lifecycle + console routing.
// Prerequisites: `npm run dev` running on 127.0.0.1:3000.
import WebSocket from "ws";

const URL = process.env.BC_URL || "ws://127.0.0.1:3000";
const HTTP = URL.replace(/^ws/, "http");
const CONSOLE_PW = process.env.BC_CONSOLE_PW || "ismism";
function sock(path) {
  // Console endpoints require ?pw=; player sockets ignore it.
  if (path.startsWith("/console")) {
    const sep = path.includes("?") ? "&" : "?";
    return new WebSocket(URL + path + sep + "pw=" + CONSOLE_PW);
  }
  return new WebSocket(URL + path);
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function onMsg(ws, cb) {
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    cb(m);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passes = 0, failures = 0;
function check(cond, label) {
  if (cond) { passes++; console.log(`  pass: ${label}`); }
  else { failures++; console.error(`  FAIL: ${label}`); }
}
const step = (label) => console.log(`\n== ${label}`);

// ---------------- HTTP routing for /room/:code -------------------------
step("/room/:code returns room.html; /room/bad returns 404");
{
  const bad = await fetch(`${HTTP}/room/abc`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  check(bad?.status === 404, "/room/abc -> 404");
  const ok = await fetch(`${HTTP}/room/365`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  check(ok?.status === 200, "/room/365 -> 200");
  const body = await ok.text();
  check(body.includes("BattleCode 控制台 · 房间"), "served room page for any 3-digit code");
}

// ---------------- empty overview list -----------------------------------
step("overview returns empty list initially");
{
  const c = sock("/console");
  const got = new Promise((res) => onMsg(c, (m) => m.t === "room:list" && res(m)));
  await new Promise((r) => c.once("open", r));
  send(c, { t: "room:list" });
  const m = await Promise.race([got, wait(1000).then(() => null)]);
  check(m?.rooms?.length === 0, "initially empty");
  c.close();
}

// ---------------- create + overview lists it ---------------------------
step("create + overview lists the new room");
const hostWs = sock("/console");
let code, token;
{
  await new Promise((r) => hostWs.once("open", r));
  const ev = new Promise((res) => onMsg(hostWs, (m) => m.t === "room:created" && res(m)));
  send(hostWs, { t: "room:create", hostName: "alice-host", code: "365" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  check(m?.t === "room:created", "got room:created");
  code = m.code; token = m.hostToken;
  check(code === "365", "code = 365");
}
{
  send(hostWs, { t: "room:list" });
  const m = await Promise.race([new Promise((res) => onMsg(hostWs, (mm) => mm.t === "room:list" && res(mm))), wait(1000).then(() => null)]);
  check(m?.rooms?.length === 1 && m.rooms[0].code === "365" && m.rooms[0].hostName === "alice-host", "list has room with hostName");
}

// ---------------- overview sockets get auto-pushes on state changes -----
step("overview sockets auto-receive list updates when any state changes");
{
  const ov = sock("/console");
  const ev = new Promise((res) => onMsg(ov, (m) => m.t === "room:list" && m.rooms?.length === 1 && m.rooms[0].playerCount === 1 && res(m)));
  await new Promise((r) => ov.once("open", r));
  send(ov, { t: "room:list" });  // start the stream
  // trigger state change via a player joining:
  const p = sock("/socket");
  await new Promise((r) => p.once("open", r));
  send(p, { t: "room:join", code, name: "bob" });
  const m = await Promise.race([ev, wait(2000).then(() => null)]);
  check(m !== null, "overview got pushed list update with playerCount=1 after bob joined");
  // clean teardown: bob explicitly leaves so the room has no lingering players.
  const leftEv = new Promise((res) => onMsg(p, (m) => m.t === "room:left" && res(m)));
  send(p, { t: "room:leave" });
  await Promise.race([leftEv, wait(1000).then(() => null)]);
  ov.close(); p.close();
  await wait(300);
}

// ---------------- leave flow + empty-close ------------------------------
step("last player leaves -> room dissolved");
{
  const h = sock("/console");
  await new Promise((r) => h.once("open", r));
  const created = new Promise((res) => onMsg(h, (m) => m.t === "room:created" && res(m)));
  send(h, { t: "room:create", hostName: "rhL", code: "555" });
  const m = await Promise.race([created, wait(1000).then(() => null)]);
  const leaveCode = m.code;

  const p = sock("/socket");
  await new Promise((r) => p.once("open", r));
  send(p, { t: "room:join", code: leaveCode, name: "carol" });
  const joined = await Promise.race([new Promise((res) => onMsg(p, (mm) => mm.t === "room:joined" && res(mm))), wait(1000).then(() => null)]);
  check(joined !== null, "carol joined into dedicated room");
  const leftEv = new Promise((res) => onMsg(p, (mm) => mm.t === "room:left" && res(mm)));
  send(p, { t: "room:leave" });
  const lm = await Promise.race([leftEv, wait(1000).then(() => null)]);
  check(lm?.t === "room:left", "carol got room:left");
  await wait(300);
  p.close();
}
{
  // overview should now be empty (room auto-closed because last member left).
  const ov = sock("/console");
  const mP = new Promise((res) => onMsg(ov, (m) => m.t === "room:list" && res(m)));
  await new Promise((r) => ov.once("open", r));
  send(ov, { t: "room:list" });
  const m = await Promise.race([mP, wait(1000).then(() => null)]);
  check(m?.rooms?.length === 0, "overview empty after auto-close");
  ov.close();
}

// ---------------- host:close broadcasts room:closed ----------------------
step("host:close broadcasts room:closed and overview reflects removal");
{
  const h = sock("/console");
  await new Promise((r) => h.once("open", r));
  const ev = new Promise((res) => onMsg(h, (m) => m.t === "room:created" && res(m)));
  send(h, { t: "room:create", hostName: "rh", code: "481" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  const c2 = m.code;

  const p = sock("/socket");
  await new Promise((r) => p.once("open", r));
  send(p, { t: "room:join", code: c2, name: "dave" });

  const oRef = sock("/console");
  const ovSeen = new Promise((res) => onMsg(oRef, (mm) => mm.t === "room:list" && mm.rooms?.length === 0 && res(mm)));
  await new Promise((r) => oRef.once("open", r));
  send(oRef, { t: "room:list" });

  const closedP = new Promise((res) => onMsg(p, (mm) => mm.t === "room:closed" && res(mm)));
  await wait(200);
  send(h, { t: "host:close" });
  const cm = await Promise.race([closedP, wait(1500).then(() => null)]);
  check(cm?.t === "room:closed", "dave got room:closed via host:close");
  // dissolveRoom pushes overview, so oRef should see length=0.
  const seenRemoved = await Promise.race([ovSeen, wait(1500).then(() => null)]);
  check(seenRemoved !== null, "overview got list with 0 rooms after close");
  h.close(); p.close(); oRef.close();
}

// ---------------- token reconnect path ----------------------------------
step("token reconnect via ?code&token restores state");
{
  const h = sock("/console");
  await new Promise((r) => h.once("open", r));
  const ev = new Promise((res) => onMsg(h, (m) => m.t === "room:created" && res(m)));
  send(h, { t: "room:create", hostName: "host3", code: "777" });
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  const code3 = m.code; const tok = m.hostToken;
  const p = sock("/socket");
  await new Promise((r) => p.once("open", r));
  send(p, { t: "room:join", code: code3, name: "frank" });
  await wait(200);
  const h2 = sock(`/console?code=${code3}&token=${tok}`);
  const stEv = new Promise((res) => onMsg(h2, (mm) => mm.t === "state" && res(mm)));
  await new Promise((r) => h2.once("open", r));
  const st = await Promise.race([stEv, wait(1500).then(() => null)]);
  check(st?.t === "state" && st.snapshot.code === code3, "reconnect with token gets state");
  send(h2, { t: "host:close" });
  h.close(); h2.close(); p.close();
}

// ---------------- leave without room -> error ----------------------------
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

// ---------------- bad token reconnect -> room:error ----------------------
step("bad token -> room:error from server on reconnect");
{
  const h = sock("/console?code=999&token=invalidfake");
  const ev = new Promise((res) => onMsg(h, (m) => m.t === "room:error" && res(m)));
  await new Promise((r) => h.once("open", r));
  const m = await Promise.race([ev, wait(1000).then(() => null)]);
  check(m?.t === "room:error", "bad token yields room:error");
  h.close();
}

step("test complete");
console.log(`\n=== result: ${passes} pass, ${failures} fail ===`);
process.exit(failures ? 1 : 0);