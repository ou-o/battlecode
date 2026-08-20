// src/rooms.ts
// In-memory room store + lifecycle. No persistence; restart wipes everything.

import {
  Faction, Room, RoomSnapshot, Unit, PlayerSummary, PlayerStats,
  BUNKER_ID_MIN, BUNKER_ID_MAX, BASE_RED_ID, BASE_BLUE_ID,
  BUNKER_MAX_HP, BASE_MAX_HP,
  MAX_PLAYERS, MAX_BUNKERS, MAX_ROOMS, VALID_CODE_RE,
  Role, RoomSummary,
} from './protocol.js';

export type { Room } from './protocol.js';

const rooms = new Map<string, Room>();

// ---- Token generation ---------------------------------------------------

function randHex(n: number): string {
  const bytes = new Uint8Array(n);
  (globalThis.crypto as any).getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function genHostToken(): string { return randHex(16); }

// ---- Helpers ------------------------------------------------------------

function makeBaseUnit(faction: Faction): Unit {
  return {
    id: faction === 'red' ? BASE_RED_ID : BASE_BLUE_ID,
    kind: 'base',
    faction,
    hp: BASE_MAX_HP, maxHp: BASE_MAX_HP,
    alive: true, destroyed: false,
    role: null, name: null, socketId: null,
    canAttack: false, respawnReadyAt: null,
  };
}

function newStats(id: number, name: string, faction: Faction, role: Role): PlayerStats {
  return { playerId: id, name, faction, role, kills: 0, deaths: 0, dealt: 0, taken: 0, healed: 0, bunkersDestroyed: 0, alive: true };
}

// ---- Public API ---------------------------------------------------------

export function createRoom(hostName: string, codeHint?: string): { room: Room; ok: true } | { ok: false; message: string } {
  if (rooms.size >= MAX_ROOMS) {
    return { ok: false, message: '房间总数已达上限 ' + MAX_ROOMS + ' 间' };
  }
  let code: string;
  if (codeHint) {
    if (!VALID_CODE_RE.test(codeHint)) return { ok: false, message: '房间号必须为三位数字' };
    if (rooms.has(codeHint)) return { ok: false, message: '房间号已被占用' };
    code = codeHint;
  } else {
    // random unused 3-digit code
    let tries = 0;
    do {
      code = String(Math.floor(Math.random() * 900) + 100);
      tries++;
      if (tries > 500) return { ok: false, message: '无可用房间号' };
    } while (rooms.has(code));
  }

  const room: Room = {
    code,
    hostSocketId: null,
    hostToken: genHostToken(),
    hostName: hostName || null,
    phase: 'lobby',
    units: new Map(),
    players: new Map(),
    log: [],
    stats: new Map(),
    startedAt: null,
    winner: null,
    lastActivity: Date.now(),
  };
  // Pre-create bases so the host can see them in the lobby. Bases are present
  // throughout; their hp matters only during 'playing'.
  room.units.set(BASE_RED_ID, makeBaseUnit('red'));
  room.units.set(BASE_BLUE_ID, makeBaseUnit('blue'));
  rooms.set(code, room);
  return { room, ok: true };
}

export function getRoom(code: string): Room | undefined { return rooms.get(code); }

export function allRooms(): Room[] { return [...rooms.values()]; }

export function closeRoom(code: string): boolean {
  const r = rooms.get(code);
  if (!r) return false;
  rooms.delete(code);
  return true;
}

// ---- Leave / explicit exit ----------------------------------------------

export interface LeaveResult {
  ok: boolean;
  message?: string;
  removedPlayer?: PlayerSummary;
  newHostSocketId?: string | null;
  roomNowEmpty: boolean;
  room: Room | undefined;
}

export function leaveRoom(room: Room, socketId: string): LeaveResult {
  const me = room.players.get(socketId);
  if (!me) return { ok: false, message: '未加入房间', roomNowEmpty: false, room };
  // Unbind this player's tag unit (if any).
  for (const u of [...room.units.values()]) {
    if (u.kind === 'player' && u.socketId === socketId) {
      room.units.delete(u.id);
      room.stats.delete(u.id);
    }
  }
  room.players.delete(socketId);
  room.lastActivity = Date.now();
  // Host handoff: pick first remaining online player, else null.
  let newHost: string | null = null;
  if (room.hostSocketId === socketId) {
    const next = [...room.players.values()].find(p => p.online);
    newHost = next ? next.socketId : null;
    room.hostSocketId = newHost;
  } else {
    newHost = room.hostSocketId;
  }
  return {
    ok: true,
    removedPlayer: me,
    newHostSocketId: newHost,
    roomNowEmpty: room.players.size === 0,
    room,
  };
}

export function joinRoom(room: Room, socketId: string, name: string): { ok: true; me: PlayerSummary } | { ok: false; message: string } {
  if (room.players.size >= MAX_PLAYERS && !room.players.has(socketId)) {
    return { ok: false, message: '房间已满（上限 ' + MAX_PLAYERS + ' 人）' };
  }
  // Re-join on reconnect: keep prior faction/role/tagId binding.
  let me = room.players.get(socketId);
  if (!me) {
    me = { socketId, name, faction: null, role: null, tagId: null, online: true };
    room.players.set(socketId, me);
  } else {
    me.name = name;
    me.online = true;
  }
  room.lastActivity = Date.now();
  return { ok: true, me };
}

export function disconnectSocket(socketId: string, roomOf: (socketId: string) => Room | undefined): Room | undefined {
  const room = roomOf(socketId);
  if (!room) return undefined;
  const me = room.players.get(socketId);
  if (me) {
    me.online = false;
    // Keep the summary (and the bound Unit) so the host can see disconnected
    // players. The room is reaped after idle timeout, not on single dc.
  }
  if (room.hostSocketId === socketId) {
    room.hostSocketId = null;  // console must re-attach with hostToken
  }
  room.lastActivity = Date.now();
  return room;
}

export function onlineCount(room: Room): number {
  let n = 0;
  for (const p of room.players.values()) if (p.online) n++;
  return n;
}

export const IDLE_ROOM_MS = 30 * 60 * 1000;        // 30 min if active players
export const EMPTY_ONLINE_MS = 2 * 60 * 1000;      // 2 min if no online players

/** Returns codes of rooms reaped. */
export function reapIdle(now = Date.now()): string[] {
  const reaped: string[] = [];
  for (const [code, r] of rooms) {
    const vacant = onlineCount(r) === 0;
    const limit = vacant ? EMPTY_ONLINE_MS : IDLE_ROOM_MS;
    if (now - r.lastActivity > limit) {
      rooms.delete(code);
      reaped.push(code);
    }
  }
  return reaped;
}

export function addBunkers(room: Room, ids: number[]): { ok: true } | { ok: false; message: string } {
  // drop non-conforming ids
  const cleaned: number[] = [];
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isInteger(id)) continue;
    if (id < BUNKER_ID_MIN || id > BUNKER_ID_MAX) continue;
    if (room.units.has(id)) continue;     // already created
    cleaned.push(id);
  }
  const existingBunkers = [...room.units.values()].filter(u => u.kind === 'bunker').length;
  if (existingBunkers + cleaned.length > MAX_BUNKERS) {
    return { ok: false, message: '掩体上限 ' + MAX_BUNKERS + ' 个' };
  }
  for (const id of cleaned) {
    room.units.set(id, {
      id, kind: 'bunker', faction: null,
      hp: BUNKER_MAX_HP, maxHp: BUNKER_MAX_HP,
      alive: true, destroyed: false,
      role: null, name: null, socketId: null,
      canAttack: false, respawnReadyAt: null,
    });
  }
  room.lastActivity = Date.now();
  return { ok: true };
}

