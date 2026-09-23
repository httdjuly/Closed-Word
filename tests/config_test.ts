// Tests for server/config.ts.
//
// The module reads the environment once at import time, so these deliberately
// avoid asserting exact values — a developer with PORT set in their shell should
// not see a red test. What is asserted are the invariants the rest of the server
// relies on: the shape is complete, frozen, and every number is usable.

import { assert } from "@std/assert";
import { config, configSummary } from "../server/config.ts";
import { LIMITS } from "../shared/constants.js";
import { BUILTIN_MAP_IDS, builtinMap } from "../shared/monopoly_maps.js";

Deno.test("config is frozen all the way down", () => {
  assert(Object.isFrozen(config));
  for (const group of [config.claude, config.assist, config.socket, config.rooms]) {
    assert(Object.isFrozen(group));
  }
});

Deno.test("every numeric setting is a usable number", () => {
  const numbers: [string, number][] = [
    ["port", config.port],
    ["rankCacheSize", config.rankCacheSize],
    ["claude.assistTimeoutMs", config.claude.assistTimeoutMs],
    ["claude.clueTimeoutMs", config.claude.clueTimeoutMs],
    ["curateTimeoutMs", config.curateTimeoutMs],
    ["assist.perMinute", config.assist.perMinute],
    ["assist.maxChars", config.assist.maxChars],
    ["socket.maxMessageBytes", config.socket.maxMessageBytes],
    ["socket.maxMapBytes", config.socket.maxMapBytes],
    ["socket.msgLimit", config.socket.msgLimit],
    ["socket.msgWindowMs", config.socket.msgWindowMs],
    ["socket.broadcastDebounceMs", config.socket.broadcastDebounceMs],
    ["rooms.idleTtlMs", config.rooms.idleTtlMs],
    ["rooms.sweepIntervalMs", config.rooms.sweepIntervalMs],
    ["rooms.maxRooms", config.rooms.maxRooms],
  ];
  for (const [name, value] of numbers) {
    assert(Number.isFinite(value), `${name} is not finite`);
    assert(value >= 0, `${name} is negative`);
  }
  assert(config.port >= 1 && config.port <= 65535, "port is out of range");
});

Deno.test("paths and the claude mode are present", () => {
  assert(config.hostname.length > 0);
  assert(config.packPath.endsWith(".bin"));
  assert(config.secretPoolPath.length > 0);
  assert(config.claude.bin.length > 0);
  assert(config.claude.mode === "auto" || config.claude.mode === "off");
  // An unset model must be undefined, not "" — it is spread into argv.
  assert(config.claude.model === undefined || config.claude.model.length > 0);
});

Deno.test("the boot summary names the things a human checks first", () => {
  const lines = configSummary();
  // By content, not by count — a line count breaks every time the summary grows,
  // which says nothing about whether the summary is right.
  assert(lines.some((line) => line.includes(`${config.hostname}:${config.port}`)), "listen");
  assert(lines.some((line) => line.includes(config.packPath)), "pack");
  assert(lines.some((line) => line.startsWith("claude")), "claude");
  assert(lines.some((line) => line.startsWith("log")), "log");
  // Nothing in the banner may carry a credential.
  for (const line of lines) assert(!/token|password|secret/i.test(line), line);
});

// A board file is ten kilobytes and the ordinary ceiling is four, so a board
// could never be loaded if these two were ever set the other way round.
Deno.test("the board-file ceiling clears an actual board", () => {
  assert(
    config.socket.maxMapBytes > config.socket.maxMessageBytes,
    "a board file needs more room than a chat line",
  );
  const biggest = Math.max(
    ...BUILTIN_MAP_IDS.map((id) => JSON.stringify({ t: "monoMap", map: builtinMap(id) }).length),
  );
  assert(
    biggest < config.socket.maxMapBytes,
    `the largest board that ships is ${biggest} bytes, over the ${config.socket.maxMapBytes} limit`,
  );
  // And the browser refuses at the same number, so nothing reaches the socket
  // that the socket is going to drop.
  assert(LIMITS.maxMapBytes <= config.socket.maxMapBytes);
});
