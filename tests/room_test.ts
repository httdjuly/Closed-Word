import { assert, assertEquals, assertThrows } from "@std/assert";
import { RoomError } from "../server/room.ts";
import { DEFAULT_CONFIG, effectiveTotalRounds, LIMITS } from "../shared/constants.js";
import { idFor, makeRoom } from "./helpers.ts";

const TEN = ["ann", "bo", "cy", "di", "ed", "fi", "gus", "hal", "ivy", "jo"];

// ---------------------------------------------------------------------------
// Lobby and membership
// ---------------------------------------------------------------------------

Deno.test("first player becomes host and host passes on when they leave", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  assertEquals(t.room.hostId, idFor("ann"));
  t.room.disconnect(idFor("ann"));
  assertEquals(t.room.hostId, idFor("bo"));
});

Deno.test("duplicate nicknames are disambiguated", async () => {
  const t = await makeRoom();
  t.room.join("aaaaaaaa1", "Duc");
  t.room.join("aaaaaaaa2", "Duc");
  const names = t.room.publicPlayers().map((p) => p.nickname);
  assertEquals(names, ["Duc", "Duc 2"]);
});

Deno.test("only the host can change settings or start", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  assertThrows(
    () => t.room.setConfig(idFor("bo"), { mode: "coop" }),
    RoomError,
    "Only the host",
  );
  assertThrows(() => t.room.start(idFor("bo")), RoomError, "Only the host");
  t.room.setConfig(idFor("ann"), { mode: "coop" });
  assertEquals(t.room.config.mode, "coop");
});

Deno.test("config is sanitised, not trusted", async () => {
  const t = await makeRoom({}, ["ann"]);
  t.room.setConfig(idFor("ann"), {
    // deno-lint-ignore no-explicit-any
    mode: "sabotage" as any,
    totalRounds: 9999,
    teamCount: 0,
    hintsPerBoard: -5,
    roundSeconds: 1e9,
  });
  const cfg = t.room.config;
  assertEquals(cfg.mode, "race");
  assertEquals(cfg.totalRounds, 20);
  assertEquals(cfg.teamCount, 2);
  assertEquals(cfg.hintsPerBoard, 0);
  assertEquals(cfg.roundSeconds, 3600);
});

