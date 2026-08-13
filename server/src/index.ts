// src/index.ts
// BattleCode server entrypoint: HTTP (static console + healthcheck) + WebSocket
// for players (path /socket) and the host console (path /console, hostToken
// in query string). All messages use the { t, ...payload } envelope directly.

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rooms from './rooms.js';
import * as game from './game.js';
import {
  ClientMessage, ServerMessage, Room, Faction, Role,
} from './protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const app = express();
app.use(express.json());
app.use(express.static(WEB_DIR));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.allRooms().length }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

interface Ctx {
  ws: WebSocket;
  id: string;
  room: Room | null;
  isConsole: boolean;
}

const ctxs = new Map<WebSocket, Ctx>();

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url ?? '', 'http://localhost');
  if (u.pathname === '/socket' || u.pathname === '/console') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const u = new URL(req.url ?? '', 'http://localhost');
  const isConsole = u.pathname === '/console';
  const query = u.searchParams;
  const ctx: Ctx = { ws, id: sockIdOf(ws), room: null, isConsole };

  // Host console reconnect: ?code=XXX&token=YYY attaches and replays state.
  if (isConsole) {
    const code = query.get('code');
    const token = query.get('token');
    if (code && token) {
      const room = rooms.getRoom(code);
      if (room && room.hostToken === token) {
        ctx.room = room;
        room.hostSocketId = ctx.id;
        send(ws, { t: 'state', snapshot: rooms.snapshot(room) });
      } else {
        send(ws, { t: 'room:error', message: '房间不存在或 token 不匹配' });
      }
    }
  }
  ctxs.set(ws, ctx);

  ws.on('message', (raw) => {
    let msg: { t?: string };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ctx, msg as ClientMessage);
    } catch (err: any) {
      console.error('[handle]', err);
      send(ws, { t: 'room:error', message: String(err?.message ?? err) });
    }
  });

  ws.on('close', () => {
    onDisconnect(ctx);
    ctxs.delete(ws);
  });
  ws.on('error', () => { /* swallow */ });
});

// ---- Id assignment ----------------------------------------------------
let NEXT_ID = 1;
const idMap = new WeakMap<WebSocket, string>();
function sockIdOf(ws: WebSocket): string {
  let id = idMap.get(ws);
  if (!id) { id = 's' + NEXT_ID++; idMap.set(ws, id); }
  return id;
}

// ---- Broadcast --------------------------------------------------------
function broadcast(room: Room, msg: ServerMessage, except?: WebSocket): void {
  for (const [ws, ctx] of ctxs) {
    if (ctx.room !== room) continue;
    if (ws === except) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    send(ws, msg);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcastState(room: Room): void { broadcast(room, { t: 'state', snapshot: rooms.snapshot(room) }); }

function onDisconnect(ctx: Ctx): void {
  const room = ctx.room;
  if (!room) return;
  if (ctx.isConsole && room.hostSocketId === ctx.id) room.hostSocketId = null;
  const me = room.players.get(ctx.id);
  if (me) me.online = false;
  broadcastState(room);
}

// ---- Message dispatch --------------------------------------------------
function handle(ctx: Ctx, msg: ClientMessage): void {
  const ws = ctx.ws;

  switch (msg.t) {
    case 'room:create': {
      const r0 = rooms.createRoom(msg.hostName, msg.code);
      if (!r0.ok) { send(ws, { t: 'room:error', message: r0.message }); return; }
      ctx.room = r0.room;
      r0.room.hostSocketId = ctx.id;
      send(ws, { t: 'room:created', code: r0.room.code, hostToken: r0.room.hostToken });
      broadcastState(r0.room);
      return;
    }
    case 'room:join': {
      const room = rooms.getRoom(msg.code);
      if (!room) { send(ws, { t: 'room:error', message: '房间不存在' }); return; }
      const r = rooms.joinRoom(room, ctx.id, msg.name);
      if (!r.ok) { send(ws, { t: 'room:error', message: r.message }); return; }
      ctx.room = room;
      send(ws, { t: 'room:joined', snapshot: rooms.snapshot(room), me: r.me });
      broadcastState(room);
      return;
    }
  }

  const room = ctx.room;
  if (!room) { send(ws, { t: 'room:error', message: '未加入房间' }); return; }

  switch (msg.t) {
    case 'faction': {
      const r = game.setFaction(room, ctx.id, msg.faction as Faction);
      if (!r.ok) send(ws, { t: 'room:error', message: r.message });
      broadcastState(room);
      return;
    }
    case 'role': {
      const r = game.setRole(room, ctx.id, msg.role as Role);
      if (!r.ok) send(ws, { t: 'room:error', message: r.message });
      broadcastState(room);
      return;
    }
    case 'bindTag': {
      const r = game.bindTag(room, msg.tagId, ctx.id);
      if (!r.ok) send(ws, { t: 'room:error', message: r.message });
      broadcastState(room);
      return;
    }
    case 'host:bunkers': {
      if (room.hostSocketId !== ctx.id) { send(ws, { t: 'room:error', message: '非房主' }); return; }
      const r = rooms.addBunkers(room, msg.ids);
      if (!r.ok) { send(ws, { t: 'room:error', message: r.message }); return; }
      broadcastState(room);
      return;
    }
    case 'host:start': {
      if (room.hostSocketId !== ctx.id) { send(ws, { t: 'room:error', message: '非房主' }); return; }
      game.startGame(room);
      broadcastState(room);
      return;
    }
    case 'host:close': {
      if (room.hostSocketId !== ctx.id) { send(ws, { t: 'room:error', message: '非房主' }); return; }
      broadcast(room, { t: 'state', snapshot: rooms.snapshot({ ...room, phase: 'ended' } as Room) });
      rooms.closeRoom(room.code);
      return;
    }
    case 'attack': {
      const out = game.resolveAttack(room, ctx.id, msg.ids);
      if (out.stateChanged) {
        for (const ev of out.events) broadcast(room, { t: 'event', e: ev.e, ts: ev.ts });
        broadcastState(room);
      }
      return;
    }
    case 'respawn': {
      const r = game.respawn(room, ctx.id, msg.baseId);
      if (!r.ok) { send(ws, { t: 'room:error', message: r.message }); return; }
      const tagId = room.players.get(ctx.id)?.tagId ?? -1;
      broadcast(room, { t: 'event', e: { t: 'playerRevive', id: tagId }, ts: Date.now() });
      broadcastState(room);
      return;
    }
    default:
      return;
  }
}

server.listen(PORT, () => {
  console.log(`battlecode server listening on http://localhost:${PORT}`);
});