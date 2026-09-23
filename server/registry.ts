// Room registry: code allocation, lookup, and reaping abandoned rooms.

import { type ClueProvider, Room } from "./room.ts";
import type { RoomConfig } from "../shared/protocol.ts";
import type { Ranker } from "./ranker.ts";
import type { IconPicker } from "./wordicon.ts";
import { LIMITS, ROOM_CODE_ALPHABET } from "../shared/constants.js";
import { log } from "./log.ts";

/**
 * Defaults for a registry constructed without overrides — tests, mostly. The
 * server passes values from server/config.ts, so these are the fallback rather
 * than the policy.
 */
const DEFAULT_IDLE_TTL_MS = 20 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_ROOMS = 500;

export interface RegistryDeps {
  ranker: Ranker;
  /** Shared by every room, so the emoji memo is warm across the whole process. */
  icon?: IconPicker;
  clueProvider?: ClueProvider | null;
  onChange: (room: Room) => void;
  /** Rooms with nobody connected are reaped after this long. */
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  maxRooms?: number;
}

export class RoomRegistry {
  #rooms = new Map<string, Room>();
  #lastActive = new Map<string, number>();
  #deps: RegistryDeps;
  #sweeper: ReturnType<typeof setInterval> | null = null;
  readonly #idleTtlMs: number;
  readonly #sweepIntervalMs: number;
  readonly #maxRooms: number;

  constructor(deps: RegistryDeps) {
    this.#deps = deps;
    this.#idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.#sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#maxRooms = deps.maxRooms ?? DEFAULT_MAX_ROOMS;
  }

  get size(): number {
    return this.#rooms.size;
  }

  rooms(): Room[] {
    return [...this.#rooms.values()];
  }

  create(config: Partial<RoomConfig> = {}): Room {
    if (this.#rooms.size >= this.#maxRooms) {
      this.sweep(true);
      if (this.#rooms.size >= this.#maxRooms) throw new Error("too many active rooms");
    }
    const code = this.#allocateCode();
    const room = new Room(code, config, {
      ranker: this.#deps.ranker,
      icon: this.#deps.icon,
      clueProvider: this.#deps.clueProvider ?? null,
      onChange: (r) => {
        this.#lastActive.set(r.code, Date.now());
        this.#deps.onChange(r);
      },
    });
    this.#rooms.set(code, room);
    this.#lastActive.set(code, Date.now());
    return room;
  }

  get(code: string): Room | null {
    return this.#rooms.get(normaliseCode(code)) ?? null;
  }

  delete(code: string): void {
    const room = this.#rooms.get(code);
    if (!room) return;
    room.close();
    this.#rooms.delete(code);
    this.#lastActive.delete(code);
  }

  #allocateCode(): string {
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = "";
      const bytes = new Uint8Array(LIMITS.roomCodeLength);
      crypto.getRandomValues(bytes);
      for (const b of bytes) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
      if (!this.#rooms.has(code)) return code;
    }
    throw new Error("could not allocate a free room code");
  }

  /** Drop empty rooms, and rooms nobody has been connected to for a while. */
  sweep(aggressive = false): number {
    const now = Date.now();
    let removed = 0;
    for (const [code, room] of this.#rooms) {
      const idleFor = now - (this.#lastActive.get(code) ?? now);
      const abandoned = room.isEmpty ||
        (room.connectedCount === 0 && idleFor > (aggressive ? 60_000 : this.#idleTtlMs));
      if (abandoned) {
        this.delete(code);
        removed++;
      }
    }
    return removed;
  }

  startSweeper(): void {
    if (this.#sweeper !== null) return;
    const handle = setInterval(() => {
      const removed = this.sweep();
      if (removed > 0) log.action("idle rooms reaped", { rooms: removed, live: this.#rooms.size });
    }, this.#sweepIntervalMs);
    this.#sweeper = handle;
    // Don't hold the process open just for housekeeping.
    Deno.unrefTimer(handle);
  }

  stopSweeper(): void {
    if (this.#sweeper !== null) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
  }
}

export function normaliseCode(raw: string): string {
  return String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
