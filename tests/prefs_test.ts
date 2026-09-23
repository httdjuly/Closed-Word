// The appearance-preference schema is a trust boundary: values reach it from
// `claude -p` and from whatever is left in a player's localStorage. These tests
// pin down what it accepts, and — more importantly — what it refuses.

import { assert, assertEquals, assertFalse } from "@std/assert";

import {
  BACKGROUNDS,
  cssVarsFor,
  DEFAULT_PREFS,
  luminance,
  MAX_BACKGROUND_BYTES,
  PRESETS,
  RADIUS_RANGE,
  readableOn,
  resolveMode,
  sanitisePrefs,
} from "../shared/prefs.js";
import {
  DIFFICULTIES,
  formatRankValue,
  RANK_DISPLAY_CAP,
  REFERENCE_VOCAB,
  tierForRank,
} from "../shared/constants.js";
import { buildAssistPrompt, extractPatch } from "../server/ai_core.ts";

// ---------------------------------------------------------------------------
// Accepting the legitimate
// ---------------------------------------------------------------------------

Deno.test("a valid patch is merged onto the current preferences", () => {
  const { prefs, applied, rejected } = sanitisePrefs({ mode: "dark", radius: 20 });
  assertEquals(prefs.mode, "dark");
  assertEquals(prefs.radius, 20);
  // Untouched fields keep their previous value.
  assertEquals(prefs.accent, DEFAULT_PREFS.accent);
  assertEquals(applied.sort(), ["mode", "radius"]);
  assertEquals(rejected, []);
});

Deno.test("a field already at the requested value is not reported as applied", () => {
  const base = { ...DEFAULT_PREFS, mode: "dark" as const };
  const { applied } = sanitisePrefs({ mode: "dark" }, base);
  // This is what stops the assistant claiming it changed something it did not.
  assertEquals(applied, []);
});

Deno.test("a preset expands into its whole bundle of fields", () => {
  const { prefs, applied } = sanitisePrefs({ preset: "midnight" });
  assertEquals(prefs.mode, "dark");
  assertEquals(prefs.background, "skyline");
  assert(applied.includes("accent"));
  assert(applied.includes("background"));
});

Deno.test("every preset is itself valid", () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    const { prefs, rejected } = sanitisePrefs(preset.prefs);
    assertEquals(rejected, [], `preset ${key} was partly refused`);
    // A preset must land exactly where it says it does.
    const landed = prefs as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(preset.prefs)) {
      assertEquals(landed[field], value, `preset ${key}.${field}`);
    }
  }
});

Deno.test("hex colours are accepted case-insensitively and normalised", () => {
  assertEquals(sanitisePrefs({ accent: "#AABBCC" }).prefs.accent, "#aabbcc");
  assertEquals(sanitisePrefs({ accent: "  #123456 " }).prefs.accent, "#123456");
});

// ---------------------------------------------------------------------------
// Refusing the rest
// ---------------------------------------------------------------------------

Deno.test("values outside the allowed set are refused, not coerced", () => {
  const { prefs, rejected } = sanitisePrefs({
    mode: "neon",
    layout: "carousel",
    font: "comic sans",
    density: "enormous",
    background: "beach",
  });
  assertEquals(prefs.mode, DEFAULT_PREFS.mode);
  assertEquals(prefs.layout, DEFAULT_PREFS.layout);
  assertEquals(prefs.font, DEFAULT_PREFS.font);
  for (const key of ["mode", "layout", "font", "density", "background"]) {
    assert(rejected.includes(key), `${key} should have been reported`);
  }
});

Deno.test("colours must be six-digit hex — no CSS expressions get through", () => {
  // The important case: anything that would let arbitrary CSS into a style
  // attribute. `red` and `#fff` are refused too, which is fine — the UI only
  // ever offers full hex.
  for (
    const bad of [
      "red",
      "#fff",
      "rgb(0,0,0)",
      "var(--x)",
      "#000;background:url(http://evil/x)",
      "url(http://evil/beacon.png)",
      "expression(alert(1))",
    ]
  ) {
    const { prefs, rejected } = sanitisePrefs({ accent: bad });
    assertEquals(prefs.accent, DEFAULT_PREFS.accent, `accepted ${bad}`);
    assert(rejected.includes("accent"));
  }
});