export function snapshot(room: Room): RoomSnapshot {
  const units = [...room.units.values()].sort((a, b) => a.id - b.id);
  const players = [...room.players.values()].map(p => ({ ...p }));
  const stats = [...room.stats.values()].sort((a, b) => a.playerId - b.playerId);
  return {
    code: room.code,
    phase: room.phase,
    units,
    players,
    winner: room.winner,
    stats,
    startedAt: room.startedAt,
  };
}

export function summarize(room: Room): RoomSummary {
  const players = [...room.players.values()];
  let hostName: string | null = room.hostName;
  if (!hostName && room.hostSocketId) {
    const hp = room.players.get(room.hostSocketId);
    if (hp) hostName = hp.name;
  }
  return {
    code: room.code,
    phase: room.phase,
    playerCount: players.length,
    onlineCount: players.filter(p => p.online).length,
    hostName,
    hasHost: room.hostSocketId !== null,
    lastActivity: room.lastActivity,
    startedAt: room.startedAt,
    winner: room.winner,
  };
}

export function allSummaries(): RoomSummary[] {
  return [...rooms.values()].map(summarize).sort((a, b) => b.lastActivity - a.lastActivity);
}

// ---- Idle reaping (defined above near disconnectSocket) -----------------

export function ensureStatsFor(room: Room, unit: Unit): void {
  if (unit.kind !== 'player') return;
  if (room.stats.has(unit.id)) return;
  room.stats.set(unit.id, newStats(unit.id, unit.name ?? '', unit.faction ?? 'red', unit.role ?? 'assault'));
}

export { rooms };