// Connection-level behaviour that only shows up over a real socket.
//
// These spin up the actual server on an ephemeral port rather than poking at
// Room, because the bug they guard against lives entirely in the socket
// lifecycle.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { REACTION_KEYS } from "../shared/constants.js";

const CLOSE_SUPERSEDED = 4001;

interface Harness {
  url: string;
  stop: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const port = 9100 + Math.floor(Math.random() * 400);
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-env",
      "--allow-run",
      "--allow-sys=networkInterfaces",
      "server/main.ts",
    ],
    env: { PORT: String(port), CLOSEWORD_AI_CLUES: "off" },
    stdout: "null",
    stderr: "piped",
  });
  const child = command.spawn();

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      await res.body?.cancel();
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  return {
    url,
    stop: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      const status = await child.status;
      await child.stderr.cancel();
      void status;
    },
  };
}

function open(url: string, id: string): Promise<WebSocket> {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws?id=${id}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 8000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("socket error"));
    };
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (e) => resolve(e as CloseEvent), { once: true });
  });
}

Deno.test("a second tab on the same player id retires the first with a distinct close code", async () => {
  const server = await startServer();
  try {
    const first = await open(server.url, "duplicate01");
    const closed = nextClose(first);
    const second = await open(server.url, "duplicate01");

    const event = await closed;
    // This code is the whole fix: without it the retired client treats the drop
    // as a network blip, reconnects, displaces the second tab, and the two
    // supersede each other indefinitely.
    assertEquals(
      event.code,
      CLOSE_SUPERSEDED,
      "the displaced socket must be told it was deliberately replaced",
    );
    assertEquals(second.readyState, WebSocket.OPEN, "the newcomer stays connected");

    second.close();
  } finally {
    await server.stop();
  }
});

Deno.test("the surviving tab can still create and play a room", async () => {
  const server = await startServer();
  try {
    const stale = await open(server.url, "survivor001");
    const staleClosed = nextClose(stale);
    const live = await open(server.url, "survivor001");
    await staleClosed;

    const messages: Record<string, unknown>[] = [];
    live.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));

    live.send(JSON.stringify({ t: "create", nickname: "solo", config: { mode: "race" } }));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !messages.some((m) => m.t === "state")) {
      await new Promise((r) => setTimeout(r, 80));
    }

    const hello = messages.find((m) => m.t === "hello") as { code?: string } | undefined;
    assert(hello?.code, "the surviving socket should be able to create a room");

    live.send(JSON.stringify({ t: "start" }));
    live.send(JSON.stringify({ t: "guess", word: "cat" }));
    const guessDeadline = Date.now() + 8000;
    while (Date.now() < guessDeadline && !messages.some((m) => m.t === "guessResult")) {
      await new Promise((r) => setTimeout(r, 80));
    }
    const result = messages.find((m) => m.t === "guessResult") as
      | { accepted?: boolean; rank?: number }
      | undefined;
    assert(result, "a guess should be answered");
    assertEquals(result.accepted, true);
    assert(typeof result.rank === "number" && result.rank >= 1);

    live.close();
  } finally {
    await server.stop();
  }
});

// --- the private assistant --------------------------------------------------
//
// startServer runs with CLOSEWORD_AI_CLUES=off, so the server reports no `claude`
// binary. That makes these deterministic: they check the wiring and the refusal
// path, not the model.

function collect(socket: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  socket.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
  return messages;
}

async function waitFor(
  messages: Record<string, unknown>[],
  match: (m: Record<string, unknown>) => boolean,
  ms = 6000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = messages.find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 60));
  }
  return undefined;
}

