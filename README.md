# CloseWord Party

Two party games for a whole team, on one server and one room code.

**CloseWord Party** is a semantic word-guessing game. There is a secret word, you guess words, and
each guess is ranked by how _semantically_ close it is to the answer — rank 1 means you found it.
Like [closeword.org](https://closeword.org), except a room here holds up to **24 players**, there
are five ways to play together, and you choose where the secret words come from.

**[Cờ tỷ phú Việt Nam](#cờ-tỷ-phú-việt-nam)** is Monopoly, in Vietnamese, on a board of Vietnamese
streets and places — 2 to 8 players, the printed rules, and boards you can write yourself.

Pick one on the first screen. Single Deno process. No framework, no build step, no database.

---

## Start in 60 seconds

```bash
deno task ingest              # build the word pack (one download, a few minutes)
deno task start               # serve the game
```

That prints something like:

```
On this machine:  http://localhost:8791
On your network:  http://10.40.50.22:8791
```

Send the **network** address to your team on Slack. Everyone opens it, picks a game on the first
screen, one person clicks **Create room** (**Mở bàn** on the board game), and the rest type the
six-character code — or just open the `/r/CODE` link the host copies from the header, which knows
which game it belongs to.

That is the whole setup. Nothing to install on anyone else's machine.

> `deno task ingest` streams fastText vectors and stops as soon as it has 50,000 words, so it reads
> only a fraction of the 682 MB archive and writes a ~58 MB pack the server keeps in memory. In a
> hurry, `deno task ingest --sample` builds a 697-word synthetic pack instantly — fine for poking at
> the UI, but see [the rank scale](#the-rank-scale) for why it plays badly. The board game needs
> neither: nothing in [Cờ tỷ phú Việt Nam](#cờ-tỷ-phú-việt-nam) touches the pack or a model, and its
> four boards are always available — but the server still wants a pack to boot, so ingest comes
> first either way.

### If something goes wrong

| Symptom                                 | Fix                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `No embedding pack at data/vectors.bin` | Run `deno task ingest` first.                                                                                                  |
| Teammates can't reach the URL           | Allow Deno through Windows Firewall on the private network, or check you sent the `10.x`/`192.168.x` address, not `localhost`. |
| Port 8791 already in use                | `PORT=9000 deno task start`, or set `PORT` in `.env`.                                                                          |
| `Bad configuration in .env`             | It lists every problem it found. `.env.example` documents the accepted values.                                                 |
| "Open in another tab" banner            | Only one tab per person. Click **Play here instead** to move the session to this tab.                                          |
| A word source shows "unavailable"       | See [word sources](#choosing-the-words) below — it needs its list built first.                                                 |
| Ordinary words are "not in vocabulary"  | The pack is too small. `deno task coverage` measures it; rebuild with `deno task ingest`.                                      |
| `~/.claude` is getting large            | `deno task sessions:prune` — see [cleaning up transcripts](#cleaning-up-claude--p-transcripts).                                |
| Something misbehaved and you missed it  | `logs/closeword-<today>.log` — see [Logs](#logs). `CLOSEWORD_LOG_LEVEL=debug` for guess-level detail.                          |

---

## Two independent choices

Everything from here to [the rank scale](#the-rank-scale) is about the word game.
[Cờ tỷ phú Việt Nam](#cờ-tỷ-phú-việt-nam) has its own section, and its own setup screen — no modes,
no word sources, no rounds.

When you create a word room you pick **how you play together** and **where the words come from**.
They are independent: any of the five modes works with any of the four word sources.

### How you play together

| Mode                   | Boards           | What it is                                                                                                     |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| **Free-for-all race**  | one per player   | Everyone hunts the same word at once. First to rank 1 wins; the rest keep playing for placement. Single round. |
| **Round match**        | one per player   | Several races back to back. Points by finish order, cumulative leaderboard.                                    |
| **Teams**              | one per team     | Teammates share a board and see each other's guesses. First team to the word wins.                             |
| **Co-op vs the clock** | one for the room | Everyone on one board against a timer. No winner, just a shared score.                                         |
| **Solo practice**      | one, yours       | Just you. Starts itself, runs word after word, and the server turns away anybody who tries the code.           |

**Solo practice** is the same game with the social parts removed rather than a separate codebase:
one board, one player, and every rule downstream unchanged. What it does differently is worth
knowing:

- **It starts on create.** A lobby whose only purpose is to wait for yourself is not a lobby, so the
  server deals the first word as part of making the room. If the chosen word set has no playable
  words you land in the lobby with the reason, which is where that is fixable.
- **The door is shut on the server.** A second player is refused with an error, not merely left
  uninvited — six characters of room code is not a door. Switching a room that already has company
  into practice is refused too, because that would be an eviction dressed up as a setting.
- **It never ends on its own.** Practice runs to the round ceiling, so there is always another word;
  you stop by pressing Finish or by leaving.
- **Your record stays in your browser.** Fewest guesses to the word, plus how many you have found
  out of how many you have seen, kept per word set and difficulty in `localStorage` and never sent
  anywhere. There is no leaderboard to join and the server is given no way to store it.
- **What cannot apply is hidden**, not greyed: no invite button, no buzz, no share link, and no
  "when someone finds the word" rule, because with one board all three settings are the same rule.

Everything in the game is written against the idea of a **board** — a guess list with its own hints,
best rank and finish position. The modes differ only in how many boards exist and who is attached to
each, which is why they all share the same scoring, hint and reveal behaviour.

Team vs team is just **Teams** with the team count set: 2 teams for 2 v 2, up to 6. Sizes do not
have to match.

Everyone gets a team the moment they walk into a team room, so the line-up is visible while people
are still arriving rather than appearing at kick-off. The **Teams** panel sits at the top of the
room setup: tap your own name to switch sides, and the host can tap anybody to pass them to the next
team. **Shuffle** (host only) deals the whole room out again at random, and an uneven split says so.
Nothing can move once a round is running.

### Choosing the words

| Source                    | Where the secret words come from                                                                        | Needs                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **1. Custom words**       | Vocabulary harvested from a Confluence space of your choosing — your own product and team language.     | `data/words-custom.txt` (a seed list is included)       |
| **2. CloseWord words**    | Everyday English, the most common words in the corpus. Plays like closeword.org.                        | nothing — always available                              |
| **3. AI-generated words** | A themed pool written by `claude -p`. Regenerate any time with a different theme.                       | `data/words-ai.txt` (one is included)                   |
| **4. After dark (18+)**   | Anatomy, sex and euphemism — cheeky rather than nasty. Host-picked, and asked about before it switches. | `data/words-adult.txt` (built by `deno task tag:adult`) |

A word source only decides which words can be the **answer** — never how guesses are scored. Every
source ranks against the same 50,000-word lexicon, so a custom round and a CloseWord round are on an
identical 1–50,000 scale and guessing feels the same whichever you pick.

Words in a list that aren't in the embedding pack are dropped at load, because a secret the server
can't rank is unplayable. That is why a themed source looks tiny on the sample pack and grows a lot
after `deno task ingest` — the bundled custom list goes from 24 playable words to **1,916**,
harvested from 1,077 Confluence pages and then vetted by `claude -p`.

The lobby shows the live pool size for each source and disables any that have no playable words, so
you find out before starting rather than mid-round.

#### The after-dark set

Somebody asked for rude words, so there is a rude word set. It is the one pool where what is _left
out_ matters more than what is in, so it is built differently from the others:

```bash
deno task tag:adult              # print the pool it would build
deno task tag:adult --write      # write data/words-adult.txt
deno task tag:adult --candidates # print neighbours from the lexicon, for review
```

The pool comes from a hand-written **tag list** inside `scripts/tag_words.ts`, grouped by category
(anatomy, sex, euphemism, romance, nightlife) and then filtered to words the embedding pack can
actually rank — 113 of them at the moment. Nothing is generated into the pool. `--candidates` walks
the lexicon for near neighbours and _prints_ them for a person to cherry-pick, because automatic
expansion in this category reliably turns up slurs and degrading terms — that is what sits next to
sex words in a web corpus, and no similarity threshold can tell a slur from a synonym. A test
asserts the shipped pool stays clear of that list, as a guard against a careless edit.

The rule the list follows: anatomy, sex, euphemism and flirtation. Nothing that insults a person, no
slurs, nothing about anyone who cannot consent, nothing violent. Cheeky, not nasty.

**There is no server-side switch, deliberately.** A deployment-wide ban would only move the rude
round to a server nobody is watching, while the person who knows whether a room wants it is the host
standing in it. So the gate is a question: picking it asks first, in the room it warns that
everybody present will be playing it, and the room panel shows **18+** as the word set for as long
as it is in play. Nobody can be dropped into it without seeing that.

#### Rebuilding the custom list

Put your Confluence credentials in `.env` (see `.env.example`), then harvest the space:

```bash
deno task ingest:custom                                  # the whole space
deno task ingest:custom --space ENG --limit 400           # somewhere else, capped
deno task ingest:custom --report data/custom-report.tsv   # inspect the corpus

# optional final pass with claude -p
deno task curate --in data/words-custom.raw.txt --out data/words-custom.txt --profile custom
```

Only word _counts_ leave Confluence; no page text is written anywhere.

The ingest writes two files: `words-custom.txt`, which the game reads, and `words-custom.raw.txt`,
the same list before curation. Two files because curating in place narrows a pool a little more on
every run — a word rejected once is gone, and the next pass judges only the survivors — so the
curation always reads the raw harvest.

Raw frequency alone produces a bad pool. Three things had to be fixed after looking at what 1,077
Confluence pages actually contain:

- **Rank by document frequency, not occurrences.** A word stamped 400 times into one release-notes
  table beat words the whole team uses. Counting each word once per page asks the question we mean —
  "is this shared vocabulary" — rather than "how repetitive is one page".
- **Drop function words and markup residue.** The first real harvest led with `with`, `this`, `will`
  and `https`. They are in the lexicon, but nothing is meaningfully _close to_ the word `this`, so
  they are dead ends as secrets. See `STOPWORDS` in the ingest script.
- **Fold plurals into singulars.** 627 pairs came back — `user` and `users`, `priority` and
  `priorities`. Guessing `user` against the secret `users` scores rank 1, which is a scoreboard
  accident rather than a deduction, and the pair is one puzzle counted twice. A plural is only
  folded when its singular is in the same corpus, which is what keeps `status`, `access` and
  `business` intact.

The `--profile custom` curation pass then vets what is left. It uses the **opposite** instinct to
the default rubric on jargon: work vocabulary is what this source is _for_, so `firmware` and
`license` stay and it strips participles, internal codenames and words too generic to picture
(`item`, `type`, `detail`).

#### Words the corpus has never heard of

Somebody guessed `rma` in a custom room and was told it is not in the word list. The obvious fix —
add it to the custom list — would not have worked, and the distinction is worth internalising
because every future report of this shape has the same answer:

- a **pool** (`data/words-*.txt`) decides what the **secret** can be;
- the **pack** (`data/vectors.bin`) decides what a **guess** can be.

Guesses are ranked against the pack's 50,000 rows, and they have to be: ranking a guess means taking
its vector, and a word with no vector has no rank. The pack came from fastText wiki-news, so it
knows `firmware`, `kiosk` and `endpoint` but has never seen `rma`, `sso`, `edr` or `metadefender`.
Re-ingesting will not help either — no general corpus contains our acronyms often enough to survive
a 50k frequency cut.

So `data/terms-custom.txt` lists domain terms next to the everyday words that explain them, and the
vector for each is the average of those:

```bash
deno task pack:terms            # review: what would be added, and what it lands next to
deno task pack:terms --write     # append to data/vectors.bin and the custom pool
```

The dry run is the review, and it is the whole point of the two-step: it prints each term's nearest
existing words, so `rma → repair 0.73  warranty 0.71  return 0.70` tells you the expansion is right
before anything is written. Rows are only ever appended, never rewritten, so a term the pack already
knows keeps its learned vector — `apt` stays the package manager rather than being redefined — and
running it twice does nothing. New rows land at the end of the frequency order, which is what
`difficulty` slices, so a composed acronym can never turn up as an easy secret.

The result is a composed vector, not a learned one. It is right about the neighbourhood, which is
all a semantic guessing game reads. One artefact comes with that and is documented in the script
rather than left to be re-discovered: averages are blander than their parts, so all of these terms
drift toward the same middle-of-the-corporate-vocabulary point, which is why `sla` and `oauth` come
out as near neighbours of `rma`. It only shows when a composed term is itself the secret, and those
sit in the tail.

Digits are legal in a guess for the same reason — `2fa` and `k8s` are words people type.

#### Regenerating the AI list

```bash
deno task words:ai                                   # general knowledge
deno task words:ai --theme "cybersecurity" --count 300
deno task words:ai --theme "food and cooking" --append
```

---

## Playing

- **You never see another board's guesses.** Snapshots are redacted per-recipient on the server, so
  nobody can read them out of devtools. What everyone _does_ see is each other's best rank and guess
  count — that tension is the point.
- **Hints** reveal a nearby word, each closing about half the remaining gap. In a themed game the
  hint is drawn from the same themed pool where possible, so a custom round hints with custom
  vocabulary. Hints belong to a **board**: in teams and co-op, clicking spends the shared allowance,
  and the UI says so before you click.
- **Late joins and reconnects work.** Refresh, shut your laptop, change Wi-Fi — you return to your
  board and score. Players are keyed by a stable id in `localStorage`, not by connection. One tab
  per person, though: a second tab displaces the first, which says so rather than fighting over the
  session.
- The host controls settings, round advancement, teams and kicks, and can hand over hosting. If the
  host disconnects, hosting passes on automatically.
- A **hint is never counted as a guess**, anywhere. Hints land on the board as rows because that is
  where they are useful, but the guess counts in the standings, the stage, the feed and the journey
  all leave them out, and score them out too.
- Press `/` to jump to the guess box, `Esc` to close whatever is open — emoji palette, release
  notes, invite picker, journey drawer, in that order.

### What a word is

Two things sit beside every word on your board, and they exist because the room this was built for
is half Vietnamese speakers: a rank tells you `warranty` was close, which is not much use if you do
not know how to say it or what it means.

**An emoji, picked by meaning.** Not a lookup table — the emoji carry anchor words and a word gets
whichever anchor it is nearest to in the same embedding space the game ranks with, so `fireplace`
gets 🔥 without anybody having listed `fireplace`. About a quarter of words get one. That is the
intended hit rate: cosine similarity in this space starts around 0.26 for two entirely unrelated
words, so a low threshold labels everything and labels most of it wrongly, and a wrong icon is a
false claim about meaning in a game about meaning. Below the line a word gets nothing, which is
honest. See `server/wordicon.ts` — it also records the two traps the calibration turned up, because
they are not obvious: antonyms are near-synonyms in this space (`slow` matched "quick"), and any
anchor with a second meaning poisons itself (`boot` matched "camp", `key` matched "critical").

**A panel, on tap.** Click any word and the browser says it out loud, then shows the IPA, the part
of speech, a one-line English meaning and the Vietnamese. The two halves have very different
dependencies and it is worth knowing which is which:

- **Saying it** is `speechSynthesis` in your own browser. No server, no network, no model — it works
  offline and on a server with nothing installed.
- **The dictionary** asks the server, which asks `claude -p` once per word and remembers the answer
  for everybody. With no `claude` on the machine the panel says so plainly and the speaker still
  works. Lookups are rate limited per person and the cache is capped and in memory.

You can look up any word, not only ones on your board — a definition is a fact about English and
cannot narrow the secret, and checking what a word means _before_ spending a guess on it is the
point.

### Finding a game

The landing page shows what is open on this server — how many browsers are connected, how many
people are sitting in a room, and one row per room with its code, mode, word set, player count and
what it is doing right now ("waiting to start", "round 2 of 5"). **Join** walks you straight in.

Three deliberate limits on that list:

- **Solo practice rooms are never listed.** They refuse a second player, and a door that advertises
  itself and then turns you away is worse than one you were never shown.
- **No room says who is in it.** A headcount answers "is anything happening here?", which is the
  question being asked. A guest list would tell the whole network who is playing with whom, which
  nobody opted into by joining a room. Names are only exchanged through the invite picker, where the
  person chose to be visible by having the app open.
- **It is a poll, not a push.** The browser asks every eight seconds while you sit on the landing
  page and stops the moment you are in a room, so a live game never carries the cost of a list
  nobody is looking at.

This does mean **room codes are discoverable by anyone who can reach the server**, which is the
right trade for something built for one team on one network and the wrong one for the public
internet. If you put this somewhere open, see [Scaling beyond a LAN](#scaling-beyond-a-lan) — the
same reasoning applies, and the fix is the same: put it behind whatever already knows who your
people are.

### House rules

Two lobby settings decide the shape of a round, and both apply to any mode with more than one board
(so co-op ignores the first).

**When someone finds the word:**

| Rule                        | What happens                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Sudden death**            | The first board to find it ends the round for everyone else, right there.                                       |
| **Grace clock** _(default)_ | The first finisher starts a countdown — 90 seconds by default. Everyone else races it for the remaining places. |
| **Everyone finishes**       | The round runs until every board has found the word. Nobody is cut off.                                         |

"Everyone finishes" is the one that can hang, which is exactly why the host controls exist: **End
round** scores it and moves on, **Stop match** scores it and calls the whole match, and **Reset
room** clears every score and history and drops back to a fresh lobby. Reset asks first — it is the
only destructive control in the app.

**Guess budget per board** (0 = unlimited) gives each board a fixed number of guesses per round.
Spend them and that board is out; when every board is out or solved, the round ends. **Hints do not
count against it**, so a stuck board can still buy its way closer — which is the trade the budget is
there to create.

### Seeing someone's journey

Click any name — in the standings, the players list or the room feed — for their **journey**: every
guess they made, in the order they made it, with rank, tier colour and how long into the round it
landed. Hints show up marked as hints and are counted separately from guesses.

The privacy rule is the same one the boards follow, and it is enforced on the server, not in the
browser: **while a round is running you only see boards you are on** — your own, or your team's in
teams and co-op. Everyone else's round shows its public numbers (guess count, best rank) with the
words withheld. Once the round ends, the whole room's journey opens up for the post-mortem.

Two ways past that during a live round:

- **Find the word** and your own journey opens to the room immediately. You have nothing left to
  protect, and watching how the winner got there is the best part.
- **Ask.** Anyone else's live round shows an **Ask _name_ to watch** button. They get _"«you» wants
  to view your plays"_ with **Approve** or **Reject**, and either way you are told. Consent covers
  the round in progress only — it is dropped when the round ends, so agreeing once does not sign
  away the match. A refusal is not recorded either, so you can ask again next round.

Either way the drawer shows **two panes side by side**: their run on the left, yours on the right. A
path to a word only means something next to another one.

A journey is fetched on demand rather than shipped in every snapshot: a 24-player, 20-round match
holds thousands of guesses and almost nobody is looking at almost all of them. Your own board is
patched straight from the snapshot the browser already has; somebody else's is re-asked only when
their public guess count runs ahead of the rows on screen — one request per guess they make, and
none once they stop.

### Round-table extras

Small things, all of them optional or ignorable, all of them in memory only:

| Thing             | What it does                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Emoji**         | A palette beside the chat box, with your recents remembered in this browser. Pasting emoji from anywhere works too — composed ones (families, skin tones, flags) survive the trip intact.                                |
| **⚡ Buzz**       | Greys the room out behind a screen-filling **BUZZ!**, shakes the window and beeps — on every browser in the room, the buzzer's included. One per player every ten seconds, and disabled when you are alone.              |
| **Extra hint 🍻** | Appears when your free hints are gone. It asks first — clicking means you owe the room a drink — then says so in the feed on your behalf. The tally rides on your name all match.                                        |
| **🌹 🥚 🚨 🚧**   | Throw a rose, an egg, an escalation or a blocker at anyone in the players list, as often as you like. Every screen in the room animates the throw; keep going and it escalates. Hover a tally to see who threw how many. |
| **@ mentions**    | Type `@` in the chat box and pick a name, or `@all` for the room. They get a toast, a chime, a marked line in the feed, and a blinking tab title if they have switched away.                                             |
| **+ Invite**      | Anyone with the app open — landing page or another room — can be invited, from the create screen or the **+** in the room. They get Join or Ignore.                                                                      |
| **What's new**    | Release notes, with a dot on the button until you have read them.                                                                                                                                                        |

**Throwing things** is deliberately unlimited — a cap turns a joke into a rationing decision — so it
is shaped instead of counted. Four kinds: two pantomime (🌹 🥚) and two borrowed from the board your
team already argues on (🚨 escalate, 🚧 blocker), each with its own impact mark and its own noise —
an escalation flares red and wails, a blocker drops hazard tape and thuds. The work pair arrives in
smaller volleys on purpose: one road sign lands harder than twenty. Every throw flies on _every_
screen: at the row in the players panel if you are watching, and from all four edges of the window
at once if you are the one being pelted, with impact marks, a jolt and a streak stamp. It escalates
with two numbers the server sends alongside the throw: how many that person has thrown at you, and
how many you have taken from the room. The rate limit is `REACTIONS_PER_WINDOW` throws every
`REACTION_WINDOW_MS` — enough for a barrage, not enough to hold the room's frame rate hostage — and
one sender's tally stops climbing at `REACTION_MAX_PER_SENDER`. The feed stays quiet about it after
the first one, then speaks up every fifth, so a pile-on reads as one story rather than forty lines.

The whole show is skipped outright for anyone who has turned motion off, in the app or in their OS,
and in a background tab — where the animation would be throttled into the wrong order anyway.

**Extra hints** are a house rule the host can switch off in the room setup.

Nothing here is persisted. Reactions, drinks and journey consent live in the room object in memory
and are cleared on round end, reset, leave, or when the room closes. Invite nicknames are held in
the WebSocket session for as long as the tab is open and are never written to disk. Emoji recents,
your name and your look are `localStorage` on your machine only, never shared with the room.

### Your own workspace, and the assistant

The **✦ button** in the bottom-right corner opens a private panel with two tabs (or press
`Shift`+`A`):

- **Chat** talks to `claude -p`. Ask it about tactics, or just describe how you want the place to
  look — _"make it dark and calm"_, _"warmer, bigger corners"_, _"one column, no distractions"_ —
  and it restyles your workspace as it replies, with an **Undo** next to what it changed.
- **Look** is the same controls by hand: five presets, accent colour, six built-in backgrounds, your
  own uploaded photo, three layouts, spacing, typeface, corner rounding, frosted glass and
  animation.

**Everything there is yours alone.** Preferences and the conversation live in your browser's
`localStorage`. They are never stored on the server, never broadcast to the room, and never visible
to another player — ten people can be looking at ten different workspaces in the same game. Clearing
your browser data resets them.

The Look tab works with no `claude` binary; only the chat needs one, and `CLOSEWORD_ASSISTANT=false`
turns chat off on its own if you want clues without it. Backgrounds are pure CSS or inline data, so
a workspace never makes a network request to paint itself, and an uploaded photo is downscaled and
kept on your machine.

Appearance can arrive from a language model, so `shared/prefs.js` is the sole authority on what may
change: enums, clamped numbers, hex colours and raster data URIs, nothing else. The model proposes,
that schema decides. Remote image URLs are refused outright — accepted, they would turn a cosmetic
preference into a request to someone else's server on every repaint. Both the server and the browser
run the check, and `tests/prefs_test.ts` pins down what gets refused.

### Optional AI clues

Turn on **AI prose clues** in the lobby and each hint also gets a sentence of context from
`claude -p`, framed for the word source in play. The request is fire-and-forget so a slow model can
never hold up a guess, and any clue that leaks the answer is rejected rather than shown. With no
`claude` on `PATH` the setting is simply disabled and everything else works.

There is also `deno task curate`, which uses `claude -p` to vet a pool for words that make poor
puzzle targets — the CloseWord pool by default, or any list with `--in`.

All three of these leave transcripts on disk. `deno task sessions:prune` clears them out; see
[cleaning up transcripts](#cleaning-up-claude--p-transcripts).

---

## Cờ tỷ phú Việt Nam

The second game on this server, and a different game rather than a word mode wearing a hat: real
Monopoly, in Vietnamese, on a board of Vietnamese streets and places. Same room codes, same lobby,
same chat and feed — its own rules, its own protocol messages and its own board view.

The first screen of the app is now a chooser. Pick **CloseWord Party** or **Cờ tỷ phú Việt Nam** and
you land on that game's own setup page; the choice is remembered in your browser, so it is the first
screen once rather than every time. Following an invite link skips it entirely — the room says which
game it is, and you get the right setup page with the code already filled in.

Everything on the board game's screens is in Vietnamese, and every label carries an icon. A board is
read at a glance, so the icon is the part that carries at speed and the words are there to settle
what it meant.

### The pictures on the squares

Every one of the 40 squares is illustrated, on the board and again as a postcard across the top of
the deed card you get by clicking it. Not photographs and not likenesses — a hand-drawn _motif_ that
says what kind of place this is: karst peaks over water, terraced fields, a container port, a
lantern street, a tea hillside, a head-on locomotive. Twenty-two recognisable drawings of specific
streets is not a thing anybody can hand-draw, and it is not what a player reads off a square anyway.

They are inline SVG in `shared/monopoly_art.js` — 40 scenes, each a handful of flat shapes on a
`0 0 100 60` canvas, drawn `slice` so the same drawing fills a square cell and a wide card without a
second version of it. No image files, no CDN, nothing fetched: the rule that nothing on a page comes
from off the machine applies to the artwork too, which is exactly why it is drawn in code.

On the board the picture sits behind the name, turned down to about a third so the words stay first,
and lifts on hover and on the square you have selected. On the deed card it is at full strength,
because there it _is_ the point.

The dice are drawn too, and thrown. ⚀–⚅ exist as characters, but at the size a die is actually shown
they are a hairline outline with pips too small to count, so the faces are SVG like everything else
on the board. Pressing **🎲 Tung xúc xắc** tumbles both dice through random faces for about six
tenths of a second and then lands them on what was rolled — the total is held back until they stop,
because a number changing while the dice spin reads as noise. Everyone at the table sees the same
throw, not just the player who made it: the snapshot carries a count of throws so far, which is what
tells a browser that a fresh roll happened even when it lands on the same faces as the last one.
Turning motion off — in the OS or in this app — gives you the result with no tumble at all.

The hole in the middle of the board has a picture of its own: the board's emblem, drawn large behind
the card, the auction and whatever deed you last clicked. Việt Nam gets a map of the country —
outline plotted from real longitude and latitude rather than drawn from memory, with the flag as a
corner badge and Hoàng Sa and Trường Sa where they belong. The city boards get their own landmark. A
board that names no emblem gets the picture from its dearest square, which is usually the landmark
its author would have chosen anyway.

### The boards that ship

| Board                  | The 40 squares are                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 🇻🇳 **Việt Nam**        | the 34 provinces and cities of the 1 July 2025 reorganisation, cheapest first: Lai Châu, Điện Biên, Cao Bằng … Hà Nội, TP. Hồ Chí Minh |
| 🏛️ **Hà Nội**          | streets, from Đường Cổ Linh and Đường Tam Trinh out on the ring road in to Phố Tràng Tiền and Phố Ngô Quyền                            |
| 🌆 **TP. Hồ Chí Minh** | streets, from Đường Nguyễn Văn Linh in to Đường Nguyễn Huệ and Đường Đồng Khởi                                                         |
| 🌉 **Đà Nẵng**         | streets, from Đường Trường Chinh in to Đường Bạch Đằng and Đường Trần Hưng Đạo                                                         |

Four airports, stations and ports; two utilities (Điện lực ⚡ and nước sạch 💧); Cơ hội 🎲 and Khí
vận 🧧 decks of sixteen cards each; income and luxury tax; Nhà tù 🚔; Bãi đỗ xe miễn phí 🅿️.

### The rules it plays

The printed ones. Two dice, doubles roll again, three doubles in a row goes to jail. Salary for
passing Xuất phát. An unowned square is bought at the list price or goes to auction. Rent doubles on
a complete colour group; houses must be built evenly and four of them become a hotel. Mortgage for
half the price, unmortgage for that plus 10%; a mortgaged square collects no rent. Jail is paid,
carded, or rolled out of, and after three turns the fine stops being optional. Trade freely, but
buildings must be sold before a deed can change hands. Run out of ways to pay and you are bankrupt —
your deeds go to whoever you owed, or back on the market if you owed the bank. Last player standing
wins.

Money keeps Monopoly's own numbers with a **K** (nghìn) suffix — 60K to 400K, 1.500K to start. The
60:400:1500 ratios are what eighty years of play balanced, and redenominating them to millions would
have thrown that away for a cosmetic gain.

Three house rules the host can switch on or off in the lobby:

| Rule                                    | Default | What it does                                                    |
| --------------------------------------- | ------- | --------------------------------------------------------------- |
| 🔨 Đấu giá khi có người bỏ qua          | on      | A refused square goes to auction, as the box says               |
| 🅿️ Tiền phạt dồn vào giữa bàn           | off     | Fines and taxes pile up under Bãi đỗ xe for whoever lands there |
| 🏁 Dừng đúng ô Xuất phát nhận đôi lương | off     | Landing exactly on Xuất phát pays double                        |

### Building happens where you are standing

One rule is deliberately not the printed one. Under the box rules you may only build on a street if
you hold every street of its colour, which in a four-player game where nobody completes a group
means nobody ever builds and the whole second half of Monopoly never happens.

So there is a second way in, and it is the square itself. **Every time you land on a street you own,
the board asks: build another storey, or leave it?** Answer and the turn carries on; walk off and
that street is unbuildable again until the next time you come home to it. Holding the whole colour
group still works the way the box says — build any time, from the estate panel — so the printed rule
is a shortcut past the asking rather than the only road.

Even build applies either way, across the squares of that colour you actually hold: word for word
the printed rule when you hold all of them, and the only reading that means anything when you hold
two of three. And while you are standing there you may put up as many storeys as you can pay for —
the board keeps asking until even build or your cash says no.

The point of tying it to the square is that it puts the decision at the moment everybody is already
looking at it. An earlier version counted visits instead and let you build from anywhere once the
count was up, which worked and was completely invisible: a progress bar in a panel, and a house that
appeared on a street nobody was standing on.

### Khí vận is a lucky draw

The two card squares are no longer the same square twice.

**Cơ hội** is the printed deck: shuffled once, stepped through in order, every card turning up
exactly once a lap. It is the deck off the box and it plays like it.

**Khí vận** is a gacha. A rarity is rolled first — ⚪ Thường, 🔵 Hiếm, 🟣 Cực hiếm, 🌟 Truyền thuyết
— and then a card inside it, so the same card can come twice and the good ones stay rare. Weighting
the tier rather than the card is what keeps the odds steady while the deck changes: adding a
legendary changes _which_ legendary you get, not how often you get one. The draw spins on screen and
settles on the tier's colour, with a run of notes that gets longer the rarer it is.

The bottom tier is small change, the way the printed deck is. The top two tiers touch property:

| Card                     | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| 🧨 Giải toả mặt bằng     | You must knock one of your own buildings down, half price back  |
| 🎁 Nghĩa tình khu phố    | Your cheapest deed goes to whoever at the table is worth least  |
| 🔄 Đổi nhà cho vui       | Your cheapest deed swaps with the richest player's cheapest     |
| 🎰 Vét hũ                | The whole pot under Bãi đỗ xe, or 150 if that house rule is off |
| 🚕 Bác xe ôm             | Three more squares, on foot, salary collected if you pass       |
| 🏗️ Trúng thưởng xây dựng | One building, free, on your cheapest street                     |
| 🛡️ Có người bảo kê       | The next rent you owe is waived                                 |
| 💎 Lô độc đắc            | 500                                                             |

The cards that move property choose the square themselves — the cheapest deed, the tallest building
— rather than opening a picker. A card that stopped the table while somebody read their own deeds
would be a card nobody wants to draw. Built and mortgaged deeds are never the ones that move, since
unwinding a loan or a colour group as a side effect of a card is not funny twice.

A board seats **2 to 8**. Arriving after it has been dealt gets you a chair rather than a closed
door: you watch the whole game, you can talk, and one button asks the table to deal again — which,
if everyone agrees, seats you in the next one.

Long games have an exit: the host's **⏹️ Kết thúc trận** awards it on net worth, so a room that has
to stop still gets a result instead of an abandoned board.

### Watching, and starting over

**🔁 Đề nghị chơi lại từ đầu** is open to anybody at the table and to anybody watching it. It is a
vote, not a host button: an hour of four people's afternoon is on that board and the host is not the
only one who put it there. Every seated player still in the room has to agree; one **Chơi tiếp**
sinks it and the game carries on. When it carries, the new board seats everyone in the room,
watchers included — which is the entire point of the button for the person who asked.

### Nobody waits for anybody

A board game with four people on it moves at the speed of whoever is slowest to notice it is their
turn, and the person who went to answer the door stops the whole table. Two things fix that.

**Turns end themselves when there is nothing left in them.** Most turns are: roll, pay the rent,
done. Stopping there to make somebody press _kết thúc lượt_ is a click that carries no information
and which three other people are waiting on, so the board only pauses at the end of a turn when
there is something to pause for — a building they can afford, a deed to redeem, an offer on the
table.

**🤖 Tự động chơi hộ tôi** hands your turns to the machine. Tick it before you get up, and the board
plays for you: it rolls, it buys while a rainy-day fund survives the price, it takes the cheaper
tax, it sells houses and mortgages deeds to cover a debt, and it folds out of an auction rather than
bidding. Offered a building on the street it is standing on it says later — spending an absent
player's money on a judgement call is exactly what this is not for — unless they hold the whole
colour group, where a house is simply the right move. Deliberately dull — the point is to keep the
table moving, not to play well with somebody else's money. Making any move of your own switches it
back off, because that is the only reliable sign that somebody came back to their keyboard.

An auction is the one thing the board waits on everybody for at once, and for a while it was the one
wait nothing could answer: a single player who had gone to answer the door stopped the table dead at
the first refused square, because the hammer cannot fall until every bidder has raised or walked
away. The same clock covers it now, one bidder at a time, and a new highest bid restarts it for
everybody — the question in an auction is "will you go higher than this", so a new high bid is a new
question and deserves the full twenty seconds.

If you have not ticked it and stop answering, the board ticks it for you: **twenty seconds** on a
decision only you can make, **twelve** on the tail of a turn where the only thing left is to say
done. The countdown is on screen the whole time, and **⏸ Tôi vẫn ở đây** puts it back to the top —
so does building or mortgaging anything, since a player who is busy managing their streets is
thinking rather than gone.

### The rulebook, at the table

**📖 Luật** sits in the top bar of every board, lobby included, and opens the rules in full over the
board: a dozen sections from what a turn is to what happens when you cannot pay, written out rather
than summarised. It is the same rules the setup page lists in eleven lines, except this version
answers the questions that actually arrive mid-game — what a second house pays, what unmortgaging
costs, whether you may build while you are in jail (you may).

The numbers in it come from the table you are sitting at, not from the printed defaults, so a board
that sets its own salary or its own bail reads correctly instead of confidently telling somebody the
wrong figure. The house rules are read the same way: switch **Dừng đúng ô Xuất phát nhận đôi lương**
on in the lobby and the Xuất phát section says so, with the doubled figure spelt out.

Beside the rules it shows **Bàn này** — starting cash, salary, bail and which house rules are on —
and **Trên màn hình**, which is where things are rather than what may happen: click a square for its
deed, the dice and your cash are in the bar above the board, what you have to do next is always
directly under it. Somebody who joined by a link never saw the setup page, and this is the only
place that tells them what the host switched on.

The same **Bàn này** and **Trên màn hình** lists also sit folded in the board's side column under
**📖 Luật chơi — hướng dẫn**, whose closed summary line carries this table's terms — the question
that gets asked most is what are we playing for, and it is answered without opening anything.

### Reading the board

Five things a running game has to be able to answer without being read.

**Whose turn is it.** A strip across the top of the board in the colour of whoever is up. When that
is you it says **LƯỢT CỦA BẠN** in the largest type on the page, glows, and chimes twice — the only
two-note sound the board makes, because it is the only one you need to hear from the kitchen. When
it is not, it says whose it is and how many turns until yours. Under it, the queue in turn order.

**Which colour is which person.** One hue per seat, dealt with the seat, and every single thing that
draws a person reads that one number: the piece on the square, the pawn in the 3D scene, their name
in the feed, their row in the table, the ribbon on a street they own. It used to be hashed from the
player id, which collides — three people in a room came out as two greens and a red. The order is
chosen so the _early_ seats are furthest apart, because three players is the common case and red,
blue, green is unmistakable where red, orange, yellow is not.

**Which square am I on.** Unanswerable from a coloured disc on a grid of forty, so the board says it
in words above itself: your square, its colour group, who owns it and what it costs to land there —
and the square whoever is moving is on, beside it. Both are buttons that open the deed. On the board
itself your square gets a ring, a lift and a 📍, and the piece of whoever is up breathes.

**What do I own, and can I build on it.** **🏘️ Tài sản của tôi** sits in the left rail directly
under the table rather than below the board, because a panel you have to scroll past a board to
reach is a panel nobody uses. Deeds are grouped by colour with the group's own colour down the side
and how much of it you hold — `2/3` — so the thing that decides whether you can build is the first
thing you see. Each street shows what it collects, what is built on it, and either 🔓 or its visit
count towards the two that unlock it.

An **auction** sits directly under those buttons rather than in the hole in the middle of the board:
the lot, the standing bid, the box you type into and the countdown, on one line. It is a decision on
a clock for everybody at the table at once, which makes it the last thing that should be somewhere
you have to go and look for — and on the 3D board the middle of the board is below the board
entirely.

**What just happened, versus what somebody said.** **Diễn biến** and **Trò chuyện** are two panels
now, each scrolling on its own. One list of both was unreadable at a board game's pace: a hundred
lines of dice and rent an hour, with a question somebody asked the table buried three screens up
inside a minute.

### Two boards

There are two of them, and the **🧊 3D / 🗺️ 2D** button in the strip above the board swaps them. The
choice is per browser and remembered: two people at the same table can be looking at the same game
two different ways, because it changes nothing about the game.

The **flat board** is the CSS grid: forty squares, every price legible at once, keyboard-reachable,
and the one a screen reader can walk. It is the whole game and always has been.

Its ring tracks are nearly twice the width of the tracks inside them, which is the proportion a real
board has and this one did not: eleven equal tracks put nine of them in the hole in the middle, so
four fifths of the picture was empty felt and every square was too small to read a street name on.
With nothing tapped, the middle now shows the square you are standing on rather than an instruction
to tap something. Below 900px the deed card comes out of the middle altogether and sits under the
board, and the ring takes almost the whole width — on a phone the middle of a 430px board is not a
place a deed card fits.

It moves, which it did not. Every snapshot rebuilds the grid, so a piece used to be simply somewhere
else than it was: the eleven squares it crossed never existed, and the one question a board has to
answer without being read — what just happened — was answerable only by reading. Its squares are
elements with rectangles, though, and that is enough to fly a piece between them. So a piece
**walks, one square at a time**, hopping, off the same numbers and timings the 3D board uses; a move
that is not a walk — sent to jail, a card that throws you across the board — arcs straight there
instead; the square it lands on flashes; and **money floats** off the square it happened on, `+200K`
in green over whoever passed Xuất phát and `−10K` in red over whoever just paid, held back until the
piece arrives so the number lands where the player does. Every position is measured off the board
itself on every frame, which is what keeps it right through a resize, a re-render or a scroll
mid-hop. Anybody who has turned motion off, in the app or in their machine, gets the arrangement
without the journey.

The **3D board** is the same forty squares extruded, and it exists for what a grid cannot do: depth,
a board you turn in your hands, buildings with height. On it:

- Your piece **walks** the same way, and the pawn carries a card with your name above it.
- The **dice are thrown into the middle**, big, and tumble to a stop. The result was decided by the
  server before they left the hand; the last fifth of the throw is a turn onto the face it rolled,
  because dice that land on the right number by accident are dice nobody can trust. The flat board
  gets the throw too — a pair the size of a fist over the middle.
- **Money floats** off the pawn rather than off the square, following it while it walks.
- **Houses grow** out of the square, one per mark, and the fifth is a hotel.
- **Owned squares** are the owner's colour on their sides and stand very slightly taller. Mortgaged
  ones keep the colour and lose the saturation.
- A **ring** sits under whoever's turn it is.
- **Drag to turn** the board, wheel to lean in. Tap a square for its deed, exactly as clicking one
  on the flat board does. Left alone the board sways very slightly — a sway rather than a rotation,
  because a board that turns and never comes back is a board whose street names are upside down by
  the end of the game.

The pieces carry **who** rather than **what**. A shared seat emoji tells you a scooter is on Tràng
Tiền; the piece is now that player's own colour with their name on a card above it — the same hue
the feed tints their messages with, so it is a colour you have already learnt. The flat board's
pieces grew into coloured discs for the same reason, with a ring around your own.

Both boards throw the dice where you can see them. On the flat board a pair the size of a fist
tumbles over the middle and lands with the total; the readout in the top bar stays where it is,
answering _what was rolled_ after the fact.

**When you get the flat board whatever you picked:** no WebGL on the machine, a 3D board that failed
to build (logged to the console, never a toast — a board game that says "your graphics card is
unsupported" instead of dealing cards has its priorities wrong), or a screen under 760px wide with
no choice stored, because the street names on a 3D board are too small to read on a phone. Turning
motion off does not switch boards; it stops the walking, the tumbling and the sway, and leaves the
pieces and the dice where they belong.

### three.js, committed

The 3D board is drawn with [three.js](https://threejs.org) **0.185.1**, and the two files it needs
are in the repository under `client/vendor/` — see the README there. Everything the browser loads
has to come off this machine: the room is a LAN with no way out, and a `<script src="https://…">`
would leave the board half drawn on the one evening the office wi-fi cannot reach the internet.

It is imported **lazily**, the first time somebody opens a 3D board — not on the landing page, never
in the word game, and never at all on a machine with no WebGL. Compressed on the way out and served
`immutable`, it is about **126KB** on the wire, once per browser.

Everything else on that board is still hand-drawn: the pictures are the same `sceneSvg` the flat
board inlines, painted into canvases, and the dice pips, the name cards and the floating amounts are
drawn with the fonts already on the machine.

### Loading your own board

The host can load a board in the lobby: a JSON file, or JSON pasted into the box. **⬇️ Tải mẫu bản
đồ** hands you the board currently selected as a starting point, which is a much better first step
than a blank file and a schema to read — rename the twenty-two places to your own streets and it is
still a valid board.

None of this is a step in setting a game up. Four boards ship, one of them is already selected, and
the loader sits folded away under **📂 Tự làm bản đồ riêng** for the evening somebody wants to name
the squares after their own streets. A board file may be up to **64KB** — the boards that ship are
about ten — and it is the one message a client sends that gets that much room, because everything
else it sends is a sentence.

A map file carries **names only**. Prices, rents and house costs come from a fixed ladder the board
owns, so a hand-written board is balanced without its author having to know anything about
Monopoly's numbers, and no map can quietly hand its author cheap hotels.

The compact form is 22 places, 4 transport squares, 2 utilities and 8 colour groups:

```json
{
  "schema": "closeword-monopoly-map/1",
  "id": "hoi-an",
  "name": "Hội An",
  "icon": "🏮",
  "region": "Phố cổ",
  "note": "Đường phố phố cổ Hội An",
  "groups": [
    { "name": "Ven sông", "icon": "🛶" },
    "… eight of these, cheapest group first"
  ],
  "places": [
    { "name": "Đường Lý Thái Tổ", "icon": "🛣️", "scene": "duongpho" },
    { "name": "Đường Cửa Đại", "icon": "🚧", "note": "shown on the deed card" },
    "… twenty-two of these, cheapest first"
  ],
  "transport": [{ "name": "Bến xe Hội An", "icon": "🚌" }, "… four"],
  "utilities": [{ "name": "Điện lực Hội An", "icon": "⚡" }, "… two"]
}
```

Order is the only thing you have to get right: **places go cheapest first**, and the eight groups
are sized 2, 3, 3, 3, 3, 3, 3, 2 in that order, exactly as on a real board.
`data/monopoly/hoi-an.json` is a complete worked example of one town's streets.

`scene` is optional and picks the square's picture by name — one of the 40 in
`shared/monopoly_art.js` (`nui`, `bien`, `phoco`, `denlong`, `cho`, `ruong`, `cang`, `chua`,
`cauvong`, `nhamay`, `caphe`, `che` and the rest). Leave it out and the square gets one from a
rotation, so a board with no `scene` anywhere still comes out illustrated rather than blank. A name
that does not exist is a **warning**, not an error: the board loads, that one square falls back to
the default drawing, and the notice tells you which name was wrong — one typo in twenty-two should
not cost you an evening's work.

A `scene` at the top level of the file, beside `name` and `icon`, is the emblem for the middle of
the board — `"bandovn"` is the map of the country, and any other scene name works too. Leave it out
and the middle shows the picture from the dearest square.

There is also an explicit form — a `spaces` array of all 40, each with its own `kind`, `price` and
`rent` — for a board that wants to move the tax squares or price its own deeds. The loader reports
_every_ problem it finds rather than the first one, because a hand-written board is usually wrong in
a handful of small ways at once.

Loading a board is host-only and lobby-only, it never touches the boards that ship, and it lives
only in that room: leaving the room takes it with you.

---
## The rank scale

Ranks are calibrated to match [closeword.org](https://closeword.org), because a rank only means
something relative to how many words it was ranked against:

- **The lexicon is 50,000 words** (`REFERENCE_VOCAB` in `shared/constants.js`). A hopeless guess
  comes back in the tens of thousands and every step toward the answer is a visible move.
- **Ranks above 30,000 display as `30000+`.** Nobody can act on the difference between 31,402 and
  44,187, and a big precise number reads as though it means something.
- **Colour bands** follow the same shape: the top hundred are unmistakably close, the low thousands
  mean "right area", and past a few thousand a guess carries no information. Bands scale down with
  the pack actually loaded, so a small pack does not paint everything warm.

All of this is per-lexicon, not per-mode — a custom round and a CloseWord round rank on exactly the
same 1–50,000 scale. The word source only decides which words can be the **answer**.

Lexicon size is also what makes ordinary words guessable. A smaller pack built from corpus frequency
quietly drops everyday nouns, because news and encyclopedia text is full of function words and
proper nouns but light on spoons and pencils:

```bash
$ deno run --allow-read scripts/coverage.ts
pack:    50000 words
probed:  141 everyday words
missing: 0 (0.0%)
```

At 10,000 words that same probe misses 20% — including `spoon`, `banana` and `pencil`. That is why
`deno task ingest` defaults to 50,000, and why the sample pack is only for looking at the UI.

## How the ranking works

For a secret word, the ranker does one matrix-vector product against the whole vocabulary, sorts it,
and keeps the result as a rank-per-word lookup table. That is ~300 ms once per round for a 50k × 300
table, and turns every later guess into a single array lookup — about 0.3 µs:

```
$ deno run --allow-read scripts/inspect.ts coffee --bench
pack: 50000 words, 300 dims, secret pool 45926

built 10 rank tables in 2937ms (293.7ms each)
100k rank lookups in 33ms

=== coffee
  closest: coffees, tea, espresso, cappuccino, cocoa, caffeine, latte, cup, cups, cuppa
  hints:   smelling(~200)  ->  coffeehouses(~60)  ->  lattes(~12)
```

That asymmetry is the whole design. The expensive sort happens once when a round starts; the
thousands of guesses that follow are free, which is what lets 24 people hammer the same room without
the server noticing.

`scripts/inspect.ts` is also how you judge whether a secret is fair before inflicting it on the
room:

```bash
deno run --allow-read scripts/inspect.ts blizzard --guess snow --guess laptop
```

Rows are unit-normalised at ingest, so cosine similarity is a plain dot product. Rank tables are
cached (48 by default, ~200 KB each at 50k words) because a room reuses its secret for a whole
round.
---

## Layout

```
.env.example               every setting, with the reasoning behind each default
shared/     constants.js   numbers both sides must agree on (plain JS, loaded by both)
            prefs.js       the appearance schema — the only thing that may restyle a page
            protocol.ts    the wire protocol
            monopoly.js    the board schema, the price ladder, the card decks, the map loader
            monopoly_maps.js  the four boards that ship
            monopoly_art.js   the 40 inline-SVG scenes the board is drawn with
server/     main.ts        HTTP + WebSocket entry point, static serving
            config.ts      operational settings from .env — never game rules
            log.ts         the rotating daily log: service/action/http/webhook
            room.ts        the game state machine — boards, rounds, scoring
            monopoly.ts    the Monopoly rules, and the only place they live
            registry.ts    room codes, lookup, reaping idle rooms
            ranker.ts      semantic ranking and the named word pools
            vectorpack.ts  the on-disk embedding format
            ai.ts          optional `claude -p` calls — clues and the assistant
client/     index.html     no build step; ES modules straight from disk
            app.js         identity, socket lifecycle, render dispatch
            views.js       screen builders and region updaters
            monopoly.js    the game chooser, the Vietnamese setup page, the flat board
            mono3d.js      the 3D board: tiles, walking pieces, thrown dice
            assistant.js   the floating chat + personalise panel
            theme.js       applies and stores the personal look (this browser only)
            dom.js         small DOM helpers
            vendor/        three.js, committed rather than fetched — see its README
scripts/    ingest_vectors.ts   build data/vectors.bin
            ingest_confluence.ts    harvest the custom pool from Confluence
            generate_words.ts   generate the AI pool with claude -p
            curate_words.ts     vet any word pool with claude -p
            coverage.ts         how much everyday English the pack covers
            inspect.ts          inspect a word's neighbourhood; benchmark
            prune_sessions.ts   delete `claude -p` transcripts, keep conversations
            simulate_players.ts drive a real server with a roomful of bots
data/       vectors.bin           the embedding pack (generated, gitignored)
            words-custom.txt      custom pool — order matters, most-shared first
            words-custom.raw.txt  the harvest before curation, so re-curating
                                  starts fresh instead of narrowing the pool again
            words-ai.txt          AI pool — order matters, most familiar first
            monopoly/hoi-an.json  a worked example of a hand-written board
```

The server is authoritative for everything. After any state change it pushes a full snapshot,
redacted per recipient. Snapshots are a few KB even for 24 players, so full-snapshot broadcast buys
freedom from desync bugs at negligible cost.

The one deliberate exception is the **journey view**, which is request/response: a long match holds
thousands of guesses that almost nobody is reading, so putting them in every snapshot would trade
the property that makes the snapshot design work. The same redaction rule applies either way — the
server decides what you may see, and withheld guesses never leave it.

**The client cannot use secure-context-only browser APIs.** Everyone plays over
`http://10.x.x.x:8791`, which is not a secure context, so `crypto.randomUUID`, `navigator.clipboard`
and friends are simply absent — `randomUUID` threw before the first render and left every teammate
staring at "Connecting…". `crypto.getRandomValues` and `localStorage` are fine. Check
`isSecureContext` before reaching for anything in that family, and test on the LAN address rather
than `localhost`, which _is_ a secure context and hides the whole class of bug.

**The word-list files are order-sensitive.** Difficulty picks from a prefix, so re-sorting one
alphabetically would turn "easy" into "words beginning with A".

---

## Development

### Running it

```bash
deno task start     # start the server
deno task dev       # same, restarting whenever a source file changes
```

Both run in the foreground and print the URLs to share. **Ctrl-C stops the server** — it records a
`shutting down` line in the log and closes every socket cleanly on the way out.

If it is already running somewhere you cannot reach — a detached shell, a closed terminal — find it
by port and stop it:

```bash
# PowerShell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8791 -State Listen).OwningProcess

# macOS / Linux
kill $(lsof -ti :8791)
```

The server holds nothing that needs saving: rooms live in memory and are meant to be ephemeral, so
stopping it mid-match costs only that match. Restart it after changing `.env`, rebuilding a word
list, or editing anything under `server/` — `deno task dev` does that last one for you.

### Deno version

Developed against **Deno 2.9.5**. Two things about 2.9 that this repository had to answer:

**`Deno.serve` no longer compresses responses by default.** 2.8 did it silently; 2.9 turned
`automaticCompression` off (denoland/deno#35486), which made every page load bigger the day the
upgrade landed and nothing said so. `server/main.ts` now asks for it explicitly, so the default
flipping again is not a silent regression a third time. It is worth real bytes: three.js goes out at
126KB instead of 366KB.

**`client/vendor/` is cached hard, everything else is not.** Our own client is served `no-cache`
because it is read off this machine's disk and changes whenever somebody edits it. A pinned
third-party library is the opposite — the bytes under a given name never change, and there are three
quarters of a megabyte of them — so it goes out `immutable` with a year on it. One function,
`cacheControlFor`, decides which is which.

Also worth knowing, and not adopted:

| 2.9 feature                                   | Verdict                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno test --changed`                         | Adopted as `deno task test:changed`, for the edit-run loop. The full `deno task test` is still what counts.                                                                                  |
| `deno test --shard`                           | 300 tests in about half a minute. Nothing to split.                                                                                                                                          |
| `Deno.test.each`, `t.assertSnapshot`          | Worth having for the next parameterised test, not worth rewriting passing ones for. Snapshots in particular would make the board views easier to pin down.                                   |
| `deno test --retry`                           | Deliberately not used. A test that passes on the second run is a bug with a workaround.                                                                                                      |
| `deno fmt --sort-named-imports`               | Skipped: it would touch every file in one commit for no behavioural gain. Imports here are hand-sorted anyway.                                                                               |
| `.editorconfig` inference                     | No `.editorconfig` in the repo, so `deno.json` remains the only thing deciding formatting. Worth keeping that way — two config files that both claim to set indentation is a bad afternoon.  |
| `deno bundle`, `deno desktop`, `deno compile` | Not wanted. The whole point of the client is that it is ES modules straight off the disk with no build step; `deno task build:prod` already covers the one deploy shape that needs anything. |

### A build with no Claude in it

`claude -p` powers three optional things: in-game prose clues, the per-player assistant, and the
word-lookup panel. On a host with no `claude` binary — most of them — all three are dead weight, and
a deploy target that forbids subprocesses will not run the code at all.

```bash
deno task prod                       # run from source, Claude integration never loaded
deno task build:prod                 # emit dist/ with the Claude files removed
deno task build:prod --with-pack     # ...including the 58 MB data/vectors.bin
```

The AI integration is split in two so this is a real exclusion rather than a feature flag:

| File                   | Ships in `dist/`? | What it is                                     |
| ---------------------- | ----------------- | ---------------------------------------------- |
| `server/ai_core.ts`    | yes               | prompts, validation, error types, the contract |
| `server/ai.ts`         | **no**            | the only module that spawns `claude -p`        |
| `server/ai_off.ts`     | yes               | the same contract, declining every call        |
| `server/ai_runtime.ts` | yes               | picks between the two at boot                  |

`server/ai_runtime.ts` imports `ai.ts` dynamically and falls back to `ai_off.ts` when it is simply
not there, which is what a production tree looks like from the inside. So the server boots, reports
`ai clues  off (not built in)`, and plays exactly as it does on a machine with no `claude` installed
— a path it has always had. Only a genuine "module not found" is swallowed; a broken `ai.ts` still
fails loudly rather than silently disabling the assistant.

Two things make the exclusion checkable rather than a promise. The emitted `deno.json` has **no
`--allow-run`**, so the runtime cannot spawn a process even if a future edit tries to. And the build
scans its own output for `new Deno.Command(`, `Deno.run(` and `child_process`, and refuses to finish
if it finds any — with comments and string bodies stripped first, so prose about subprocesses does
not trip it.

The offline word scripts that need the binary (`curate`, `words:ai`) are dropped from `dist/` too,
and the tasks that would call them are left out of the emitted `deno.json`.

### Running in a container

`Dockerfile` builds an image for anything that runs containers — Railway, Render, Fly.io, Cloud Run,
Kubernetes, a VPS with Docker on it. Not for Vercel: Vercel does not run Dockerfiles, and this
process holds a WebSocket per player and a 60 MB embedding table, neither of which survives a
serverless request model.

```bash
docker build -t closeword .
docker run --rm -p 8791:8791 closeword
```

The build stage runs `deno task build:prod` and the runtime stage is assembled from the `dist/` tree
it emits, so **the image cannot contain `server/ai.ts`** — the exclusion above applies by
construction, and it keeps its second guarantee too: the `start` task in the emitted `deno.json` has
no `--allow-run`, so the process could not spawn anything even if something tried.

**The embedding pack** is the one thing the build has to decide for you. It is generated data, so
`.dockerignore` keeps it out of the build context and `--build-arg PACK=` picks where the image's
copy comes from:

| `PACK=`  | What happens                                       | Use it for                            |
| -------- | -------------------------------------------------- | ------------------------------------- |
| `sample` | synthetic 64-d vectors, built in seconds (default) | a smoke test — the ranks mean nothing |
| `full`   | downloads fastText, builds the real 50k pack       | a self-contained production image     |
| `none`   | no pack; the container will not start without one  | keeping the pack on a volume          |

```bash
docker build --build-arg PACK=full -t closeword .

# or keep the pack out of the image entirely
docker build --build-arg PACK=none -t closeword .
docker run --rm -p 8791:8791 -v "$PWD/data/vectors.bin:/app/data/vectors.bin:ro" closeword
```

A mounted pack wins however the image was built. The pack file is self-describing and nothing reads
`data/pack.json` at run time, so a sample manifest left beside a real pack is stale documentation
rather than a problem.

Settings come from the environment — the image ships an empty `.env` only because the `start` task
names one:

```bash
docker run --rm -p 80:8791 -e CLOSEWORD_LOG_LEVEL=debug closeword
```

It listens on `PORT` (8791 by default), which is the variable hosts inject when they assign one.
Logs go to stdout only, it runs as the non-root `deno` user, and `HEALTHCHECK` polls `/healthz`.

### Every task

| Task                       | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `deno task start`          | Run the server                                                        |
| `deno task dev`            | Run it with auto-restart on source changes                            |
| `deno task prod`           | Run it with the Claude integration switched off                       |
| `deno task build:prod`     | Emit `dist/`, a tree with no Claude integration in it                 |
| `deno task test`           | 250 tests                                                             |
| `deno task check`          | Type-check the server and every script                                |
| `deno task sim`            | Drive a real server with a roomful of bots                            |
| `deno task ingest`         | Build `data/vectors.bin`, the embedding pack                          |
| `deno task ingest:custom`  | Harvest the custom word pool from Confluence                          |
| `deno task pack:terms`     | Teach the pack our acronyms (dry run unless you add `--write`)        |
| `deno task tag:adult`      | Rebuild the 18+ pool from its tag list                                |
| `deno task words:ai`       | Generate a themed word pool with `claude -p`                          |
| `deno task curate`         | Vet a word pool with `claude -p`                                      |
| `deno task coverage`       | Measure how much everyday English the pack covers                     |
| `deno task sessions:prune` | Clear out `claude -p` transcripts (dry run unless you add `--delete`) |

`deno task test` needs a pack — either one. Both are deterministic, so assertions about _relative_
ranks hold on each; no test may assume a particular word is **absent**, because the real pack
contains most things you would reach for as a non-word.

The simulation is the transport-level counterpart to the unit tests: it verifies that ten concurrent
clients get correct, redacted, timely snapshots, which tests on `Room` alone cannot prove.

```bash
deno task sim --mode teams --players 12
deno task sim --mode coop --source custom --rounds 3
deno task sim --url http://10.40.50.22:8791     # point at another machine
```

### Configuration

Settings live in `.env`. Copy the template and edit — every variable is optional, so an empty file
behaves exactly like no file at all:

```bash
cp .env.example .env
```

`.env.example` documents all of them with the reasoning behind each default; `.env` is gitignored,
so it is the right place for a Confluence token. A real environment variable beats the file, which
makes a one-off override just `PORT=9000 deno task start`.

Bad values are refused at boot rather than silently ignored, all of them at once:

```
Bad configuration in .env or the environment:
  - PORT=80O is not a number
  - CLOSEWORD_AI_CLUES=maybe must be one of auto, off
```

The ones worth knowing about:

| Variable                      | Default                   | Purpose                                                          |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------- |
| `PORT`                        | `8791`                    | HTTP/WebSocket port                                              |
| `HOST`                        | `0.0.0.0`                 | Bind address — the default is what makes LAN play work           |
| `CLOSEWORD_PACK`              | `data/vectors.bin`        | Embedding pack from `deno task ingest`                           |
| `CLOSEWORD_AI_CLUES`          | `auto`                    | `off` disables every `claude` feature: clues _and_ chat          |
| `CLOSEWORD_ASSISTANT`         | `true`                    | `false` turns off chat only; clues and the Look tab keep working |
| `CLOSEWORD_CLAUDE_BIN`        | `claude`                  | Path to the CLI                                                  |
| `CLOSEWORD_CLAUDE_MODEL`      | —                         | Passed to `claude --model`                                       |
| `CLOSEWORD_ROOM_IDLE_MINUTES` | `20`                      | How long an empty room survives before being reaped              |
| `CLOSEWORD_LOG_LEVEL`         | `info`                    | `debug` also records guesses and hint words — see [Logs](#logs)  |
| `CLOSEWORD_LOG_KEEP_DAYS`     | `5`                       | Day-files older than this are deleted automatically              |
| `CLOSEWORD_LOG_MAX_BYTES`     | `2000000`                 | The live file is rolled aside once a write would exceed this     |
| `CONFLUENCE_SITE`             | `your-team.atlassian.net` | Site for `ingest:custom`                                         |
| `CONFLUENCE_EMAIL`            | —                         | Confluence account for `ingest:custom`                           |
| `CONFLUENCE_API_TOKEN`        | —                         | Confluence API token for `ingest:custom`                         |

Timeouts, socket limits, the assistant rate cap and the rank-table cache size are configurable too —
see `.env.example`. Game **rules** deliberately are not: rank bands, hint policy, player caps and
scoring live in `shared/constants.js`, because the browser imports that same file and a rule the two
sides disagreed about would be a bug no amount of configuration could fix.

### Logs

One file per day in `logs/`, written as `closeword-YYYY-MM-DD.log`:

```
2026-08-13T02:42:04.044Z INFO  service starting pid=6652 deno=2.8.3
2026-08-13T02:42:05.681Z INFO  service listening host=0.0.0.0 port=8791 words=50000 clues=true
2026-08-13T02:42:19.881Z WARN  http    request method=GET path=/nope status=404 ms=0 remote=127.0.0.1
2026-08-13T02:42:19.987Z INFO  http    websocket open player=simbot0000 remote=10.40.50.22 sessions=1
2026-08-13T02:42:19.990Z INFO  action  room created room=WRCJAD mode=race source=custom by=simbot0000
2026-08-13T02:42:20.163Z INFO  action  round started room=WRCJAD round=1 players=4
2026-08-13T02:43:02.031Z ERROR webhook assist timed out player=simbot0002 ms=90014
```

Four channels, because "what happened on that box last Friday" is nearly always one of four
questions:

| Channel   | What lands there                                                    |
| --------- | ------------------------------------------------------------------- |
| `service` | the process itself — start, pack loaded, listening, shutdown        |
| `action`  | what people did — rooms, joins, rounds, hints, kicks, host handover |
| `http`    | requests and WebSocket opens/closes, floods, oversized frames       |
| `webhook` | outbound calls, today `claude -p` — duration, outcome, timeouts     |

Errors are a **level**, not a channel, so a failure files next to the thing that failed: a `claude`
timeout sits with the other webhook lines rather than in a separate file you would have to correlate
by timestamp.

**Two things are deliberately never written.** The **secret word** — this is a LAN game where the
host usually plays, and the host is the person holding the log file. And **guesses**, unless you set
`CLOSEWORD_LOG_LEVEL=debug`: the game's core promise is that you never see another board's guesses,
and a log tailing them on the host's screen would quietly break it. Field names that look like
credentials (`token`, `password`, `authorization`, …) are redacted to `***` as a backstop.

Rotation and retention are automatic:

- **Daily**, on the first line written after midnight.
- **On size** — the live file is rolled aside to `closeword-2026-08-13.1.log` once a write would
  take it past `CLOSEWORD_LOG_MAX_BYTES` (2 MB), so the active file never exceeds it. Rolled rather
  than truncated in place, because a file hits its cap precisely when something has gone wrong and
  truncation throws away the lines leading up to it.
- **Deleted after `CLOSEWORD_LOG_KEEP_DAYS` (5)**, checked at startup and once a day after. This is
  the only thing bounding the directory, so `0` — keep everything — means exactly that.

Writes are synchronous. That is a deliberate trade: at this volume an append costs microseconds, and
it removes the failure where the log stops just before the interesting part — `Deno.serve` installs
its own SIGINT handler that exits the process, and an async write queue loses its tail to it.

### Cleaning up `claude -p` transcripts

Every `claude` call leaves a transcript in `~/.claude/projects/`. Clues, curation and the assistant
all call `claude -p`, so a few evenings of play bury your actual conversations under hundreds of
one-shot prompts. The pruner deletes those and keeps the conversations:

```bash
deno task sessions:prune                       # dry run — shows what would go
deno task sessions:prune --delete              # actually remove them
deno task sessions:prune --project closeword   # one project only
deno task sessions:prune --older-than 7 --list # spare the last week, show each file
```

It tells the two apart by how the session was started: `entrypoint=sdk-cli` is `claude -p`,
`entrypoint=cli` is you at a keyboard. Only the former is deleted, only files named `<uuid>.jsonl`
are ever candidates, and anything it cannot positively classify is reported and left alone — the
cost of being wrong is not symmetric.

### Scaling beyond a LAN

Nothing here needs changing for a bigger room — the limits are `LIMITS.maxPlayers` (24) and one
process. It is a single process because the ranker's value comes from being _resident_; there is
nothing to gain from splitting it up until a box runs out of cores. If you do outgrow one: rooms are
independent, so shard by room code and put a WebSocket-aware proxy in front.