Deno.test("radius is clamped rather than refused", () => {
  assertEquals(sanitisePrefs({ radius: 9999 }).prefs.radius, RADIUS_RANGE.max);
  assertEquals(sanitisePrefs({ radius: -40 }).prefs.radius, RADIUS_RANGE.min);
  assertEquals(sanitisePrefs({ radius: 12.6 }).prefs.radius, 13);
  // Not a number at all, though, is a refusal.
  const { prefs, rejected } = sanitisePrefs({ radius: "huge" });
  assertEquals(prefs.radius, DEFAULT_PREFS.radius);
  assert(rejected.includes("radius"));
});

Deno.test("background images may only be raster data URIs", () => {
  // A remote URL is the one that actually matters: accepted, it would turn a
  // cosmetic preference into a request to someone else's server on every paint.
  for (
    const bad of [
      "https://example.com/pic.png",
      "http://example.com/pic.png",
      "//example.com/pic.png",
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      'data:image/png;base64,AAAA"),url(http://evil/x)',
    ]
  ) {
    const { prefs, rejected } = sanitisePrefs({ backgroundImage: bad });
    assertEquals(prefs.backgroundImage, null, `accepted ${bad}`);
    assert(rejected.includes("backgroundImage"));
  }

  const good = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==";
  assertEquals(sanitisePrefs({ backgroundImage: good }).prefs.backgroundImage, good);
});

Deno.test("an oversized background image is refused so it cannot break storage", () => {
  const huge = `data:image/png;base64,${"A".repeat(MAX_BACKGROUND_BYTES + 1)}`;
  const { prefs, rejected } = sanitisePrefs({ backgroundImage: huge });
  assertEquals(prefs.backgroundImage, null);
  assert(rejected.includes("backgroundImage"));
});

Deno.test("unknown fields are reported rather than silently dropped", () => {
  const { rejected } = sanitisePrefs({ cssOverride: "body{display:none}", zIndex: 9 });
  assert(rejected.includes("cssOverride"));
  assert(rejected.includes("zIndex"));
});

Deno.test("asking for a custom background with no image falls back", () => {
  const { prefs, rejected } = sanitisePrefs({ background: "custom" });
  // Otherwise the page would paint nothing at all.
  assertEquals(prefs.background, DEFAULT_PREFS.background);
  assert(rejected.includes("background"));
});

Deno.test("a custom background survives when an image is present", () => {
  const base = {
    ...DEFAULT_PREFS,
    backgroundImage: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==",
  };
  assertEquals(sanitisePrefs({ background: "custom" }, base).prefs.background, "custom");
});

Deno.test("garbage input yields usable defaults instead of throwing", () => {
  for (const junk of [null, undefined, "dark", 42, [], true]) {
    const { prefs } = sanitisePrefs(junk);
    assertEquals(prefs.mode, DEFAULT_PREFS.mode);
  }
});

// ---------------------------------------------------------------------------
// Turning preferences into CSS
// ---------------------------------------------------------------------------

Deno.test("cssVarsFor emits a complete set of custom properties", () => {
  const vars = cssVarsFor(DEFAULT_PREFS, "light");
  for (const name of ["--accent", "--radius", "--space-scale", "--font-ui", "--scene"]) {
    assert(name in vars, `missing ${name}`);
  }
  assertEquals(vars["--radius"], `${DEFAULT_PREFS.radius}px`);
});