Deno.test("the assistant answers without being in a room", async () => {
  const server = await startServer();
  try {
    const socket = await open(server.url, "assistant01");
    const messages = collect(socket);

    // Deliberately before joining anything: the assistant is a personal
    // companion, so it must work on the landing screen too.
    socket.send(JSON.stringify({ t: "assist", id: "q1", text: "make it dark" }));

    const reply = await waitFor(messages, (m) => m.t === "assistReply");
    assert(reply, "an assist message should get a reply");
    assertEquals(reply.id, "q1", "the reply must carry the correlation id");
    // No `claude` on this server, so it explains itself rather than hanging.
    assert(typeof reply.error === "string" && reply.error.length > 0);
    assert(
      String(reply.error).includes("Look tab"),
      "the refusal should point at the manual controls",
    );

    // And it must not be mistaken for a room action.
    assertFalse(
      messages.some((m) => m.t === "error" && m.code === "noRoom"),
      "the assistant must not require a room",
    );

    socket.close();
  } finally {
    await server.stop();
  }
});

Deno.test("an assist message with no correlation id is dropped without killing the socket", async () => {
  const server = await startServer();
  try {
    const socket = await open(server.url, "assistant02");
    const messages = collect(socket);

    socket.send(JSON.stringify({ t: "assist", text: "hello" }));
    // A reply would have nowhere to go, so silence is correct — but the
    // connection has to survive it.
    socket.send(JSON.stringify({ t: "ping" }));

    const pong = await waitFor(messages, (m) => m.t === "pong");
    assert(pong, "the socket should still be usable");
    assertFalse(
      messages.some((m) => m.t === "assistReply"),
      "there is no id to answer against",
    );

    socket.close();
  } finally {
    await server.stop();
  }
});

Deno.test("an empty assist message is answered, not ignored", async () => {
  const server = await startServer();
  try {
    const socket = await open(server.url, "assistant03");
    const messages = collect(socket);

    socket.send(JSON.stringify({ t: "assist", id: "blank", text: "   " }));
    const reply = await waitFor(messages, (m) => m.t === "assistReply");
    assert(reply, "the client is waiting on this id and must be released");
    assertEquals(reply.id, "blank");
    assert(typeof reply.error === "string");

    socket.close();
  } finally {
    await server.stop();
  }
});

Deno.test("/api/info reports assistant availability separately from clues", async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/api/info`);
    const info = await res.json() as { assistant?: unknown; aiClues?: unknown };
    // Two flags rather than one: the assistant is per-player, AI clues are a
    // room setting, and the UI needs to speak about them separately.
    assertEquals(info.assistant, false);
    assertEquals(info.aiClues, false);
  } finally {
    await server.stop();
  }
});

Deno.test("a malformed player id is refused at the upgrade", async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/ws?id=short`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    await res.body?.cancel();
    assertEquals(res.status, 400);
  } finally {
    await server.stop();
  }
});

// --- one player, two rooms --------------------------------------------------

Deno.test("kicking a ghost from one room does not touch the room they moved to", async () => {
  const server = await startServer();
  try {
    const host = await open(server.url, "twoRoomHost01");
    const hostMsgs = collect(host);
    host.send(JSON.stringify({ t: "create", nickname: "hosty", config: { mode: "race" } }));
    const helloA = await waitFor(hostMsgs, (m) => m.t === "hello") as { code: string };
    assert(helloA?.code, "the host should get a room");

    const guest = await open(server.url, "twoRoomGuest1");
    const guestMsgs = collect(guest);
    guest.send(JSON.stringify({ t: "join", code: helloA.code, nickname: "wanderer" }));
    assert(await waitFor(guestMsgs, (m) => m.t === "hello"), "the guest should get into room A");

    // Started, so leaving keeps them on room A's roster for a reconnect — which
    // is exactly the state that makes them kickable after they have gone.
    host.send(JSON.stringify({ t: "start" }));
    assert(
      await waitFor(
        hostMsgs,
        (m) => m.t === "state" && (m.room as { phase?: string }).phase === "playing",
      ),
    );

    guest.send(JSON.stringify({ t: "leave" }));
    guest.send(JSON.stringify({ t: "create", nickname: "wanderer", config: { mode: "race" } }));
    const helloB = await waitFor(
      guestMsgs,
      (m) => m.t === "hello" && (m as { code?: string }).code !== helloA.code,
    ) as { code: string };
    assert(helloB?.code, "the guest should be in a second room");

    guestMsgs.length = 0;
    host.send(JSON.stringify({ t: "kick", playerId: "twoRoomGuest1" }));

    // Give the kick time to be wrong before declaring it right.
    assertEquals(
      await waitFor(guestMsgs, (m) => m.t === "kicked", 1200),
      undefined,
      "room A's host must not be able to evict them from room B",
    );
    guest.send(JSON.stringify({ t: "guess", word: "cat" }));
    const still = await waitFor(guestMsgs, (m) => m.t === "guessResult" || m.t === "error");
    assertEquals(still?.t, "guessResult", "they are still playing in room B");

    host.close();
    guest.close();
  } finally {
    await server.stop();
  }
});

