// Tests for the rotating logger.
//
// The behaviour worth pinning down is the part that runs unattended for weeks:
// rotation on size, rotation on date, retention, and the guarantee that a secret
// never reaches the file.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dayStamp, errorFields, formatFields, formatLine, Logger } from "../server/log.ts";

/** A logger writing into a throwaway directory, with the directory path. */
async function withLogger(
  options: Record<string, unknown>,
  body: (log: Logger, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "closeword-log-" });
  const log = new Logger({ dir, console: false, ...options });
  try {
    await body(log, dir);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function listLogs(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) if (entry.isFile) names.push(entry.name);
  return names.sort();
}

Deno.test("a line carries time, level, channel, message and fields", () => {
  const line = formatLine(
    new Date("2026-08-13T09:41:02.184Z"),
    "info",
    "service",
    "listening",
    { port: 8791, host: "0.0.0.0" },
  );
  assertEquals(line, "2026-08-13T09:41:02.184Z INFO  service listening port=8791 host=0.0.0.0");
});

Deno.test("a multi-line message stays on one line", () => {
  // Anything reading this file a line at a time — grep included — breaks
  // otherwise.
  const line = formatLine(new Date(), "error", "action", "boom\n  at somewhere");
  assertEquals(line.split("\n").length, 1);
  assertStringIncludes(line, "boom ⏎ at somewhere");
});

Deno.test("values that would break key=value parsing are quoted", () => {
  assertEquals(formatFields({ a: "two words" }), ` a="two words"`);
  assertEquals(formatFields({ a: "plain" }), " a=plain");
  assertEquals(formatFields({ a: "" }), ` a=""`);
  assertEquals(formatFields({ a: "has=equals" }), ` a="has=equals"`);
  assertEquals(formatFields({ a: null }), " a=null");
  assertEquals(formatFields({ a: 12 }), " a=12");
  assertEquals(formatFields({ a: true }), " a=true");
  // undefined means "no value", which is not the same as the string "undefined".
  assertEquals(formatFields({ a: undefined, b: 1 }), " b=1");
});

Deno.test("secret-looking fields are redacted", () => {
  // A backstop. Call sites are not supposed to pass these at all, but a token in
  // a log file is discovered much later and by someone else.
  for (const key of ["token", "apiKey", "api_key", "password", "authorization", "SECRET"]) {
    assertEquals(formatFields({ [key]: "hunter2" }), ` ${key}=***`);
  }
  assertEquals(formatFields({ tokens: 5 }), " tokens=***");
  // Ordinary fields are untouched.
  assertEquals(formatFields({ player: "abc" }), " player=abc");
});

Deno.test("an error contributes its name, message and a trimmed stack", () => {
  const fields = errorFields(new TypeError("bad thing"));
  assertEquals(fields.error, "TypeError");
  assertEquals(fields.message, "bad thing");
  assert(typeof fields.stack === "string" && fields.stack.length > 0);
  // A thrown non-Error still produces something readable.
  assertEquals(errorFields("just a string").message, "just a string");
});

Deno.test("lines land in the day's file", async () => {
  await withLogger({}, async (log, dir) => {
    log.service("hello", { n: 1 });
    await log.flush();
    const name = `closeword-${dayStamp(new Date())}.log`;
    const text = await Deno.readTextFile(join(dir, name));
    assertStringIncludes(text, "INFO  service hello n=1");
    assertEquals(text.endsWith("\n"), true);
  });
});

Deno.test("lines below the configured level are dropped", async () => {
  await withLogger({ level: "warn" }, async (log, dir) => {
    log.service("not written");
    log.action("nor this");
    log.warn("service", "but this is");
    await log.flush();
    const text = await Deno.readTextFile(join(dir, `closeword-${dayStamp(new Date())}.log`));
    assertEquals(text.includes("not written"), false);
    assertStringIncludes(text, "but this is");
  });
});

Deno.test("the active file never exceeds the size cap", async () => {
  await withLogger({ maxBytes: 64_000 }, async (log, dir) => {
    const filler = "x".repeat(500);
    for (let i = 0; i < 400; i++) log.service("filler", { i, filler });
    await log.flush();

    const names = await listLogs(dir);
    assert(names.length > 1, `expected a rollover, got ${names.join(", ")}`);
    for (const name of names) {
      const size = (await Deno.stat(join(dir, name))).size;
      assert(size <= 64_000, `${name} is ${size} bytes, over the cap`);
    }
  });
});

Deno.test("rolled parts are numbered and the live file keeps the plain name", async () => {
  await withLogger({ maxBytes: 64_000 }, async (log, dir) => {
    const filler = "x".repeat(500);
    for (let i = 0; i < 300; i++) log.service("filler", { i, filler });
    await log.flush();

    const today = dayStamp(new Date());
    const names = await listLogs(dir);
    assert(names.includes(`closeword-${today}.log`), "the live file keeps the plain name");
    assert(names.includes(`closeword-${today}.1.log`), `expected a .1 part in ${names.join(", ")}`);
  });
});

