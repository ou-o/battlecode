// src/protocol.ts
// Shared event names + payload types. Must mirror the WeChat client
// (utils/ws.js + pages/*) and the web console (web/console.js).
//
// Wire format is a single JSON envelope: { t: <eventName>, p: <payload> }.
// The server treats `{ t, p }` as the canonical wrapper; the 't' field is one
// of EVENT_NAMES below.

// ---- Identifiers & enums -------------------------------------------------

export type Faction = 'red' | 'blue';
export type Role = 'assault' | 'engineer' | 'sniper';
export type UnitKind = 'player' | 'bunker' | 'base';
export type Phase = 'lobby' | 'binding' | 'armed' | 'playing' | 'ended';

// ---- Units ---------------------------------------------------------------

export interface Unit {
  id: number;           // 25h9 tag id
  kind: UnitKind;
  faction: Faction | null;       // base & player have faction; bunker has none
  hp: number;
  maxHp: number;
  alive: boolean;
  destroyed: boolean;           // bunker single-use marker
  // player-only
  role: Role | null;
  name: string | null;          // bound player's nickname
  socketId: string | null;       // bound player's socket id
  canAttack: boolean;            // false while dead / during respawn wait
  respawnReadyAt: number | null; // epoch ms when respawn becomes available
}

// ---- Stats (for result page) --------------------------------------------

export interface PlayerStats {
  playerId: number;
  name: string;
  faction: Faction;
  role: Role;
  kills: number;
  deaths: number;
  dealt: number;       // cumulative damage dealt
  taken: number;       // cumulative damage taken
  healed: number;      // cumulative heal (currently: revive heal only)
  bunkersDestroyed: number;
  alive: boolean;
}

// ---- Room (server-internal; broadcast via RoomSnapshot) ------------------

export interface Room {
  code: string;
  hostSocketId: string | null;
  hostToken: string;
  hostName: string | null;
  phase: Phase;
  units: Map<number, Unit>;
  players: Map<string, PlayerSummary>;
  log: EventEnvelope[];          // full event history (for console)
  stats: Map<number, PlayerStats>;
  startedAt: number | null;
  winner: Faction | null;
  lastActivity: number;
}

// ---- Room snapshot (broadcast to all peers on every change) -------------

export interface RoomSnapshot {
  code: string;
  phase: Phase;
  hostName: string | null;      // 房主昵称（建造时指定）
  units: Unit[];
  players: PlayerSummary[];     // joined (not necessarily bound) players
  winner: Faction | null;
  stats: PlayerStats[];         // populated at game end
  startedAt: number | null;
}

export interface PlayerSummary {
  socketId: string;
  name: string;
  faction: Faction | null;
  role: Role | null;
  tagId: number | null;         // null until bound
  online: boolean;
}

// ---- Game event stream (incremental) -------------------------------------

export type GameEvent =
  | { t: 'hit'; src: number; tgt: number; dmg: number }
  | { t: 'kill'; src: number; tgt: number }
  | { t: 'playerDown'; id: number }
  | { t: 'playerRevive'; id: number }
  | { t: 'bunkerDestroyed'; id: number; src: number | null }
  | { t: 'baseHit'; id: number; src: number | null; hp: number }
  | { t: 'gameOver'; winner: Faction };

export interface EventEnvelope {
  t: 'event';
  e: GameEvent;
  ts: number;
}

// ---- C2S messages --------------------------------------------------------

export type ClientMessage =
  | { t: 'room:create'; hostName: string; code?: string }
  | { t: 'room:join'; code: string; name: string }
  | { t: 'room:leave' }
  | { t: 'room:list' }
  | { t: 'faction'; faction: Faction }
  | { t: 'role'; role: Role }
  | { t: 'bindTag'; tagId: number }
  | { t: 'host:bunkers'; ids: number[] }
  | { t: 'host:start' }
  | { t: 'host:close' }
  | { t: 'attack'; ids: number[] }
  | { t: 'respawn'; baseId: number };

// ---- S2S messages (server -> client) ------------------------------------

export type ServerMessage =
  | { t: 'room:created'; code: string; hostToken: string }
  | { t: 'room:joined'; snapshot: RoomSnapshot; me: PlayerSummary }
  | { t: 'room:left' }
  | { t: 'room:closed'; code: string; reason: string }
  | { t: 'room:list'; rooms: RoomSummary[] }
  | { t: 'room:error'; message: string }
  | { t: 'state'; snapshot: RoomSnapshot }
  | EventEnvelope
  | { t: 'pong' };

// ---- Room summary (for console overview) --------------------------------

export interface RoomSummary {
  code: string;
  phase: Phase;
  playerCount: number;
  onlineCount: number;
  hostName: string | null;
  hasHost: boolean;
  lastActivity: number;
  startedAt: number | null;
  winner: Faction | null;
}

// ---- Constants ----------------------------------------------------------

export const DAMAGE_PER_HIT = 10;
export const PLAYER_MAX_HP = 100;
export const BUNKER_MAX_HP = 2000;
export const BASE_MAX_HP = 500;
export const RESPAWN_MS = 30000;

export const PLAYER_ID_MIN = 0;
export const PLAYER_ID_MAX = 23;
export const BUNKER_ID_MIN = 24;
export const BUNKER_ID_MAX = 33;
export const BASE_RED_ID = 34;
export const BASE_BLUE_ID = 35;

export const MAX_PLAYERS = 12;
export const MAX_BUNKERS = 10;
export const MAX_ROOMS = 10;

export const VALID_CODE_RE = /^\d{3}$/;

// Event names used as the `{ t }` discriminator. Listed for grep-ability;
// the union types above are the source of truth for payloads.
export const EVENT_NAMES = [
  'room:create', 'room:join', 'room:leave', 'room:list',
  'room:created', 'room:joined', 'room:left', 'room:closed', 'room:list',
  'room:error',
  'faction', 'role', 'bindTag',
  'host:bunkers', 'host:start', 'host:close',
  'attack', 'respawn',
  'state', 'event', 'pong',
  'hit', 'kill', 'playerDown', 'playerRevive',
  'bunkerDestroyed', 'baseHit', 'gameOver'
] as const;