Deno.test("a solo room starts itself and turns a second player away", async () => {
  const server = await startServer();
  try {
    const owner = await open(server.url, "solopractice1");
    const ownerMsgs: Record<string, unknown>[] = [];
    owner.addEventListener("message", (e) => ownerMsgs.push(JSON.parse(String(e.data))));

    owner.send(JSON.stringify({ t: "create", nickname: "duc", config: { mode: "solo" } }));
    const deadline = Date.now() + 10_000;
    // No `start` is ever sent: practice has nobody to wait for, so the server
    // deals the first word as part of creating the room.
    while (
      Date.now() < deadline &&
      !ownerMsgs.some((m) =>
        m.t === "state" && (m.room as { phase?: string } | undefined)?.phase === "playing"
      )
    ) {
      await new Promise((r) => setTimeout(r, 80));
    }
    const hello = ownerMsgs.find((m) => m.t === "hello") as { code?: string } | undefined;
    assert(hello?.code, "creating a solo room should answer with hello");
    const playing = ownerMsgs.find((m) =>
      m.t === "state" && (m.room as { phase?: string } | undefined)?.phase === "playing"
    );
    assert(playing, "a solo room should be playing without anybody pressing start");

    // The closed door. A room code is six characters, so "nobody knows it" is
    // not a door — the refusal has to come from the server.
    const stranger = await open(server.url, "solointruder1");
    const strangerMsgs: Record<string, unknown>[] = [];
    stranger.addEventListener("message", (e) => strangerMsgs.push(JSON.parse(String(e.data))));
    stranger.send(JSON.stringify({ t: "join", code: hello.code, nickname: "nosy" }));

    const refuseBy = Date.now() + 8000;
    while (Date.now() < refuseBy && !strangerMsgs.some((m) => m.t === "error")) {
      await new Promise((r) => setTimeout(r, 80));
    }
    const error = strangerMsgs.find((m) => m.t === "error") as
      | { code?: string; message?: string }
      | undefined;
    assert(error, "joining somebody's practice room should be refused");
    assertEquals(error.code, "solo");
    assertFalse(
      strangerMsgs.some((m) => m.t === "state"),
      "a refused joiner must never receive a snapshot of the room",
    );

    stranger.close();
    owner.close();
  } finally {
    await server.stop();
  }
});

