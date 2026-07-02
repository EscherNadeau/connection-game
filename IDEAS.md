# Connection Game — IDEAS (unlocked, undecided)

A holding pen for gameplay ideas not yet promoted to `TODO.md`. Nothing here is
committed — these are conversation starters. When one gets designed/decided, it
graduates to `TODO.md` with a date.

## ★ The north star

The thing that's genuinely special here: **truly using the live API for the
deep-cut "wow."** The moment a player bridges two corners of cinema through one
obscure actor nobody remembers was in both — that jolt of "no WAY they were in
that" — is the whole game. Every idea below should be judged by one question:

> Does this create more deep-cut wows, or does it bury them?

Mechanics that reward elegance and surprise = yes. Mechanics that reward typing
the same three super-connectors every game = no.

---

## The core-loop gaps (from the 2026-06-24 review)

> **#1, #2, and #3 graduated to TODO #17 (2026-07-01)** — shipped as one system:
> fame-tier star rating on classic wins (super-connectors legal but capped at 1★),
> "one take" flourish, deep-cut placement flares, and last-placement undo.
> **#4 graduated to TODO #18 the same day** — "Now Showing" shipped: date-seeded
> daily double bill, streaks, spoiler-free share, zero backend.

### 1. No efficiency pressure in default play
In quick Classic only the shortest path counts, dead ends are free, and there's
no fail state — so the optimal play every game is to fire a mega-connector and
win in 2 links. All the tension knobs (budget, par, bans) live *only* inside
authored challenges; the mode most people actually open has no stakes.
- **Idea:** a lightweight "can you do it in N?" target + a star rating on quick
  play. No new screen — just a target line and 1–3 stars on the win modal.
- **North-star tie-in:** a target is what *forces* the deep-cut route — the
  obvious super-connector answer should miss the star.

### 2. The super-connector problem (the real skill ceiling)
A handful of ultra-connected actors (Bacon, Samuel L. Jackson, Marvel
ensembles) trivialize the entire graph. Solved for authored challenges via bans,
never for the mode people play. This is the single thing that caps how good the
game can feel — and it's the *direct enemy* of the north star.
- **Ideas to weigh:**
  - Soft score penalty scaled to a bridge's fame/obscurity (deep cuts score
    better — directly rewards the wow).
  - Optional "house bans" toggle in quick play (the usual suspects, one tap).
  - "No repeats" wrinkle — can't reuse a person across the chain.

### 3. No take-back / undo on the board
Confirmed: no undo, no remove, no right-click/double-tap on a placed node. Once
it's down it's down. Cosmetic in free play, but in **budget challenges every
misclick is permanent** — a fat-fingered wrong actor can fail an otherwise-won
run with no recovery. Harsh for a mode that's deliberately strict pass/fail.
- **Idea (minimum):** let the *most recently placed* node be removed before the
  next placement. Cheapest correctness/feel win on this list.

### 4. A daily does NOT need a backend — and it's the biggest retention lever
Deferred to "the Supabase era," but the *puzzle* half needs no server: seed the
RNG with the date and everyone gets the same Start→Goal that day. Only the
*leaderboard* needs a backend. The share-text machinery already exists.
- **Idea:** ship "Today's Connection" now, on GitHub Pages, zero infra — one
  deterministic daily matchup + a spoiler-free shareable result grid. Add the
  leaderboard later when the backend lands.
- **Why it matters:** this genre (Wordle / NYT Connections / Pinpoint) lives on
  the daily ritual. Highest impact-per-effort idea here.
- **Open question (for Escher):** was the daily deferred for a reason beyond
  "needs a backend"? If not, it's more shippable than the TODO assumes.

---

## Lighter gaps

### Themed / curated quick-play seeds
Every quick matchup is pure random within an obscurity band. No "Marvel corner,"
decade lock, or genre theme. Type restriction exists only as a challenge rule,
never as quick-play flavor. Themed corners add variety cheaply — and a tightly
themed pool concentrates the deep-cut surprises.

### Celebrate the great find (in the moment)
When someone bridges two deep cuts through one obscure actor, nothing marks it —
the rarest moment plays identically to the most obvious one. The Archives idea
(`TODO #13`) gestures at recording it after the fact, but **in-the-moment juice**
is missing: a flare / sound / "🎉 deep cut!" badge on a low-fame bridge. This is
the most literal expression of the north star — make the wow *feel* like a wow.

### Knowledge-mode categories
It's always "name everything." A "name only the *shows*" or "name co-stars from
the 90s" variant is sitting right there in the per-scene types work already done.

---

## The Studio — customization (2026-06-24)

Verdict on "do we need more settings?": **no — the difficulty axis is saturated.**
A Studio author can already make a puzzle harder ~40 ways (timer, budget, bans,
types, waypoints, target). Adding more *restriction* dials (decade locks, A-list
only, genre) = bloat: each is a new blob field, new enforcement, new rules-sheet
clutter, backward-compat forever. **Hold the line on new constraint knobs.**

What's actually thin is the **expression axis** — an author can make a puzzle
hard but can't make it feel like *theirs*. Every lever is mechanical; the only
voice is title/tagline/byline. The fixes below add character, not difficulty —
and they serve the deep-cut-wow north star directly.

### ★ The author path / the authored "wow" reveal (Escher's idea)
The creator already solves their own puzzle to stamp par — so they *know* the
beautiful obscure bridge — and right now that knowledge is thrown away.
- **Idea:** an optional, creator-authored reveal. The author marks (or the test
  run captures) the path they found; on completion — or if the *player* lands the
  same deep-cut bridge — the game goes "🎉 yay, you found it!" The author becomes
  a **curator of deep cuts**, handing players a manufactured wow.
- **Why it's the one:** this is the single most on-brand thing the Studio is
  missing. It's the literal north star, authored.
- **Open shape (Escher, 2026-06-24):** "something that if the user finds it,
  like, yay." So: not just an end reveal — a *live* celebration the moment the
  player hits the intended/secret bridge, even mid-solve. Author optionally
  marks a "golden connection"; finding it pops. Exact UX TBD (design together).

### Per-scene flavor / clue line
One free-text line per scene ("Scene 2: this is where it gets cruel," or a
riddle hint). Scene rows currently auto-summarize ("Connect X to Y") with no room
for voice. Cheap; makes a 5-scene feature read like a story, not a worksheet.

### Per-scene intermission text
The "Scene 2 of 3 — Cut!" card is generic. Let the creator write the beat
between scenes — the difference between a playlist and an album.

### Mode parity: Double Feature scenes in the Studio
The only fair "more *control*" ask (not a new knob — parity with a shipped mode).
Quick play has one-start/multi-goal Double Feature, but the Studio can't author
it (`m:"h"` reserved + stubbed). Decide whether the Studio should reach
mode-parity with quick play.

### Keep these restraints (don't "fix" them)
- **Bans stay global** — per-scene ban lists = miserable UI (already decided, correct).
- The rules-pill + live-summary pattern is doing its job; don't surface knobs to
  the top level to make them "discoverable."

## Ranking (impact-per-effort, reviewer's take)
1. **Local daily (#4)** — biggest lever, surprisingly shippable now.
2. **Efficiency + super-connectors (#1/#2)** — the deepest design fix; most
   directly serves the deep-cut north star.
3. **Undo (#3)** — cheapest correctness/feel win.
4. Everything under "Lighter gaps" — flavor and juice once the above land.