Deno.test("settings and teams lock while a round runs", async () => {
  const t = await makeRoom({ mode: "teams" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  assertThrows(() => t.room.setConfig(idFor("ann"), { teamCount: 3 }), RoomError, "locked");
  assertThrows(() => t.room.shuffleTeams(idFor("ann")), RoomError, "locked");
});

// ---------------------------------------------------------------------------
// Guessing
// ---------------------------------------------------------------------------

Deno.test("guess validation covers junk, unknown words and duplicates", async () => {
  const t = await makeRoom({}, ["ann"]);
  const ann = idFor("ann");
  t.room.start(ann);

  assertEquals(t.room.guess(ann, "x").accepted, false);
  assertEquals(t.room.guess(ann, "hello world").accepted, false);
  assertEquals(t.room.guess(ann, "123").accepted, false);

  const unknown = t.room.guess(ann, "zzzzqqqq");
  assertEquals(unknown.accepted, false);
  assert(!unknown.accepted && unknown.reason === "unknown");

  const first = t.room.guess(ann, "cat");
  assert(first.accepted);
  const again = t.room.guess(ann, "cat");
  assert(!again.accepted);
  assertEquals(again.reason, "duplicate");
  // A duplicate still reports the rank, so the player is not left guessing.
  assertEquals(again.rank, first.rank);
});

Deno.test("guesses are case- and whitespace-insensitive", async () => {
  const t = await makeRoom({}, ["ann"]);
  const ann = idFor("ann");
  t.room.start(ann);
  const outcome = t.room.guess(ann, "  CoFFeE  ");
  assert(outcome.accepted);
  assertEquals(outcome.word, "coffee");
});

Deno.test("guesses are rate limited per player", async () => {
  const t = await makeRoom({}, ["ann"]);
  const ann = idFor("ann");
  t.room.start(ann);
  const words = [
    "cat",
    "dog",
    "horse",
    "bird",
    "fish",
    "bee",
    "bear",
    "lion",
    "bread",
    "cheese",
    "apple",
    "potato",
    "coffee",
    "dinner",
    "sugar",
  ];
  let rejected = 0;
  for (const w of words) {
    const r = t.room.guess(ann, w);
    if (!r.accepted && r.reason === "tooFast") rejected++;
  }
  assert(rejected > 0, "expected the rate limiter to bite");
  // Waiting out the window lets play resume.
  t.advance(6000);
  assert(t.room.guess(ann, "salt").accepted);
});

Deno.test("no guessing outside a round", async () => {
  const t = await makeRoom({}, ["ann"]);
  const before = t.room.guess(idFor("ann"), "cat");
  assertEquals(before.accepted, false);
  assert(!before.accepted && before.reason === "closed");
});

// ---------------------------------------------------------------------------
// Race mode
// ---------------------------------------------------------------------------

Deno.test("race: each player gets a private board", async () => {
  const t = await makeRoom({ mode: "race" }, TEN);
  t.room.start(idFor("ann"));
  assertEquals(t.room.boards.size, 10);

  t.room.guess(idFor("ann"), "cat");
  // Bo's view must not contain Ann's guess.
  const boView = t.room.viewFor(idFor("bo"));
  assertEquals(boView.board?.guesses.length, 0);
  assertEquals(t.room.viewFor(idFor("ann")).board?.guesses.length, 1);
  // But Ann's progress is visible as a rank, which is the whole tension.
  const annPublic = boView.players.find((p) => p.id === idFor("ann"))!;
  assertEquals(annPublic.guessCount, 1);
  assert(annPublic.bestRank !== null);
});

Deno.test("race: placement is assigned in finish order and scored by placement", async () => {
  const t = await makeRoom({ mode: "race", graceSeconds: 0 }, TEN);
  t.room.start(idFor("ann"));

  t.solve(idFor("cy"));
  t.solve(idFor("ann"));
  t.solve(idFor("jo"));

  assertEquals(t.room.boards.get(`p:${idFor("cy")}`)?.place, 1);
  assertEquals(t.room.boards.get(`p:${idFor("ann")}`)?.place, 2);
  assertEquals(t.room.boards.get(`p:${idFor("jo")}`)?.place, 3);

  t.room.endRound();
  const byId = new Map(t.room.publicPlayers().map((p) => [p.id, p]));
  // 10 boards: first gets 10, second 9, third 8, nobody else scores.
  assertEquals(byId.get(idFor("cy"))!.score, 10);
  assertEquals(byId.get(idFor("ann"))!.score, 9);
  assertEquals(byId.get(idFor("jo"))!.score, 8);
  assertEquals(byId.get(idFor("bo"))!.score, 0);
});

Deno.test("race: round ends by itself once every board has solved", async () => {
  const t = await makeRoom({ mode: "race" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.solve(idFor("ann"));
  assertEquals(t.room.phase, "playing");
  t.solve(idFor("bo"));
  // Race is a single round, so finishing it ends the match outright.
  assertEquals(t.room.phase, "matchEnd");
});

Deno.test("race: the first finisher starts a grace clock for everyone else", async () => {
  const t = await makeRoom({ mode: "race", graceSeconds: 90, roundSeconds: 0 }, TEN);
  t.room.start(idFor("ann"));
  assertEquals(t.room.roundEndsAt, null, "untimed until someone finishes");

  t.solve(idFor("ann"));
  assert(t.room.roundEndsAt !== null, "grace clock should now be running");
  assertEquals(t.room.roundEndsAt! - t.room.now(), 90_000);
});

Deno.test("race: grace never extends an existing shorter deadline", async () => {
  const t = await makeRoom({ mode: "race", graceSeconds: 300, roundSeconds: 60 }, TEN);
  t.room.start(idFor("ann"));
  const original = t.room.roundEndsAt;
  t.solve(idFor("ann"));
  assertEquals(t.room.roundEndsAt, original);
});

Deno.test("race is always one round even if totalRounds is set high", async () => {
  const t = await makeRoom({ mode: "race", totalRounds: 9 }, ["ann"]);
  assertEquals(t.room.totalRounds, 1);
});

// ---------------------------------------------------------------------------
// Rounds mode
// ---------------------------------------------------------------------------

Deno.test("rounds: scores accumulate and secrets never repeat", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 3, graceSeconds: 0 }, [
    "ann",
    "bo",
    "cy",
  ]);
  const ann = idFor("ann");
  t.room.start(ann);

  const secrets: string[] = [];
  for (let round = 1; round <= 3; round++) {
    assertEquals(t.room.round, round);
    secrets.push(t.secret());
    t.solve(ann);
    t.solve(idFor("bo"));
    t.room.endRound();
    if (round < 3) t.room.next(ann);
  }

  assertEquals(new Set(secrets).size, 3, "each round needs a fresh secret");
  assertEquals(t.room.phase, "matchEnd");
  const byId = new Map(t.room.publicPlayers().map((p) => [p.id, p]));
  // Ann finished first each round (3 boards -> 3 points), Bo second (2 points).
  assertEquals(byId.get(ann)!.score, 9);
  assertEquals(byId.get(idFor("bo"))!.score, 6);
  assertEquals(byId.get(idFor("cy"))!.score, 0);
});

Deno.test("rounds: per-round state resets but the match score does not", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 2, graceSeconds: 0 }, ["ann", "bo"]);
  const ann = idFor("ann");
  t.room.start(ann);
  t.room.guess(ann, "cat");
  t.solve(ann);
  t.solve(idFor("bo"));
  t.room.endRound();
  const scoreAfterOne = t.room.publicPlayers().find((p) => p.id === ann)!.score;
  t.room.next(ann);

  const annView = t.room.viewFor(ann);
  assertEquals(annView.board?.guesses.length, 0, "board should be empty again");
  assertEquals(annView.players.find((p) => p.id === ann)!.score, scoreAfterOne);
});

