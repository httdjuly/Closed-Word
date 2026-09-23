#!/usr/bin/env -S deno run --allow-read
/**
 * How much everyday English does the current pack actually cover?
 *
 * A guessing game lives or dies on this. If a player types an ordinary word and
 * gets "not in vocabulary", the game feels broken — and a raw corpus-frequency
 * prefix is exactly where that happens, because news and encyclopedia text is
 * full of function words and proper nouns but light on spoons and pencils.
 *
 *   deno run --allow-read scripts/coverage.ts
 *   deno run --allow-read scripts/coverage.ts --pack data/vectors.bin
 */

import { decodePack } from "../server/vectorpack.ts";

/**
 * A deliberately mundane probe list: the concrete nouns, clothes, food, animals,
 * furniture and feelings a player reaches for first. Nothing here is obscure, so
 * anything missing is a genuine gap rather than a hard word.
 */
export const EVERYDAY_PROBE = `
pencil eraser spoon fork knife plate bowl mug kettle towel pillow blanket mattress
curtain carpet ladder hammer screwdriver bucket broom sponge soap shampoo toothbrush
razor comb jacket sweater trousers socks shoes boots gloves scarf belt button pocket
apple banana orange grape carrot potato onion garlic tomato lettuce bread butter cheese
milk sugar salt pepper coffee tea juice water rice pasta chicken beef fish egg
dog cat horse cow sheep pig rabbit mouse bird snake spider ant bee
table chair sofa bed desk lamp mirror clock window door wall floor ceiling roof
car bus train bicycle boat plane truck taxi road bridge tunnel garage
rain snow wind cloud sun moon star sky sea river lake mountain forest beach
happy sad angry tired hungry thirsty scared excited bored calm
walk run jump swim sleep eat drink laugh cry sing dance read write listen
`.trim().split(/\s+/);

if (import.meta.main) {
  let packPath = "data/vectors.bin";
  const argv = Deno.args;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pack") packPath = argv[++i];
  }

  const pack = decodePack(await Deno.readFile(packPath));
  const vocab = new Set(pack.words);
  const missing = EVERYDAY_PROBE.filter((w) => !vocab.has(w));
  const pct = (100 * missing.length / EVERYDAY_PROBE.length).toFixed(1);

  console.log(`pack:    ${pack.words.length} words${pack.sample ? " (SAMPLE)" : ""}`);
  console.log(`probed:  ${EVERYDAY_PROBE.length} everyday words`);
  console.log(`missing: ${missing.length} (${pct}%)`);
  if (missing.length) console.log(`\n  ${missing.join(" ")}`);
}
