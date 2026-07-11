# The Connection Game — the whole picture

*Written 2026-07-08 as a reading document: everything the game is, why it's shaped this way, and the questions still open. Companion files: `TODO.md` (the decision log this distills), `CLAUDE.md` (how the code works).*

---

## The one-line pitch

Link two corners of cinema through the people and titles that bind them — movie trivia as a web you weave.

## The magic trick

Strip everything away and the game has one repeatable moment of delight: **"wait, THEY were in THAT?"** Harold Ramis was in *Airheads*. Sandler was in a movie you've never heard of. Every system in the game exists to manufacture, celebrate, or share that moment. The design log's phrasing, which has decided at least four arguments: **the wow lives in the credit, not the celebrity.**

## The north star (set 2026-07-08)

**A web game that perfectly captures people huddled around one screen — laptop or TV — working together (or against each other), shouting names, finding paths, with challenges and custom rounds. Super beautiful, functional, maximum fun, minimum friction.**

Two huddle tiers follow from this, and the zero-friction one must never be forced through the ceremony of the other:

- **Tier 0 — one keyboard, many voices.** The classic game played socially IS the product for this couch: someone drives, everyone shouts "try Buscemi!" No lobby, no phones, no join flow. What serves this tier is *presentation* — a board readable from couch distance, flares big enough to celebrate across the room, instant next round — never systems.
- **Tier 1 — phones as controllers (Opening Night).** Only where simultaneity is the fun: Blitz's everyone-types-at-once can't work with one keyboard. Round types that can work phone-free should keep a no-phones path.

Solo play is the between-nights habit, not the center.

---

## The one rule

A **person** connects to a **movie or show** they acted in. That's it. Titles never link to titles, people never to people. Everything else in the game is a way of asking: *can you get from here to there?*

## The fame vocabulary

Every item carries a fame tier — **famous / known / deep cut / crazy** — derived from TMDB popularity (people) or vote count (titles). One vocabulary, used everywhere: the casting page badges, the scoring stars, the flares, the party multipliers.

The crucial subtlety: **a link's tier is its more obscure end.** Sandler is famous, but "Sandler was in Airheads" is a deep cut — and "that guy you've never heard of was in Titanic" is one too. Famous↔famous links are legal but unimpressive; routing through the weird corner of a famous filmography is the connoisseur's move.

---

## The modes

### Classic
Two corners — a Start and a Goal. Search anything; if it connects to something on your board, it sticks. Branch freely: dead ends cost nothing, exploration is never punished. Win the moment any path closes.

**Scoring is stars by links, not speed:** ⭐ connected · ⭐⭐ clean chain (no famous↔famous link) · ⭐⭐⭐ clean plus a deep-cut/crazy link. A "🎞 one take" flourish when every placement made the gold path. Deep-cut and crazy-pull flares fire *the moment you place them* — the celebration happens live, not at the end.