Deno.test("standings order by score, then placement, then guess count", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 1, graceSeconds: 0 }, [
    "ann",
    "bo",
    "cy",
  ]);
  const ann = idFor("ann");
  t.room.start(ann);
  t.solve(idFor("cy"));
  t.solve(ann);
  t.room.endRound();
  const standings = t.room.standings();
  assertEquals(standings[0].key, idFor("cy"));
  assertEquals(standings[1].key, ann);
  assertEquals(standings[2].key, idFor("bo"));
});

// ---------------------------------------------------------------------------
// Teams mode
// ---------------------------------------------------------------------------

Deno.test("teams: ten players are balanced across boards and share guesses", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2, graceSeconds: 0 }, TEN);
  t.room.start(idFor("ann"));
  assertEquals(t.room.boards.size, 2);

  const teams = t.room.teamViews();
  assertEquals(teams[0].memberIds.length, 5);
  assertEquals(teams[1].memberIds.length, 5);

  // Two players on the same board see each other's guesses.
  const [a, b] = teams[0].memberIds;
  t.room.guess(a, "cat");
  const bView = t.room.viewFor(b);
  assertEquals(bView.board?.guesses.length, 1);
  assertEquals(bView.board?.guesses[0].byNickname, t.room.players.get(a)!.nickname);

  // The other team's board is untouched and invisible.
  const other = t.room.viewFor(teams[1].memberIds[0]);
  assertEquals(other.board?.guesses.length, 0);
  assert(other.board?.id !== bView.board?.id);
});