Deno.test("the open-room list shows shared rooms and hides practice ones", async () => {
  const server = await startServer();
  try {
    const host = await open(server.url, "roomlisthost1");
    const hostMsgs: Record<string, unknown>[] = [];
    host.addEventListener("message", (e) => hostMsgs.push(JSON.parse(String(e.data))));
    host.send(JSON.stringify({ t: "create", nickname: "host", config: { mode: "race" } }));

    const loner = await open(server.url, "roomlistsolo1");
    const lonerMsgs: Record<string, unknown>[] = [];
    loner.addEventListener("message", (e) => lonerMsgs.push(JSON.parse(String(e.data))));
    loner.send(JSON.stringify({ t: "create", nickname: "loner", config: { mode: "solo" } }));

    const bothBy = Date.now() + 10_000;
    while (
      Date.now() < bothBy &&
      !(hostMsgs.some((m) => m.t === "hello") && lonerMsgs.some((m) => m.t === "hello"))
    ) {
      await new Promise((r) => setTimeout(r, 80));
    }
    const shared = (hostMsgs.find((m) => m.t === "hello") as { code?: string }).code;
    const practice = (lonerMsgs.find((m) => m.t === "hello") as { code?: string }).code;
    assert(shared && practice);

    const asker = await open(server.url, "roomlistasker1");
    const askerMsgs: Record<string, unknown>[] = [];
    asker.addEventListener("message", (e) => askerMsgs.push(JSON.parse(String(e.data))));
    asker.send(JSON.stringify({ t: "rooms" }));

    const replyBy = Date.now() + 8000;
    while (replyBy > Date.now() && !askerMsgs.some((m) => m.t === "rooms")) {
      await new Promise((r) => setTimeout(r, 80));
    }
    const reply = askerMsgs.find((m) => m.t === "rooms") as {
      online?: number;
      playing?: number;
      rooms?: { code: string; players: number; joinable: boolean; phase: string }[];
    };
    assert(reply?.rooms, "asking for rooms should be answered");

    const listed = reply.rooms.find((r) => r.code === shared);
    assert(listed, "a shared room with somebody in it should be listed");
    assertEquals(listed.players, 1);
    assertEquals(listed.joinable, true);
    // Practice is a closed door, so it is not on the list either — a door that
    // advertises itself and then refuses you is worse than not being shown.
    assertFalse(
      reply.rooms.some((r) => r.code === practice),
      "a solo room must never appear in the open-room list",
    );
    // Three browsers connected, two of them sitting in a room.
    assertEquals(reply.online, 3);
    assertEquals(reply.playing, 2);

    asker.close();
    loner.close();
    host.close();
  } finally {
    await server.stop();
  }
});

Deno.test("lining somebody up tells them before the room exists", async () => {
  const server = await startServer();
  try {
    const host = await open(server.url, "aheadhost0001");
    const guest = await open(server.url, "aheadguest001");
    const guestMsgs: Record<string, unknown>[] = [];
    guest.addEventListener("message", (e) => guestMsgs.push(JSON.parse(String(e.data))));

    // Both are on the landing page. This is the case the feature exists for: the
    // host has not created anything yet, so there is no code to hand over.
    host.send(JSON.stringify({ t: "presence", nickname: "duc" }));
    guest.send(JSON.stringify({ t: "presence", nickname: "tduong" }));
    await new Promise((r) => setTimeout(r, 250));
    host.send(JSON.stringify({ t: "inviteAhead", playerId: "aheadguest001" }));

    const by = Date.now() + 8000;
    while (Date.now() < by && !guestMsgs.some((m) => m.t === "inviteAhead")) {
      await new Promise((r) => setTimeout(r, 60));
    }
    const notice = guestMsgs.find((m) => m.t === "inviteAhead") as
      | { fromNickname?: string; cancel?: boolean }
      | undefined;
    assert(notice, "being lined up should reach the person it is about");
    assertEquals(notice.fromNickname, "duc");
    assertFalse(notice.cancel);

    // Changing your mind withdraws it, so a landing page does not sit there
    // promising a room that nobody is building any more.
    host.send(JSON.stringify({ t: "inviteAhead", playerId: "aheadguest001", cancel: true }));
    const cancelBy = Date.now() + 8000;
    while (
      Date.now() < cancelBy &&
      !guestMsgs.some((m) => m.t === "inviteAhead" && m.cancel === true)
    ) {
      await new Promise((r) => setTimeout(r, 60));
    }
    assert(
      guestMsgs.some((m) => m.t === "inviteAhead" && m.cancel === true),
      "un-ticking a name should withdraw the notice",
    );

    // And then the real thing, once there is a room to name.
    host.send(JSON.stringify({ t: "create", nickname: "duc", config: { mode: "race" } }));
    await new Promise((r) => setTimeout(r, 400));
    host.send(JSON.stringify({ t: "invite", playerId: "aheadguest001" }));
    const invitedBy = Date.now() + 8000;
    while (Date.now() < invitedBy && !guestMsgs.some((m) => m.t === "invited")) {
      await new Promise((r) => setTimeout(r, 60));
    }
    const invited = guestMsgs.find((m) => m.t === "invited") as { code?: string } | undefined;
    assert(invited?.code, "the invitation itself still arrives, with a code");

    guest.close();
    host.close();
  } finally {
    await server.stop();
  }
});

