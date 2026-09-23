// Release notes, newest first.
//
// Lives in shared/ because both the landing page and the room show it, and it is
// plain data so that adding a release is one entry rather than a template edit.
//
// `version` is what the browser stores as "last seen" in localStorage, so the
// unread dot appears exactly once per release per browser. Never renumber a
// published entry: doing so re-marks it unread for everybody who already read
// it.

export const RELEASES = [
  {
    version: 6,
    name: "Cờ tỷ phú Việt Nam",
    date: "2026-08-27",
    summary: "A second game on the same server: Monopoly, in Vietnamese, on a board " +
      "of Vietnamese streets and places — with boards you can write yourself.",
    changes: [
      {
        title: "Two games, one room code",
        detail: "The first screen now asks which game you want. CloseWord Party is " +
          "unchanged; beside it is Cờ tỷ phú Việt Nam, a full Monopoly for 2 to 8 " +
          "people. Each has its own setup screen, and the choice is remembered so " +
          "it is the first screen once rather than every time. An invite link " +
          "skips it: the room knows which game it is.",
      },
      {
        title: "Four boards of real places",
        detail: "Việt Nam plays the 34 provinces and cities of the 1 July 2025 " +
          "reorganisation, cheapest first from Lai Châu to TP. Hồ Chí Minh. Hà " +
          "Nội, TP. Hồ Chí Minh and Đà Nẵng each play the streets of that city, " +
          "from the ring road in to the streets you would actually want to own. " +
          "Every square, group, card and button carries an icon, and every " +
          "province says on its deed card what it is now made of — which units " +
          "merged into it, and what is worth stopping for there.",
      },
      {
        title: "Every square is a picture, and the dice are thrown",
        detail: "The forty squares are illustrated — karst peaks over water, terraced " +
          "fields, a container port, a lantern street — behind the name on the " +
          "board, and full size as a postcard on the deed card you get by " +
          "clicking one. The middle of the board carries a map of the country, " +
          "outline plotted from real coordinates. Drawn in the page itself " +
          "rather than fetched, so they work on a LAN with no way out. A board " +
          "you write can name its own picture per square and its own emblem for " +
          "the middle, or leave both and get sensible ones. The dice are drawn " +
          "rather than typed, and a roll tumbles before it lands — everyone at " +
          "the table watches the same throw.",
      },
      {
        title: "The rules off the box",
        detail: "Dice and doubles, three doubles to jail, salary past Xuất phát, buy or " +
          "auction, doubled rent on a complete colour group, even building, " +
          "hotels, mortgages at half price and 10% to undo, jail by fine or card " +
          "or doubles, free trading, and bankruptcy to whoever you owed. Three " +
          "house rules the host can switch: auctions, a pot under the free " +
          "parking square, and double salary for landing exactly on Xuất phát.",
      },
      {
        title: "A board you can watch things happen on",
        detail: "There is now a 3D board, and the 🧊/🗺️ button in its corner swaps " +
          "back to the flat one — your choice, remembered, and it changes nothing " +
          "about the game. On it your piece walks the squares one at a time, so a " +
          "six looks like a six before you read it and passing Xuất phát is " +
          "something you see. The dice are thrown into the middle, big, and tumble " +
          "to a stop on the face the server rolled. Money floats off whoever it " +
          "happened to. Houses grow out of the square. Squares wear their owner's " +
          "colour. Drag to turn the board, tap a square for its deed. The flat " +
          "board gets the throw too — a pair the size of a fist over the middle. " +
          "Phones, machines with no WebGL and anybody who has turned motion off " +
          "keep the flat board, which is still the whole game.",
      },
      {
        title: "The pieces are people now",
        detail: "A piece used to be the seat's emoji at the size of a word, which told " +
          "you somebody was on a square and not who. It is now that player's own " +
          "colour — the same hue the feed tints their name with — as a disc big " +
          "enough to see on the flat board and a piece with their name on a card " +
          "above it in 3D. Your own has a ring around it.",
      },
      {
        title: "The rulebook is on the table",
        detail: "📖 Luật in the top bar opens the rules in full over the board — a " +
          "dozen sections, written out rather than summarised, so the questions " +
          "that arrive mid-game have an answer without leaving the game. What a " +
          "second house pays, what unmortgaging costs, whether you can build " +
          "while you are in jail. The figures come from the table you are at, " +
          "and the house rules the host switched on are read back in the rules " +
          "themselves. Beside them: what this table started with, and where " +
          "everything is on the screen — for the player who joined by a link and " +
          "never saw the setup page.",
      },
      {
        title: "Bring your own board",
        detail: "The host can load a board in the lobby, from a file or pasted JSON, and " +
          "download the current one as a starting point. A map file carries names " +
          "only — twenty-two places cheapest first, four transport squares, two " +
          "utilities, eight colour groups. Prices and rents come from the board " +
          "itself, so a board named after your own street corners is balanced " +
          "without you having to know any of Monopoly's numbers.",
      },
      {
        title: "A chair for whoever turns up late",
        detail: "Arriving after the board has been dealt used to be a closed door, which " +
          "is a strange thing to show somebody holding your room code. Now you get " +
          "a chair: the whole game as it happens, the chat, the deed cards, and one " +
          "button — 🔁 Đề nghị chơi lại từ đầu — that asks the table to deal again. " +
          "It is a vote rather than a host button, because an hour of four people's " +
          "afternoon is on that board and the host is not the only one who put it " +
          "there: every seated player has to agree, one Chơi tiếp sinks it, and if " +
          "it carries the new board seats everybody in the room including the people " +
          "who were only watching.",
      },
      {
        title: "One colour each",
        detail: "Colours used to be hashed from the player id, and hashes collide — three " +
          "people in a room came out as two greens and a red, which is unusable in a " +
          "game whose whole board is colour. A hue is now dealt with the seat, and " +
          "every single thing that draws a person reads that one number: the piece " +
          "on the square, the pawn in 3D, the name in the feed, the row in the " +
          "table, the ribbon along a street they own, the deeds in their own estate " +
          "panel. The order is picked so the early seats are furthest apart, because " +
          "three players is the common case and red, blue, green is unmistakable " +
          "where red, orange, yellow is not.",
      },
      {
        title: "The board asks you to build, on the square you are standing on",
        detail: "Under the printed rules you may only build where you hold every street of " +
          "the colour, which in a real four-player game where nobody completes a " +
          "group means nobody ever builds and the entire second half of Monopoly " +
          "never happens. So there is a second way in, and it is the square itself: " +
          "every time you land on a street you own, the board asks whether to put " +
          "another storey up. Answer and the turn carries on; walk off and that " +
          "street is unbuildable until you come home to it again. Holding the whole " +
          "colour group still works the way the box says, from the estate panel, and " +
          "even building applies either way — across the squares of that colour you " +
          "actually hold, which is word for word the printed rule when you hold all " +
          "of them. While you are standing there you may put up as many storeys as " +
          "you can pay for. An earlier version counted visits and let you build from " +
          "anywhere once the count was up, which worked and was invisible: a progress " +
          "bar in a panel, and a house appearing on a street nobody was standing on.",
      },
      {
        title: "Khí vận is a lucky draw now",
        detail: "The two card squares were the same square twice: sixteen small numbers " +
          "dealt off a shuffled pile, and after two laps you knew what was left. Cơ " +
          "hội is still exactly that — the printed deck, in order, every card once a " +
          "lap. Khí vận is a gacha. A rarity is rolled first — ⚪ Thường, 🔵 Hiếm, " +
          "🟣 Cực hiếm, 🌟 Truyền thuyết — and then a card inside it, so the same " +
          "card can come twice and the good ones stay rare. It spins on screen and " +
          "settles on the tier's colour, with a run of notes that gets longer the " +
          "rarer it is. The bottom tier is small change; the top two touch property. " +
          "You can be made to knock one of your own buildings down, hand your " +
          "cheapest deed to whoever at the table is worth least, swap it with the " +
          "richest player's, empty the pot under the free parking square, walk three " +
          "more squares, get a building free, or take 🛡️ — the next rent you owe is " +
          "waived. The cards that move property pick the square themselves rather " +
          "than opening a picker, because a card that stops the table while somebody " +
          "reads their own deeds is a card nobody wants to draw.",
      },
      {
        title: "Cards you never saw",
        detail: "A fix that only mattered once turns started ending themselves: a card " +
          "that just paid out cash was drawn, applied and cleared inside one " +
          "synchronous step, so no browser ever rendered it. The only trace was a " +
          "line in the feed. A card now stays on the table until somebody picks up " +
          "the dice.",
      },
      {
        title: "Nobody waits for anybody",
        detail: "A table moves at the speed of whoever is slowest to notice it is their " +
          "turn, and the person who went to answer the door stopped everybody. Two " +
          "things fix that. Turns now end themselves when there is nothing left in " +
          "them — most turns are roll, pay, done, and making somebody press kết thúc " +
          "lượt is a click carrying no information that three other people are " +
          "waiting on; the board only pauses at the end of a turn when there is " +
          "something to pause for. And 🤖 Tự động chơi hộ tôi hands your turns to the " +
          "machine: it rolls, buys while a rainy-day fund survives the price, takes " +
          "the cheaper tax, and mortgages to cover a debt. Deliberately dull. If you " +
          "stop answering without ticking it, the board ticks it for you — twenty " +
          "seconds on a real decision, twelve on the tail of a turn — with the " +
          "countdown on screen the whole time and ⏸ Tôi vẫn ở đây to push it back.",
      },
      {
        title: "It is your turn, and you will know",
        detail: "A strip across the top of the board in the colour of whoever is up. When " +
          "that is you it says LƯỢT CỦA BẠN in the largest type on the page, glows, " +
          "and chimes twice — the only two-note sound the board makes, because it is " +
          "the only one you need to hear from the kitchen. When it is not, it says " +
          "whose it is and how many turns until yours, with the queue in turn order " +
          "underneath. And because a coloured disc on a grid of forty squares does " +
          "not tell you which square you are on, the board says that in words above " +
          "itself — your square and the moving player's, both buttons that open the " +
          "deed — while on the board your square gets a ring, a lift and a 📍, and " +
          "the piece of whoever is up breathes.",
      },
      {
        title: "The important things at the top",
        detail: "🏘️ Tài sản của tôi has moved out from under the board into the left rail " +
          "directly beneath the table, because a panel you scroll past a board to " +
          "reach is a panel nobody uses. Deeds are grouped by colour, each group " +
          "wearing its own colour and saying how much of it you hold — 2/3 — so the " +
          "thing that decides whether you can build is the first thing you see, and " +
          "the build button is greyed by the server with the reason in its tooltip " +
          "rather than guessed at in the browser. Diễn biến and Trò chuyện are two " +
          "panels now, each scrolling on its own: one list of both was unreadable at " +
          "a board game's pace, with a question somebody asked the table buried three " +
          "screens up inside a minute.",
      },
      {
        title: "The flat board moves",
        detail: "Every snapshot rebuilds the grid, so a piece on the flat board used to be " +
          "simply somewhere else than it was — the eleven squares it crossed never " +
          "existed, and what just happened was answerable only by reading the feed. " +
          "Its squares are elements with rectangles, though, and that is enough to " +
          "fly a piece between them. So it walks now, one square at a time, hopping, " +
          "off the same numbers and timings the 3D board has always used: a six looks " +
          "like a six before you read the number, and passing Xuất phát is something " +
          "you watch. A move that is not a walk arcs straight there. The square it " +
          "lands on flashes, and money floats off it — +200K in green over whoever " +
          "passed Xuất phát, −10K in red over whoever just paid — held back until the " +
          "piece arrives so the number lands where the player does. Turn motion off " +
          "and you get the arrangement without the journey.",
      },
      {
        title: "An auction is not something you go and find",
        detail: "It has moved out of the hole in the middle of the board and up under the " +
          "buttons: the lot, the standing bid, the box you type into and the " +
          "countdown, on one line. It is a decision on a clock for everybody at once, " +
          "which makes it the last thing that should be somewhere you have to look " +
          "for — and on the 3D board the middle of the board is below the board " +
          "entirely. It also runs on a clock at all now. An auction is the one wait " +
          "the board holds on everybody at the same time, and it was the one wait " +
          "nothing could answer: one player who had gone to answer the door stopped " +
          "the table dead at the first refused square, because the hammer cannot fall " +
          "until every bidder has raised or walked away. The machine folds for them, " +
          "one at a time, and a new highest bid restarts the clock for everybody " +
          "else.",
      },
      {
        title: "A board the size of the screen it is on",
        detail: "Eleven equal tracks put nine of them in the hole in the middle, so four " +
          "fifths of the flat board was empty felt and no square was wide enough to " +
          "read a street name on. The ring tracks are now nearly twice the inner " +
          "ones, which is the proportion a real board has, and the middle shows the " +
          "square you are standing on rather than an instruction to tap something. On " +
          "a phone the deed card comes out of the middle altogether and sits under " +
          "the board — the middle of a 430px board is not a place a deed card fits — " +
          "and the 3D/2D button moved off the corner square it had grown to cover. " +
          "Resizing the window now re-decides the layout instead of keeping the one " +
          "it was first drawn with.",
      },
    ],
  },
  {
    version: 5,
    name: "Say it out loud",
    date: "2026-08-13",
    summary: "Words you can hear, read in Vietnamese and recognise at a glance, " +
      "@ mentions in the feed, two new things to throw, and a vocabulary that " +
      "finally knows what an RMA is.",
    changes: [
      {
        title: "Every word can say itself",
        detail: "Tap any word on your board and the browser pronounces it, then shows " +
          "the IPA, the part of speech, a one-line English meaning and the " +
          "Vietnamese. The speaking half is entirely local — no server, no " +
          "network, works offline; the dictionary half asks the server, which " +
          "answers from memory the second time anybody asks about the same word. " +
          "The revealed answer at the end of a round has a speaker button too.",
      },
      {
        title: "An icon for what a word means",
        detail: "Words now carry a small emoji picked by meaning rather than by a lookup " +
          "table, so `fireplace` gets 🔥 without anybody having listed it. About a " +
          "quarter of words get one: the threshold is set where it is because a " +
          "wrong icon misleads you about meaning in a game about meaning, and a " +
          "blank is honest.",
      },
      {
        title: "@ somebody in the feed",
        detail: "Type @ in the chat box and pick a name — or @all for everyone. They get " +
          '"{name} tagged you in room feed", a chime, and their tab title blinks ' +
          "until they come back to it. The line is marked in the feed so they can " +
          "see which one wanted them. Names are matched whole, longest first, so " +
          "@Duc never lands on Duc M by accident.",
      },
      {
        title: "Escalate it, or call it a blocker",
        detail: "Two more things to throw, borrowed from the board you already argue on: " +
          "🚨 escalate and 🚧 blocker. Same flight, same mess on landing, their own " +
          "sirens — an escalation flares red and wails, a blocker drops hazard tape " +
          "and thuds. They come in smaller volleys than eggs on purpose: one road " +
          "sign lands harder than twenty.",
      },
      {
        title: "rma, sso, edr and forty more are words now",
        detail: 'Guessing "rma" in a custom room said it was not in the word list, and ' +
          "rebuilding the custom word list would not have fixed it — a guess is " +
          "checked against the 50,000-word vocabulary, which came from a news " +
          "corpus that has never heard of us. Forty-three domain terms now have " +
          "vectors built from the words that explain them, so they can be guessed " +
          "and can turn up as answers. Digits work in the guess box too, for 2fa " +
          "and k8s.",
      },
    ],
  },
  {
    version: 4,
    name: "Direct hit",
    date: "2026-08-13",
    summary: "Throw as much as you like and watch it land, a room list on the front page, " +
      "solo practice, and a word set for after hours.",
    changes: [
      {
        title: "Roses and eggs, unlimited",
        detail: "The one-each-per-round cap is gone. Keep throwing: the throw now flies " +
          "on every screen in the room, lands on the target's row and leaves a mess " +
          "behind. Get hit and it comes at you from all four edges of the window with " +
          "a jolt and a running count. The more that lands on one person, the bigger " +
          "it gets — and the feed stops narrating after the first one so a pile-on " +
          "reads as one story.",
      },
      {
        title: "BUZZ! across the whole screen",
        detail: "A buzz used to shake the window and hope you were looking. Now the room " +
          "greys out behind one enormous word saying who did it. It never eats a " +
          "click or a keystroke — you can keep typing straight through it.",
      },
      {
        title: "Solo practice",
        detail: "A fifth mode: just you, starting the moment you make the room, word " +
          "after word for as long as you like. Nobody else can join — the server " +
          "refuses them, it is not just an unshared code. Your record for each word " +
          "set stays in your own browser and goes nowhere near the server.",
      },
      {
        title: "See who is playing, from the front page",
        detail: "The landing page lists every open room — code, mode, word set, how many " +
          "people and what it is doing right now — with a Join button. Practice rooms " +
          "stay off the list, and no room says who is in it.",
      },
      {
        title: "After dark (18+)",
        detail: "A fourth word set: anatomy, sex and euphemism, cheeky rather than nasty. " +
          "Hand-tagged from the lexicon, and the host picks it — it asks first, warns " +
          "that the whole room will be playing it, and shows 18+ in the room for as " +
          "long as it is in play.",
      },
      {
        title: "Inviting before the room exists",
        detail: 'Ticking somebody on the create screen said "invited" and then went ' +
          'dead, which read as broken. It now says "lined up", lets you change your ' +
          "mind, and counts them inside the picker. They are invited the second you " +
          "press Create room.",
      },
      {
        title: "Being removed from one room stays in that room",
        detail: "If you were in two rooms and a host removed you from one, you were " +
          "thrown out of the other. A room can only close its own door now.",
      },
      {
        title: "The 5-second penalty is gone",
        detail: "Getting close no longer locks you out for five seconds. It was funnier " +
          "in theory than in a room.",
      },
    ],
  },
  {
    version: 3,
    name: "Make some noise",
    date: "2026-08-13",
    summary: "Emoji, buzzing, invites, reactions, team switching and a few jokes with teeth.",
    changes: [
      {
        title: "Pick your own side",
        detail: "Teams are handed out the moment you walk into a team room, not at " +
          "kick-off, so the line-up is there to argue with while people are still " +
          "arriving. Tap your own name to switch sides; the host can tap anybody. " +
          "A 3-v-1 says so, in as many words.",
      },
      {
        title: "Emoji beside the chat box",
        detail: "A palette of the ones you actually reach for, with your recents " +
          "remembered in this browser. Pasting emoji from Windows, macOS or a phone " +
          "keyboard now survives intact — composed emoji like 👨‍👩‍👧 and 👩🏽‍🚀 used to be " +
          "cut in half by the length limit and arrive as broken boxes.",
      },
      {
        title: "Buzz!",
        detail: "Shake everyone's window when the room has gone quiet. One buzz per " +
          "player every ten seconds, and it does nothing when you are the only one " +
          "connected.",
      },
      {
        title: "Extra hints, on your tab",
        detail: "Out of hints? Buy one anyway. It asks first — clicking means you owe " +
          "the room a drink — and it announces it in the feed on your behalf. The " +
          "tally rides on your name for the rest of the match.",
      },
      {
        title: "Invite whoever has the app open",
        detail: "Pick people from the create screen or hit + in the room. They get " +
          '"someone wants you to join the war" with Join or Ignore. Names are held ' +
          "in memory for as long as the tab is open and never written down.",
      },
      {
        title: "Asking to see a journey",
        detail: "Once you have found the word your journey is open to the room. " +
          "Before that, someone wanting a look has to ask, and you get Approve or " +
          "Reject. Approve and they see their run beside yours, side by side.",
      },
      {
        title: "Roses and eggs",
        detail: "Throw either at anyone in the players list. One of each per person " +
          "per round; hover a tally to see who.",
      },
      {
        title: "One number per round",
        detail: "Hints land on the board as rows, and used to be counted as guesses in " +
          "some places and not others — so the same round could read 11 guesses in the " +
          "standings and 16 in the feed. A hint is not a guess anywhere now.",
      },
      {
        title: "These notes",
        detail: "What's new, with a dot on the button until you have read it.",
      },
    ],
  },
  {
    version: 2,
    name: "House rules",
    date: "2026-08-13",
    summary: "See how anyone got there, and decide what a round even is.",
    changes: [
      {
        title: "The journey view",
        detail: "Click a name anywhere to see every guess they made in order, with " +
          "rank, heat and timing. Guesses stay private while a round is running " +
          "unless you share a board — enforced on the server, not hidden in the page.",
      },
      {
        title: "What ends a round",
        detail: "Sudden death stops the moment somebody finds it. Grace clock gives " +
          "the rest a countdown. Everyone finishes waits for the whole room.",
      },
      {
        title: "Guess budgets",
        detail: "Give each board a fixed number of guesses per round. Hints stay " +
          "free, so a stuck board can still buy its way closer.",
      },
      {
        title: "Host controls",
        detail: "Stop match scores the round in progress and calls it. Reset room " +
          "clears every score and drops back to a fresh lobby.",
      },
    ],
  },
  {
    version: 1,
    name: "Groundwork",
    date: "2026-08-12",
    summary: "Configuration, logging, and a much larger custom vocabulary.",
    changes: [
      {
        title: "Settings moved to .env",
        detail: "Port, paths, timeouts and limits all come from one documented file " +
          "instead of being compiled in. Bad values are reported together at " +
          "start-up rather than one restart at a time.",
      },
      {
        title: "Logs you can read afterwards",
        detail: "Service, action, HTTP and webhook lines to logs/, rotating daily, " +
          "chunked past 2 MB and swept after five days. Guesses and hint words only " +
          "at debug, so a log never spoils a round.",
      },
      {
        title: "The custom word set grew eightfold",
        detail: "237 words to 1,916, harvested from 1,077 Confluence pages, ranked by " +
          "how many pages use them and vetted by claude -p.",
      },
      {
        title: "Room feed and standings",
        detail: "Names carry a colour that follows a person everywhere, each kind of " +
          "line has its own glyph, and the players list shows who is actually " +
          "connected.",
      },
      {
        title: "The guess box stopped wandering",
        detail: "It sits above the guess list now, so it stays put instead of walking " +
          "down the page as the list grows.",
      },
      {
        title: "Ctrl-C works again",
        detail: "And the shutdown is recorded before the process goes.",
      },
    ],
  },
];

/** The newest release's version. What a fully-read browser has stored. */
export const CURRENT_RELEASE = RELEASES[0].version;