Deno.test("teams: every member of the winning team is credited", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2, graceSeconds: 0 }, TEN);
  t.room.start(idFor("ann"));
  const teams = t.room.teamViews();
  t.solve(teams[0].memberIds[0]);
  t.room.endRound();

  // Two boards, so the winner scores 2 and the loser 0.
  assertEquals(t.room.teamScores.get(0), 2);
  for (const id of teams[0].memberIds) {
    assertEquals(t.room.players.get(id)!.score, 2, `${id} should share the team's points`);
  }
  for (const id of teams[1].memberIds) {
    assertEquals(t.room.players.get(id)!.score, 0);
  }
});

Deno.test("teams: empty teams do not hold the round open", async () => {
  const t = await makeRoom(
    { mode: "teams", teamCount: 4, totalRounds: 1, graceSeconds: 0 },
    ["ann", "bo"],
  );
  const ann = idFor("ann");
  // Put both players on team 0, leaving three teams empty.
  t.room.setTeam(ann, ann, 0);
  t.room.setTeam(ann, idFor("bo"), 0);
  t.room.start(ann);
  assertEquals(t.room.boards.size, 1, "no board for a team with no players");
  t.solve(ann);
  assertEquals(t.room.phase, "matchEnd", "the only board solved, so the round is over");
});

Deno.test("teams: a player cannot be moved to a team that does not exist", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2 }, ["ann"]);
  assertThrows(() => t.room.setTeam(idFor("ann"), idFor("ann"), 5), RoomError, "No such team");
});

Deno.test("teams: players may set their own team but not someone else's", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2 }, ["ann", "bo"]);
  t.room.setTeam(idFor("bo"), idFor("bo"), 1);
  assertEquals(t.room.players.get(idFor("bo"))!.teamId, 1);
  assertThrows(
    () => t.room.setTeam(idFor("bo"), idFor("ann"), 1),
    RoomError,
    "Only the host",
  );
});

Deno.test("teams: the lobby already shows a balanced split", async () => {
  // Nobody can rebalance a line-up they cannot see, so the teams are handed out
  // on arrival rather than at kick-off.
  const t = await makeRoom({ mode: "teams", teamCount: 2 }, ["ann", "bo", "cy"]);
  assertEquals(t.room.phase, "lobby");
  const sizes = t.room.teamViews().map((v) => v.memberIds.length);
  assertEquals(sizes.reduce((a, b) => a + b, 0), 3, "everyone has a team before the match");
  assertEquals(Math.max(...sizes) - Math.min(...sizes), 1, "and the split is as even as 3 allows");
});

Deno.test("teams: switching to team mode deals the room out immediately", async () => {
  const t = await makeRoom({ mode: "race" }, ["ann", "bo", "cy", "di"]);
  for (const p of t.room.players.values()) assertEquals(p.teamId, null, "race has no teams");
  t.room.setConfig(idFor("ann"), { mode: "teams", teamCount: 2 });
  assertEquals(t.room.teamViews().map((v) => v.memberIds.length), [2, 2]);
});

Deno.test("teams: the host can move anybody, and the room is told", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2 }, ["ann", "bo"]);
  t.room.setTeam(idFor("ann"), idFor("bo"), 0);
  assertEquals(t.room.players.get(idFor("bo"))!.teamId, 0);
  const feed = t.room.viewFor(idFor("ann")).feed.map((f) => f.text);
  assert(
    feed.some((line) => line.includes("was moved to")),
    `expected a move notice, got ${JSON.stringify(feed)}`,
  );
});

Deno.test("teams: moving somebody to the team they are already on says nothing", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2 }, ["ann", "bo"]);
  const before = t.room.viewFor(idFor("ann")).feed.length;
  const team = t.room.players.get(idFor("bo"))!.teamId!;
  t.room.setTeam(idFor("ann"), idFor("bo"), team);
  assertEquals(t.room.viewFor(idFor("ann")).feed.length, before, "no news is no feed line");
});