### Credits (blitz)
One center item, a clock, name everything directly connected to it. Placements are correct by definition; the round ends when time does. *(Renamed from "Knowledge" 2026-07-11 — you're reciting the credits; the internal mode id stays `knowledge`.)*

### The Reveal (post-game, built 2026-07-11)
After a finish, "view the web" opens the board up instead of just showing it. Tap anything and its **credits become walkable** — tap a credit to add it to the web (the answer sheet is the fun now; mid-game this exact list is forbidden). A **tightest route** tool shows the shortest path the current web allows — expand the web and a better road can appear, which quietly teaches how the game is played. **Frame the web** saves the whole board as a warm-paper one-sheet PNG: marquee title, gold winning path, sage/clay endpoint rings. Nothing in the reveal writes the ledger or the record — it's browsing, not playing.

### Double Feature (internally "hybrid")
One start, one to three goals picked visibly at setup, all on the board from move one. Win = every goal connected; the signature stat is nodes that served more than one path.

### The daily — "Now Showing"
A date-seeded double bill, the same for every player on Earth, zero backend (deterministic RNG from the date string). English-original titles only (a Korean drama → *Alien* bill proved unsolvable for most). Runs on your own difficulty settings; hints show in the share text so the flex stays honest.

**The streak is a win streak, deliberately forgiving:** win +1, lose = reset, *skip = nothing* — the streak survives a vacation. No backfills, no streak freezes, no makeup days. A loss must be recorded and stick (a later same-day win can't erase it, or "lose resets" means nothing). Quitting before the clock is a skip, never a loss — nobody's punished for closing the tab.

### The Archive
Every daily, kept. Calendar of medal-ringed days — 🥇 no hints + 3★, 🥈 no hints, 🥉 hint-assisted, ✗ loss, dotted = skipped. Past days are replayable as practice (deterministic seeding makes this free); only today goes on the books. The guilt is visual, not mechanical — empty cells nag, but the streak never breaks over a skipped day. This screen is the future home of any deep solo stats ("the super detailed archive page" conversation, still open).

### Opening Night — the couch multiplayer (Tier 1)
PC hosts the shared stage; phones are controllers; the phone NEVER shows the board. Built screens-first with fake friends (🤖 join, think, answer from real credit pools) so every round is playable before any networking exists.

- **The waiting room:** room code in big type, icebreaker question answered via real TMDB search, answers popping in as color-bordered posters.
- **⚡ Blitz (built):** three random famous-band titles on stage, the couch **votes on phones** for the seed (majority wins, ties draw straws — nobody authors the seed, so nobody has an edge). 90 seconds, everyone types at once, valid answers fly onto a shared web color-ringed with the namer's name. Everyone scores per answer — **speed is never rewarded** (the cozy couch rule). Deep cuts pay triple, uniques double, echoes half. Round ends with the **uniqueness ceremony**: each nobody-else-got-it answer revealed one at a time with its finder's name — the reveal is the social payload.
- **The Ensemble (designed, next to build):** co-op chain, turns rotate, tension is the **burning reel** — one shared clock; flubs burn film. Blame diffuses into "we're running out of film!" — no individual is ever the reason the group lost.
- **The Pitch (designed):** "I can connect X to Y in 4." Bids go down Name-That-Tune style; low bidder proves it live while everyone else wagers **back it / doubt it** on their phones. Even the casual player scores by judging. *(North-star note: this one might not need phones at all — bidding out loud IS the game; the screen just keeps score.)*
- **Final Cut (designed, drawered):** the don't-complete-the-chain inversion. Kept in the drawer: turn-based competitive made the couch quiet, and "don't leave a one-move finish" is uncomputable.

---

## Creation & sharing

- **Challenge links:** any game serializes into a URL hash — no server, the link IS the level. Budgets, bans, waypoints, type restrictions, par. Their real job is not distributing puzzles but **distributing discovery** — the click delivers the surprise by making the receiver earn their own.
- **The Studio:** a WYSIWYG builder for **features** — one to five scenes with a marquee title, tagline, and credit. Test Screening stamps your par. Every feature premieres on a title card with fanned posters and a "Roll Film" button; multi-scene features get intermissions and a finale where each scene is its own colored island on one big board.
- **Tickets:** a feature as a movie-ticket PNG with the level embedded in the image file itself. Drop the picture on the app and it plays. (Metadata-only: the original file is required.)
- **The Box Office:** shelves — Staff Picks (curated, bundled), Your Filmography (things you've released), Ticket Stubs (every feature you've finished, replayable).
- **The Back Lot:** research mode — browse TMDB big, walk credits as a breadcrumb trail, "play from here."

## Accounts & the ledger (new, 2026-07-08)

- **Sign-in is an email code, no passwords ever.** First sign-in creates the account; Google one-tap can be added later if friction demands. Anonymous play is untouched — the account is opt-in, and localStorage remains the only thing the app reads. Supabase is backup that follows you (dailyLog, shelf, stubs, ledger; settings deliberately stay per-device).
- **The Ledger** records lifetime finds invisibly: distinct deep cuts and crazy pulls discovered, corners reached, the people your winning paths route through, your single rarest link. Solo modes only — the couch's collective finds aren't your record.
- **The profile is deliberately tiny:** sign-in, streak, deep cuts, crazy pulls, and an avatar that is your most-routed person's face. It was built as a full stats-identity page (four favorite connections, distribution bars, breadth counts) and trimmed to this the same day — a dashboard is quiet pressure, and this game refuses pressure everywhere else. The ledger's numbers are really waiting for the party stage: *"Escher's 100th crazy pull 🤯"* means more on a Tuesday night with friends than on any solo dashboard.

---

## Design principles (the ones that keep deciding arguments)

**The lens** *(named 2026-07-08 by an outside review that put words to what the decision log had been doing on instinct):*

- **Surprise is the product.** Movie connections are the mechanic; the game is discovering and sharing surprising pieces of movie history. The huddle amplifies it. The share extends it.
- **The feature filter.** Every new feature must do at least one of: help players *discover* an unexpected connection; make that discovery feel more *exciting*; or give players a reason to *tell someone else*. If it does none of the three, it's complexity without the feeling the game is built on.
- **Three reveal surfaces, three jobs — never mixed.**
  - The **win screen rewards you**: full reveal, loud — name the pull.
  - The **text share tempts them**: tease the tier, never name the pull — the click should deliver the surprise, and with a challenge link attached, the surprise they get is the one they *earn*.
  - The **share card celebrates you**: the full route, deliberately shown. A trophy isn't a spoiler; it's a souvenir.

**The house rules:**

1. **The wow lives in the credit, not the celebrity.** Score links, not names; badge the arrows, not the posters.
2. **Maximum fun, minimum friction.** The best version of any feature is the one with fewer steps. Tier 0 needs zero ceremony.
3. **Cozy over competitive.** Speed is never rewarded, anywhere. Exploration is free. Strikes were replaced by the burning reel specifically so no individual carries blame. The streak forgives absence.
4. **Click depth = control depth.** Defaults need the fewest clicks; power hides behind pills, sheets, and extra taps.
5. **Warm paper cinema.** Grain, pill buttons, Instrument Serif italics for the accent word, gold for the winning path, sage/clay for start/goal. Light and dark both first-class.
6. **Theme the delight, not the disclaimers.** Headlines and celebrations speak in-voice; security notices, errors, and instructions speak plain English.
7. **Layout stability.** Nothing pops or shifts; panels reserve their space.
8. **No honesty theater.** Hints show in share text. Practice days don't count. A recorded loss sticks.

## The audiences, honestly ranked

1. **The huddle** — friends around a laptop or TV. The north star. Tier 0 exists today; Tier 1 is two rounds and a transport layer from real.
2. **The daily-puzzle person** — the Wordle-crowd habit between nights. Served: daily, streak, archive, spoiler-free share.
3. **The film buff** — the tastemaker who screenshots a crazy pull. Served by the flares and the share cards more than by any profile.
4. **The creator** — builds features, prints tickets. Small, valuable, feeds everyone else's content.

## The tech, in one paragraph

A single static page — vanilla JS, no framework, no build step. All data live from TMDB through one rate-limited gate. Deploys by `git push` to GitHub Pages. Levels travel as URL hashes and PNG metadata, not database rows. Supabase (just added) handles identity and backup, and will handle realtime rooms; the app boots and plays fully with the backend absent.

---

## Open questions to mull

**The near ones:**
- **Ensemble vs. real rooms — which first?** Polish the night's content with fake friends, or get real phones joining ASAP because that's the product feel? (Rooms = Supabase Realtime + a QR encoder; the fake-friends architecture was built to be swapped.)
- **The Tier-0 party pass:** what does the classic game need to be great at couch distance? Bigger board text? A "party" display toggle? A rematch/next-round loop with zero navigation? This might be the highest fun-per-effort work in the whole backlog.
- **The Pitch without phones:** bids called out loud, host clicks the winning bidder, wagers by show of hands? If it works it's the lowest-friction competitive round imaginable.
- **The detailed Archive page:** which solo stats deserve to exist at all (win rate, distribution, avg links, hint-free rate…), and does anyone but us look?

**The structural ones:**
- **Curated dailies distribution (TODO #21's fork):** personal calendar (local, free) vs. shipped event days (a deploy) vs. self-serve for everyone (backend). All three share the same authoring UX; where does the assignment land?
- **Multi-stage daily scoring:** if an event day is a 3-scene feature, what does "won the day" mean? (Single-stage event days dodge this — do those first.)
- **When accounts meet the couch:** do party players sign in on their phones eventually (names, colors, lifetime crazy-pull counts following them between nights)? That's where the ledger's numbers become social currency.
- **The Charts:** when they arrive, what's ranked? Today's cleanest solves and longest streaks feel right; anything speed-shaped is banned by principle.

**The someday ones:**
- Themed language days ("Foreign Film Friday") — the daily's language restriction, inverted into a feature.
- Icebreaker answer voting with a 🏆 crown for the night — pure lobby warmth, shelved, cheap.
- Final Cut's return for graduated film-nerd tables, if the stall problem ever tests well.
- A real domain: unlocks proper email deliverability (and a name that isn't a github.io subdomain).