Deno.test("no built-in scene reaches out to the network", () => {
  // Every background must be self-contained: the whole app runs on a LAN with no
  // internet, and a background is not worth telling a third party what we play.
  //
  // Only fetched references count. The inline SVG scenes carry an xmlns of
  // http://www.w3.org/2000/svg, which is an XML namespace name — an identifier
  // the browser never dereferences — so a blanket "no http" check would be wrong.
  for (const [key, scene] of Object.entries(BACKGROUNDS)) {
    for (const value of [scene.light, scene.dark]) {
      if (!value) continue;
      assertFalse(
        /url\(\s*["']?\s*(?:https?:)?\/\//i.test(value),
        `${key} fetches a remote image`,
      );
      assertFalse(/@import/i.test(value), `${key} uses @import`);
    }
  }
});

Deno.test("a custom image becomes a url() and a solid becomes the colour", () => {
  const image = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==";
  const custom = cssVarsFor(
    { ...DEFAULT_PREFS, background: "custom", backgroundImage: image },
    "light",
  );
  assertEquals(custom["--scene"], `url("${image}")`);

  const solid = cssVarsFor(
    { ...DEFAULT_PREFS, background: "solid", backgroundColor: "#102030" },
    "dark",
  );
  assertEquals(solid["--scene"], "#102030");
});

Deno.test("glass off removes the blur rather than just hiding it", () => {
  const off = cssVarsFor({ ...DEFAULT_PREFS, glass: false }, "light");
  assertEquals(off["--glass-blur"], "0px");
  assertEquals(off["--surface-alpha"], "1");
});

Deno.test("accent text colour flips so a pale accent stays readable", () => {
  // Without this a player who picks pale yellow gets white-on-yellow buttons.
  assertEquals(readableOn("#ffee88"), "#17150f");
  assertEquals(readableOn("#1a1a2e"), "#ffffff");
  assert(luminance("#ffffff") > luminance("#000000"));
});

Deno.test("system mode resolves against the viewer's OS setting", () => {
  assertEquals(resolveMode("system", true), "dark");
  assertEquals(resolveMode("system", false), "light");
  // An explicit choice ignores the OS in both directions.
  assertEquals(resolveMode("light", true), "light");
  assertEquals(resolveMode("dark", false), "dark");
});

// ---------------------------------------------------------------------------
// The rank scale, calibrated to closeword
// ---------------------------------------------------------------------------

Deno.test("ranks past the cap read as 30000+ rather than a precise number", () => {
  assertEquals(formatRankValue(RANK_DISPLAY_CAP), "30,000");
  assertEquals(formatRankValue(RANK_DISPLAY_CAP + 1), "30,000+");
  assertEquals(formatRankValue(41_207), "30,000+");
  // Below the cap the exact rank is what a player acts on, so it stays exact.
  assertEquals(formatRankValue(1), "1");
  assertEquals(formatRankValue(842), "842");
  assertEquals(formatRankValue(11_432), "11,432");
});

Deno.test("the lexicon is large enough for the scale to mean anything", () => {
  // The whole point of REFERENCE_VOCAB: a far guess must be able to come back in
  // the tens of thousands, the way it does on closeword.
  assert(REFERENCE_VOCAB >= RANK_DISPLAY_CAP, "the cap must be reachable");
  assertEquals(DIFFICULTIES.hard.poolLimit, REFERENCE_VOCAB);
  assert(DIFFICULTIES.easy.poolLimit < DIFFICULTIES.normal.poolLimit);
  assert(DIFFICULTIES.normal.poolLimit < DIFFICULTIES.hard.poolLimit);
});

Deno.test("tier bands reproduce closeword's banding at full lexicon size", () => {
  const tier = (rank: number) => tierForRank(rank, REFERENCE_VOCAB).key;
  assertEquals(tier(1), "found");
  // Ranks taken from a real closeword board: 3 is unmistakably close, a few
  // hundred is "right area", and eight thousand carries no information.
  assertEquals(tier(3), "scorching");
  assertEquals(tier(380), "hot");
  assertEquals(tier(8204), "cold");
  // Monotonic: further away is never a warmer tier.
  const order = ["found", "scorching", "hot", "warm", "cool", "cold"];
  let last = 0;
  for (const rank of [1, 3, 99, 101, 599, 601, 2499, 2501, 7999, 8001, 40_000]) {
    const index = order.indexOf(tier(rank));
    assert(index >= last, `rank ${rank} went backwards to ${tier(rank)}`);
    last = index;
  }
});

Deno.test("tier bands still discriminate on a small pack", () => {
  // Without scaling, every guess in a 700-word pack looks warm. The floors stop
  // the bands collapsing onto rank 1.
  assertEquals(tierForRank(1, 697).key, "found");
  assertEquals(tierForRank(650, 697).key, "cold");
  assert(
    ["scorching", "hot"].includes(tierForRank(5, 697).key),
    "a near miss in a small pack should still read as close",
  );
});

// ---------------------------------------------------------------------------
// Reading a patch out of a model reply
// ---------------------------------------------------------------------------

Deno.test("a fenced json block is separated from the prose", () => {
  const { text, patch } = extractPatch(
    'Going dark for you.\n\n```json\n{"mode":"dark"}\n```',
  );
  assertEquals(text, "Going dark for you.");
  assertEquals(patch, { mode: "dark" });
});

Deno.test("the fence label may be json, closeword or absent", () => {
  for (const label of ["json", "closeword", "closeword-prefs", ""]) {
    const { patch } = extractPatch(`Done.\n\`\`\`${label}\n{"radius":20}\n\`\`\``);
    assertEquals(patch, { radius: 20 }, `label "${label}" was not parsed`);
  }
});

Deno.test("an unfenced trailing object is still found", () => {
  // Models drop the fence often enough that refusing would lose real changes.
  const { text, patch } = extractPatch('Warmer it is.\n{"accent":"#c2410c"}');
  assertEquals(text, "Warmer it is.");
  assertEquals(patch, { accent: "#c2410c" });
});

Deno.test("prose containing braces is not mistaken for a patch", () => {
  const raw = "Try guessing {something} broad, then narrow down.";
  const { text, patch } = extractPatch(raw);
  assertEquals(patch, null);
  assertEquals(text, raw);
});

Deno.test("a plain answer leaves the prose untouched", () => {
  const raw = "Probe a few unrelated domains, then push into whichever felt warm.";
  const { text, patch } = extractPatch(raw);
  assertEquals(patch, null);
  assertEquals(text, raw);
});

Deno.test("malformed or non-object json is ignored, keeping the reply usable", () => {
  for (const body of ["{not json}", "[1,2,3]", '"just a string"', ""]) {
    const { patch } = extractPatch(`Here you go.\n\`\`\`json\n${body}\n\`\`\``);
    assertEquals(patch, null, `parsed ${body}`);
  }
});

Deno.test("the assistant prompt advertises exactly the fields the schema allows", () => {
  const prompt = buildAssistPrompt({ text: "make it dark" }, DEFAULT_PREFS);
  // If a field exists but is never mentioned, the model cannot offer it; if one is
  // mentioned but not in the schema, the model will offer something we discard.
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (key === "backgroundImage") continue; // deliberately not offered — upload only
    assert(prompt.includes(`"${key}"`), `prompt never mentions ${key}`);
  }
  for (const preset of Object.keys(PRESETS)) {
    assert(prompt.includes(preset), `prompt never mentions the ${preset} preset`);
  }
  // It must not invite the one thing it cannot do.
  assert(
    prompt.includes("cannot set a background photograph"),
    "the prompt should rule out setting a photo",
  );
  assert(prompt.includes("do NOT know the secret word"), "the prompt must disclaim the answer");
});

Deno.test("the prompt carries the current look and recent turns", () => {
  const prompt = buildAssistPrompt(
    {
      text: "a bit warmer",
      history: [
        { role: "you", text: "make it dark" },
        { role: "bot", text: "Done." },
      ],
    },
    { ...DEFAULT_PREFS, mode: "dark" as const, radius: 22 },
  );
  // "a bit warmer than that" is meaningless without both of these.
  assert(prompt.includes("theme=dark"));
  assert(prompt.includes("radius=22"));
  assert(prompt.includes("Player: make it dark"));
  assert(prompt.includes("You: Done."));
  assert(prompt.trimEnd().endsWith("You:"), "the model should be cued to answer");
});

Deno.test("a patch from a reply still has to survive the schema", () => {
  // The end-to-end shape: whatever the model emits, only allowed fields land.
  const { patch } = extractPatch(
    'Done.\n```json\n{"mode":"dark","cssOverride":"body{display:none}",' +
      '"backgroundImage":"https://evil/x.png"}\n```',
  );
  const { prefs, applied, rejected } = sanitisePrefs(patch);
  assertEquals(applied, ["mode"]);
  assertEquals(prefs.backgroundImage, null);
  assert(rejected.includes("cssOverride"));
  assert(rejected.includes("backgroundImage"));
});