// ---------------------------------------------------------------------------
// Co-op mode
// ---------------------------------------------------------------------------

Deno.test("coop: one shared board for everyone, always on a clock", async () => {
  const t = await makeRoom({ mode: "coop", roundSeconds: 0 }, TEN);
  t.room.start(idFor("ann"));
  assertEquals(t.room.boards.size, 1);
  assert(t.room.roundEndsAt !== null, "coop must never run untimed");
  assertEquals(t.room.roundEndsAt! - t.room.roundStartedAt, 300_000);

  t.room.guess(idFor("ann"), "cat");
  t.room.guess(idFor("jo"), "dog");
  for (const name of TEN) {
    assertEquals(t.room.viewFor(idFor(name)).board?.guesses.length, 2);
  }
});

Deno.test("coop: score falls with guesses and elapsed time", async () => {
  const fast = await makeRoom({ mode: "coop" }, ["ann", "bo"]);
  fast.room.start(idFor("ann"));
  fast.solve(idFor("ann"));
  fast.room.endRound();

  const slow = await makeRoom({ mode: "coop" }, ["ann", "bo"]);
  slow.room.start(idFor("ann"));
  slow.room.guess(idFor("ann"), "cat");
  slow.room.guess(idFor("bo"), "dog");
  slow.advance(60_000);
  slow.solve(idFor("ann"));
  slow.room.endRound();

  assert(
    fast.room.coopTotal > slow.room.coopTotal,
    `fast ${fast.room.coopTotal} should beat slow ${slow.room.coopTotal}`,
  );
});

Deno.test("coop: an unsolved round scores nothing", async () => {
  const t = await makeRoom({ mode: "coop", roundSeconds: 30 }, ["ann"]);
  t.room.start(idFor("ann"));
  t.room.guess(idFor("ann"), "cat");
  t.advance(31_000);
  t.room.endRound();
  assertEquals(t.room.coopTotal, 0);
});

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

Deno.test("hints land on the board, count down, and then refuse", async () => {
  const t = await makeRoom({ hintsPerBoard: 2 }, ["ann"]);
  const ann = idFor("ann");
  t.room.start(ann);

  const first = t.room.hint(ann);
  assert(first.rank > 1);
  let view = t.room.viewFor(ann);
  assertEquals(view.board?.hintsLeft, 1);
  assertEquals(view.board?.guesses.length, 1);
  assertEquals(view.board?.guesses[0].hint, true);

  const second = t.room.hint(ann);
  assert(second.rank < first.rank, "the second hint should be closer");
  view = t.room.viewFor(ann);
  assertEquals(view.board?.hintsLeft, 0);

  assertThrows(() => t.room.hint(ann), RoomError, "No hints left");
});

Deno.test("a hinted word cannot then be guessed for credit", async () => {
  const t = await makeRoom({ hintsPerBoard: 1 }, ["ann"]);
  const ann = idFor("ann");
  t.room.start(ann);
  const { word } = t.room.hint(ann);
  const repeat = t.room.guess(ann, word);
  assertEquals(repeat.accepted, false);
  assert(!repeat.accepted && repeat.reason === "duplicate");
});

Deno.test("hints are per board, not per player, in shared modes", async () => {
  const t = await makeRoom({ mode: "coop", hintsPerBoard: 1 }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.room.hint(idFor("ann"));
  assertThrows(() => t.room.hint(idFor("bo")), RoomError, "No hints left");
});

// ---------------------------------------------------------------------------
// Disconnects, reconnects and late joins
// ---------------------------------------------------------------------------

Deno.test("a mid-match disconnect keeps the board and score for a reconnect", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 2, graceSeconds: 0 }, ["ann", "bo"]);
  const ann = idFor("ann");
  t.room.start(ann);
  t.room.guess(ann, "cat");
  t.room.disconnect(ann);

  assert(t.room.players.has(ann), "player is retained mid-match");
  assertEquals(t.room.players.get(ann)!.connected, false);
  assertEquals(t.room.boards.get(`p:${ann}`)?.guesses.length, 1);

  t.room.join(ann, "ann");
  assertEquals(t.room.players.get(ann)!.connected, true);
  assertEquals(t.room.viewFor(ann).board?.guesses.length, 1, "board survived the round trip");
});

