// tools/smoke.mjs — end-to-end server smoke test. Run while server is up.
import WebSocket from "ws";

const players = new Map();   // socketId -> ws
let nextId = 1;
function newConn() {
  const ws = new WebSocket("ws://localhost:3000/socket");
  ws._id = "p" + nextId++;
  return ws;
}

let logs = [];
function tag(msg) { logs.push(msg); console.log(msg); }

const host = new WebSocket("ws://localhost:3000/console?pw=ismism");
let code, token;

function finish(code2 = 0) {
  console.log("\n=== summary ===");
  logs.forEach((l) => console.log(" " + l));
  process.exit(code2);
}

host.on("open", () => host.send(JSON.stringify({ t: "room:create", hostName: "host" })));
host.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "room:created") {
    code = m.code; token = m.hostToken;
    tag(`host created room ${code} token=${token.slice(0,6)}…`);
    // host adds 2 bunkers
    host.send(JSON.stringify({ t: "host:bunkers", ids: [24, 25] }));
    // start 2 players
    joinPlayer("alice", "red", "assault", 0);
    joinPlayer("bob", "blue", "sniper", 1);
  } else if (m.t === "state") {
    const snap = m.snapshot;
    if (snap.phase === "playing" && !host._started) {
      host._started = true;
      tag("host sees playing; alice needs to attack bob.");
    }
  }
});

let alice, bob;
let aliceState = null, bobState = null;
let attackIssued = false;
let respawned = false;
let aliceAttackedTimes = 0;

function joinPlayer(name, faction, role, idx) {
  const ws = newConn();
  const role2 = idx === 0 ? alice : bob;
  if (idx === 0) alice = ws; else bob = ws;
  ws.on("open", () => ws.send(JSON.stringify({ t: "room:join", code, name })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "room:joined") tag(`${name} joined`);
    if (m.t === "state") {
      const snap = m.snapshot;
      const me = snap.players.filter((p) => (faction === "red" && p.name === "alice") || (faction === "blue" && p.name === "bob"))[0];
      // tag binding & faction/role
      if (!ws._faction) { ws.send(JSON.stringify({ t: "faction", faction })); ws._faction = true; return; }
      if (!ws._role) { ws.send(JSON.stringify({ t: "role", role })); ws._role = true; return; }
      if (!ws._bound && snap.players.find(p => p.name === name)?.faction) {
        const tagId = idx;  // alice = id 0, bob = id 1
        ws.send(JSON.stringify({ t: "bindTag", tagId }));
        ws._bound = true;
        tag(`${name} bound tag ${tagId}`);
        return;
      }
      // When bound → host starts? host triggers start when both bound.
      const allBound = snap.players.filter(p => ["alice", "bob"].includes(p.name)).every(p => p.tagId !== null);
      if (allBound && !host._startSent) {
        host._startSent = true;
        host.send(JSON.stringify({ t: "host:start" }));
        tag("host started game");
      }
      // Alice attacks bob (id 1) repeatedly → expect bob death at 10 hits.
      if (snap.phase === "playing" && idx === 0 && !attackIssued) {
        attackIssued = true;
        attackLoop(alice);
      }
      // respawn on dying? handled below via event.
    }
    if (m.t === "event") {
      const e = m.e;
      if (e.t === "kill") tag(`kill: id${e.src} >> id${e.tgt}`);
      if (e.t === "playerDown") tag(`down: id${e.id}`);
      if (e.t === "playerRevive") tag(`revive: id${e.id}`);
      if (e.t === "bunkerDestroyed") tag(`bunker destroyed id${e.id}`);
      if (e.t === "gameOver") tag(`GAME OVER winner=${e.winner}`);
    }
    if (m.t === "room:error") tag(`ERR ${name}: ${m.message}`);
  });
}

function attackLoop(wsAlice) {
  // attack bob (id=1) 11 times → bob will die (hp 100 → 0 after 10 hits).
  let i = 0;
  const timer = setInterval(() => {
    i++;
    wsAlice.send(JSON.stringify({ t: "attack", ids: [1] }));
    aliceAttackedTimes++;
    if (i >= 12) {
      clearInterval(timer);
      tag(`alice issued ${aliceAttackedTimes} attacks on bob`);
      // After bob dies alice should attack the enemy base (id 34 blue) 50 times to win.
      let j = 0;
      const t2 = setInterval(() => {
        j++;
        wsAlice.send(JSON.stringify({ t: "attack", ids: [34] }));
        if (j >= 51) {
          clearInterval(t2);
          tag("alice exhausted base attacks");
          host.send(JSON.stringify({ t: "host:close" }));
          setTimeout(finish, 1500);
        }
      }, 30);
    }
  }, 30);
}

setTimeout(() => { tag("TIMEOUT"); finish(1); }, 15000);