// --- reactions and word lookups over the wire -------------------------------
//
// Both of these are about the socket layer specifically, not the room. The room
// tests already prove `react` tallies four kinds and `chat` resolves mentions;
// what is tested here is the translation between a client message and that call,
// which is where a hardcoded pair of kinds silently turned every escalation into a
// rose.

Deno.test("every reaction kind survives the trip to the server", async () => {
  const server = await startServer();
  try {
    const host = await open(server.url, "reactkind0001");
    const guest = await open(server.url, "reactkind0002");
    const hostMsgs = collect(host);

    host.send(JSON.stringify({ t: "create", nickname: "ann", config: { mode: "race" } }));
    const hello = await waitFor(hostMsgs, (m) => m.t === "hello") as { code?: string } | undefined;
    assert(hello?.code, "the room should exist");
    guest.send(JSON.stringify({ t: "join", code: hello.code, nickname: "bo" }));
    await new Promise((r) => setTimeout(r, 400));

    for (const kind of REACTION_KEYS) {
      hostMsgs.length = 0;
      guest.send(JSON.stringify({ t: "react", playerId: "reactkind0001", kind }));
      const echo = await waitFor(hostMsgs, (m) => m.t === "reaction");
      assert(echo, `a ${kind} should be broadcast`);
      assertEquals(echo.kind, kind, `a ${kind} must not arrive as something else`);
    }

    // And a kind nobody declared is refused rather than quietly turned into one
    // that was.
    hostMsgs.length = 0;
    guest.send(JSON.stringify({ t: "react", playerId: "reactkind0001", kind: "trophy" }));
    await new Promise((r) => setTimeout(r, 400));
    assertFalse(
      hostMsgs.some((m) => m.t === "reaction"),
      "an unknown reaction should throw nothing at anybody",
    );

    guest.close();
    host.close();
  } finally {
    await server.stop();
  }
});

Deno.test("a word lookup always gets an answer, even with no claude", async () => {
  const server = await startServer();
  try {
    const socket = await open(server.url, "definer00001");
    const messages = collect(socket);

    // Deliberately outside a room: a definition is a fact about English, and
    // somebody on the landing page has as much right to it as somebody mid-round.
    socket.send(JSON.stringify({ t: "define", word: "warranty" }));
    const reply = await waitFor(messages, (m) => m.t === "definition");
    assert(reply, "a define must always be answered — a spinner forever is the worst case");
    assertEquals(reply.word, "warranty");
    // startServer runs with clues off, so this server has no dictionary and says
    // so rather than hanging or pretending.
    assertEquals(reply.status, "unavailable");

    // Nonsense is dropped on shape, before any subprocess could be spawned.
    messages.length = 0;
    socket.send(JSON.stringify({ t: "define", word: "42" }));
    socket.send(JSON.stringify({ t: "define", word: "a b c" }));
    socket.send(JSON.stringify({ t: "define", word: "x".repeat(200) }));
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(messages.filter((m) => m.t === "definition").length, 0);

    socket.close();
  } finally {
    await server.stop();
  }
});