Deno.test("a lobby disconnect removes the player outright", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  t.room.disconnect(idFor("bo"));
  assertEquals(t.room.players.has(idFor("bo")), false);
});

Deno.test("a late joiner gets a board and can play the round in progress", async () => {
  const t = await makeRoom({ mode: "race" }, ["ann"]);
  t.room.start(idFor("ann"));
  t.room.join("latecomer1", "Zoe");
  assert(t.room.boardFor("latecomer1"), "late joiner needs a board");
  assert(t.room.guess("latecomer1", "cat").accepted);
});

Deno.test("a late joiner in teams mode is placed on the smallest team", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2 }, ["ann", "bo", "cy"]);
  t.room.start(idFor("ann"));
  const before = t.room.teamViews().map((x) => x.memberIds.length);
  t.room.join("latecomer1", "Zoe");
  const after = t.room.teamViews().map((x) => x.memberIds.length);
  const smallest = before[0] <= before[1] ? 0 : 1;
  assertEquals(after[smallest], before[smallest] + 1);
});

Deno.test("removing the last unsolved board ends the round", async () => {
  const t = await makeRoom({ mode: "race", graceSeconds: 0 }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.solve(idFor("ann"));
  assertEquals(t.room.phase, "playing");
  t.room.remove(idFor("bo"));
  assertEquals(t.room.phase, "matchEnd");
});

// ---------------------------------------------------------------------------
// Views and redaction
// ---------------------------------------------------------------------------

Deno.test("the secret never appears in a snapshot while the round is live", async () => {
  const t = await makeRoom({ mode: "race" }, TEN);
  t.room.start(idFor("ann"));
  const secret = t.secret();
  for (const name of TEN) {
    const json = JSON.stringify(t.room.viewFor(idFor(name)));
    assert(
      !json.includes(`"secret":"${secret}"`),
      "the answer must not be serialised to clients mid-round",
    );
    assertEquals(t.room.viewFor(idFor(name)).round?.secret, null);
  }
});

Deno.test("the secret is revealed at round end only when configured", async () => {
  const shown = await makeRoom({ revealOnEnd: true, graceSeconds: 0 }, ["ann"]);
  shown.room.start(idFor("ann"));
  const secret = shown.secret();
  shown.solve(idFor("ann"));
  assertEquals(shown.room.viewFor(idFor("ann")).round?.secret, secret);
  assert((shown.room.viewFor(idFor("ann")).round?.nearMisses?.length ?? 0) > 0);

  const hidden = await makeRoom({ revealOnEnd: false, graceSeconds: 0 }, ["ann"]);
  hidden.room.start(idFor("ann"));
  hidden.solve(idFor("ann"));
  assertEquals(hidden.room.viewFor(idFor("ann")).round?.secret, null);
});

Deno.test("state changes notify clients", async () => {
  const t = await makeRoom({}, ["ann"]);
  const before = t.changes();
  t.room.guess(idFor("ann"), "cat");
  t.room.start(idFor("ann"));
  t.room.guess(idFor("ann"), "cat");
  assert(t.changes() > before, "guessing and starting must trigger a broadcast");
});

Deno.test("chat is relayed through the feed", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  t.room.chat(idFor("ann"), "  hello   there  ");
  const feed = t.room.viewFor(idFor("bo")).feed;
  const chat = feed.filter((f) => f.kind === "chat");
  assertEquals(chat.length, 1);
  assert(chat[0].text.endsWith("hello there"), chat[0].text);
});

