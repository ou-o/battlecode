// src/game.ts
// Attack resolution, death/respawn, bunker destruction, base win condition,
// stats accumulation. Pure logic operating on a Room; the WS layer (index.ts)
// calls these and handles broadcasting.

import {
  Room,
  Unit, GameEvent, EventEnvelope, Faction, Role,
  DAMAGE_PER_HIT, PLAYER_MAX_HP, RESPAWN_MS,
  PLAYER_ID_MIN, PLAYER_ID_MAX, BASE_RED_ID, BASE_BLUE_ID,
} from './protocol.js';
import { ensureStatsFor } from './rooms.js';

interface AttackOutcome {
  events: { e: GameEvent; ts: number }[];
  stateChanged: boolean;
}

function now(): number { return Date.now(); }

function recordEvent(room: Room, e: GameEvent): void {
  const env: EventEnvelope = { t: 'event', e, ts: now() };
  room.log.push(env);
}

// ---- Phase transitions triggered by host --------------------------------

export function startGame(room: Room): void {
  // Only valid from 'binding' (or 'lobby' as a degenerate skip — but we
  // require 'armed' herein). Caller is expected to have invoked host:bunkers.
  room.phase = 'armed';
  // Transition immediately to playing; 'armed' is a momentary marker.
  room.phase = 'playing';
  room.startedAt = now();
  // Reset every unit's hp at game start (in case lobby tinkering changed it).
  for (const u of room.units.values()) {
    u.hp = u.maxHp;
    u.alive = true;
    u.destroyed = false;
    if (u.kind === 'player') {
      u.canAttack = true;
      u.respawnReadyAt = null;
      ensureStatsFor(room, u);
    }
  }
}

export function closeGame(room: Room): void {
  room.phase = 'ended';
  room.startedAt = null;
}

// ---- Player tag binding -------------------------------------------------

export function bindTag(room: Room, unitId: number, socketId: string): { ok: true } | { ok: false; message: string } {
  if (room.phase !== 'lobby' && room.phase !== 'binding') {
    return { ok: false, message: '当前阶段不可绑定' };
  }
  if (unitId < PLAYER_ID_MIN || unitId > PLAYER_ID_MAX) {
    return { ok: false, message: '玩家 ID 必须在 ' + PLAYER_ID_MIN + '-' + PLAYER_ID_MAX + ' 之间' };
  }
  // Already bound to someone else?
  for (const u of room.units.values()) {
    if (u.kind === 'player' && u.id === unitId && u.socketId && u.socketId !== socketId) {
      return { ok: false, message: 'ID ' + unitId + ' 已被其他玩家绑定' };
    }
  }
  // Unbind any previous tag this socket had.
  for (const u of room.units.values()) {
    if (u.kind === 'player' && u.socketId === socketId && u.id !== unitId) {
      room.units.delete(u.id);
    }
  }
  const me = room.players.get(socketId);
  if (!me) return { ok: false, message: '未加入房间' };
  // Create or update the player unit.
  let unit = room.units.get(unitId);
  if (!unit) {
    unit = {
      id: unitId, kind: 'player', faction: me.faction ?? null,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP,
      alive: true, destroyed: false,
      role: me.role, name: me.name, socketId,
      canAttack: false, respawnReadyAt: null,
    };
    room.units.set(unitId, unit);
  } else {
    unit.socketId = socketId;
    unit.name = me.name;
    unit.role = me.role;
    unit.faction = me.faction ?? unit.faction;
  }
  me.tagId = unitId;
  ensureStatsFor(room, unit);
  room.phase = room.phase === 'lobby' ? 'binding' : 'binding';
  return { ok: true };
}

// ---- Faction / role -----------------------------------------------------

export function setFaction(room: Room, socketId: string, faction: Faction): { ok: true } | { ok: false; message: string } {
  const me = room.players.get(socketId);
  if (!me) return { ok: false, message: '未加入房间' };
  me.faction = faction;
  // Reflect onto bound player unit if any.
  for (const u of room.units.values()) {
    if (u.kind === 'player' && u.socketId === socketId) { u.faction = faction; }
  }
  return { ok: true };
}

export function setRole(room: Room, socketId: string, role: Role): { ok: true } | { ok: false; message: string } {
  const me = room.players.get(socketId);
  if (!me) return { ok: false, message: '未加入房间' };
  me.role = role;
  for (const u of room.units.values()) {
    if (u.kind === 'player' && u.socketId === socketId) { u.role = role; }
  }
  return { ok: true };
}

// ---- Attack resolution --------------------------------------------------

