# Connection Game — TODO

## 24. The Profile page — stats as identity (SHAPING 2026-07-05, mock at `profile-mockup.html`)
The reframe that reshapes #23: accounts aren't "back up my localStorage," they're a **player profile** — "what kind of connector am I." Grounded in the game's soul ("the wow lives in the credit, not the celebrity"; the Archive tagline "Every connection, kept"). This page IS the argument for accounts. Mock built in the real warm-paper system; published concept: sample data, react to shape.

**Stat tiers (designed from the game, not generic):**
- **Tier 1 — hero (identity + retention):** daily win streak + the Archive calendar (#20, built); medal/star distribution bar; **deep cuts & crazy pulls found (lifetime)** — the signature stat, the number a film buff screenshots.
- **Tier 2 — identity color:** breadth (unique titles/people connected); **your signature bridge** (person you route through most — "you thread through Steve Buscemi, 41×"); your single rarest link.
- **Tier 3 — volume/utility:** totals by mode, hint-free win rate, avg links to solve.
- **Tier 4 — needs backend (design schema for it now):** The Charts (daily leaderboard, longest streaks); creator stats (plays of your Studio features, how often players beat your par); Opening Night (nights won, unique finds).
- **Deliberate anti-stat: do NOT lead with speed** — already decided anti-cozy (#19 "speed is NOT rewarded"). Timers are pressure, not a flex.

- [ ] **Four Favorite Connections (Escher, 2026-07-05) — the centerpiece.** The connection-game's native answer to Letterboxd's four-favorite-films row: four *routes* you love (X → Y), two posters joined by the gold thread + link-count chip, reusing the board's visual language (person = circle, title = poster). Picked via the existing TMDB search. **OPEN:** any two titles/people, or only connections you've actually solved (earned vs. free)? — decide before building.
- [ ] **What's free vs. new (build order):** streak / calendar / distribution are already derivable from `dailyLog` — do first. Deep cuts / crazy pulls / breadth / signature bridge / rarest link need ONE small capture: a running tally the game increments where it ALREADY fires the deep-cut/crazy-pull flares (+ a per-person route counter, a seen-keys set). Four Favorite Connections is the only purely-new UI.
- [ ] Home entry: a Profile button / the avatar as the switcher. Anonymous play still shows a local profile; signing in makes it follow you (ties to #23).

## 23. Accounts + saved data (Supabase) — go-live prep (SHAPING 2026-07-05, no code yet)
"Live soon" needs data to survive a cleared cache / new device. Deferred to its own focused session (decided 2026-07-05 — small UX polish shipped first).
- [ ] **Sync scope (Escher, 2026-07-05):** an account holds **daily streak & history** (`dailyLog`), **Your Filmography** (`shelf`), **ticket stubs** (`stubs`), and — added with #24 — the **profile tallies** (lifetime deep cuts / crazy pulls, breadth seen-keys, signature-bridge counts) + **Four Favorite Connections**. **Settings are explicitly OUT** — difficulty/hints/timer stay device-local (they're a per-sitting preference, not identity).
- [ ] Auth: lowest-friction sign-in (magic-link email or Google OAuth — decide at build time). Anonymous/local play must keep working; account is opt-in and merges local → remote on first sign-in.
- [ ] Local-first: localStorage stays the source of truth offline; Supabase is a sync/backup layer, not a hard dependency (the app already boots with zero backend — keep that).
- [ ] Pairs with #21's "self-serve curated dailies" (fork c) and #19's rooms — all the same Supabase era.

## 22. Feature-runtime UX polish ✅ DONE (2026-07-05)
- [x] **Poster peek is a real zoom:** the board-peek modal (`openBoardPeek`) now stacks a large poster (`.peek-panel` column layout, ~320px) over name/overview instead of the small side-by-side thumbnail.
- [x] **"View the map" at intermissions:** `#round-modal` gets a ghost button that ducks the modal to admire the just-finished scene (gold path still lit), with a floating `#btn-resume-round` Continue to bring the intermission back — same duck/resume pattern as the win modal's view-the-web.
- [x] **The finale is five separate games, not one web (Escher, 2026-07-05):** `showFinale` now lays each scene out as its **own island** on a grid. Shared items are DUPLICATED per island via namespaced keys (`"<scene>:<key>"`) so clusters never touch; the scene's start/goal are pinned as fixed anchors; islands sit `CELL=780`px apart (> `REPULSE_RANGE`) so inter-node repulsion can't bridge them; a new `finaleView` flag disables centering gravity so they don't clump. Each scene's winning chain glows in its **own color** (`SCENE_COLORS`, `colorScene()` — classic lights the path, knowledge lights the whole island). Per-scene snapshots captured in `endRound` (`quest.scenes[]`: own nodes/edges/path). Replaces the old single-ring merged web.

## 21. Curated / featured dailies (SHAPING 2026-07-05, no code — builds on #20 Archive + #15 Tickets + #10 Studio)
On chosen dates, override the algorithmic daily with a **hand-authored level** — single-stage or a multi-scene feature — that everyone plays that day. It's still the *shared* daily, so it still counts toward the streak and earns a medal (no honesty problem — unlike letting players author their own private "dailies").

- [ ] **Mechanism:** a `date → blob` override map (v3 Studio blobs, bundled like `STAFF_PICKS`). `resolveDailyFor(date)` checks it FIRST, falls back to the random generator. Multi-stage runs through the existing `quest`/premiere/finale runtime. Almost all the machinery already exists.
- [ ] **Authoring UX (Escher, 2026-07-05): upload a ticket image → pick a day.** Reuse the Tickets pipeline (#15): drop/redeem a ticket PNG (or pull a Studio feature), decode the embedded blob via `pngReadText`, then choose the date to schedule it on. A "schedule this feature" flow — the creator side of the curated daily.
- [ ] **The distribution fork (the thing to decide — Escher unsure):** a ticket assigned in-browser only overrides *your* localStorage → that's a **personal puzzle calendar**, not "all users." Three distinct products hide here:
  - **(a) Personal schedule** — local override map, zero infra. Should NOT count toward the streak/medal (same rule as practice) since it isn't the shared daily.
  - **(b) Shipped event day** — bundle the `date → blob` into app.js and `git push`. "Deciding a day" = a deploy. Perfect for *planned* event days, no backend. IS the shared daily → counts.
  - **(c) Self-serve, all-users, any day** — needs Supabase (upload writes a row, clients fetch). The full version of "I upload and pick a day and everyone gets it." Supabase-era.
  The upload-and-pick-a-day UI is the same front-end for all three; only where the assignment LANDS differs (localStorage / a committed file / a backend row).
- [ ] **Featured border in the archive:** keep the medal (how you did) and ADD an authored accent on top — 🎬 corner badge / gold-foil double ring / creator's color — so event days stand out at a glance without losing the result. (Distinct from the plain medal tiers in #20.)
- [ ] **OPEN — multi-stage "won the day":** the daily record is currently a single classic win/loss (`ok` + steps/stars/hints). A multi-scene curated day has per-scene results, not one star rating — so it needs a day-result shape (cleared N/M scenes? all-clean = gold?) and a "did you win the day" rule (clear everything? reach the finale?). Single-stage curated days slot into the existing record untouched; **do those first**, decide multi-stage scoring later.

## 20. The Archive — Now Showing history + streak (DESIGN LOCKED 2026-07-05; mockup at `archive-mockup.html`)
Extends #18 (Now Showing). No backend — pure render of what's already in localStorage (`dailyLog`), plus a losses record we don't keep yet.

- [ ] **The streak is a WIN streak, not a calendar streak (Escher, 2026-07-05).** Win → streak+1; **lose → reset to 0**; **skip a day → nothing** (the streak survives the gap). Stored as a plain running counter, NOT derived by walking the calendar (that's how it works today — that logic gets replaced). No backfill, no makeups, no streak-freeze, no "play a past day to save it" — all explicitly rejected as over-engineering. A skipped day is a non-event.
- [ ] **Loss vs skip (the only fork, decided forgiving):** a **loss** = you played today's daily and the clock beat you → resets the streak. **Quitting before the clock = a skip** (never recorded) — nobody's punished for closing the tab. This means the daily must start **recording losses** too (today `dailyLog` only writes the first WIN), and a lost date must STICK (a later same-day win can't overwrite it, or "lose resets" isn't real).
- [ ] **Two numbers do the two jobs (reviewer's synthesis, Escher approved):** the *win streak* is the kind, forgiving flex; the **archive calendar itself is the retention pressure** — skipped days show as empty/grey cells, so missing a day is *visible* (nagging) without ever breaking the streak. The guilt is visual, not mechanical — the humane version of the Wordle chain. Also surface **max streak** + **win %** (Wordle's trio) — free from the same data.
- [ ] **Colored border per date = how you won it (Escher's idea):** medal tiers by how much help you took —
  - 🥇 **gold ring** — won with NO hints AND 3★ (clean chain + a deep/crazy link): the purest.
  - 🥈 **silver ring** — won with no hints, under 3★.
  - 🥉 **bronze ring** — won, but used hint(s).
  - **loss** — hairline red + ✗ (played, failed).
  - **skip** — empty dotted cell (didn't play).
- [ ] **Playable past days come FREE from the date-seeded design** (FNV-1a→mulberry32 on the date string is deterministic, so any past date reproduces exactly). Tap an empty past cell → play that day's bill. Open question deferred (doesn't gate the archive): whether a past-day win counts toward the win streak or is just for the badge — lean "badge only, streak is forward-only" so the streak stays honest, but not blocking.
- [ ] Home entry: a ghost button near the daily strip ("The Archive"), same tier as The Box Office.

## 19. Opening Night — couch multiplayer (DESIGN LOCKED 2026-07-01; waiting room BUILT same day)
- [x] **Waiting room shipped (2026-07-01):** `screen-lobby` host stage (room code in Bebas, QR slot dashed-out until rooms exist, icebreaker question, color-bordered poster answers popping in, player chips, Roll Film gated on 2+ players & 1+ answer) + the **phone preview** — a real local controller in a phone shell (join with code/name/color validation, icebreaker answered via TMDB search, seated screen). Fake friends join with a 🤖, think, and answer from the warmed pools. Rounds stubbed behind Roll Film.
- [x] **⚡ Blitz built (2026-07-02):** Roll Film now starts a real round — title card ("Round N · Greta's pick", 3-2-1), 90s clock, the knowledge-mode board hosting a party web (`game.mode = "party"` sidelines every solo path), answers landing color-ringed with namer tags, live score strip, deep-cut flares with the player's name, phone round controller (search + your score + your feed; ✗/repeat rejected politely), fake friends answering from the seed's real credit set (crazy pulls mostly re-rolled so they read human), uniqueness ceremony (ascending crescendo, ×2 pays live), podium with night totals, Next Round (fresh seed) / back to the waiting room; quit mid-round returns to the lobby with the party intact. Gotcha for the file: party podium button is `#btn-party-next` — `#btn-next-round` belongs to the QUEST intermission (a duplicate id silently cross-wired both flows; found in verification).
- [x] **Blitz seeding redesigned: the marquee vote (2026-07-02, same day, after the first playtest).** Escher's flag: seeding Blitz from icebreaker picks broke it two ways — players who don't know the seed have zero legal moves (exclusion, not difficulty), and the picker always knows their own pick best (built-in edge). Any person-authored seed carries an edge, so: **three RANDOM famous-band candidates on the stage, everyone votes on their phone (~10s, first tap locks, short-circuits when all have voted), majority wins, ties draw straws.** The couch votes what it knows → the seed self-selects common ground; nobody authored it → nobody's edge. Candidates are **titles only** — famous-band titles are vote_count-sorted (truly known), famous-band PEOPLE ride TMDB's trending signal and can be nobodies. Icebreaker picks now seed only Ensemble/Pitch (a route beats a cast list there). Also decided: **echoes pay half** (naming it first matters; parroting the couch still counts). Local-demo phone learned to stay above stage modals (z-index 120), auto-close at round end, and carry a mid-round "put the phone down". The vote UI is the same phone-button pattern The Pitch needs for back-it/doubt-it.
- **Shelved idea (Escher, 2026-07-02):** vote for the best icebreaker *answer*, winner gets a 🏆 crown on their chip for the night — pure lobby juice, no gameplay power (as a seed-picker it would rebuild the picker's edge). Build whenever the lobby wants more warmth.
- [ ] **Next: The Ensemble** (burning reel co-op), then **The Pitch** (bid + back it/doubt it — reuses the marquee-vote phone buttons). All still local-demo (fake friends play too).
- [ ] Supabase era: rooms + realtime transport; QR encoder vendored then.
PC hosts the shared stage; phones are controllers (per the #16 platform decision). Build order: **screens first** (host stage, waiting room, phone controller — playable in a local fake-players demo mode), realtime transport in the Supabase era. Supersedes/absorbs #1 Phase B.

**Join flow:** room code on the stage PLUS a QR that opens the join page with the code prefilled (QR generation = vendor a tiny single-file MIT encoder, consistent with the jsQR plan for tickets v2). Phone: enter name, pick a color, answer the icebreaker **with the search** — so every answer is a real TMDB item. Host stage shows the question + answers arriving as color-bordered posters with names.

**The icebreaker IS the content:** players' picks seed the rounds — a blitz round centers on someone's pick; co-op/versus rounds connect two players' picks to each other ("link Escher's favorite to Sam's favorite").

**Three round types, one stage (lineup revised 2026-07-02 after the mode study — night shape: opener → loud middle → competitive finale):**
1. **Blitz** (party opener): center item, ~90s, everyone types at once on phones, valid connections fly onto the shared web color-coded with names. Scoring: everyone scores per valid answer (speed is NOT rewarded — cozy couch rule, decided), fame tiers multiply (deep cut ≈ 3×, flares BIG on the stage with your name — mid-round the flares are the show). Round end = the **uniqueness ceremony** (decided 2026-07-02): the stage steps through each nobody-else-got-it answer one at a time with the player's name/color before the podium — the reveal is the social payload, never a dumped list.
2. **The ensemble** (co-op, loudest): shared classic chain, turns rotate through the colors, place anything that connects (relay variant = later house rule). Tension = the **burning reel** (decided 2026-07-02, replaced shared strikes): one shared clock for the whole chain; flubs and passes burn extra seconds. Same dread, but blame diffuses into "we're running out of film" — no single player ever burns the reel personally (strike shame was the flaw: the casual player must never be the reason the group lost).
3. **The Pitch** (competitive finale — decided 2026-07-02, replaced Final Cut in the lineup): "I can connect X to Y in 4." Bids go down around the couch Name-That-Tune style; the low bidder proves it live on the stage while everyone watches. Before the run, everyone else wagers on their phone — **back it / doubt it** — and scores by predicting the outcome (no dead air; even casuals score by judging, not knowing). Make it in-budget: bidder + backers score; bust: doubters feast. Deep cuts are the currency of a low bid; speed never matters; icebreaker tie-in: "connect Escher's pick to Sam's pick — who's bidding?" Tech = classic mode + existing budget enforcement.

**Final Cut — designed but DRAWERED (2026-07-02):** the don't-win inversion (complete-the-chain-loses mind game, big casts as landmines) is kept in the drawer as a possible mode 4 for graduated film-nerd tables. Why demoted, honestly: turn-based competitive = quiet couch (secret thinking, no table talk); "don't leave a one-move finish" is uncomputable (depends on opponents' knowledge, not the board — losers learn nothing); and it needed three anti-stall patches (placement points, turn cap, film-dies) before ever being played. If revisited: stress-test the stall problem with fake friends first.

**Phone screen during rounds:** search box + suggestions + your score/color only. The phone NEVER shows the board — the TV is the stage (platform decision).

## 18. Now Showing — the daily connection ✅ DONE (2026-07-01)
The daily, shipped with zero backend (graduated from IDEAS #4; name per the #14 reservation — "it means *today* on a marquee"). Same puzzle for everyone: a date-seeded RNG (FNV-1a → mulberry32) drives every pick, so all players resolve the same discover pages/rows; the first resolution caches per-date in localStorage (`dailyPuzzle`) so mid-day TMDB vote drift can't change a bill someone already saw.
- [x] A double bill: both endpoints are titles (seeded 70/30 movie/tv), discover pages 1–8 by vote count. A deterministic forward-walk skips dupes and one-link anticlimaxes (last try accepts anything, so there's always a bill).
- [x] **English originals only for v1** (decided 2026-07-01 after the first live test dealt *Guardian: The Lonely and Great God* → *Alien*): cross-industry bills are near-unsolvable for most players. The main game stays unrestricted. Themed language days ("Foreign Film Friday") noted as a future feature.
- [x] Home marquee strip (`#daily-strip`, reserved-height slot — no layout pop): today's bill + play/done-with-streak status.
- [x] Win integration: first completion recorded to `dailyLog` (steps/stars/hints/placed), 🔥 streak line + spoiler-free share text (endpoints, stars, links, hints — never the path) via `#btn-share-daily`. Replays welcome but only the first completion is on the books.
- [x] Daily runs the player's own difficulty settings (timer/hints) — hints show in the share text, so the flex is honest.
- Supabase era: daily leaderboard; consider region-aware or themed-language dailies.

## 17. Core loop pass — deep-cut scoring + undo ✅ DONE (2026-07-01)
Graduated from IDEAS.md (#1 efficiency pressure, #2 super-connectors, #3 undo) as ONE system instead of three. Decided: super-connectors stay **legal but unimpressive** (scoring beats bans); exploration stays free (waste never gates stars); groundwork for multiplayer scoring.
- [x] Items carry `fame` (TMDB popularity for people / vote_count for titles) from every source; `fameTier()` is the single fame vocabulary (shared with the casting-page badges).
- [x] **Person fame recalibrated (2026-07-01):** TMDB reworked popularity into a compressed trending signal (Sandler = 5.5 now!) — the old 35/12/4 bands had been misfiling A-listers as deep cuts, on the casting page too, since it shipped. New bands famous ≥4 / known ≥2.2 / deep cut ≥1 / crazy <1, calibrated against a live sample (values in the `fameTier` comment). Trending spikes only ever err toward "famous". Title vote_count bands unchanged (never rescaled).
- [x] Classic wins star-rated by the chain's **links, not its names** (decided 2026-07-01 — "the wow lives in the credit, not the celebrity": Sandler is famous, but "Sandler was in Airheads" is a deep cut). A link's tier = its more obscure end (`edgeTier`): famous↔famous = obvious; either end deep-cut/crazy = the pull. ⭐ connected · ⭐⭐ clean chain (no famous↔famous link) · ⭐⭐⭐ clean + a deep/crazy link. Nested on purpose — famous people are fine bridges IF you route through the weird corner of their filmography. (Superseded same-day: v1 rated bridge *nodes*, which punished the famous-face-obscure-credit route.)
- [x] "🎞 one take" flourish when every placement made the gold path (the "both" answer to waste: never punished, flawless gets applause).
- [x] Badges sit on the win-path **arrows** ("deep cut" / "crazy pull") — the connection is what glows, not the poster.
- [x] In-the-moment juice: a placement that creates a surprising link flares the toast right then ("🎉 deep cut!" / "🤯 crazy pull!"), all modes.
- [x] Undo: ↩ in the game header takes back the most recent placement until the next one lands; refunds budget spend; classic/hybrid only (knowledge placements are correct by definition — decided 2026-07-01). Hybrid undo re-runs the goal-chip check (an undo can un-reach a goal).
- Known edge (accepted): the budget-spent fail fires on the placement itself, so the *final* budget spend can't be undone — undo protects mid-run waste only.
- Later: star-rate hybrid wins (multi-path rating is its own design); optional "house bans" toggle if stars alone don't curb super-connectors; record deep-cut finds in The Archives (#13).

## 10. The Studio — multi-scene features ✅ DONE (2026-06-11)
The builder is now **The Studio** ("Challenge a Friend" renamed). A custom game is a *feature*: 1–5 scenes (rounds), any modes, any order.
- [x] Scenes tray in the builder: "add current matchup as a scene", reorder, remove; cap 5. Empty reel = single-round challenge (old behavior).
- [x] **WYSIWYG redesign (2026-06-11, superseded the film-strip layout same day):** you build standing on your own premiere page — type title/tagline/credit straight onto the one-sheet, poster fan grows as scenes are added, scene rows match exactly what the player will see (tap to edit). One focused scene sheet at a time (plain-language mode cards "Connect two things" / "Name everything" with classic/knowledge tags), house rules tucked behind a pill, Roll Film-style progression: Test/Release disabled until the first scene exists. Scenes are always explicit now — the "empty tray = single round" magic rule is gone.
- [x] Knowledge scenes get a **target** ("name N to clear it"); reaching it ends the scene early as a success. No penalty for wrong guesses (decided 2026-06-11).
- [x] **Premiere screen**: every shared link (v1/v2/v3) now lands on a title card — title, tagline, "a production by X", scene list, fanned poster backdrop, Roll Film button.
- [x] Scene intermissions between rounds ("Scene 2 of 3 — Cut!"); failures don't end the feature, the next scene rolls.
- [x] **Finale**: all scenes merge onto ONE map (shared answers knit rounds together; subjects pinned in a ring) + credits modal with per-scene results, totals, creator par comparison.
- [x] Blob v3: `{v:3, sc:[{m,s,g?,t?,n?,b?,wps?}], h?, bans?, ty?, ti?, tg?, by?, par:[..]}`. Studio always emits v3; v1/v2 links still load fine.
- [x] Test Run plays the whole feature via the premiere and stamps per-scene pars.
- [x] Quit now returns to where you came from (setup for quick play, premiere for links, builder for tests) instead of dumping to home.
- [x] **Scene editor rebuilt as a screen (2026-06-12):** the scene sheet modal is gone. Scenes are now edited on a full screen modeled on the quick-play setup screen — big start/goal poster cards dead center with reroll + search, mode chips up top (the title does the mode explaining), and every rule knob behind a "rules" pill with a live summary that opens a small sheet (click-depth = control depth — same pattern as the bans pill). Fixes from the old sheet: tap-outside-to-discard replaced by an explicit ← back with a confirm on dirty drafts, Save Scene properly disabled until the matchup is complete, reorder/cut moved out of the editor onto the scene rows on the stage, knowledge target relabeled "Target" (no more double "Goal").
- [x] **Per-scene rules (2026-06-11):** hints + allowed types moved from global "house rules" into each scene (they're round-difficulty knobs like clock/budget/target — and per-scene types enable themed rounds: "name only the SHOWS"). Bans stay global (a feature-spirit rule; per-scene ban lists would be miserable UI). v3 scenes carry `h`/`ty`; old global `h`/`ty` still read as fallbacks. Decision: link length is a non-concern — blobs move to Supabase later.
- [ ] **When live (Supabase era): raise the 5-scene cap** — store features as rows/files instead of URL blobs, so big features (10+ scenes) and a community browser become possible.
- [ ] Later: Spotify/soundtrack integration — creator picks a track/mood for their feature.
- Note: multi-scene features supersede the old "Hybrid mode" spec (#3) — a knowledge scene followed by classic scenes IS hybrid.

## 9. Robustness + QoL pass ✅ DONE (2026-06-11)
- [x] TMDB rate-limit resilience: all requests share a concurrency gate (max 8 in flight) + automatic retry on 429 honoring Retry-After.
- [x] Pool drain fix: when an obscurity band is exhausted in a long session, servedKeys/usedPages recycle and the band refills fresh.
- [x] Knowledge mode "⏹ i'm done" button — bank your score before the clock runs out.
- [x] Win modal "🕸 view the web" — dismisses the modal to explore the full board; floating "🏆 results" button brings it back.
- [x] Keyboard navigation in every search box: ↑/↓ walk suggestions, Enter picks (first result if none highlighted), Escape closes.
- Decision: NO penalty for wrong guesses in knowledge mode — just the error message (2026-06-11).
- Deferred: daily puzzle — wait until the site is hosted (Supabase/backend era).

## 11. The casting call ✅ DONE (2026-06-12)
Full-page TMDB browse (`screen-cast`) behind a ▦ button on every endpoint card — the "browse big" tier of click-depth = control depth (dropdown stays the default everywhere; in-game search untouched).
- [x] Grid of poster cards: name, year, type, fame badge (vote_count/popularity mapped onto the obscurity vocabulary), known-for credits on people, ＋ more pagination (capped 20 pages).
- [x] Empty query shows `/trending` (all or per type) so the page is never blank; type chips switch to typed search endpoints.
- [x] Quick-play context ("slot" mode): tap a card → fills the Start/Goal you came from → straight back. One click.
- [x] Studio context ("studio" mode): a casting session — target chips (Start / Goal / Via / Ban, mode-aware), tap to assign and stay, running tally line, ✓ done returns to the scene editor. Bans assigned here void the par immediately (global rule), via capped at 3.

## 12. The Back Lot ✅ DONE (2026-06-12)
Research mode on the home switcher (after The Studio) — the casting page in a third context (`{mode:"research"}`): no clock, no stakes, no assignment.
- [x] Tap a card → detail panel: poster, year + fame badge, overview/bio, and the item's credits as walkable mini cards (top 30; people sorted by vote count).
- [x] Tap a connection → the panel walks to it; the breadcrumb trail is literally a connection chain (tap a crumb to backtrack). New grid tap = fresh walk.
- [x] "▶ Play from here" bridges research into a classic game with the current item as Start.
- [x] Detail data cached per item (`detailCache`); stale-walk guard.

## 14. The Box Office ✅ DONE (2026-06-12)
The feature browser (`screen-office`, "🎟 the box office" ghost button on home). **Naming map decided:** "Now Showing" is RESERVED for the future daily (it means *today* on a marquee); "Box Office" is the browser (and pre-names the community charts — "Top of the Box Office"); shelves inside: Staff Picks / Your Filmography / Ticket Stubs; "The Charts" = future community shelf.
- [x] `loadFeature(blob, link?)` extracted from `tryLoadChallenge` — the shared boot path for URL links, shelf cards, and (later) community rows. `quest.blob` keeps the parsed blob for replays.
- [x] Staff Picks: 4 curated features bundled as v3 blobs (`STAFF_PICKS`) — the game ships with content.
- [x] Your Filmography: Studio Release (copy link) now also auto-saves the blob locally (`shelf` in localStorage, deduped, cap 30).
- [x] Ticket Stubs: every finished link/shelf feature records `{title, by, poster, result line, ✓/✗, date, blob}` (`stubs`, cap 30) — tap a stub to replay the exact feature. Test screenings and quick play don't record.
- [x] Card posters hydrate lazily from each blob's first scene (cached promises in `officePosters`).
- Supabase era: add "The Charts" shelf (plays / completion rate / likes per TODO #7), swap shelf storage for rows, raise caps.
- Later (Escher, 2026-06-12): a curator path — Escher authors features in the Studio and publishes them to everyone's Staff Picks (pre-backend: paste the released blob into `STAFF_PICKS`; post-backend: a flagged "curated" row). Plus user-picks / top-rated shelves when ratings exist.

## 15. Tickets — the feature as an image file ✅ DONE (2026-06-12)
Escher's idea: a feature "printed" as a designed movie-ticket PNG that IS the game — send the image, redeem it, play.
- [x] **Print a Ticket** in the Studio (next to Release; also files the feature on your shelf): canvas-drawn ticket (warm paper, marquee title, tagline, "a production by", scene count + par, perforated stub, deterministic decorative barcode) with the v3 blob embedded in a PNG `tEXt` chunk (`connection-game` keyword). Pure vanilla — CRC32 + chunk splice before IEND, round-trip unit-tested.
- [x] **Redeem** at the Box Office (file picker) or by dropping the PNG anywhere on the app → `pngReadText` → `loadFeature`.
- Decision: v1 is metadata-only — the original FILE must be sent (photo-mode recompression to JPEG strips the chunk; the error message says so). The barcode slot is reserved for a real QR in v2 (vendored jsQR), which would survive recompression and become phone-camera-scannable once hosted.

## 16. Per-device testing pass (opened 2026-06-12, site is live)
**Scope decision (Escher, 2026-07-01): PC is the primary play surface.** Phones are companions/controllers for the coming multiplayer (join code, waiting room, name+color, answer input — a few purpose-built phone-first screens), NOT a full port of the game. The bar for the existing screens on phones drops to "not broken"; deep phone layout polish of the full game is explicitly out of scope. The mobile fixes below (pinch-zoom, dvh, touch targets) stay — they make the not-broken bar real and the board is still touchable on tablets.
Known gaps from code review, before anyone even touches a device:
- [x] **Board pinch-zoom** (2026-07-01) — the board tracks its touches in `boardPointers`: one pointer pans, two pinch-zoom around the finger midpoint (midpoint drift pans simultaneously), lifting one finger hands back to panning without a hiccup. Same 0.25–2.5 scale clamp as the wheel. `touch-action: none` was already set — only the gesture logic was missing.
- [x] `100vh` audit (2026-07-01) — all six uses now pair a `100vh` fallback with a `100dvh` override (body, `.screen`, `.screen.game`, scene-editor endpoint clamp, df-deck/df-card clamps).
- [x] Touch-target audit, first pass (2026-07-01) — `@media (pointer: coarse)` block: scene tools 28→42px, header pills fatter, suggestion rows taller. Desktop visuals untouched. Deck fan tap areas left for on-device verdict.
- [x] Poster-rain: phones and low-memory devices (`navigator.deviceMemory ≤ 4`) now build 4 columns instead of building 6 and hiding 2 — no decode work for posters that never show (2026-07-01).
- [ ] Cast grid / Box Office shelves / scene editor deck at 360px widths.
- [ ] Safari specifics: View Transitions API fallback paths, `aspect-ratio` in the deck, PNG ticket download UX on iOS (no real "download" — share sheet).
- [x] Drag lag fixed (2026-06-12): node drags painted in the pointermove handler instead of waiting for the next physics frame (one-frame cursor trail), edges of the dragged node updated in the same breath.
- [x] Auto-fit camera (2026-07-01, Escher: big webs drift offscreen and force constant zoom-outs): after each placement/undo the view eases out to contain the whole web — only when it actually doesn't fit, chasing the still-settling nodes for ~0.7s, and any manual pan/pinch/wheel/drag cancels it immediately.
- [x] Board peek (2026-07-01, Escher): tap a placed node (tap-vs-drag: <8px pointer travel) → modal with big poster, name, year/type/fame meta, overview. Deliberately NO credits mid-game — that's a free answer sheet; the Back Lot is where credits walk. Reuses `loadDetail`'s cache.
- [x] Centering gravity (2026-07-01, Escher: auto-fit is cool but big webs end up so zoomed out): nodes beyond `GRAV_FREE` of the web's centroid get a pull proportional to the overshoot (`GRAV`). Compact webs never feel it — no jitter fights with the `MIN_SEP` pass; sprawling webs pull in so the camera doesn't have to retreat as far.
- [x] Local repulsion (2026-07-01, Escher: "line line line" — wants clumps, a half-point): repulsion now fades linearly to zero at `REPULSE_RANGE` (380px). Global all-pairs push is exactly what straightened every chain into a line; with local push, chains kink and branches nestle. `REPULSION` bumped 72k→90k to keep near-field spacing through the fade; `GRAV_FREE` 420→320 so clumps gather sooner. Knobs: `REPULSE_RANGE` down = clumpier, up = straighter.
- [x] Hint frontier bug (2026-07-01, Escher: "hints only go out 1 from the person"): stepping-stone hints always expanded from the start/goal endpoint itself, orbiting it at radius 1 forever (a person goal = endless list of their movies). Now they expand from the component node FARTHEST from the endpoint (BFS distance, random among ties, falling inward when a node's fresh credits run dry) — successive hints walk outward toward the other side.

## 13. The Archives (idea, no code — 2026-06-12)
A separate screen like achievements but *discoveries*: a record of what you've found across games — connections discovered, chains walked, rare deep-cut placements, maybe "first time you used X". Name reserved from the Back Lot naming discussion. Spec TBD; likely wants persistence (localStorage now, Supabase later).

## 1. Multiplayer mode
Phased approach (no backend exists today):
- [x] **Phase A — Challenge links (no server) ✅:** start/goal/timer/hints encoded in the URL hash (the #7 blob, v1). Home button cycles Classic ↔ Challenge a Friend; setup screen has copy-link; win screen has "copy challenge" with score text; opening a link jumps straight onto that board with the creator's rules. NOTE: links only work for others once the game is hosted on a real URL (file:// paths don't travel).
- [ ] **Phase B — Local same-screen:** co-op (build one web together) and versus (turn-based or split board).
  - Idea (Escher, 2026-06-12): Jackbox-style couch play — the PC hosts and its screen is the shared stage; players join a waiting room from their phones, pick a name + a color, and answer an icebreaker question shown on the host screen (e.g. "favorite actor"), answers popping up as they arrive. Build the screens (waiting room, host stage) before any backend; wire up rooms/realtime in the Supabase era. Spec TBD — to be designed together.
  - Confirmed (Escher, 2026-07-01): the phone side is ONLY the companion screens (join code, waiting room, input) — phone-first designs of their own, not adaptations of the PC screens. PC is the primary play surface (see #16 scope decision).
- [ ] **Phase C — Real-time online:** separate boards, win by faster time or fewer connections. Needs a small WebSocket server or Firebase-style service.

## 2. Sound effects
- [x] Sound list defined — Escher is producing the audio files (place-success, place-fail, win, reroll, ui-click, game-start, timer-tick, timer-end → `sounds/` folder).
- [ ] Wire up playback once files exist.
- [ ] Mute/volume toggle (persist in localStorage, place near theme toggle).

## 3. Game modes (knowledge / hybrid) — SPEC LOCKED 2026-06-11
- [x] Hints + timer wired into gameplay: countdown in header with low-time warning, time's-up modal ("Run It Back" replays the same board), 💡 hint button names something one step from the goal/start, hint count shown on win.
- [x] Mode-select exists: home ‹ › switcher (Classic / Challenge) — new modes slot in there.

**Knowledge mode (blitz):**
- One start item, center of the board. Name as many DIRECT connections as you can before the clock (default 2 min). Placements must connect to the start item itself, not just anything on the board — answers spoke out around it.
- Search stays as-is (it only matches typed text, never reveals connections; wrong guesses cost time).
- Clock out → results modal with your count. Challenge link carries start + time + your count as the bar to beat.
- [x] Built ✅ (2026-06-11): home switcher entry, single-card setup, direct-connection placement rule, forced timer, results modal with bar comparison, knowledge challenge links (m:"k" blob), hint button disabled in this mode.

**Double Feature (replaced the two-phase hybrid spec, 2026-06-12):**
- The original hybrid (knowledge warmup → hidden-goal reveal) was built and then cut THE SAME DAY after an honest review: phase 1 was a toll booth (you can't aim openers at goals you can't see, so the dominant play was rote super-connectors every game). Decision: strategy needs information.
- [x] What shipped instead: **one start, 1–3 goals, all visible from setup** (each goal slot has its own reroll/search), everything on the board from move 1, win = every goal connected. Shared trunks are the skill — the win stat counts nodes that pulled double duty across paths. Goals knob (default 2, max 3 in quick play) persists in settings outside the presets. Header chips: poster thumb + name, ✓ when reached, tap = marquee peek (top billed names — kept from the hybrid build, still great for deep cuts). Hints chase the first unreached goal. Run It Back replays the same bill. Internal mode id is still `"hybrid"`.
- No double-feature challenge links yet (share buttons hidden) — blob `m:"h"` reserved; Studio double-feature scenes possible later (cap 5 goals there?).
- Salvageable someday: the hidden-goal reveal as a classic "surprise me" toggle (fame floor + peek made it viable; the warmup gate was the problem, not the surprise).

## 8. How to play page ✅ DONE
- [x] Dedicated screen linked from home: 4 rule cards, example chain (Dark Knight → Cillian Murphy → Oppenheimer), tips for hints/timer/board controls, CTA straight into setup.

## 7. Custom games + community browser (design locked, no code yet)
A custom game is a small JSON blob (~300 bytes). Challenge links (#1 Phase A) are this blob serialized into a URL — build the format first, links second, browser last; nothing gets thrown away.

**The blob — core puzzle:**
- Start + goal as fixed TMDB items (type + id), creator-picked.
- Title + blurb (flavor text, e.g. "The Two Batmans"), creator name, puzzle ID/slug.

**Creator-set rules:**
- Timer on/off + minutes; hints allowed or not.
- Placement budget ("solve in ≤ 6 placements").
- Bans: specific items (e.g. super-connectors like Samuel L. Jackson) or whole types ("movies only").
- Waypoints: chain must pass through a given item or category.

**Completion rule (decided):** STRICT — every constraint the creator sets is pass/fail. Beat the clock AND stay in budget AND hit waypoints, or the run does not count as a completion. Connecting without meeting constraints = attempt, not completion.

**Solvability proof + par (decided):** creator must solve their own puzzle before publishing. Proves solvability, sets par (creator's link count), blocks troll puzzles.

**Community browser (needs a backend — same infra decision as real-time multiplayer):**
- Per puzzle: plays, completion rate (the real difficulty rating), average links, likes/saves, tags, best-ever solution + holder.
- Featured/daily slots curated from the pool.

Build order: blob format → challenge links (no backend) → community browser (backend).

**Challenge Builder — BUILT ✅ (2026-06-11):** dedicated screen via "Challenge a Friend"; Classic/Knowledge modes (Hybrid stubbed); budget, bans, waypoint, type restrictions, timer/hints; title + creator; Test Run stamps par (classic = links, knowledge = count); v2 blob with strict enforcement (banned/type-blocked placements rejected, budget spend = fail modal, waypoint required in win path, par compared on win). v1 links still work.

**Original spec (for reference):**
- Entry: home → "Challenge a Friend" goes to the builder screen (not the plain setup).
- Sections:
  - **Mode** — Classic / Knowledge / Hybrid; pickers adapt (Classic: start+goal; Knowledge: start + minutes; Hybrid: start + N goals + K openers).
  - **Rules** — timer, hints allowed, placement budget, banned items (searchable chip list), required waypoint, type restrictions (e.g. movies only).
  - **Identity** — challenge title / taunt line, creator name.
  - **Verify (optional)** — solve it yourself first; your result is stamped into the link as par ("creator did it in 4").
  - **Share** — copy link.
- Blob v2: { v:2, mode, s, g | goals[], k, t, h, budget, bans[], wp, types, title, by, par }. v1 links keep working.
- Engine enforcement (strict, per completion rule): bans rejected at placement with a message; waypoint checked in win path; budget counter visible in-game ("4/6"), exceeding = failed attempt modal.

## 6. Page transitions ✅ DONE
- [x] Radial reveal between screens (View Transitions API, same look as the theme toggle), expanding from the last click point; instant fallback on unsupported browsers; respects prefers-reduced-motion.

## 4. Node collision — items on top of each other push away ✅ DONE
- [x] Hard minimum-separation pass in `physicsTick` (positional, eased over a few frames): overlapping nodes always push apart, pinned/dragged nodes shove others the full distance, dead-center stacks split in a random direction.

## 5. Home page background — scrolling poster columns ✅ DONE
- [x] 6 vertical columns (4 on phones) scrolling top→bottom infinitely, each at a random speed/offset.
- [x] Mix of movies, shows, and people — re-interleaved by type so every column has all three.
- [x] Reuses poster URLs from the already-prefetched pools (zero extra API calls, w185 size).
- [x] Dimmed + paper-gradient veil clears a soft window behind the hero; respects prefers-reduced-motion.
- [x] Fallback when no API key / API failure: blobs-only, current look.