Deno.test("feed lines name the actor separately from the message", async () => {
  // The client colours the name per person. It can only do that if the name
  // arrives as its own field — searching for it inside the text would go wrong
  // the moment somebody is called "left" or "joined".
  const t = await makeRoom({}, ["ann", "bo"]);
  const feed = t.room.viewFor(idFor("ann")).feed;

  const joins = feed.filter((f) => f.kind === "join");
  assert(joins.length >= 2, "both players joined");
  for (const item of joins) {
    assertEquals(item.text, "joined");
    assert(item.actor, "carries a display name");
    assert(item.playerId, "carries the id the colour is keyed on");
    // The name must not also be inside the message, or it renders twice.
    assert(!item.text.includes(item.actor!), item.text);
  }

  t.room.chat(idFor("ann"), "hello");
  const chat = t.room.viewFor(idFor("bo")).feed.filter((f) => f.kind === "chat")[0];
  assertEquals(chat.text, "hello");
  assertEquals(chat.actor, "ann");
  assertEquals(chat.playerId, idFor("ann"));
});

Deno.test("room-wide feed lines have no actor to colour", async () => {
  const t = await makeRoom({ mode: "race" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  const round = t.room.viewFor(idFor("ann")).feed.filter((f) => f.kind === "round")[0];
  assertEquals(round.actor, undefined);
  assert(round.text.includes("Round 1"), round.text);
});

Deno.test("host can kick, and the kicked player loses their board", async () => {
  const t = await makeRoom({ mode: "race" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.room.remove(idFor("bo"));
  assertEquals(t.room.players.has(idFor("bo")), false);
  assertEquals(t.room.boardFor(idFor("bo")), null);
});

Deno.test("a full room refuses further players", async () => {
  const t = await makeRoom();
  for (let i = 0; i < 24; i++) t.room.join(`filler${String(i).padStart(4, "0")}`, `p${i}`);
  assertThrows(() => t.room.join("overflow01", "nope"), RoomError, "is full");
});

Deno.test("returning to the lobby clears the match but keeps the roster", async () => {
  const t = await makeRoom({ mode: "race", graceSeconds: 0 }, ["ann", "bo"]);
  const ann = idFor("ann");
  t.room.start(ann);
  t.solve(ann);
  t.solve(idFor("bo"));
  assertEquals(t.room.phase, "matchEnd");
  t.room.next(ann);
  assertEquals(t.room.phase, "lobby");
  assertEquals(t.room.players.size, 2);
  assertEquals(t.room.boards.size, 0);
  assertEquals(t.room.viewFor(ann).round, null);
});

// ---------------------------------------------------------------------------
// Solo practice
// ---------------------------------------------------------------------------

Deno.test("practice runs to the ceiling rather than to a finish line", () => {
  // Nothing is at stake, so there is no reason to stop at three: there should
  // always be another word waiting, and you stop by leaving.
  assertEquals(
    effectiveTotalRounds({ ...DEFAULT_CONFIG, mode: "solo", totalRounds: 2 }),
    LIMITS.maxRounds,
  );
});

Deno.test("a solo room refuses a second player", async () => {
  const t = await makeRoom({ mode: "solo" }, ["ann"]);
  assertThrows(() => t.room.join(idFor("bo"), "bo"), RoomError, "solo practice");
  // The owner reconnecting is not a second player.
  t.room.disconnect(idFor("ann"));
  t.room.join(idFor("ann"), "ann");
  assertEquals(t.room.players.size, 1);
});

Deno.test("a room with company cannot be switched to practice", async () => {
  const t = await makeRoom({ mode: "race" }, ["ann", "bo"]);
  assertThrows(
    () => t.room.setConfig(idFor("ann"), { mode: "solo" }),
    RoomError,
    "Solo practice is for one",
  );
  // Alone, it is nobody else's business.
  t.room.remove(idFor("bo"));
  t.room.setConfig(idFor("ann"), { mode: "solo" });
  assertEquals(t.room.config.mode, "solo");
});
