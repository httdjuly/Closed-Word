// Tagging somebody with @, and the word panel.
//
// Both are notification-shaped features, which is why the tests are mostly about
// who *does not* get told: a mention that reaches the wrong person, or everybody,
// is worse than one that reaches nobody.

import { assert, assertEquals } from "@std/assert";
import { parseNote } from "../server/define.ts";
import { idFor, makeRoom } from "./helpers.ts";

const ANN = idFor("ann");
const BO = idFor("bo");
const CY = idFor("cy");

Deno.test("an @name tags that person and nobody else", async () => {
  const t = await makeRoom({}, ["ann", "bo", "cy"]);
  assertEquals(t.room.chat(ANN, "@bo have you tried fruit"), [BO]);
  // And it is recorded on the line, so a client can mark it without guessing.
  const line = t.room.viewFor(BO).feed.filter((f) => f.kind === "chat").at(-1)!;
  assertEquals(line.mentions, [BO]);
});

Deno.test("a name is matched whole, and the longest one wins", async () => {
  // "ann" is a prefix of "annabel": the shorter name must not steal the mention.
  const t = await makeRoom({}, ["ann", "annabel"]);
  assertEquals(t.room.chat(idFor("annabel"), "@ann your turn"), [ANN]);
  assertEquals(t.room.chat(ANN, "@annabel your turn"), [idFor("annabel")]);
});

Deno.test("punctuation ends a name but letters do not", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  assertEquals(t.room.chat(ANN, "well spotted @bo!"), [BO]);
  assertEquals(t.room.chat(ANN, "ask @bo, they know"), [BO]);
  // "@bots" is a word that happens to start with a name.
  assertEquals(t.room.chat(ANN, "the @bots are winning"), []);
});

Deno.test("an @ that is not at the start of a word tags nobody", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  assertEquals(t.room.chat(ANN, "mail me at me@bo.example"), []);
});

Deno.test("@all reaches the room but never the person who typed it", async () => {
  const t = await makeRoom({}, ["ann", "bo", "cy"]);
  assertEquals(t.room.chat(ANN, "@all guess something").sort(), [BO, CY].sort());
  assertEquals(t.room.chat(ANN, "@room anybody?").sort(), [BO, CY].sort());
});

Deno.test("tagging yourself notifies nobody", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  assertEquals(t.room.chat(ANN, "@ann talking to myself"), []);
});

Deno.test("naming somebody twice notifies them once", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  assertEquals(t.room.chat(ANN, "@bo @bo @bo look at this"), [BO]);
});

Deno.test("an ordinary line carries no mentions field at all", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  assertEquals(t.room.chat(ANN, "no tags here"), []);
  const line = t.room.viewFor(BO).feed.filter((f) => f.kind === "chat").at(-1)!;
  assertEquals(line.mentions, undefined);
});

// ---------------------------------------------------------------------------
// Word notes
// ---------------------------------------------------------------------------

Deno.test("a well-formed note comes through intact", () => {
  const note = parseNote(
    "warranty",
    '{"ipa":"/ˈwɔːrənti/","pos":"noun","meaning":"a promise to repair or replace","vi":"bảo hành"}',
  );
  assert(note);
  assertEquals(note.word, "warranty");
  // The slashes are the client's job, so they are stripped here rather than
  // rendered twice.
  assertEquals(note.ipa, "ˈwɔːrənti");
  assertEquals(note.pos, "noun");
  assertEquals(note.vi, "bảo hành");
});

Deno.test("a note survives prose around the json", () => {
  const note = parseNote("cat", 'Sure!\n```json\n{"pos":"noun","vi":"con mèo"}\n```\n');
  assertEquals(note?.pos, "noun");
  assertEquals(note?.vi, "con mèo");
});

Deno.test("an invented part of speech is dropped, not shown", () => {
  const note = parseNote("cat", '{"pos":"substantive","vi":"con mèo"}');
  assertEquals(note?.pos, undefined);
  assertEquals(note?.vi, "con mèo");
});

Deno.test("Vietnamese diacritics survive the length limit", () => {
  // Combining marks make byte length and character length disagree; cutting on
  // the wrong one produces a letter with somebody else's accent on it.
  const long = "bảo hành ".repeat(30);
  const note = parseNote("warranty", JSON.stringify({ vi: long }));
  assert(note?.vi);
  assert(!note.vi.includes("�"), "no replacement characters");
  assert([...note.vi].length <= 120, `${[...note.vi].length} characters`);
});

Deno.test("rubbish, an empty answer, and an unknown word all come back as null", () => {
  assertEquals(parseNote("xyzzy", "I have no idea what that is."), null);
  assertEquals(parseNote("xyzzy", '{"unknown":true}'), null);
  assertEquals(parseNote("xyzzy", "{ not json at all "), null);
  // Valid JSON, nothing usable in it: a panel of four blank rows looks broken,
  // so this must be indistinguishable from not knowing.
  assertEquals(parseNote("xyzzy", '{"pos":"nonsense","ipa":"","vi":"  "}'), null);
});

Deno.test("a newline in a field cannot break the panel open", () => {
  const note = parseNote("cat", '{"meaning":"a small\\n\\npet animal","pos":"noun"}');
  assertEquals(note?.meaning, "a small pet animal");
});