export function resolveAttack(room: Room, attackerSocketId: string, targetIds: number[]): AttackOutcome {
  const outcome: AttackOutcome = { events: [], stateChanged: false };
  if (room.phase !== 'playing') return outcome;

  const attacker = [...room.units.values()].find(u => u.kind === 'player' && u.socketId === attackerSocketId);
  if (!attacker || !attacker.alive || !attacker.canAttack) return outcome;

  const src = attacker.id;
  const attackerStats = room.stats.get(src);
  // Dedupe & ignore impossible ids.
  const seen = new Set<number>();
  for (const id of targetIds) {
    if (typeof id !== 'number' || !Number.isInteger(id)) continue;
    if (seen.has(id)) continue;
    const unit = room.units.get(id);
    if (!unit) continue;
    // Can't attack your own faction's player/base (but bunkers are unaligned).
    if (unit.faction && unit.faction === attacker.faction && unit.kind !== 'bunker') continue;
    if (!unit.alive && !unit.destroyed) continue;       // dead target
    if (unit.destroyed) continue;
    seen.add(id);
    outcome.stateChanged = true;

    applyDamage(room, unit, DAMAGE_PER_HIT, src, outcome);
    if (attackerStats && unit.kind !== 'base') {
      attackerStats.dealt += DAMAGE_PER_HIT;
    }
    if (unit.kind === 'player' && room.stats.has(unit.id)) {
      room.stats.get(unit.id)!.taken += DAMAGE_PER_HIT;
    }
    // hit event for shooter feedback (even on base)
    pushHit(outcome, room, src, unit.id, DAMAGE_PER_HIT);
    if (unit.kind === 'base') {
      pushBaseHit(outcome, room, unit, src);
    }
  }
  return outcome;
}

function pushHit(out: AttackOutcome, room: Room, src: number, tgt: number, dmg: number): void {
  const e: GameEvent = { t: 'hit', src, tgt, dmg };
  out.events.push({ e, ts: now() });
  recordEvent(room, e);
}

function pushBaseHit(out: AttackOutcome, room: Room, base: Unit, src: number | null): void {
  const e: GameEvent = { t: 'baseHit', id: base.id, src, hp: base.hp };
  out.events.push({ e, ts: now() });
  recordEvent(room, e);
}

function applyDamage(room: Room, unit: Unit, dmg: number, srcId: number | null, out: AttackOutcome): void {
  unit.hp = Math.max(0, unit.hp - dmg);
  if (unit.hp > 0) return;
  // hp reached 0 — death/destruction handling per kind.
  switch (unit.kind) {
    case 'player': {
      unit.alive = false;
      unit.canAttack = false;
      unit.respawnReadyAt = now() + RESPAWN_MS;
      const stats = room.stats.get(unit.id);
      if (stats) { stats.deaths += 1; stats.alive = false; }
      pushEvent(out, room, { t: 'playerDown', id: unit.id });
      // Kill credit + kill event (only when a real attacker killed them)
      if (srcId !== null && srcId !== unit.id && room.stats.has(srcId)) {
        room.stats.get(srcId)!.kills += 1;
        pushEvent(out, room, { t: 'kill', src: srcId, tgt: unit.id });
      }
      break;
    }
    case 'bunker': {
      unit.destroyed = true;
      unit.alive = false;
      if (srcId !== null && room.stats.has(srcId)) {
        room.stats.get(srcId)!.bunkersDestroyed += 1;
      }
      pushEvent(out, room, { t: 'bunkerDestroyed', id: unit.id, src: srcId });
      break;
    }
    case 'base': {
      unit.alive = false;
      const winner: Faction = unit.faction === 'red' ? 'blue' : 'red';
      room.winner = winner;
      room.phase = 'ended';
      pushEvent(out, room, { t: 'gameOver', winner });
      break;
    }
  }
}

function pushEvent(out: AttackOutcome, room: Room, e: GameEvent): void {
  const ts = now();
  out.events.push({ e, ts });
  recordEvent(room, e);
}

// ---- Respawn ------------------------------------------------------------

export function respawn(room: Room, socketId: string, baseId: number): { ok: true } | { ok: false; message: string } {
  if (room.phase !== 'playing') return { ok: false, message: '游戏未在进行' };
  const player = [...room.units.values()].find(u => u.kind === 'player' && u.socketId === socketId);
  if (!player) return { ok: false, message: '未绑定标签' };
  if (player.alive) return { ok: false, message: '未阵亡' };
  if (player.faction === null) return { ok: false, message: '未选择阵营' };
  const expectedBase = player.faction === 'red' ? BASE_RED_ID : BASE_BLUE_ID;
  if (baseId !== expectedBase) return { ok: false, message: '请在自己阵营的基地复位' };
  // Even if the 30s hasn't elapsed we accept — but we should enforce it.
  if (player.respawnReadyAt !== null && now() < player.respawnReadyAt) {
    const remain = Math.ceil((player.respawnReadyAt - now()) / 1000);
    return { ok: false, message: '复活倒计时未结束（剩 ' + remain + ' s）' };
  }
  player.alive = true;
  player.canAttack = true;
  player.hp = player.maxHp;
  player.respawnReadyAt = null;
  const stats = room.stats.get(player.id);
  if (stats) {
    stats.alive = true;
    stats.healed += player.maxHp;   // revive回血计入累计治疗量
  }
  return { ok: true };
}