Deno.test("no line is lost across a rollover", async () => {
  await withLogger({ maxBytes: 64_000 }, async (log, dir) => {
    const filler = "y".repeat(400);
    const count = 300;
    for (let i = 0; i < count; i++) log.service("seq", { i, filler });
    await log.flush();

    let seen = 0;
    for (const name of await listLogs(dir)) {
      const text = await Deno.readTextFile(join(dir, name));
      seen += text.split("\n").filter((line) => line.includes("seq")).length;
    }
    assertEquals(seen, count);
  });
});

Deno.test("a restart onto a full file rotates instead of appending past the cap", async () => {
  const dir = await Deno.makeTempDir({ prefix: "closeword-log-" });
  try {
    const today = dayStamp(new Date());
    const path = join(dir, `closeword-${today}.log`);
    await Deno.writeTextFile(path, "z".repeat(70_000));

    const log = new Logger({ dir, console: false, maxBytes: 64_000 });
    log.service("after restart");
    await log.close();

    const names = await listLogs(dir);
    assert(names.includes(`closeword-${today}.1.log`), "the full file was rolled aside");
    const size = (await Deno.stat(path)).size;
    assert(size < 1_000, `the new live file should be small, was ${size}`);
    assertStringIncludes(await Deno.readTextFile(path), "after restart");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("day-files past the retention window are deleted, with their parts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "closeword-log-" });
  try {
    const old = new Date();
    old.setDate(old.getDate() - 9);
    const recent = new Date();
    recent.setDate(recent.getDate() - 2);
    const oldStamp = dayStamp(old);
    const recentStamp = dayStamp(recent);

    for (
      const name of [
        `closeword-${oldStamp}.log`,
        `closeword-${oldStamp}.1.log`,
        `closeword-${recentStamp}.log`,
        "notes.txt",
        "other-2020-01-01.log",
      ]
    ) {
      await Deno.writeTextFile(join(dir, name), "x\n");
    }

    const log = new Logger({ dir, console: false, keepDays: 5 });
    const removed = await log.sweep();
    await log.close();

    assertEquals(removed, 2);
    const names = await listLogs(dir);
    assertEquals(names.includes(`closeword-${oldStamp}.log`), false);
    assertEquals(names.includes(`closeword-${oldStamp}.1.log`), false);
    assert(names.includes(`closeword-${recentStamp}.log`), "inside the window, kept");
    // Only this logger's own files are candidates.
    assert(names.includes("notes.txt"));
    assert(names.includes("other-2020-01-01.log"));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("retention of 0 keeps everything", async () => {
  const dir = await Deno.makeTempDir({ prefix: "closeword-log-" });
  try {
    const old = new Date();
    old.setDate(old.getDate() - 400);
    await Deno.writeTextFile(join(dir, `closeword-${dayStamp(old)}.log`), "x\n");
    const log = new Logger({ dir, console: false, keepDays: 0 });
    assertEquals(await log.sweep(), 0);
    await log.close();
    assertEquals((await listLogs(dir)).length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("retention runs on the first write, not only after a day rolls over", async () => {
  // A box switched on to play and off again never crosses midnight, so a
  // rollover-only sweep would never delete anything on it.
  const dir = await Deno.makeTempDir({ prefix: "closeword-log-" });
  try {
    const old = new Date();
    old.setDate(old.getDate() - 30);
    await Deno.writeTextFile(join(dir, `closeword-${dayStamp(old)}.log`), "x\n");

    const log = new Logger({ dir, console: false, keepDays: 5 });
    log.service("first line");
    await log.close();

    assertEquals((await listLogs(dir)).includes(`closeword-${dayStamp(old)}.log`), false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("toFile:false writes nothing to disk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "closeword-log-" });
  try {
    const log = new Logger({ dir, console: false, toFile: false });
    log.service("nowhere");
    await log.close();
    assertEquals((await listLogs(dir)).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("an unwritable directory does not throw at the call site", async () => {
  // Logging must never be the thing that takes the game down. A file inside a
  // path component that is itself a file cannot be created.
  const base = await Deno.makeTempDir({ prefix: "closeword-log-" });
  try {
    const blocker = join(base, "blocked");
    await Deno.writeTextFile(blocker, "not a directory");
    const log = new Logger({ dir: join(blocker, "logs"), console: false });
    log.service("this cannot be written");
    await log.flush();
    log.service("and neither can this");
    await log.close();
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
});

Deno.test("channel helpers file under the right channel", async () => {
  await withLogger({ level: "debug" }, async (log, dir) => {
    log.service("a");
    log.action("b");
    log.http("c");
    log.webhook("d");
    log.error("webhook", "e", new Error("nope"));
    await log.flush();
    const text = await Deno.readTextFile(join(dir, `closeword-${dayStamp(new Date())}.log`));
    assertStringIncludes(text, "INFO  service a");
    assertStringIncludes(text, "INFO  action  b");
    assertStringIncludes(text, "INFO  http    c");
    assertStringIncludes(text, "INFO  webhook d");
    assertStringIncludes(text, "ERROR webhook e error=Error message=nope");
  });
});
