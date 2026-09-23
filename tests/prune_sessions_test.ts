// Tests for the session pruner.
//
// This is the only script in the repo that deletes anything, so the two pieces
// of logic that decide what goes get covered directly: the name patterns, and
// the classifier that reads `entrypoint` out of a transcript.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { classify, human, SESSION_DIR_RE, SESSION_FILE_RE } from "../scripts/prune_sessions.ts";

const ONE_SHOT =
  `{"parentUuid":null,"type":"user","promptSource":"sdk","userType":"external","entrypoint":"sdk-cli","message":{"role":"user","content":"hi"}}`;
const INTERACTIVE =
  `{"parentUuid":null,"type":"user","promptSource":"typed","userType":"external","entrypoint":"cli","message":{"role":"user","content":"hi"}}`;
const PREAMBLE = [
  `{"type":"mode","mode":"normal","sessionId":"x"}`,
  `{"type":"ai-title","aiTitle":"Something","sessionId":"x"}`,
  `{"type":"summary","summary":"..."}`,
].join("\n");

/** Write a transcript into a throwaway directory and classify it. */
async function classifyLines(lines: string): Promise<{ kind: string; entrypoint: string | null }> {
  const dir = await Deno.makeTempDir({ prefix: "closeword-prune-" });
  try {
    const path = join(dir, "session.jsonl");
    await Deno.writeTextFile(path, lines);
    return await classify(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("only uuid-named .jsonl files are candidates", () => {
  const uuid = "14f4ec1a-a0d1-4c6b-98b7-c4d5dec0c97f";
  assert(SESSION_FILE_RE.test(`${uuid}.jsonl`));
  assert(SESSION_DIR_RE.test(uuid));

  // The things that live alongside sessions and must never be touched.
  for (
    const name of [
      "memory",
      "MEMORY.md",
      "journal.jsonl",
      "subagents",
      "tool-results",
      "not-a-session.jsonl",
      "",
      ".",
      "..",
    ]
  ) {
    assert(!SESSION_FILE_RE.test(name), `${name} must not match the file pattern`);
    assert(!SESSION_DIR_RE.test(name), `${name} must not match the directory pattern`);
  }

  // Near-misses: a directory name is not a file name, and vice versa.
  assert(!SESSION_DIR_RE.test(`${uuid}.jsonl`));
  assert(!SESSION_FILE_RE.test(uuid));
  assert(!SESSION_FILE_RE.test(`${uuid}.jsonl.bak`));
  assert(!SESSION_FILE_RE.test(`prefix-${uuid}.jsonl`));
});

Deno.test("classify recognises a claude -p transcript", async () => {
  const result = await classifyLines(`${PREAMBLE}\n${ONE_SHOT}\n`);
  assertEquals(result.kind, "one-shot");
  assertEquals(result.entrypoint, "sdk-cli");
});

Deno.test("classify recognises an interactive transcript", async () => {
  const result = await classifyLines(`${PREAMBLE}\n${INTERACTIVE}\n`);
  assertEquals(result.kind, "interactive");
  assertEquals(result.entrypoint, "cli");
});

Deno.test("the first entrypoint decides, not a later one", async () => {
  // A resumed interactive session can contain sdk-cli turns from subagent work.
  // Whoever started the session owns it.
  const result = await classifyLines(`${PREAMBLE}\n${INTERACTIVE}\n${ONE_SHOT}\n`);
  assertEquals(result.kind, "interactive");
});

Deno.test("an unknown entrypoint is kept, not treated as one-shot", async () => {
  const future = ONE_SHOT.replace('"sdk-cli"', '"some-future-frontend"');
  const result = await classifyLines(`${PREAMBLE}\n${future}\n`);
  assertEquals(result.kind, "interactive");
  assertEquals(result.entrypoint, "some-future-frontend");
});

Deno.test("a transcript with no entrypoint is unknown", async () => {
  const result = await classifyLines(`${PREAMBLE}\n`);
  assertEquals(result.kind, "unknown");
  assertEquals(result.entrypoint, null);
});

Deno.test("an empty file is unknown, not one-shot", async () => {
  assertEquals((await classifyLines("")).kind, "unknown");
});

Deno.test("a missing file is unknown rather than an error", async () => {
  const result = await classify(join(await Deno.makeTempDir(), "nope.jsonl"));
  assertEquals(result.kind, "unknown");
});

Deno.test("classification survives a first line larger than the read buffer", async () => {
  // The buffer is 64 KB; a pasted file or a big tool result easily exceeds it,
  // and the classifying record sits *after* that line.
  const huge = JSON.stringify({ type: "user", message: { content: "x".repeat(200_000) } });
  const result = await classifyLines(`${huge}\n${ONE_SHOT}\n`);
  assertEquals(result.kind, "one-shot");
});

Deno.test("a truncated trailing line does not derail classification", async () => {
  const result = await classifyLines(`${PREAMBLE}\n${ONE_SHOT}\n{"type":"assi`);
  assertEquals(result.kind, "one-shot");
});

Deno.test("a corrupt line before the marker is skipped", async () => {
  const result = await classifyLines(`{not json at all\n${ONE_SHOT}\n`);
  assertEquals(result.kind, "one-shot");
});

Deno.test("byte sizes read the way a human would say them", () => {
  assertEquals(human(0), "0 B");
  assertEquals(human(999), "999 B");
  assertEquals(human(1024), "1.0 KB");
  assertEquals(human(5 * 1024 * 1024), "5.0 MB");
  assertEquals(human(190 * 1024 * 1024), "190 MB");
  assertEquals(human(2 * 1024 ** 3), "2.0 GB");
});
