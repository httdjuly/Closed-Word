// Shared test fixtures.

import { decodePack, type VectorPack } from "../server/vectorpack.ts";
import { Ranker } from "../server/ranker.ts";
import { Room, type RoomDeps } from "../server/room.ts";
import type { RoomConfig } from "../shared/protocol.ts";

let cached: VectorPack | null = null;

/**
 * Whatever pack the machine has built — the real 50,000-word one or the
 * synthetic sample. Both are deterministic, so assertions about *relative* ranks
 * hold either way, but nothing here may assume a particular word is absent: the
 * real pack contains most things you would think to use as a non-word.
 */
export async function loadTestPack(): Promise<VectorPack> {
  if (!cached) {
    try {
      cached = decodePack(await Deno.readFile("data/vectors.bin"));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(
          "No embedding pack at data/vectors.bin.\n" +
            "The tests need one — build the deterministic sample pack first:\n\n" +
            "    deno task ingest --sample\n",
        );
      }
      throw err;
    }
  }
  return cached;
}

export interface TestRoom {
  room: Room;
  ranker: Ranker;
  /** How many times clients would have been pushed a new snapshot. */
  changes: () => number;
  /** Advance the room's injected clock. */
  advance: (ms: number) => void;
  /** The current secret — tests need it to simulate a correct guess. */
  secret: () => string;
  /** Solve the round on behalf of `playerId`. */
  solve: (playerId: string) => void;
}

export async function makeRoom(
  config: Partial<RoomConfig> = {},
  playerNames: string[] = [],
  /** Optional extras the real server wires in and most tests do not need. */
  extras: Partial<Pick<RoomDeps, "icon" | "clueProvider">> = {},
): Promise<TestRoom> {
  const ranker = new Ranker(await loadTestPack());
  let clock = 1_700_000_000_000;
  let changes = 0;

  const room = new Room("TEST01", config, {
    ranker,
    ...extras,
    onChange: () => changes++,
    now: () => clock,
  });

  for (const name of playerNames) room.join(idFor(name), name);

  return {
    room,
    ranker,
    changes: () => changes,
    advance: (ms) => {
      clock += ms;
    },
    secret: () => {
      const secret = room.secret;
      if (!secret) throw new Error("no round in progress");
      return secret;
    },
    solve: (playerId) => {
      const secret = room.secret;
      if (!secret) throw new Error("no round in progress");
      const outcome = room.guess(playerId, secret);
      if (!outcome.accepted) {
        throw new Error(`solve rejected: ${outcome.reason} ${outcome.message}`);
      }
    },
  };
}

/** Stable, valid player id derived from a name, so tests stay readable. */
export function idFor(name: string): string {
  return `player-${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`.padEnd(10, "0");
}
