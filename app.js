// ===== The Connection Game =====
// Chain rule: a person connects to a movie/show they appeared in (cast).
// Board is a graph — branching is allowed. Win when start and goal are linked
// by any path; score is the shortest path.

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w342";

// The house key: lets visitors on the live site play instantly, no
// signup wall. TMDB keys are client-visible by nature; anyone can still
// bring their own via "change api key" (their key wins once saved).
const DEFAULT_TMDB_KEY = "2d93c6b7fd37267cb508e4cf8ce02dda";

let apiKey = localStorage.getItem("tmdb_key") || DEFAULT_TMDB_KEY;

// ---- API helper (supports v3 key or v4 bearer token) ----
// Every request funnels through a small concurrency gate plus 429 retry,
// so burst-heavy callers (the bridge-finder fetches credits for every
// board node at once) can't trip TMDB's rate limiter.
const MAX_INFLIGHT = 8;
let inflight = 0;
const fetchQueue = [];

function acquireSlot() {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => fetchQueue.push(resolve));
}

function releaseSlot() {
  const next = fetchQueue.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else inflight--;
}

async function tmdb(path, params = {}) {
  const url = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const opts = {};
  if (apiKey.length > 60) {
    opts.headers = { Authorization: "Bearer " + apiKey };
  } else {
    url.searchParams.set("api_key", apiKey);
  }
  await acquireSlot();
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, opts);
      if (res.status === 429 && attempt < 3) {
        const waitSec = +res.headers.get("Retry-After") || 1 + attempt;
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      if (!res.ok) throw new Error("TMDB error " + res.status);
      return res.json();
    }
  } finally {
    releaseSlot();
  }
}

// ---- Item model ----
// item = { key, id, type: 'movie'|'tv'|'person', name, img, fame }
// fame = raw TMDB popularity (people) / vote_count (titles); null when the
// source response didn't carry it — unknown fame never scores either way.
function makeItem(raw, type) {
  const t = type || raw.media_type;
  return {
    key: t + "-" + raw.id,
    id: raw.id,
    type: t,
    name: raw.title || raw.name,
    img: raw.poster_path || raw.profile_path
      ? IMG + (raw.poster_path || raw.profile_path)
      : null,
    fame: t === "person" ? raw.popularity ?? null : raw.vote_count ?? null,
  };
}

// The one fame vocabulary (casting-page badges + deep-cut scoring).
// Returns null for unknown fame so scoring can skip it.
// Person thresholds recalibrated 2026-07-01 against TMDB's reworked popularity
// (now a compressed, trending-driven scale — megastars baseline ~5-12, character
// actors ~2-3.5, true obscurities <1; trending people spike into the hundreds,
// which only ever errs toward "famous"). Samples at calibration: Cruise 9.2,
// Sandler 5.5, Rockwell 4.1, Trejo 3.4, Tobolowsky 2.6, Clint Howard 1.9,
// Al Mancini 0.75. Title vote_count was never rescaled — those bands stand.
function fameTier(fame, type) {
  if (fame == null) return null;
  if (type === "person")
    return fame >= 4 ? "famous" : fame >= 2.2 ? "known" : fame >= 1 ? "deep cut" : "crazy";
  return fame >= 8000 ? "famous" : fame >= 1500 ? "known" : fame >= 250 ? "deep cut" : "crazy";
}

// The wow lives in the credit, not the celebrity (Escher, 2026-07-01): a link's
// surprise is named by its more OBSCURE end. Sandler is famous, but "Sandler
// was in Airheads" is a deep cut — and "that guy was in Titanic" is one too.
// famous↔famous = obvious; either end deep-cut/crazy = the pull.
// Returns null when either end's fame is unknown (never scores either way).
const FAME_RANK = { famous: 0, known: 1, "deep cut": 2, crazy: 3 };
function edgeTier(a, b) {
  const ta = fameTier(a.fame, a.type);
  const tb = fameTier(b.fame, b.type);
  if (!ta || !tb) return null;
  return FAME_RANK[ta] >= FAME_RANK[tb] ? ta : tb;
}

const TYPE_LABEL = { movie: "Movie", tv: "TV Show", person: "Person" };
const TYPE_EMOJI = { movie: "🎬", tv: "📺", person: "🧑" };
const isTitle = (item) => item.type === "movie" || item.type === "tv";

// ---- Credits cache + connection check ----
const creditsCache = new Map(); // key -> Set of connected keys

async function getConnections(item) {
  if (creditsCache.has(item.key)) return creditsCache.get(item.key);
  const set = new Set();
  if (item.type === "person") {
    const data = await tmdb(`/person/${item.id}/combined_credits`);
    for (const c of data.cast || []) {
      if (c.media_type === "movie" || c.media_type === "tv")
        set.add(c.media_type + "-" + c.id);
    }
  } else if (item.type === "movie") {
    const data = await tmdb(`/movie/${item.id}/credits`);
    for (const c of data.cast || []) set.add("person-" + c.id);
  } else {
    const data = await tmdb(`/tv/${item.id}/aggregate_credits`);
    for (const c of data.cast || []) set.add("person-" + c.id);
  }
  creditsCache.set(item.key, set);
  return set;
}

// Two items connect if one is a person, the other a title, and either
// side's credits list the other (TV aggregate vs combined credits can
// disagree, so check both directions).
async function connects(a, b) {
  if (isTitle(a) === isTitle(b)) return false;
  const setA = await getConnections(a);
  if (setA.has(b.key)) return true;
  const setB = await getConnections(b);
  return setB.has(a.key);
}

// ---- Random item pool, bucketed by obscurity ----
// Titles come from /discover sorted by total vote count — the strongest
// "have people actually seen this" signal (plain /popular is traffic-driven
// and gets obscure fast). People come from /person/popular. Each obscurity
// level draws from its own page band and keeps its own prefetch pool, so
// switching levels keeps rerolls instant.
const POOL_LOW_WATER = 10;
const OBSCURITY_BANDS = {
  famous: { title: [1, 5], person: [1, 2] },   // top ~100 titles, A-list people
  known:  { title: [6, 25], person: [3, 10] },
  deep:   { title: [26, 80], person: [11, 40] },
  crazy:  { title: [81, 250], person: [41, 150] }, // rank ~1600-5000 — you'd better know your stuff
};
const pools = { famous: [], known: [], deep: [], crazy: [] };
const servedKeys = new Set();
const usedPages = {};    // "level:type" -> Set of pages already pulled
const fillPromises = {}; // level -> in-flight fill

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomPage(level, type) {
  const [lo, hi] = OBSCURITY_BANDS[level][type === "person" ? "person" : "title"];
  const span = hi - lo + 1;
  const key = level + ":" + type;
  const used = usedPages[key] || (usedPages[key] = new Set());
  let p;
  do {
    p = lo + Math.floor(Math.random() * span);
  } while (used.has(p) && used.size < span);
  used.add(p);
  return p;
}

function fetchTypePage(level, type) {
  const page = randomPage(level, type);
  if (type === "person") return tmdb("/person/popular", { page });
  return tmdb(`/discover/${type}`, {
    page,
    sort_by: "vote_count.desc",
    include_adult: "false",
  });
}

function fillPool(level = settings.obscurity) {
  if (fillPromises[level]) return fillPromises[level];
  fillPromises[level] = (async () => {
    const pool = pools[level];
    const types = ["movie", "tv", "person"];
    const lists = await Promise.all(
      types.map(async (type) => {
        const data = await fetchTypePage(level, type);
        let raws = data.results || [];
        if (type === "person")
          raws = raws.filter((r) => r.known_for_department === "Acting");
        return shuffle(
          raws
            .map((r) => makeItem(r, type))
            .filter(
              (it) =>
                it.img && // endpoints deserve artwork
                !servedKeys.has(it.key) &&
                !pool.some((p) => p.key === it.key)
            )
        );
      })
    );
    // round-robin merge so the mix of movies/shows/people stays even
    const max = Math.max(...lists.map((l) => l.length));
    for (let i = 0; i < max; i++) {
      for (const list of shuffle([...lists])) {
        if (list[i]) pool.push(list[i]);
      }
    }
    preloadPosters(pool);
  })().finally(() => {
    fillPromises[level] = null;
  });
  return fillPromises[level];
}

// Warm the next few posters of EACH type, so type-filtered rerolls
// (which skip deeper into the pool) are just as instant as "any".
function preloadPosters(pool) {
  const seen = { movie: 0, tv: 0, person: 0 };
  for (const it of pool) {
    if (seen[it.type] >= 3) continue;
    seen[it.type]++;
    if (it.img && !it.preloaded) {
      new Image().src = it.img.replace("/w342/", "/w500/");
      it.preloaded = true;
    }
    if (seen.movie >= 3 && seen.tv >= 3 && seen.person >= 3) break;
  }
}

// Resolve once the poster is downloaded AND decoded, so the card swap
// paints in a single frame instead of name-first, image-later.
async function posterReady(item) {
  if (!item.img) return;
  const img = new Image();
  img.src = item.img.replace("/w342/", "/w500/");
  try {
    await img.decode();
  } catch {
    /* broken image — render anyway */
  }
}

// Direct single fetch — only used if the pool somehow can't serve.
async function randomItemDirect(type = "any", level = settings.obscurity) {
  if (type === "any")
    type = ["movie", "tv", "person"][Math.floor(Math.random() * 3)];
  const data = await fetchTypePage(level, type);
  let results = data.results || [];
  if (type === "person")
    results = results.filter((r) => r.known_for_department === "Acting");
  if (!results.length) throw new Error("no items available for " + type);
  return makeItem(results[Math.floor(Math.random() * results.length)], type);
}

// `exclude` may be a single key, an array/Set of keys, or falsy — callers that
// need to avoid several already-chosen endpoints (double feature) pass a set.
async function takeRandomItem(exclude, type = "any", level = settings.obscurity) {
  const excludeSet =
    exclude instanceof Set
      ? exclude
      : Array.isArray(exclude)
        ? new Set(exclude)
        : exclude
          ? new Set([exclude])
          : new Set();
  const pool = pools[level];
  const matches = (it) =>
    !excludeSet.has(it.key) && (type === "any" || it.type === type);
  if (pool.length === 0) await fillPool(level);
  let idx = pool.findIndex(matches);
  if (idx < 0) {
    await fillPool(level);
    idx = pool.findIndex(matches);
  }
  if (idx < 0) {
    // band exhausted in a long session — recycle it: forget what's been
    // served and which pages were pulled, then refill fresh
    servedKeys.clear();
    for (const k of Object.keys(usedPages))
      if (k.startsWith(level + ":")) usedPages[k].clear();
    await fillPool(level);
    idx = pool.findIndex(matches);
  }
  const item = idx >= 0 ? pool.splice(idx, 1)[0] : await randomItemDirect(type, level);
  servedKeys.add(item.key);
  if (pool.length < POOL_LOW_WATER) fillPool(level).catch(() => {});
  preloadPosters(pool);
  return item;
}

// ===== Screens =====
const screens = ["key", "home", "how", "build", "scene", "cast", "office", "mode", "game", "premiere", "lobby"];
function show(name) {
  for (const s of screens)
    document.getElementById("screen-" + s).classList.toggle("hidden", s !== name);
}
const $ = (sel) => document.querySelector(sel);

// Radial reveal between screens (same trick as the theme toggle),
// expanding from wherever the user last clicked. Resolves once the
// DOM has actually switched, so callers can measure the new screen.
let lastClick = { x: innerWidth / 2, y: innerHeight / 2 };
document.addEventListener(
  "pointerdown",
  (e) => { lastClick = { x: e.clientX, y: e.clientY }; },
  true
);

function showT(name) {
  if (!document.startViewTransition) {
    show(name);
    return Promise.resolve();
  }
  const root = document.documentElement.style;
  root.setProperty("--reveal-x", lastClick.x + "px");
  root.setProperty("--reveal-y", lastClick.y + "px");
  root.setProperty(
    "--reveal-r",
    Math.hypot(
      Math.max(lastClick.x, innerWidth - lastClick.x),
      Math.max(lastClick.y, innerHeight - lastClick.y)
    ) + "px"
  );
  root.setProperty("--reveal-dur", "0.8s"); // navigation is snappier than the theme fade
  const t = document.startViewTransition(() => show(name));
  t.finished.finally(() => root.removeProperty("--reveal-dur"));
  return t.updateCallbackDone;
}

// ---- Key screen ----
$("#key-save").addEventListener("click", async () => {
  const val = $("#key-input").value.trim();
  if (!val) return;
  apiKey = val;
  try {
    await tmdb("/configuration");
    localStorage.setItem("tmdb_key", val);
    $("#key-error").classList.add("hidden");
    showT("home");
    fillPool().catch(() => {});
    initPosterRain();
    initDailyStrip();
    tryLoadChallenge(); // a first-time player may have arrived via a link
  } catch {
    $("#key-error").textContent = "That key didn't work — TMDB rejected it.";
    $("#key-error").classList.remove("hidden");
  }
});
$("#key-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#key-save").click();
});

$("#btn-change-key").addEventListener("click", () => {
  $("#key-input").value = "";
  showT("key");
});

// ---- Home screen ----
$("#btn-mode").addEventListener("click", async () => {
  const id = HOME_MODES[homeModeIdx].id;
  if (id === "challenge") {
    openBuilder();
    return;
  }
  if (id === "backlot") {
    openCasting({ mode: "research" });
    return;
  }
  playMode = id; // classic | knowledge | hybrid (double feature)
  applySetupMode();
  showT("mode");
  if (playMode === "classic")
    await Promise.all([rerollSlot("start"), rerollSlot("end")]);
  else if (playMode === "hybrid")
    await Promise.all([rerollSlot("start"), ensureGoalSlots()]);
  else await rerollSlot("start"); // knowledge sets up one card
});
$("#btn-back-home").addEventListener("click", () => showT("home"));

// ---- Home mode switcher ----
// The big button cycles through play modes; future modes slot in here.
const HOME_MODES = [
  { id: "classic", label: "Play Classic", desc: "Random corners of cinema — link them." },
  { id: "knowledge", label: "Play Knowledge", desc: "One subject, one clock — name everything connected to it." },
  { id: "hybrid", label: "Play Double Feature", desc: "One start, many destinations — weave a web that reaches them all." },
  { id: "challenge", label: "The Studio", desc: "Direct a feature: stack scenes, set the rules, share the premiere." },
  { id: "backlot", label: "The Back Lot", desc: "No clock, no stakes — wander the catalog and follow the threads." },
];
let homeModeIdx = 0;
let playMode = "classic"; // gameplay ruleset chosen on the home screen

function applySetupMode() {
  const k = playMode === "knowledge";
  const h = playMode === "hybrid";
  document.body.classList.toggle("knowledge-intent", k);
  document.body.classList.toggle("hybrid-intent", h);
  $("#screen-mode .setup-title").innerHTML = k
    ? `Name everything tied to <em>this</em>.`
    : h
      ? `Connect <em>this</em> to <em>all of those</em>.`
      : `Connect <em>this</em> to <em>that</em>.`;
  if (h) renderGoalStack();
}

function renderHomeMode() {
  const mode = HOME_MODES[homeModeIdx];
  const label = $("#mode-label");
  label.textContent = mode.label;
  $("#mode-desc").textContent = mode.desc;
  $("#btn-mode").classList.toggle("studio", mode.id === "challenge");
  // re-trigger the swap animation
  label.classList.remove("swapping");
  void label.offsetWidth;
  label.classList.add("swapping");
}

$("#mode-prev").addEventListener("click", () => {
  homeModeIdx = (homeModeIdx - 1 + HOME_MODES.length) % HOME_MODES.length;
  renderHomeMode();
});
$("#mode-next").addEventListener("click", () => {
  homeModeIdx = (homeModeIdx + 1) % HOME_MODES.length;
  renderHomeMode();
});
renderHomeMode();

// ---- How to play ----
$("#btn-how").addEventListener("click", () => showT("how"));
$("#btn-how-back").addEventListener("click", () => showT("home"));
$("#btn-how-play").addEventListener("click", async () => {
  playMode = "classic";
  applySetupMode();
  showT("mode");
  await Promise.all([rerollSlot("start"), rerollSlot("end")]);
});

// ---- Mode screen ----
const slots = { start: null, end: null };

function renderItemDisplay(el, item) {
  if (!item) {
    el.innerHTML = `<div class="poster-fallback loading">🎞️</div>`;
    return;
  }
  const poster = item.img ? item.img.replace("/w342/", "/w500/") : null;
  el.innerHTML = `
    ${poster ? `<img src="${poster}" alt="">` : `<div class="poster-fallback">${TYPE_EMOJI[item.type]}</div>`}
    <div class="poster-scrim"></div>
    <div class="poster-info">
      <div class="item-name">${esc(item.name)}</div>
      <div class="item-type">${TYPE_LABEL[item.type]}</div>
    </div>`;
}

const slotFilter = { start: "any", end: "any" };
const rerollSeq = { start: 0, end: 0 }; // guards against out-of-order results

// the start slot has two faces (classic card + double-feature deck card)
function renderSlotDisplays(slot, item) {
  document
    .querySelectorAll(`.item-display[data-slot="${slot}"]`)
    .forEach((el) => renderItemDisplay(el, item));
}

async function rerollSlot(slot) {
  const token = ++rerollSeq[slot];
  if (pools[settings.obscurity].length === 0) renderSlotDisplays(slot, null); // loading pulse only on cold start
  // never roll a duplicate of another live endpoint — in double feature the
  // start must dodge every goal, and the classic goal must dodge the start
  const exclude = new Set();
  if (slot === "start") {
    if (slots.end) exclude.add(slots.end.key);
    if (playMode === "hybrid")
      for (let i = 0; i < settings.hybridN; i++)
        if (goalSlots[i]) exclude.add(goalSlots[i].key);
  } else if (slots.start) {
    exclude.add(slots.start.key);
  }
  const item = await takeRandomItem(exclude, slotFilter[slot]);
  await posterReady(item);
  if (token !== rerollSeq[slot]) return; // a newer reroll/pick superseded this one
  slots[slot] = item;
  renderSlotDisplays(slot, item);
}

document.querySelectorAll(".reroll").forEach((btn) =>
  btn.addEventListener("click", () => rerollSlot(btn.dataset.slot))
);

// Type filter chips — picking one rerolls that slot to the chosen type
document.querySelectorAll(".type-filter").forEach((group) =>
  group.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const slot = group.dataset.slot;
    slotFilter[slot] = chip.dataset.type;
    group.querySelectorAll(".chip").forEach((c) =>
      c.classList.toggle("active", c === chip)
    );
    rerollSlot(slot);
  })
);

// ---- Search / autocomplete (shared) ----
function esc(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function attachAutocomplete(input, listEl, onPick) {
  let timer = null;
  let items = [];
  let active = -1; // keyboard-highlighted row

  // Open on whichever side of the input has room and never run past the
  // viewport edge — inputs low on the page (under the poster cards) used
  // to push the results below the fold.
  const placeList = () => {
    const r = input.getBoundingClientRect();
    const below = innerHeight - r.bottom - 20;
    const above = r.top - 20;
    const openUp = below < 240 && above > below;
    listEl.classList.toggle("up", openUp);
    listEl.style.maxHeight =
      Math.max(140, Math.min(330, openUp ? above : below)) + "px";
  };

  const renderActive = () => {
    [...listEl.children].forEach((li, i) =>
      li.classList.toggle("active", i === active)
    );
    if (active >= 0)
      listEl.children[active]?.scrollIntoView({ block: "nearest" });
  };

  const pick = (i) => {
    if (!items[i]) return;
    listEl.classList.add("hidden");
    active = -1;
    input.value = "";
    onPick(items[i]);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      listEl.classList.add("hidden");
      return;
    }
    timer = setTimeout(async () => {
      try {
        const data = await tmdb("/search/multi", { query: q, include_adult: "false" });
        items = (data.results || [])
          .filter((r) => ["movie", "tv", "person"].includes(r.media_type))
          .slice(0, 8)
          .map((r) => makeItem(r));
        active = -1;
        listEl.innerHTML = items
          .map(
            (it, i) => `<li data-i="${i}">
              ${it.img ? `<img src="${it.img}">` : `<div class="no-img">${TYPE_EMOJI[it.type]}</div>`}
              <div><div class="s-name">${esc(it.name)}</div>
              <div class="s-type">${TYPE_LABEL[it.type]}</div></div></li>`
          )
          .join("");
        placeList();
        listEl.classList.toggle("hidden", items.length === 0);
      } catch {
        listEl.classList.add("hidden");
      }
    }, 300);
  });

  // arrows walk the list, Enter picks (first result if nothing highlighted),
  // Escape closes — every search box gets this for free
  input.addEventListener("keydown", (e) => {
    if (listEl.classList.contains("hidden") || !items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % items.length;
      renderActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + items.length) % items.length;
      renderActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(active >= 0 ? active : 0);
    } else if (e.key === "Escape") {
      listEl.classList.add("hidden");
      active = -1;
    }
  });

  listEl.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (li) pick(+li.dataset.i);
  });

  document.addEventListener("click", (e) => {
    if (!input.parentElement.contains(e.target)) listEl.classList.add("hidden");
  });
}

// Endpoint search boxes on mode screen
document.querySelectorAll(".endpoint-search").forEach((input) => {
  const listEl = input.parentElement.querySelector(".suggestions");
  attachAutocomplete(input, listEl, (item) => {
    const slot = input.dataset.slot;
    rerollSeq[slot]++; // cancel any in-flight reroll for this slot
    slots[slot] = item;
    renderSlotDisplays(slot, item);
  });
});

// ---- Double-feature poster deck (1 start front, goals fanned behind) ----
const goalSlots = [null, null, null];
const goalRollSeq = [0, 0, 0];
let dfSel = "start"; // which card is at the front: "start" | 0 | 1 | 2

// lay the deck out around the selection and repaint every card
function renderDF() {
  if (typeof dfSel === "number" && dfSel >= settings.hybridN) dfSel = "start";
  const behind = ["pos-l", "pos-r", "pos-l2"];
  let bi = 0;
  document.querySelectorAll(".df-card").forEach((el) => {
    const id = el.dataset.card;
    el.classList.remove("pos-front", "pos-l", "pos-r", "pos-l2");
    if (id !== "start" && +id >= settings.hybridN) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    el.classList.add(String(dfSel) === id ? "pos-front" : behind[bi++ % 3]);
  });
  renderSlotDisplays("start", slots.start);
  for (let i = 0; i < 3; i++) {
    const el = document.querySelector(`.item-display[data-goal-slot="${i}"]`);
    if (el && i < settings.hybridN) renderItemDisplay(el, goalSlots[i]);
  }
}
// classic/knowledge keep their own layouts — the deck is hybrid-only
function renderGoalStack() {
  renderDF();
}

async function rerollGoalSlot(i) {
  const token = ++goalRollSeq[i];
  const el = document.querySelector(`.item-display[data-goal-slot="${i}"]`);
  if (!goalSlots[i]) renderItemDisplay(el, null); // loading pulse on empty card
  // dodge the start and every OTHER goal so the deck can't hold two of a kind
  const exclude = new Set();
  if (slots.start) exclude.add(slots.start.key);
  for (let j = 0; j < settings.hybridN; j++)
    if (j !== i && goalSlots[j]) exclude.add(goalSlots[j].key);
  const item = await takeRandomItem(exclude);
  await posterReady(item);
  if (token !== goalRollSeq[i]) return;
  goalSlots[i] = item;
  renderItemDisplay(el, item);
}

// fill whatever visible goal slots are still empty
function ensureGoalSlots() {
  renderDF();
  const jobs = [];
  for (let i = 0; i < settings.hybridN; i++)
    if (!goalSlots[i]) jobs.push(rerollGoalSlot(i));
  return Promise.all(jobs);
}

// tap a fanned poster to bring it forward; the tools act on the front card
$("#df-deck").addEventListener("click", (e) => {
  const card = e.target.closest(".df-card");
  if (!card) return;
  const id = card.dataset.card;
  const sel = id === "start" ? "start" : +id;
  if (sel === dfSel) return;
  dfSel = sel;
  renderDF();
});

$("#df-reroll").addEventListener("click", () => {
  if (dfSel === "start") rerollSlot("start");
  else rerollGoalSlot(dfSel);
});

$("#df-browse").addEventListener("click", () => {
  openCasting(
    dfSel === "start"
      ? { mode: "slot", slot: "start" }
      : { mode: "slot", goal: dfSel }
  );
});

attachAutocomplete(
  $("#df-search"),
  $("#df-search").parentElement.querySelector(".suggestions"),
  (item) => {
    if (dfSel === "start") {
      rerollSeq.start++;
      slots.start = item;
      renderSlotDisplays("start", item);
    } else {
      goalRollSeq[dfSel]++;
      goalSlots[dfSel] = item;
      renderItemDisplay(
        document.querySelector(`.item-display[data-goal-slot="${dfSel}"]`),
        item
      );
    }
  }
);

// ===== Game =====
const game = {
  mode: "classic", // "classic" | "knowledge"
  nodes: new Map(), // key -> item
  edges: new Map(), // key -> Set of neighbor keys
  startKey: null,
  endKey: null,
  placed: 0,
  lastPlaced: null, // key of the most recent placement — undoable until the next one
  won: false,
  over: false, // time ran out
  bar: 0, // knowledge: challenger's score to beat
  rules: null, // custom-challenge rules: { budget, bans, waypoint, types, par, title, by }
  phase: 0, // double feature: 2 while racing (kept for win-check gating)
  goals: [], // double feature: the destinations
  goalKeys: null, // double feature: Set of goal keys (board styling)
};
let lastEndpoints = null; // remembered for "run it back" after a loss
let hintsUsed = 0;

$("#btn-start-game").addEventListener("click", () => {
  quest.active = false; // quick play — no premiere, no scenes
  if (playMode === "knowledge") {
    if (!slots.start) return;
    startKnowledge(structuredClone(slots.start));
    return;
  }
  if (playMode === "hybrid") {
    const goals = goalSlots.slice(0, settings.hybridN).filter(Boolean);
    if (!slots.start || goals.length < settings.hybridN) return;
    const keys = new Set(goals.map((g) => g.key));
    if (keys.has(slots.start.key) || keys.size < goals.length) {
      alert("The start and every goal must be different items!");
      return;
    }
    startHybrid(structuredClone(slots.start), structuredClone(goals));
    return;
  }
  if (!slots.start || !slots.end) return;
  if (slots.start.key === slots.end.key) {
    alert("Start and goal are the same item — change one of them!");
    return;
  }
  startGame(structuredClone(slots.start), structuredClone(slots.end));
});

// Knowledge blitz: one subject in the center, name as many direct
// connections as the clock allows. `bar` is a challenger's score to beat.
async function startKnowledge(start, bar = 0, rules = null) {
  dailyActive = false;
  lastEndpoints = { start: structuredClone(start), end: null };
  game.rules = rules;
  game.mode = "knowledge";
  game.nodes = new Map([[start.key, start]]);
  game.edges = new Map([[start.key, new Set()]]);
  game.startKey = start.key;
  game.endKey = null;
  game.placed = 0;
  game.lastPlaced = null;
  game.won = false;
  game.over = false;
  game.bar = bar;
  game.target = rules?.target || 0; // scene goal: name this many to clear it
  game.phase = 0;
  game.goals = [];
  game.goalKeys = null;
  hintsUsed = 0;

  sim.clear();
  edgeEls.length = 0;
  nodesLayer.innerHTML = "";
  edgesSvg.innerHTML = "";
  $("#btn-show-results").classList.add("hidden");

  $("#game-goal").innerHTML =
    `<span class="goal-start">${esc(start.name)}</span>` +
    `<span class="goal-sep">·</span>` +
    `<span class="goal-end">${game.target ? `name ${game.target}` : bar ? `beat ${bar}` : "name its connections"}</span>`;
  $("#btn-hint").classList.add("hidden"); // a hint here would just be an answer
  $("#btn-finish").classList.remove("hidden"); // bank your score before the clock
  setMessage("");
  updateStats();
  startTimer(true); // blitz — the clock always runs
  await showT("game");

  addBoardNode(start, 0, 0, true);
  const rect = viewport.getBoundingClientRect();
  view.scale = 1;
  view.x = rect.width / 2;
  view.y = rect.height / 2 - 30;
  applyView();

  boardActive = true;
  $("#game-search-input").focus();
}

async function startGame(start, end, rules = null) {
  dailyActive = pendingDaily; // Now Showing arrives through here
  pendingDaily = false;
  lastEndpoints = {
    start: structuredClone(start),
    end: structuredClone(end),
    daily: dailyActive, // so a retry after a loss still counts as the daily
  };
  game.rules = rules;
  game.mode = "classic";
  game.nodes = new Map([[start.key, start], [end.key, end]]);
  game.edges = new Map([[start.key, new Set()], [end.key, new Set()]]);
  game.startKey = start.key;
  game.endKey = end.key;
  game.placed = 0;
  game.lastPlaced = null;
  game.won = false;
  game.over = false;
  game.target = 0;
  game.phase = 0;
  game.goals = [];
  game.goalKeys = null;
  hintsUsed = 0;

  // reset the board
  sim.clear();
  edgeEls.length = 0;
  nodesLayer.innerHTML = "";
  edgesSvg.innerHTML = "";
  $("#btn-show-results").classList.add("hidden");

  const extras = [];
  if (rules?.waypoints?.length)
    extras.push(`via ${rules.waypoints.map((w) => esc(w.name)).join(", ")}`);
  if (rules?.budget) extras.push(`≤ ${rules.budget} moves`);
  if (rules?.par) extras.push(`par ${rules.par}`);
  $("#game-goal").innerHTML =
    `<span class="goal-start">${esc(start.name)}</span><span class="goal-sep">to</span><span class="goal-end">${esc(end.name)}</span>` +
    (extras.length ? `<span class="goal-extra">· ${extras.join(" · ")}</span>` : "");
  $("#btn-hint").classList.toggle("hidden", settings.hints !== "yes");
  $("#btn-finish").classList.add("hidden"); // knowledge-only
  setMessage(
    rules?.title
      ? `🎯 “${rules.title}” — by ${rules.by || "anonymous"}`
      : dailyActive
        ? "🎞 Now Showing — today's connection."
        : ""
  );
  updateStats();
  startTimer();
  await showT("game"); // wait for the reveal so the viewport is measurable

  // start pinned left, goal pinned right; view centered between them
  const gap = 440;
  addBoardNode(start, -gap, 0, true);
  addBoardNode(end, gap, 0, true);
  const rect = viewport.getBoundingClientRect();
  view.scale = Math.min(1, rect.width / (gap * 2 + 380));
  view.x = rect.width / 2;
  view.y = rect.height / 2 - 30; // breathing room above the bottom search bar
  applyView();

  boardActive = true;
  $("#game-search-input").focus();

  // Rare but possible: the two endpoints connect directly.
  checkWin();
}

function setMessage(text, kind) {
  const el = $("#game-message");
  el.textContent = text;
  el.className = "message" + (kind ? " " + kind : "");
}

// ===== Double feature: one start, many goals, one shared web =====
// (internal mode id stays "hybrid".) All goals are visible from move 1;
// win = every goal connected. Shared trunks are the genius move — one
// bridge that serves two goals beats two separate chains.
async function startHybrid(start, goals) {
  dailyActive = false;
  lastEndpoints = {
    start: structuredClone(start),
    end: null,
    goals: structuredClone(goals), // run it back = same bill
  };
  game.rules = null;
  game.mode = "hybrid";
  game.phase = 2; // no warmup phase — the double feature is all race
  game.nodes = new Map([[start.key, start]]);
  game.edges = new Map([[start.key, new Set()]]);
  for (const g of goals) {
    game.nodes.set(g.key, g);
    game.edges.set(g.key, new Set());
  }
  game.goals = goals;
  game.goalKeys = new Set(goals.map((g) => g.key));
  game.startKey = start.key;
  game.endKey = goals[0].key; // aims the hint machinery at a goal
  game.placed = 0;
  game.lastPlaced = null;
  game.won = false;
  game.over = false;
  game.target = 0;
  game.bar = 0;
  hintsUsed = 0;

  sim.clear();
  edgeEls.length = 0;
  nodesLayer.innerHTML = "";
  edgesSvg.innerHTML = "";
  $("#btn-show-results").classList.add("hidden");

  renderHybridHeader();
  $("#btn-hint").classList.toggle("hidden", settings.hints !== "yes");
  $("#btn-finish").classList.add("hidden");
  setMessage(
    `Reach ${goals.length === 1 ? "the goal" : goals.length === 2 ? "both goals" : `all ${goals.length}`} — one item can serve two paths.`
  );
  updateStats();
  startTimer();
  await showT("game");

  // start pinned left; goals pinned in a column on the right
  const gap = 440;
  addBoardNode(start, -gap, 0, true);
  goals.forEach((g, i) =>
    addBoardNode(g, gap, (i - (goals.length - 1) / 2) * 330, true)
  );
  const rect = viewport.getBoundingClientRect();
  view.scale = Math.min(
    1,
    rect.width / (gap * 2 + 380),
    rect.height / ((goals.length - 1) * 330 + 440)
  );
  view.x = rect.width / 2;
  view.y = rect.height / 2 - 30;
  applyView();
  boardActive = true;
  $("#game-search-input").focus();
}

function renderHybridHeader(paths = null) {
  const start = game.nodes.get(game.startKey);
  const done = (i) =>
    paths ? !!paths[i] : !!pathBetween(game.startKey, game.goals[i].key);
  $("#game-goal").innerHTML =
    `<span class="goal-start">${esc(start.name)}</span><span class="goal-sep">to</span>` +
    game.goals
      .map(
        (g, i) =>
          `<button class="goal-chip${done(i) ? " done" : ""}" data-key="${g.key}" title="tap to peek at the marquee">
            ${g.img ? `<img src="${g.img}" alt="">` : ""}<span>${esc(g.name)}</span>${done(i) ? "<b>✓</b>" : ""}
          </button>`
      )
      .join("");
}

function hybridCheckWin() {
  if (game.phase !== 2) return;
  const paths = game.goals.map((g) => pathBetween(game.startKey, g.key));
  const open = game.goals.find((g, i) => !paths[i]);
  if (open) game.endKey = open.key; // hints chase the first unreached goal
  renderHybridHeader(paths);
  if (paths.some((p) => !p)) return;
  game.won = true;
  stopTimer();
  highlightPaths(paths);
  showHybridWin(paths);
}

function showHybridWin(paths) {
  const totalLinks = paths.reduce((a, p) => a + p.length - 1, 0);
  // the mode's signature stat: nodes that served more than one goal
  const counts = new Map();
  for (const p of paths)
    for (const k of new Set(p)) counts.set(k, (counts.get(k) || 0) + 1);
  const shared = [...counts].filter(
    ([k, c]) => c > 1 && k !== game.startKey
  ).length;
  const n = game.goals.length;
  $("#win-modal .eyebrow").textContent = "That's a wrap";
  $("#win-stars").classList.add("hidden"); // classic-only (for now)
  $("#win-daily").classList.add("hidden");
  $("#btn-share-daily").classList.add("hidden");
  $("#win-modal h1").innerHTML =
    n === 1 ? "<em>Connected.</em>" : "<em>All goals reached.</em>";
  $("#win-score").innerHTML =
    `${n} goal${n === 1 ? "" : "s"} in <b>${totalLinks} link${totalLinks === 1 ? "" : "s"}</b>` +
    ` (${game.placed} placed${hintsUsed ? `, ${hintsUsed} hint${hintsUsed === 1 ? "" : "s"}` : ""})` +
    (shared
      ? ` — <b>${shared}</b> node${shared === 1 ? "" : "s"} pulled double duty 🎬`
      : ".");
  $("#win-path").innerHTML = paths
    .map(
      (p) =>
        `<div class="win-goal-row">` +
        p
          .map((k) => {
            const it = game.nodes.get(k);
            return `<div class="path-item">
              ${it.img ? `<img src="${it.img}">` : `<div class="no-img">${TYPE_EMOJI[it.type]}</div>`}
              <span>${esc(it.name)}</span></div>`;
          })
          .join(`<div class="arrow">→</div>`) +
        `</div>`
    )
    .join("");
  $("#btn-copy-challenge").classList.add("hidden"); // no hybrid links yet
  lastCard = {
    kind: "chain",
    headline: n === 1 ? "Connected." : "All goals reached.",
    subtitle: "Double Feature",
    stars: null,
    lines: paths.map((p) => ({
      items: p.map((k) => game.nodes.get(k)),
      tiers: p
        .slice(0, -1)
        .map((k, i) => edgeTier(game.nodes.get(p[i]), game.nodes.get(p[i + 1]))),
    })),
    stat:
      `${n} goal${n === 1 ? "" : "s"} · ${totalLinks} link${totalLinks === 1 ? "" : "s"} · ${game.placed} placed` +
      (shared ? ` · ${shared} shared` : ""),
  };
  $("#btn-save-card").classList.remove("hidden");
  setTimeout(() => $("#win-modal").classList.remove("hidden"), 600);
}

// gold-light every winning path at once (they may share nodes)
function highlightPaths(paths) {
  const onPath = new Set(paths.flat());
  const edgeOk = new Set();
  for (const p of paths)
    for (let i = 0; i < p.length - 1; i++)
      edgeOk.add(p[i] < p[i + 1] ? p[i] + "|" + p[i + 1] : p[i + 1] + "|" + p[i]);
  for (const [key, s] of sim) s.el.classList.toggle("on-path", onPath.has(key));
  for (const e of edgeEls)
    e.el.classList.toggle(
      "on-path",
      edgeOk.has(e.a < e.b ? e.a + "|" + e.b : e.b + "|" + e.a)
    );
}

// the marquee peek: a revealed goal you don't know whispers its names
$("#game-goal").addEventListener("click", async (e) => {
  const chip = e.target.closest(".goal-chip");
  if (!chip || game.mode !== "hybrid") return;
  const g = game.goals.find((x) => x.key === chip.dataset.key);
  if (!g) return;
  setMessage("★ reading the marquee…");
  try {
    let names;
    if (g.type === "person") {
      const data = await tmdb(`/person/${g.id}/combined_credits`);
      names = (data.cast || [])
        .filter((c) => c.media_type === "movie" || c.media_type === "tv")
        .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
        .slice(0, 3)
        .map((c) => c.title || c.name);
    } else {
      const data = await tmdb(
        g.type === "movie" ? `/movie/${g.id}/credits` : `/tv/${g.id}/aggregate_credits`
      );
      names = (data.cast || []).slice(0, 3).map((c) => c.name);
    }
    setMessage(
      `★ ${g.name} — ${g.type === "person" ? "known for" : "starring"} ${names.join(", ")}.`
    );
  } catch {
    setMessage("The marquee is dark — try again.", "bad");
  }
});

function updateStats() {
  const budget = game.rules?.budget;
  $("#stat-placed").textContent =
    (game.mode === "knowledge" ? "Named: " : "Placed: ") +
    game.placed +
    (budget
      ? "/" + budget
      : game.mode === "knowledge" && game.target
        ? "/" + game.target
        : "");
  updateUndoBtn();
}

// ---- Undo (last placement only) ----
// Classic/hybrid only — in knowledge every placement is correct by definition,
// so undo would just lower your own count.
function updateUndoBtn() {
  $("#btn-undo").classList.toggle(
    "hidden",
    !game.lastPlaced || game.won || game.over || game.mode === "knowledge"
  );
}

function undoLast() {
  const key = game.lastPlaced;
  if (!key || game.won || game.over || game.mode === "knowledge") return;
  const item = game.nodes.get(key);
  if (!item) return;
  for (const nb of game.edges.get(key) || []) game.edges.get(nb)?.delete(key);
  game.edges.delete(key);
  game.nodes.delete(key);
  game.placed--; // refunds the budget spend too
  game.lastPlaced = null;
  sim.get(key)?.el.remove();
  sim.delete(key);
  for (let i = edgeEls.length - 1; i >= 0; i--) {
    if (edgeEls[i].a === key || edgeEls[i].b === key) {
      edgeEls[i].el.remove();
      edgeEls.splice(i, 1);
    }
  }
  updateStats();
  if (game.mode === "hybrid") hybridCheckWin(); // re-mark goal chips (an undo can un-reach one)
  fitBoard(450);
  setMessage(`↩ Took back ${item.name}.`);
}

$("#btn-undo").addEventListener("click", undoLast);

// ---- Countdown timer ----
let timerInterval = null;
let timeLeft = 0;

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function renderTimer() {
  const el = $("#game-timer");
  el.textContent =
    Math.floor(timeLeft / 60) + ":" + String(timeLeft % 60).padStart(2, "0");
  el.classList.toggle("warn", timeLeft <= 30);
}

function startTimer(force = false) {
  stopTimer();
  const on = force || settings.timer === "yes";
  $("#game-timer").classList.toggle("hidden", !on);
  if (!on) return;
  timeLeft = settings.timerMinutes * 60;
  renderTimer();
  timerInterval = setInterval(() => {
    timeLeft--;
    renderTimer();
    if (timeLeft <= 0) {
      stopTimer();
      timeUp();
    }
  }, 1000);
}

function timeUp() {
  if (game.won) return;
  game.over = true;
  updateUndoBtn();
  if (questMulti()) {
    // clocking out IS the round in knowledge (unless a target was missed);
    // in classic it means the scene goes unfinished — the feature rolls on
    const r = quest.rounds[quest.idx];
    endRound(
      game.mode === "knowledge" ? !r.target || game.placed >= r.target : false
    );
    return;
  }
  if (game.mode === "knowledge") {
    showKnowledgeResults();
    return;
  }
  if (game.mode === "hybrid") {
    const n = game.goals.length;
    $("#lose-modal .eyebrow").textContent = "Out of time";
    $("#lose-modal h1").innerHTML = "<em>Time's up.</em>";
    $("#lose-text").innerHTML =
      `You placed <b>${game.placed}</b> item${game.placed === 1 ? "" : "s"}, but ${n === 1 ? "the goal wasn't" : "not every goal was"} reached.`;
    $("#lose-modal").classList.remove("hidden");
    return;
  }
  recordStub("ran out of time", false);
  $("#lose-modal .eyebrow").textContent = "Out of time"; // budget fail rewrites these
  $("#lose-modal h1").innerHTML = "<em>Time's up.</em>";
  $("#lose-text").innerHTML =
    `You placed <b>${game.placed}</b> item${game.placed === 1 ? "" : "s"}, but the chain never closed.`;
  $("#lose-modal").classList.remove("hidden");
}

// Knowledge results reuse the win modal shell with blitz copy.
function showKnowledgeResults() {
  const start = game.nodes.get(game.startKey);
  if (builderTest) builder.par = game.placed; // knowledge par = your count
  recordStub(
    `${game.placed} named`,
    game.target ? game.placed >= game.target : true
  );
  $("#btn-copy-challenge").classList.remove("hidden"); // hybrid wins hide it
  $("#win-stars").classList.add("hidden"); // stars are a classic-chain thing
  $("#win-daily").classList.add("hidden");
  $("#btn-share-daily").classList.add("hidden");
  $("#win-modal .eyebrow").textContent =
    game.target && game.placed >= game.target ? "Goal reached!" : "Time!";
  $("#win-modal h1").innerHTML = `<em>${game.placed} named.</em>`;
  const vsBar = game.bar
    ? game.placed > game.bar
      ? ` You beat the bar of <b>${game.bar}</b> 🏆`
      : ` The bar was <b>${game.bar}</b> — not this time.`
    : "";
  $("#win-score").innerHTML =
    `Connections of <b>${esc(start.name)}</b> in ${settings.timerMinutes} min.${vsBar}`;
  const named = [...game.nodes.values()].filter((it) => it.key !== game.startKey);
  $("#win-path").innerHTML = named
    .map(
      (it) => `<div class="path-item">
        ${it.img ? `<img src="${it.img}">` : `<div class="no-img">${TYPE_EMOJI[it.type]}</div>`}
        <span>${esc(it.name)}</span></div>`
    )
    .join("");
  lastCard = {
    kind: "web",
    headline: `${game.placed} named.`,
    subtitle: `Everything ${start.name}`,
    center: start,
    named,
    stat:
      `${game.placed} connection${game.placed === 1 ? "" : "s"} in ${settings.timerMinutes} min` +
      (game.bar && game.placed > game.bar ? ` · beat ${game.bar} 🏆` : ""),
  };
  $("#btn-save-card").classList.remove("hidden");
  $("#win-modal").classList.remove("hidden");
}

// ---- Hints ----
// A hint AUTO-PLACES the most helpful item it can find:
//   1. Best case — a "bridge": something whose credits link the start-side
//      cluster to the goal-side cluster. Placing it closes (or nearly
//      closes) the chain. Found by intersecting the credit sets the game
//      has already fetched, so the more you've placed, the smarter it gets.
//   2. Otherwise — a strong stepping stone off the goal side (then the
//      start side, alternating), expanding from the FRONTIER: the component
//      node farthest from the endpoint. Successive hints walk outward
//      (goal → stone → stone-of-stone…) instead of orbiting the endpoint
//      at radius 1 forever (the original bug — hints never went out past 1).
let hintFlip = false; // flipped before use — first stepping stone favors the goal side

function componentOf(key) {
  const seen = new Set([key]);
  const queue = [key];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of game.edges.get(cur) || [])
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
  }
  return seen;
}

async function findBridge() {
  const startSide = componentOf(game.startKey);
  const goalSide = componentOf(game.endKey);
  // tally how many nodes on each side can reach each off-board item
  const reach = (side) => {
    const counts = new Map();
    return Promise.all(
      [...side].map(async (k) => {
        for (const c of await getConnections(game.nodes.get(k)))
          if (!game.nodes.has(c)) counts.set(c, (counts.get(c) || 0) + 1);
      })
    ).then(() => counts);
  };
  const [fromStart, fromGoal] = await Promise.all([reach(startSide), reach(goalSide)]);
  let best = null;
  let bestScore = 0;
  for (const [key, n] of fromStart) {
    const m = fromGoal.get(key);
    if (m && n + m > bestScore) {
      bestScore = n + m;
      best = key;
    }
  }
  return best; // an item credited on BOTH sides, most-connected first
}

async function fetchItemByKey(key) {
  const [type, id] = key.split("-");
  return makeItem(await tmdb(`/${type}/${id}`), type);
}

async function steppingStone(target) {
  if (isTitle(target)) {
    const data = await tmdb(
      target.type === "movie"
        ? `/movie/${target.id}/credits`
        : `/tv/${target.id}/aggregate_credits`
    );
    const cast = (data.cast || [])
      .slice(0, 12) // top billing — names a player might actually know
      .filter((c) => !game.nodes.has("person-" + c.id));
    if (!cast.length) return null;
    return makeItem(cast[Math.floor(Math.random() * Math.min(6, cast.length))], "person");
  }
  const data = await tmdb(`/person/${target.id}/combined_credits`);
  const titles = (data.cast || [])
    .filter(
      (c) =>
        (c.media_type === "movie" || c.media_type === "tv") &&
        !game.nodes.has(c.media_type + "-" + c.id)
    )
    .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
    .slice(0, 8);
  if (!titles.length) return null;
  return makeItem(titles[Math.floor(Math.random() * Math.min(5, titles.length))]);
}

async function giveHint() {
  if (game.won || game.over) return;
  const btn = $("#btn-hint");
  btn.disabled = true;
  setMessage("💡 Looking for the most helpful move…");
  try {
    let item = null;
    const bridgeKey = await findBridge();
    if (bridgeKey) {
      item = await fetchItemByKey(bridgeKey);
    } else {
      hintFlip = !hintFlip;
      const rootKey = hintFlip ? game.endKey : game.startKey;
      // BFS distances from the endpoint across its component, then try the
      // farthest-out node first (random among ties) and fall back inward —
      // steppingStone returns null when a node's fresh credits run dry
      const dist = new Map([[rootKey, 0]]);
      const queue = [rootKey];
      while (queue.length) {
        const cur = queue.shift();
        for (const nb of game.edges.get(cur) || [])
          if (!dist.has(nb)) {
            dist.set(nb, dist.get(cur) + 1);
            queue.push(nb);
          }
      }
      const frontier = [...dist.entries()]
        .sort((a, b) => b[1] - a[1] || Math.random() - 0.5)
        .map(([k]) => k);
      for (const k of frontier) {
        item = await steppingStone(game.nodes.get(k));
        if (item) break;
      }
    }
    if (!item) {
      setMessage("💡 No fresh hint found — keep weaving!");
      return;
    }
    hintsUsed++;
    await tryPlace(item);
  } catch {
    setMessage("Something went wrong talking to TMDB. Try again.", "bad");
  } finally {
    btn.disabled = false;
  }
}

$("#btn-hint").addEventListener("click", giveHint);

// Knowledge blitz only: bank your score without waiting out the clock.
$("#btn-finish").addEventListener("click", () => {
  if (game.mode !== "knowledge" || game.won || game.over) return;
  stopTimer();
  timeUp();
});

// ===== The web board: pan/zoom viewport + force-directed physics =====
const viewport = $("#board-viewport");
const world = $("#board-world");
const edgesSvg = $("#edges");
const nodesLayer = $("#nodes");

const sim = new Map(); // key -> {x, y, vx, vy, el, fixed, dragging}
const edgeEls = [];    // {a, b, el(svg line)}
const view = { x: 0, y: 0, scale: 1 };
let boardActive = false;

// physics tuning — heavy damping so new arrivals settle fast
const REPULSION = 90000; // node-node push (local — fades to zero at REPULSE_RANGE)
const REPULSE_RANGE = 380; // beyond this, nodes ignore each other — global push
                         // straightens chains into lines; local push lets them
                         // fold into clumps (Escher: "line line line", 2026-07-01)
const REST = 250;        // edge spring rest length
const STIFF = 0.03;      // edge spring stiffness
const DAMP = 0.6;        // velocity damping — heavy: placements thunk, not drift
const MAXF = 10;         // repulsion cap
const SLEEP = 0.08;      // below this speed, stop moving entirely
const MIN_SEP = 165;     // hard floor on node spacing (tokens are ~94-141px)
const SEP_EASE = 0.45;   // fraction of overlap resolved per frame
const GRAV = 0.0012;     // centering pull per px beyond the flat core
const GRAV_FREE = 320;   // no gravity inside this radius of the centroid —
                         // compact webs are left alone (no fights with MIN_SEP)

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  // keep the dot grid glued to the world: same offset, same scale
  const grid = 48 * view.scale;
  viewport.style.backgroundSize = `${grid}px ${grid}px`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
}

// --- auto-fit camera ---
// Big webs outgrow the screen and force constant manual zoom-outs. After a
// placement the camera eases out just enough to keep everything visible —
// chasing (not jumping), because the physics is still settling the new node.
// Any manual pan/pinch/wheel/drag cancels the follow: the player always wins.
let fitFollow = null; // rAF id while the camera is following

function cancelFitFollow() {
  if (fitFollow) cancelAnimationFrame(fitFollow);
  fitFollow = null;
}

function boardBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of sim.values()) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }
  const pad = 160; // token + label breathing room
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad + 40 };
}

function fitBoard(ms = 700) {
  if (!boardActive || sim.size === 0) return;
  // already comfortably on screen? leave the camera alone
  const b = boardBounds();
  const rect = viewport.getBoundingClientRect();
  if (
    b.minX * view.scale + view.x >= 0 &&
    b.maxX * view.scale + view.x <= rect.width &&
    b.minY * view.scale + view.y >= 0 &&
    b.maxY * view.scale + view.y <= rect.height
  )
    return;
  cancelFitFollow();
  const t0 = performance.now();
  const step = () => {
    if (!boardActive || sim.size === 0) { fitFollow = null; return; }
    const bb = boardBounds();
    const r = viewport.getBoundingClientRect();
    const scale = Math.max(
      0.25,
      Math.min(1, r.width / (bb.maxX - bb.minX), r.height / (bb.maxY - bb.minY))
    );
    const tx = r.width / 2 - ((bb.minX + bb.maxX) / 2) * scale;
    const ty = r.height / 2 - ((bb.minY + bb.maxY) / 2) * scale - 20;
    view.scale += (scale - view.scale) * 0.16;
    view.x += (tx - view.x) * 0.16;
    view.y += (ty - view.y) * 0.16;
    applyView();
    fitFollow =
      performance.now() - t0 < ms ? requestAnimationFrame(step) : null;
  };
  fitFollow = requestAnimationFrame(step);
}

// --- pan & zoom (one pointer pans, two pinch-zoom, wheel zooms) ---
let panning = null;
const boardPointers = new Map(); // pointerId -> {x, y} — live touches on the viewport
let pinch = null; // last {d, mx, my} — finger distance + midpoint

function pinchNow() {
  const [a, b] = [...boardPointers.values()];
  return {
    d: Math.hypot(b.x - a.x, b.y - a.y),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
  };
}

viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".gnode")) return;
  cancelFitFollow();
  boardPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  viewport.classList.add("panning");
  viewport.setPointerCapture(e.pointerId);
  if (boardPointers.size === 2) {
    pinch = pinchNow(); // second finger down — pan hands over to pinch
    panning = null;
  } else if (boardPointers.size === 1) {
    panning = { px: e.clientX, py: e.clientY };
  }
});
viewport.addEventListener("pointermove", (e) => {
  if (boardPointers.has(e.pointerId))
    boardPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && boardPointers.size >= 2) {
    // zoom by the finger-distance ratio around the midpoint; the midpoint's
    // own drift pans, so one gesture can do both at once
    const rect = viewport.getBoundingClientRect();
    const now = pinchNow();
    const next = Math.min(2.5, Math.max(0.25, view.scale * (now.d / (pinch.d || 1))));
    const f = next / view.scale;
    const mx = now.mx - rect.left;
    const my = now.my - rect.top;
    view.x = mx - (mx - view.x) * f + (now.mx - pinch.mx);
    view.y = my - (my - view.y) * f + (now.my - pinch.my);
    view.scale = next;
    pinch = now;
    applyView();
    return;
  }
  if (!panning) return;
  view.x += e.clientX - panning.px;
  view.y += e.clientY - panning.py;
  panning = { px: e.clientX, py: e.clientY };
  applyView();
});
function boardPointerEnd(e) {
  boardPointers.delete(e.pointerId);
  pinch = null;
  if (boardPointers.size === 1) {
    // one finger left — carry on as a pan from where it sits
    const [p] = boardPointers.values();
    panning = { px: p.x, py: p.y };
  } else {
    panning = null;
    if (boardPointers.size === 0) viewport.classList.remove("panning");
  }
}
viewport.addEventListener("pointerup", boardPointerEnd);
viewport.addEventListener("pointercancel", boardPointerEnd);
viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    cancelFitFollow();
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const next = Math.min(2.5, Math.max(0.25, view.scale * Math.exp(-e.deltaY * 0.0014)));
    const f = next / view.scale;
    view.x = mx - (mx - view.x) * f;
    view.y = my - (my - view.y) * f;
    view.scale = next;
    applyView();
  },
  { passive: false }
);

// --- nodes & edges ---
function addBoardNode(item, x, y, fixed = false) {
  const el = document.createElement("div");
  el.className = "gnode " + (item.type === "person" ? "person" : "title");
  if (item.key === game.startKey) el.classList.add("start");
  if (item.key === game.endKey) el.classList.add("end");
  el.innerHTML = `
    <div class="token">${item.img ? `<img src="${item.img}" alt="">` : `<span>${TYPE_EMOJI[item.type]}</span>`}</div>
    <div class="gnode-label">${esc(item.name)}</div>`;
  nodesLayer.appendChild(el);

  if (game.goalKeys?.has(item.key)) el.classList.add("end"); // hybrid goals glow clay
  const s = { x, y, vx: 0, vy: 0, el, fixed, dragging: false };
  sim.set(item.key, s);
  positionNode(s);

  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    cancelFitFollow();
    el.setPointerCapture(e.pointerId);
    s.dragging = true;
    // tap vs drag: barely-moved pointerups open the peek instead
    let moved = 0;
    let lx = e.clientX;
    let ly = e.clientY;
    const move = (ev) => {
      if (!s.dragging) return;
      moved += Math.abs(ev.clientX - lx) + Math.abs(ev.clientY - ly);
      lx = ev.clientX;
      ly = ev.clientY;
      const rect = viewport.getBoundingClientRect();
      s.x = (ev.clientX - rect.left - view.x) / view.scale;
      s.y = (ev.clientY - rect.top - view.y) / view.scale;
      s.vx = s.vy = 0;
      // paint NOW — deferring to the next physics frame trails the cursor
      positionNode(s);
      for (const eg of edgeEls) {
        if (eg.a !== item.key && eg.b !== item.key) continue;
        const a = sim.get(eg.a);
        const b = sim.get(eg.b);
        eg.el.setAttribute("x1", a.x);
        eg.el.setAttribute("y1", a.y);
        eg.el.setAttribute("x2", b.x);
        eg.el.setAttribute("y2", b.y);
      }
    };
    const up = () => {
      s.dragging = false;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (moved < 8) openBoardPeek(item); // a tap, not a drag
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
  return s;
}

function positionNode(s) {
  s.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
}

function addEdgeLine(aKey, bKey) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("class", "edge");
  edgesSvg.appendChild(line);
  edgeEls.push({ a: aKey, b: bKey, el: line });
}

// --- simulation loop (runs forever, works only while a board is live) ---
function physicsTick() {
  const bodies = [...sim.values()];

  // pairwise repulsion
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        d2 = 1;
      }
      const d = Math.sqrt(d2);
      if (d >= REPULSE_RANGE) continue; // out of range — no push, chains may fold
      // linear fade to zero at the range edge — no pop at the boundary
      const f = Math.min(REPULSION / d2, MAXF) * (1 - d / REPULSE_RANGE);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!a.fixed && !a.dragging) { a.vx -= fx; a.vy -= fy; }
      if (!b.fixed && !b.dragging) { b.vx += fx; b.vy += fy; }
    }
  }

  // springs along connections
  for (const e of edgeEls) {
    const a = sim.get(e.a);
    const b = sim.get(e.b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - REST) * STIFF;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    if (!a.fixed && !a.dragging) { a.vx += fx; a.vy += fy; }
    if (!b.fixed && !b.dragging) { b.vx -= fx; b.vy -= fy; }
  }

  // weak centering gravity — big webs compact instead of sprawling, so the
  // auto-fit camera doesn't have to pull back so far. Only bites beyond
  // GRAV_FREE of the centroid; the compact core never feels it.
  if (bodies.length > 2) {
    let cx = 0;
    let cy = 0;
    for (const s of bodies) { cx += s.x; cy += s.y; }
    cx /= bodies.length;
    cy /= bodies.length;
    for (const s of bodies) {
      if (s.fixed || s.dragging) continue;
      const dx = cx - s.x;
      const dy = cy - s.y;
      const d = Math.hypot(dx, dy);
      if (d > GRAV_FREE) {
        const f = ((d - GRAV_FREE) * GRAV) / d;
        s.vx += dx * f;
        s.vy += dy * f;
      }
    }
  }

  // integrate
  for (const s of bodies) {
    if (!s.fixed && !s.dragging) {
      s.vx *= DAMP;
      s.vy *= DAMP;
      if (Math.abs(s.vx) < SLEEP && Math.abs(s.vy) < SLEEP) {
        s.vx = 0;
        s.vy = 0;
      }
      s.x += s.vx;
      s.y += s.vy;
    }
  }

  // hard minimum separation — capped repulsion + the sleep threshold can
  // leave nodes resting on top of each other (worst near the pinned
  // endpoints). Resolve overlaps positionally so nothing can defeat it.
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d >= MIN_SEP) continue;
      if (d < 1) {
        const ang = Math.random() * Math.PI * 2; // dead-center stack — pick a direction
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        d = 1;
      }
      const push = (MIN_SEP - d) * 0.5 * SEP_EASE; // eased so it slides, not snaps
      const ux = dx / d;
      const uy = dy / d;
      const aMoves = !a.fixed && !a.dragging;
      const bMoves = !b.fixed && !b.dragging;
      if (aMoves && bMoves) {
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
      } else if (aMoves) {
        a.x -= ux * push * 2; a.y -= uy * push * 2;
      } else if (bMoves) {
        b.x += ux * push * 2; b.y += uy * push * 2;
      }
    }
  }

  // render
  for (const s of bodies) positionNode(s);
  for (const e of edgeEls) {
    const a = sim.get(e.a);
    const b = sim.get(e.b);
    e.el.setAttribute("x1", a.x);
    e.el.setAttribute("y1", a.y);
    e.el.setAttribute("x2", b.x);
    e.el.setAttribute("y2", b.y);
  }
}

(function loop() {
  if (boardActive) physicsTick();
  requestAnimationFrame(loop);
})();

function highlightPath(path) {
  const order = new Map(path.map((k, i) => [k, i]));
  for (const [key, s] of sim)
    s.el.classList.toggle("on-path", order.has(key));
  for (const e of edgeEls) {
    const ia = order.get(e.a);
    const ib = order.get(e.b);
    e.el.classList.toggle(
      "on-path",
      ia !== undefined && ib !== undefined && Math.abs(ia - ib) === 1
    );
  }
}

// Place a searched item: it must connect to at least one node on the board.
async function tryPlace(item) {
  if (game.won || game.over) return;
  if (game.nodes.has(item.key)) {
    setMessage(`${item.name} is already on the board.`, "bad");
    return;
  }
  if (game.rules?.types && !game.rules.types.has(item.type)) {
    setMessage(`🚫 ${TYPE_LABEL[item.type]}s aren't allowed in this challenge.`, "bad");
    return;
  }
  if (game.rules?.bans?.has(item.key)) {
    setMessage(`🚫 ${item.name} is banned in this challenge.`, "bad");
    return;
  }
  setMessage(`Checking ${item.name}…`);
  try {
    // knowledge mode only accepts DIRECT connections to the center item
    const direct = game.mode === "knowledge";
    const candidates = direct
      ? [[game.startKey, game.nodes.get(game.startKey)]]
      : [...game.nodes];
    const linked = [];
    for (const [key, node] of candidates) {
      if (await connects(item, node)) linked.push(key);
    }
    if (linked.length === 0) {
      setMessage(
        direct
          ? `❌ ${item.name} isn't directly connected to ${game.nodes.get(game.startKey).name}.`
          : `❌ ${item.name} doesn't connect to anything on the board.`,
        "bad"
      );
      return;
    }
    game.nodes.set(item.key, item);
    game.edges.set(item.key, new Set(linked));
    for (const k of linked) game.edges.get(k).add(item.key);
    game.placed++;
    game.lastPlaced = item.key;

    // drop the new node near the things it connects to, with a little scatter
    let sx = 0;
    let sy = 0;
    for (const k of linked) {
      sx += sim.get(k).x;
      sy += sim.get(k).y;
    }
    sx = sx / linked.length + (Math.random() - 0.5) * 90;
    sy = sy / linked.length + (Math.random() - 0.5) * 90;
    addBoardNode(item, sx, sy);
    for (const k of linked) addEdgeLine(item.key, k);
    fitBoard(); // ease out if the web has outgrown the screen

    updateStats();
    const names = linked.map((k) => game.nodes.get(k).name).join(", ");
    // the north star, in the moment: a surprising LINK gets its flare right now
    const linkTiers = linked.map((k) => edgeTier(item, game.nodes.get(k)));
    const flare = linkTiers.includes("crazy")
      ? " 🤯 crazy pull!"
      : linkTiers.includes("deep cut")
        ? " 🎉 deep cut!"
        : "";
    setMessage(
      game.mode === "knowledge"
        ? `✅ ${item.name} — ${game.placed} named!${flare}`
        : `✅ ${item.name} placed — connects to ${names}.${flare}`,
      "ok"
    );
    checkWin();
    updateUndoBtn(); // a winning placement must not leave undo showing behind the modal

    // knowledge target hit — the scene is cleared before the clock
    if (
      game.mode === "knowledge" &&
      game.target &&
      game.placed >= game.target &&
      !game.over
    ) {
      game.over = true;
      stopTimer();
      if (questMulti()) setTimeout(() => endRound(true), 600);
      else setTimeout(showKnowledgeResults, 600);
      return;
    }

    // strict completion: spending the whole budget without closing = fail
    const budget = game.rules?.budget;
    if (budget && !game.won && game.mode !== "knowledge" && game.placed >= budget) {
      game.over = true;
      stopTimer();
      updateUndoBtn();
      if (questMulti()) {
        setTimeout(() => endRound(false), 600);
        return;
      }
      recordStub("budget spent", false);
      $("#lose-modal .eyebrow").textContent = "Out of moves";
      $("#lose-modal h1").innerHTML = "<em>Budget spent.</em>";
      $("#lose-text").innerHTML =
        `All <b>${budget}</b> placements used — the chain never closed.`;
      setTimeout(() => $("#lose-modal").classList.remove("hidden"), 600);
    }
  } catch (err) {
    setMessage("Something went wrong talking to TMDB. Try again.", "bad");
    console.error(err);
  }
}

// BFS shortest path between two board nodes; returns array of keys or null.
function pathBetween(aKey, bKey) {
  const prev = new Map([[aKey, null]]);
  const queue = [aKey];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === bKey) {
      const path = [];
      for (let k = cur; k !== null; k = prev.get(k)) path.unshift(k);
      return path;
    }
    for (const nb of game.edges.get(cur) || []) {
      if (!prev.has(nb)) {
        prev.set(nb, cur);
        queue.push(nb);
      }
    }
  }
  return null;
}

function shortestPath() {
  return pathBetween(game.startKey, game.endKey);
}

function checkWin() {
  if (game.mode === "knowledge") return; // blitz ends on the clock, not a path
  if (game.mode === "hybrid") {
    hybridCheckWin();
    return;
  }
  let path;
  const wps = game.rules?.waypoints;
  if (wps?.length) {
    // the chain must route through every waypoint: start → wp1 → … → goal
    if (!wps.every((w) => game.nodes.has(w.key))) return;
    const stops = [game.startKey, ...wps.map((w) => w.key), game.endKey];
    path = null;
    for (let i = 0; i < stops.length - 1; i++) {
      const seg = pathBetween(stops[i], stops[i + 1]);
      if (!seg) return;
      path = path ? [...path, ...seg.slice(1)] : seg;
    }
  } else {
    path = shortestPath();
    if (!path) return;
  }
  game.won = true;
  stopTimer();
  highlightPath(path);
  if (questMulti()) {
    // mid-feature: a moment to admire the gold path, then the intermission
    setTimeout(() => endRound(true), 900);
    return;
  }
  if (builderTest) builder.par = path.length - 1; // verified — stamp the par
  $("#win-modal .eyebrow").textContent = "Chain complete";
  $("#win-modal h1").innerHTML = "<em>Connected.</em>"; // results modal may have rewritten it
  $("#btn-copy-challenge").classList.remove("hidden"); // hybrid wins hide it

  const steps = path.length - 1;
  recordStub(`connected in ${steps} link${steps === 1 ? "" : "s"}`, true);

  // Deep-cut scoring: the chain is rated by its LINKS, not its names — a
  // famous face is a fine bridge if you route through the weird corner of
  // their filmography. famous↔famous links are legal but unimpressive.
  const linkTiers = [];
  for (let i = 0; i < path.length - 1; i++)
    linkTiers.push(edgeTier(game.nodes.get(path[i]), game.nodes.get(path[i + 1])));
  const clean = !linkTiers.includes("famous"); // "famous" link = both ends famous
  const deep =
    clean && linkTiers.some((t) => t === "deep cut" || t === "crazy");
  const stars = 1 + (clean ? 1 : 0) + (deep ? 1 : 0);
  // "one take": every placement ended up in the gold path — exploration is
  // free, but the flawless line gets its applause
  const oneTake = path.length > 2 && game.placed === path.length - 2;
  $("#win-stars").classList.remove("hidden");
  $("#win-stars").innerHTML =
    `<span class="stars">${"★".repeat(stars)}${"☆".repeat(3 - stars)}</span> ` +
    `<span class="stars-label">${
      stars === 3
        ? "deep-cut route — the connoisseur's path"
        : stars === 2
          ? "clean chain — no obvious links"
          : "the obvious links did the heavy lifting"
    }${oneTake ? " · 🎞 one take" : ""}</span>`;

  // Now Showing: first completion goes on the books; streak shown either way
  if (dailyActive) {
    const log = dailyLog();
    const first = !log[dailyDateStr()];
    if (first) {
      log[dailyDateStr()] = {
        steps,
        stars,
        hints: hintsUsed,
        placed: game.placed,
      };
      localStorage.setItem("dailyLog", JSON.stringify(log));
    }
    $("#win-daily").textContent =
      `🎞 Today's connection, made — 🔥 ${dailyStreak(log)}-day streak` +
      (first ? "" : " (today was already on the books)");
    $("#win-daily").classList.remove("hidden");
    $("#btn-share-daily").classList.remove("hidden");
    initDailyStrip(); // refresh the marquee status behind the modal
  } else {
    $("#win-daily").classList.add("hidden");
    $("#btn-share-daily").classList.add("hidden");
  }

  const par = game.rules?.par;
  $("#win-score").innerHTML =
    `You connected them in <b>${steps} link${steps === 1 ? "" : "s"}</b>` +
    ` (${game.placed} item${game.placed === 1 ? "" : "s"} placed` +
    `${hintsUsed ? `, ${hintsUsed} hint${hintsUsed === 1 ? "" : "s"}` : ""}).` +
    (par
      ? steps <= par
        ? ` Creator's par was <b>${par}</b> — matched or beat it 🏆`
        : ` Creator's par: <b>${par}</b>.`
      : "");
  $("#win-path").innerHTML = path
    .map((k, i) => {
      const it = game.nodes.get(k);
      const cell = `<div class="path-item">
        ${it.img ? `<img src="${it.img}">` : `<div class="no-img">${TYPE_EMOJI[it.type]}</div>`}
        <span>${esc(it.name)}</span></div>`;
      if (i === path.length - 1) return cell;
      // the badge sits on the connection — that's where the surprise lives
      const t = linkTiers[i];
      const isDeep = t === "deep cut" || t === "crazy";
      return (
        cell +
        `<div class="arrow${isDeep ? " deep" : ""}">→${
          isDeep ? `<span class="path-badge">${t === "crazy" ? "crazy pull" : "deep cut"}</span>` : ""
        }</div>`
      );
    })
    .join("");
  lastCard = {
    kind: "chain",
    headline: "Connected.",
    subtitle: dailyActive
      ? `Now Showing · ${cardDateNice()}`
      : rules?.title
        ? `“${rules.title}”`
        : "The Connection Game",
    stars,
    lines: [{ items: path.map((k) => game.nodes.get(k)), tiers: linkTiers }],
    stat:
      `${steps} link${steps === 1 ? "" : "s"} · ${game.placed} placed` +
      (hintsUsed ? ` · ${hintsUsed} hint${hintsUsed === 1 ? "" : "s"}` : "") +
      (oneTake ? " · 🎞 one take" : ""),
  };
  $("#btn-save-card").classList.remove("hidden");
  setTimeout(() => $("#win-modal").classList.remove("hidden"), 600);
}

attachAutocomplete($("#game-search-input"), $("#game-suggestions"), tryPlace);

// After a win, step out of the modal to admire (and pan around) the full
// web you built; the floating results button brings the modal back.
$("#btn-view-web").addEventListener("click", () => {
  $("#win-modal").classList.add("hidden");
  $("#btn-show-results").classList.remove("hidden");
});
$("#btn-show-results").addEventListener("click", () => {
  $("#btn-show-results").classList.add("hidden");
  $("#win-modal").classList.remove("hidden");
});

$("#btn-quit").addEventListener("click", () => {
  boardActive = false;
  stopTimer();
  $("#btn-show-results").classList.add("hidden");
  $("#round-modal").classList.add("hidden");
  if (game.mode === "party") {
    // the night isn't over — back to the waiting room, everyone stays seated
    blitzTeardown();
    showT("lobby");
    return;
  }
  if (builderTest) {
    builderTest = false; // abandoned test run — no par stamped
    quest.active = false;
    restoreQuestSettings();
    showT("build");
    return;
  }
  if (quest.active) {
    showPremiere(); // back to the title card — replay or head home from there
    return;
  }
  showT("mode"); // back to setup with the same matchup waiting
});
$("#btn-play-again").addEventListener("click", () => {
  boardActive = false;
  $("#win-modal").classList.add("hidden");
  $("#btn-show-results").classList.add("hidden");
  if (builderTest) {
    // back to the builder — the test run just stamped a par
    builderTest = false;
    quest.active = false;
    restoreQuestSettings();
    showT("build");
    renderBuilder();
    return;
  }
  if (quest.active) {
    showPremiere();
    return;
  }
  showT("mode");
  rerollSlot("start");
  rerollSlot("end");
});
$("#btn-retry").addEventListener("click", () => {
  $("#lose-modal").classList.add("hidden");
  if (game.mode === "hybrid") {
    // same start, same hidden goals — a true rematch
    startHybrid(
      structuredClone(lastEndpoints.start),
      structuredClone(lastEndpoints.goals)
    );
    return;
  }
  pendingDaily = !!lastEndpoints.daily; // a daily rematch is still the daily
  startGame(
    structuredClone(lastEndpoints.start),
    structuredClone(lastEndpoints.end),
    game.rules
  );
});
$("#btn-lose-new").addEventListener("click", () => {
  boardActive = false;
  $("#lose-modal").classList.add("hidden");
  if (builderTest) {
    builderTest = false;
    quest.active = false;
    restoreQuestSettings();
    showT("build");
    return;
  }
  if (quest.active) {
    showPremiere();
    return;
  }
  showT("mode");
  rerollSlot("start");
  rerollSlot("end");
});

// ---- Lobby settings: difficulty presets + custom knobs ----
// Difficulty is a preset bundle; touching any knob by hand flips to Custom.
// Obscurity drives the random pools; hints/timer drive the in-game systems.
const PRESETS = {
  easy:   { obscurity: "famous", hints: "yes", timer: "no",  timerMinutes: 5 },
  medium: { obscurity: "known",  hints: "no",  timer: "no",  timerMinutes: 5 },
  hard:   { obscurity: "deep",   hints: "no",  timer: "yes", timerMinutes: 5 },
  crazy:  { obscurity: "crazy",  hints: "no",  timer: "yes", timerMinutes: 3 },
};
const SETTINGS_DEFAULTS = {
  difficulty: "medium",
  ...PRESETS.medium,
  hybridN: 2, // double feature: how many goals (1–3)
};
let settings = { ...SETTINGS_DEFAULTS };
try {
  settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
} catch { /* corrupted storage — fall back to defaults */ }

function saveSettings() {
  localStorage.setItem("settings", JSON.stringify(settings));
}

function renderSettings() {
  document.querySelectorAll("#difficulty-chips .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.value === settings.difficulty)
  );
  document.querySelectorAll(".chip-group[data-setting]").forEach((group) => {
    const key = group.dataset.setting;
    group.querySelectorAll(".chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.value === String(settings[key]))
    );
  });
  $("#timer-minutes").value = settings.timerMinutes;
  $("#timer-minutes-wrap").classList.toggle("disabled", settings.timer !== "yes");
  $("#knobs-wrap").classList.toggle("open", settings.difficulty === "custom");
  document.querySelectorAll("#hybrid-n-chips .chip").forEach((c) =>
    c.classList.toggle("active", +c.dataset.value === settings.hybridN)
  );
}

// the goals knob isn't part of the difficulty presets — no custom flip
$("#hybrid-n-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || +chip.dataset.value === settings.hybridN) return;
  settings.hybridN = +chip.dataset.value;
  saveSettings();
  renderSettings();
  ensureGoalSlots(); // a new slot may have appeared — fill it
});

// new difficulty, new world — every visible card redraws from the new band
function rerollVisibleSlots() {
  rerollSlot("start");
  if (playMode === "hybrid")
    for (let i = 0; i < settings.hybridN; i++) rerollGoalSlot(i);
  else if (playMode === "classic") rerollSlot("end");
}

$("#difficulty-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || chip.dataset.value === settings.difficulty) return;
  settings.difficulty = chip.dataset.value;
  if (PRESETS[settings.difficulty]) Object.assign(settings, PRESETS[settings.difficulty]);
  saveSettings();
  renderSettings();
  rerollVisibleSlots();
});

document.querySelectorAll(".chip-group[data-setting]").forEach((group) =>
  group.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const key = group.dataset.setting;
    if (String(settings[key]) === chip.dataset.value) return;
    settings[key] = chip.dataset.value;
    settings.difficulty = "custom"; // hand-tweaked — no longer a preset
    saveSettings();
    renderSettings();
    if (key === "obscurity") rerollVisibleSlots();
  })
);

$("#timer-minutes").addEventListener("change", () => {
  settings.timerMinutes = Math.max(1, Math.min(120, +$("#timer-minutes").value || 5));
  settings.difficulty = "custom";
  saveSettings();
  renderSettings();
});

renderSettings();

// ---- Theme (cinema dark by default) ----
function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  $("#btn-theme").textContent = dark ? "☀" : "☾";
  localStorage.setItem("theme", dark ? "dark" : "light");
}

// Slow radial reveal from the toggle button (View Transitions API,
// graceful cross-fade fallback elsewhere).
$("#btn-theme").addEventListener("click", () => {
  const dark = !document.body.classList.contains("dark");

  if (!document.startViewTransition) {
    document.body.style.transition = "background 0.6s, color 0.6s";
    applyTheme(dark);
    setTimeout(() => (document.body.style.transition = ""), 700);
    return;
  }

  const rect = $("#btn-theme").getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y)
  );

  const root = document.documentElement.style;
  root.setProperty("--reveal-x", x + "px");
  root.setProperty("--reveal-y", y + "px");
  root.setProperty("--reveal-r", radius + "px");
  document.startViewTransition(() => applyTheme(dark));
});

applyTheme(localStorage.getItem("theme") !== "light");

// ---- Poster rain: scrolling poster columns behind the home hero ----
// Built once from a snapshot of the prefetched pool (no extra API calls).
// The pool is already a round-robin mix of movies, shows, and people, and
// we re-interleave by type here so every column gets all three.
const RAIN_COLS = 6;
let rainBuilt = false;

async function initPosterRain() {
  if (rainBuilt || !apiKey) return;
  try {
    await fillPool();
  } catch {
    return; // no art, no rain — the blobs still carry the background
  }
  const byType = { movie: [], tv: [], person: [] };
  for (const it of pools[settings.obscurity])
    if (it.img) byType[it.type].push(it.img.replace("/w342/", "/w185/"));
  const urls = [];
  const max = Math.max(byType.movie.length, byType.tv.length, byType.person.length);
  for (let i = 0; i < max; i++)
    for (const t of ["movie", "person", "tv"])
      if (byType[t][i]) urls.push(byType[t][i]);
  if (urls.length < RAIN_COLS * 3) return; // too sparse to look intentional
  rainBuilt = true;

  // phones hide columns 5-6 in CSS (max-width: 700px) — don't build and
  // decode posters that will never show; low-memory devices get the same cap
  const cols =
    innerWidth <= 700 || (navigator.deviceMemory || 8) <= 4 ? 4 : RAIN_COLS;

  const rain = document.getElementById("poster-rain");
  // size each column to just cover the viewport — oversized animated
  // layers make the GPU re-rasterize tiles mid-scroll, which stutters
  const colWidth = (innerWidth - 32 - (cols - 1) * 16) / cols;
  const posterH = colWidth * 1.5 + 16;
  const perCol = Math.max(3, Math.ceil(innerHeight / posterH) + 1);

  const allImgs = [];
  for (let c = 0; c < cols; c++) {
    const col = document.createElement("div");
    col.className = "rain-col";
    const track = document.createElement("div");
    track.className = "rain-track";
    const colUrls = [];
    for (let i = 0; i < perCol; i++)
      colUrls.push(urls[(c * perCol + i) % urls.length]);
    // two identical halves — the -50% keyframe wraps seamlessly
    for (const url of [...colUrls, ...colUrls]) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      track.appendChild(img);
      allImgs.push(img);
    }
    // one shared speed for every column — only the start offset is random
    track.style.animationDelay = -Math.random() * 90 + "s";
    col.appendChild(track);
    rain.appendChild(col);
  }
  // decode every poster before fading in, so nothing pops or hitches later
  Promise.allSettled(allImgs.map((im) => im.decode())).then(() =>
    requestAnimationFrame(() => rain.classList.add("on"))
  );
}

// ---- Cycling genre fonts on the hero word ----
const WORD_FONTS = ["", "wf-action", "wf-horror", "wf-neon", "wf-western", "wf-noir", "wf-fantasy"];
let wfIndex = 0;
setInterval(() => {
  const word = document.getElementById("cycle-word");
  if (!word || word.closest(".hidden")) return; // only animate while visible
  wfIndex = (wfIndex + 1) % WORD_FONTS.length;
  word.className = WORD_FONTS[wfIndex];
  void word.offsetWidth; // restart the swap animation
  word.classList.add("swapping");
}, 2400);

// ---- Challenge links ----
// A challenge is the custom-game blob (TODO #7) serialized into the URL
// hash: start/goal keys + the rules that must be matched (timer, hints).
function b64url(s) {
  // unicode-safe: titles/names can contain anything
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
}

function buildChallengeLink(start, end) {
  const c = {
    v: 1,
    s: start.key,
    g: end.key,
    h: settings.hints === "yes" ? 1 : 0,
    t: settings.timer === "yes" ? settings.timerMinutes : 0,
  };
  return location.href.split("#")[0] + "#c=" + b64url(JSON.stringify(c));
}

// knowledge blitz: subject + minutes + (optionally) a score to beat
function buildKnowledgeLink(start, bar = 0) {
  const c = { v: 1, m: "k", s: start.key, t: settings.timerMinutes, n: bar };
  return location.href.split("#")[0] + "#c=" + b64url(JSON.stringify(c));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

// brief "✓ copied" feedback on whichever button was pressed
async function copyWithFeedback(btn, text) {
  const ok = await copyText(text);
  const orig = btn.innerHTML;
  btn.innerHTML = ok ? "✓ copied!" : "couldn't copy";
  btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = orig;
    btn.disabled = false;
  }, 1600);
}

$("#btn-share-link").addEventListener("click", (e) => {
  if (playMode === "hybrid") return; // no hybrid links yet (button is hidden)
  if (playMode === "knowledge") {
    if (!slots.start) return;
    copyWithFeedback(e.currentTarget, buildKnowledgeLink(slots.start));
    return;
  }
  if (!slots.start || !slots.end) return;
  copyWithFeedback(e.currentTarget, buildChallengeLink(slots.start, slots.end));
});

$("#btn-copy-challenge").addEventListener("click", (e) => {
  if (questMulti() && quest.link) {
    const cleared = quest.results.filter((r) => r.success).length;
    const named = quest.results
      .filter((r) => r.mode === "knowledge")
      .reduce((a, r) => a + r.score, 0);
    const text =
      `The Studio — “${quest.title || "a feature"}”: I cleared ` +
      `${cleared}/${quest.results.length} scenes${named ? ` and named ${named}` : ""}. ` +
      `Your turn: ${quest.link}`;
    copyWithFeedback(e.currentTarget, text);
    return;
  }
  const start = game.nodes.get(game.startKey);
  if (game.mode === "knowledge") {
    const text =
      `The Connection Game — I named ${game.placed} connection${game.placed === 1 ? "" : "s"} ` +
      `of ${start.name} in ${settings.timerMinutes} min. ` +
      `Beat me: ${quest.active && quest.link ? quest.link : buildKnowledgeLink(start, game.placed)}`;
    copyWithFeedback(e.currentTarget, text);
    return;
  }
  const end = game.nodes.get(game.endKey);
  const steps = shortestPath().length - 1;
  const text =
    `The Connection Game — I linked ${start.name} to ${end.name} ` +
    `in ${steps} link${steps === 1 ? "" : "s"} (${game.placed} placed` +
    `${hintsUsed ? `, ${hintsUsed} hint${hintsUsed === 1 ? "" : "s"}` : ""}). ` +
    `Beat me: ${quest.active && quest.link ? quest.link : buildChallengeLink(start, end)}`;
  copyWithFeedback(e.currentTarget, text);
});

// Opening a challenge link lands on the premiere (title card) screen;
// Roll Film starts the feature with the creator's rules applied
// (in memory only — not saved). Every blob version gets the premiere.
function typeSetFrom(ty) {
  return ty
    ? new Set([...ty].map((ch) => (ch === "m" ? "movie" : ch === "t" ? "tv" : "person")))
    : null;
}

async function tryLoadChallenge() {
  const m = location.hash.match(/[#&]c=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    return await loadFeature(JSON.parse(unb64url(m[1])), location.href);
  } catch {
    return false; // malformed link — fall through to the normal home screen
  }
}

// Boot a feature from a parsed blob — the shared core behind URL links,
// the Box Office shelves, and (someday) community rows from a backend.
async function loadFeature(c, link = "") {
  try {
    quest.link =
      link || location.href.split("#")[0] + "#c=" + b64url(JSON.stringify(c));
    quest.blob = c;
    quest.title = c.ti || "";
    quest.tag = c.tg || "";
    quest.by = c.by || "";
    quest.hints = !!c.h;
    quest.par = Array.isArray(c.par) ? c.par : c.par ? [c.par] : [];

    if (c.v >= 3 && Array.isArray(c.sc)) {
      // v3 — a Studio feature: bans are global; hints/types are per scene
      // (early v3 links carried global h/ty — read those as fallbacks)
      const bans = new Set(c.bans || []);
      quest.rounds = await Promise.all(
        c.sc.slice(0, 5).map(async (s) => ({
          mode: s.m === "k" ? "knowledge" : "classic",
          start: await fetchItemByKey(s.s),
          goal: s.g ? await fetchItemByKey(s.g) : null,
          minutes: s.t || 0,
          target: s.n || 0,
          budget: s.b || 0,
          hints: !!(s.h ?? c.h),
          rules: {
            budget: s.b || 0,
            bans,
            waypoints: await Promise.all((s.wps || []).map(fetchItemByKey)),
            types: typeSetFrom(s.ty || c.ty),
            target: s.n || 0,
            par: 0,
            title: c.ti || "",
            by: c.by || "",
          },
        }))
      );
    } else {
      // v1/v2 — a single-round challenge, wrapped in the same premiere flow
      const wpKeys = c.wps || (c.wp ? [c.wp] : []); // early v2 used single `wp`
      const rules = {
        budget: c.b || 0,
        bans: new Set(c.bans || []),
        waypoints: await Promise.all(wpKeys.map(fetchItemByKey)),
        types: typeSetFrom(c.ty),
        target: 0,
        par: c.par || 0,
        title: c.ti || "",
        by: c.by || "",
      };
      if (c.m === "k") {
        quest.rounds = [{
          mode: "knowledge",
          start: await fetchItemByKey(c.s),
          goal: null,
          minutes: c.t || 2,
          target: 0,
          bar: c.n || 0, // v2 knowledge: n = challenger's score to beat
          rules,
        }];
      } else {
        const [start, end] = await Promise.all([
          fetchItemByKey(c.s),
          fetchItemByKey(c.g),
        ]);
        quest.rounds = [{
          mode: "classic",
          start,
          goal: end,
          minutes: c.t || 0,
          rules,
        }];
      }
    }
    quest.active = true;
    showPremiere();
    return true;
  } catch {
    return false; // bad blob or a TMDB miss — caller decides what to show
  }
}

// ===== The Studio: quests (features of 1–5 scenes) =====
// A quest is a sequence of rounds played back to back behind one premiere
// title card. Multi-scene quests get intermissions between rounds and a
// finale that merges every scene's web into a single map — shared answers
// knit the rounds together on their own.
const quest = {
  active: false,
  rounds: [], // {mode, start, goal, minutes, target, budget, bar?, rules}
  idx: 0,
  results: [], // per scene: {mode, score, success}
  nodes: new Map(), // accumulated across scenes for the finale map
  edges: new Map(),
  title: "",
  tag: "",
  by: "",
  hints: false, // global: hints allowed in classic scenes
  par: [], // creator's per-scene scores (rides with the link)
  link: "", // the shareable link for this quest
  blob: null, // the parsed blob this quest was booted from (stub replays)
};

function questMulti() {
  return quest.active && quest.rounds.length > 1;
}

// Quest rounds tweak timer/hints in memory (never saved) — snapshot the
// player's own settings at Roll Film and restore them on the way out, so
// quick play (and a later saveSettings) never inherits a challenge's rules.
let settingsSnapshot = null;
function restoreQuestSettings() {
  if (!settingsSnapshot) return;
  Object.assign(settings, settingsSnapshot);
  settingsSnapshot = null;
  renderSettings();
}

// Ticket stubs: a local history of every feature you've finished.
function recordStub(line, ok) {
  if (!quest.active || builderTest) return;
  const r0 = quest.rounds[0];
  const stubs = JSON.parse(localStorage.getItem("stubs") || "[]");
  stubs.unshift({
    ti:
      quest.title ||
      (r0.mode === "knowledge"
        ? `Everything ${r0.start.name}`
        : `${r0.start.name} to ${r0.goal?.name || "?"}`),
    by: quest.by,
    img: r0.start.img,
    when: Date.now(),
    line,
    ok,
    blob: quest.blob, // lets a stub replay the exact feature
  });
  localStorage.setItem("stubs", JSON.stringify(stubs.slice(0, 30)));
}

// One-line description of a scene — shared by the premiere and the builder.
// Works on quest rounds (waypoints/types in .rules) and builder scenes
// (.waypoints array, .types array of allowed type names).
function sceneSummary(r) {
  const types = r.types || r.rules?.types; // array or Set, or null = all
  const typeNote = types
    ? ` · ${[...types]
        .map((t) => (t === "movie" ? "movies" : t === "tv" ? "shows" : "people"))
        .join(" + ")} only`
    : "";
  if (r.mode === "knowledge")
    return (
      `<b>${esc(r.start.name)}</b> — name ${r.target ? `<b>${r.target}</b> connections` : "everything you can"} in ${r.minutes || settings.timerMinutes} min` +
      typeNote
    );
  const wps = r.waypoints?.length ? r.waypoints : r.rules?.waypoints || [];
  return (
    `<b>${esc(r.start.name)}</b> to <b>${esc(r.goal.name)}</b>` +
    (wps.length ? ` · via ${wps.map((w) => esc(w.name)).join(", ")}` : "") +
    (r.budget || r.rules?.budget ? ` · ≤${r.budget || r.rules.budget} moves` : "") +
    (r.minutes ? ` · ${r.minutes} min` : "") +
    typeNote +
    (r.hints ? " · hints" : "")
  );
}

function showPremiere() {
  const r0 = quest.rounds[0];
  $("#prem-eyebrow").textContent = quest.by
    ? `A production by ${quest.by}`
    : questMulti()
      ? "A Studio production"
      : "You've been challenged";
  const title =
    quest.title ||
    (questMulti()
      ? `A feature in ${quest.rounds.length} scenes`
      : r0.mode === "knowledge"
        ? `Everything ${r0.start.name}`
        : `${r0.start.name} to ${r0.goal.name}`);
  $("#prem-title").innerHTML = `<em>${esc(title)}</em>`;
  $("#prem-tag").textContent = quest.tag;
  $("#prem-tag").classList.toggle("hidden", !quest.tag);
  $("#prem-scenes").innerHTML = quest.rounds
    .map(
      (r, i) =>
        `<div class="prem-scene"><span class="prem-num">${questMulti() ? i + 1 : "◆"}</span><span>${sceneSummary(r)}</span></div>`
    )
    .join("");
  const posters = [
    ...new Set(
      quest.rounds.flatMap((r) => [r.start?.img, r.goal?.img]).filter(Boolean)
    ),
  ].slice(0, 6);
  $("#premiere-posters").innerHTML = posters
    .map((p, i) => `<img src="${p.replace("/w342/", "/w500/")}" class="fan-${i}" alt="">`)
    .join("");
  showT("premiere");
}

async function startRound(i) {
  quest.idx = i;
  const r = quest.rounds[i];
  if (r.mode === "knowledge") {
    if (r.minutes) settings.timerMinutes = r.minutes;
    await startKnowledge(
      structuredClone(r.start),
      r.bar || quest.par[i] || 0,
      r.rules
    );
  } else {
    settings.timer = r.minutes ? "yes" : "no";
    if (r.minutes) settings.timerMinutes = r.minutes;
    settings.hints = (r.hints ?? quest.hints) ? "yes" : "no";
    renderSettings();
    if (!r.rules.par) r.rules.par = quest.par[i] || 0;
    await startGame(structuredClone(r.start), structuredClone(r.goal), r.rules);
  }
  if (questMulti())
    $("#game-goal").insertAdjacentHTML(
      "afterbegin",
      `<span class="goal-extra">Scene ${i + 1}/${quest.rounds.length} ·</span> `
    );
}

$("#btn-prem-play").addEventListener("click", () => {
  quest.idx = 0;
  quest.results = [];
  quest.nodes = new Map();
  quest.edges = new Map();
  // remember the player's own settings before a round tweaks them
  if (!settingsSnapshot) settingsSnapshot = { ...settings };
  startRound(0);
});

$("#btn-prem-home").addEventListener("click", () => {
  quest.active = false;
  restoreQuestSettings(); // hand the player's own settings back to quick play
  if (builderTest) {
    builderTest = false;
    showT("build");
    return;
  }
  showT("home");
});

// A scene is over (cleared or not) — merge its web, show the intermission.
function endRound(success) {
  stopTimer();
  game.over = true;
  boardActive = false;
  for (const [k, it] of game.nodes) quest.nodes.set(k, it);
  for (const [k, set] of game.edges) {
    if (!quest.edges.has(k)) quest.edges.set(k, new Set());
    for (const n of set) quest.edges.get(k).add(n);
  }
  const r = quest.rounds[quest.idx];
  const score =
    r.mode === "knowledge"
      ? game.placed
      : success
        ? shortestPath().length - 1
        : 0;
  quest.results.push({ mode: r.mode, score, success });
  const last = quest.idx >= quest.rounds.length - 1;
  const par = quest.par[quest.idx];
  $("#round-eyebrow").textContent = `Scene ${quest.idx + 1} of ${quest.rounds.length}`;
  $("#round-h1").innerHTML = success ? "<em>Scene complete.</em>" : "<em>Cut!</em>";
  $("#round-text").innerHTML =
    (r.mode === "knowledge"
      ? `You named <b>${score}</b> connection${score === 1 ? "" : "s"} of ${esc(r.start.name)}.`
      : success
        ? `${esc(r.start.name)} to ${esc(r.goal.name)} in <b>${score}</b> link${score === 1 ? "" : "s"}.`
        : `The chain never closed — the next scene is waiting.`) +
    (par ? ` <span class="round-par">Creator's score: <b>${par}</b>.</span>` : "");
  $("#btn-next-round").innerHTML = last
    ? `The Finale <span class="arrow-r">→</span>`
    : `Next Scene <span class="arrow-r">→</span>`;
  $("#round-modal").classList.remove("hidden");
}

$("#btn-next-round").addEventListener("click", () => {
  $("#round-modal").classList.add("hidden");
  if (quest.idx < quest.rounds.length - 1) startRound(quest.idx + 1);
  else showFinale();
});

// The finale: every scene's nodes and edges on one board, plus the
// credits (per-scene results) in the win-modal shell.
async function showFinale() {
  game.mode = "classic";
  game.won = true; // locks placements; view-the-web works as usual
  game.over = true;
  game.rules = null;
  game.startKey = null;
  game.endKey = null;
  game.nodes = new Map(quest.nodes);
  game.edges = new Map([...quest.edges].map(([k, s]) => [k, new Set(s)]));
  sim.clear();
  edgeEls.length = 0;
  nodesLayer.innerHTML = "";
  edgesSvg.innerHTML = "";
  $("#btn-show-results").classList.add("hidden");
  $("#game-goal").innerHTML =
    `<span class="goal-start">${esc(quest.title || "The feature")}</span>` +
    `<span class="goal-sep">·</span><span class="goal-end">the full map</span>`;
  $("#game-timer").classList.add("hidden");
  $("#btn-hint").classList.add("hidden");
  $("#btn-finish").classList.add("hidden");
  $("#btn-undo").classList.add("hidden");
  setMessage("Every scene, one web.");
  $("#stat-placed").textContent = "Placed: " + game.nodes.size;
  await showT("game");

  // scene subjects pinned in a wide ring; everything else settles via physics
  const anchors = new Set();
  for (const r of quest.rounds) {
    anchors.add(r.start.key);
    if (r.goal) anchors.add(r.goal.key);
  }
  const keys = [...game.nodes.keys()];
  const R = 160 + 36 * Math.sqrt(keys.length);
  const anchorList = [...anchors].filter((k) => game.nodes.has(k));
  anchorList.forEach((k, i) => {
    const ang = (i / anchorList.length) * Math.PI * 2 - Math.PI / 2;
    addBoardNode(game.nodes.get(k), Math.cos(ang) * R, Math.sin(ang) * R, true);
  });
  for (const k of keys) {
    if (anchors.has(k)) continue;
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.random() * R * 0.8;
    addBoardNode(game.nodes.get(k), Math.cos(ang) * rr, Math.sin(ang) * rr);
  }
  const drawn = new Set();
  for (const [k, set] of game.edges)
    for (const n of set) {
      const id = k < n ? k + "|" + n : n + "|" + k;
      if (drawn.has(id) || !game.nodes.has(n)) continue;
      drawn.add(id);
      addEdgeLine(k, n);
    }
  const rect = viewport.getBoundingClientRect();
  view.scale = Math.min(1, rect.width / (R * 2 + 420));
  view.x = rect.width / 2;
  view.y = rect.height / 2 - 30;
  applyView();
  boardActive = true;

  // roll the credits
  if (builderTest) {
    builder.parRounds = quest.results.map((res) => res.score); // verified
    builder.par = 0;
  }
  const named = quest.results
    .filter((r) => r.mode === "knowledge")
    .reduce((a, r) => a + r.score, 0);
  const cleared = quest.results.filter((r) => r.success).length;
  recordStub(
    `${cleared}/${quest.results.length} scenes cleared${named ? ` · ${named} named` : ""}`,
    cleared === quest.results.length
  );
  $("#btn-copy-challenge").classList.remove("hidden"); // hybrid wins hide it
  $("#btn-save-card").classList.add("hidden"); // finale card would be stale
  $("#win-stars").classList.add("hidden"); // the credits speak for themselves
  $("#win-daily").classList.add("hidden");
  $("#btn-share-daily").classList.add("hidden");
  $("#win-modal .eyebrow").textContent = "That's a wrap";
  $("#win-modal h1").innerHTML = "<em>The credits roll.</em>";
  $("#win-score").innerHTML =
    `<b>${cleared}/${quest.results.length}</b> scenes cleared` +
    (named ? ` · <b>${named}</b> named` : "") +
    ".";
  $("#win-path").innerHTML = quest.results
    .map((res, i) => {
      const r = quest.rounds[i];
      const par = quest.par[i];
      const it = r.start;
      const line =
        res.mode === "knowledge"
          ? `${esc(r.start.name)}: <b>${res.score}</b> named`
          : `${esc(r.start.name)} → ${esc(r.goal.name)}: ` +
            (res.success ? `<b>${res.score}</b> link${res.score === 1 ? "" : "s"}` : "unfinished");
      return `<div class="path-item">
        ${it.img ? `<img src="${it.img}">` : `<div class="no-img">${TYPE_EMOJI[it.type]}</div>`}
        <span>${res.success ? "✓" : "✗"} ${line}${par ? ` · creator ${par}` : ""}</span></div>`;
    })
    .join("");
  setTimeout(() => $("#win-modal").classList.remove("hidden"), 400);
}

// ===== Challenge Builder =====
const builder = {
  mode: "classic",
  start: null,
  goal: null,
  timer: "no",
  minutes: 5,
  hints: "no",
  budget: 0,
  target: 0, // knowledge: name this many to clear the scene (0 = pure clock)
  types: { movie: true, tv: true, person: true },
  waypoints: [], // up to 3 must-pass items (captured per scene)
  bans: [],
  scenes: [], // the feature — up to 5 frames on the reel
  editing: -1, // index of the frame loaded in the editor (-1 = composing new)
  title: "",
  tag: "",
  by: "",
  par: 0, // single-round verified score
  parRounds: [], // multi-scene verified scores, one per scene
};
let builderTest = false; // a test run is in progress

function openBuilder() {
  showT("build");
  renderBuilder();
}

// Rolls only touch the editor's draft — nothing is final until Save Scene.
const buildRollSeq = { start: 0, goal: 0 }; // guards against out-of-order results
async function builderRoll(which) {
  const token = ++buildRollSeq[which];
  if (!builder[which]) renderBuilderPick(which); // loading pulse on an empty card
  const other = builder[which === "start" ? "goal" : "start"];
  const item = await takeRandomItem(other?.key);
  await posterReady(item);
  if (token !== buildRollSeq[which]) return; // a newer roll/pick superseded this one
  builder[which] = item;
  renderBuilderPick(which);
}

function renderBuilderPick(which) {
  renderItemDisplay($(`#scene-${which}-display`), builder[which]);
  updateSceneSave();
}

// Save is live only once the matchup is complete for the chosen mode.
function updateSceneSave() {
  $("#btn-scene-save").disabled =
    !(builder.start && (builder.mode === "knowledge" || builder.goal));
}

function renderParStatus() {
  const el = $("#build-par-status");
  if (builder.parRounds.length) {
    el.innerHTML = `✓ Verified — your scores: <b>${builder.parRounds.join(" · ")}</b>. They ride with the link.`;
    el.classList.add("verified");
  } else if (builder.par) {
    el.innerHTML =
      builder.mode === "knowledge"
        ? `✓ Verified — your score: <b>${builder.par}</b>. It rides with the link.`
        : `✓ Verified — your par: <b>${builder.par}</b>. It rides with the link.`;
    el.classList.add("verified");
  } else {
    el.textContent = "Untested — run it yourself to stamp a par.";
    el.classList.remove("verified");
  }
}

function renderRuleChips() {
  updateRulesSummary(); // the pill mirrors the draft's rules
  $("#build-wp-chips").innerHTML = builder.waypoints
    .map(
      (w, i) =>
        `<span class="rule-chip">via ${esc(w.name)}<button data-wp="${i}">×</button></span>`
    )
    .join("");
  $("#build-ban-chips").innerHTML = builder.bans
    .map(
      (b, i) =>
        `<span class="rule-chip">🚫 ${esc(b.name)}<button data-ban="${i}">×</button></span>`
    )
    .join("");
}

function renderBuilder() {
  renderStage();
  renderParStatus();
}

// The stage: your own premiere page, growing as you build.
function renderStage() {
  $("#build-title").value = builder.title;
  $("#build-tag").value = builder.tag;
  $("#build-by").value = builder.by;
  $("#build-scenes").innerHTML = builder.scenes
    .map(
      (s, i) => `<div class="scene-row">
        <button class="prem-scene build-scene" data-i="${i}" title="tap to edit">
          <span class="prem-num">${i + 1}</span>
          <span class="scene-thumbs">${sceneThumb(s.start)}${s.mode === "classic" ? sceneThumb(s.goal) : ""}</span>
          <span class="scene-text">${sceneSummary(s)}</span>
          <span class="scene-pencil">✎</span>
        </button>
        <div class="scene-tools">
          <button class="btn icon" data-act="up" data-i="${i}" title="play earlier"${i === 0 ? " disabled" : ""}>▲</button>
          <button class="btn icon" data-act="down" data-i="${i}" title="play later"${i === builder.scenes.length - 1 ? " disabled" : ""}>▼</button>
          <button class="btn icon" data-act="cut" data-i="${i}" title="cut this scene">✕</button>
        </div>
      </div>`
    )
    .join("");
  const n = builder.scenes.length;
  const add = $("#btn-add-scene");
  add.disabled = n >= MAX_SCENES;
  add.textContent =
    n === 0
      ? "＋ add your first scene"
      : n >= MAX_SCENES
        ? `the reel is full — ${MAX_SCENES} scenes`
        : "＋ add a scene";
  $("#btn-build-test").disabled = n === 0;
  $("#btn-build-copy").disabled = n === 0;
  $("#btn-build-ticket").disabled = n === 0;
  renderBuildPosters();
}

function sceneThumb(it) {
  return it?.img
    ? `<img src="${it.img}" alt="">`
    : `<span class="no-thumb">${TYPE_EMOJI[it?.type] || "🎞️"}</span>`;
}

// the poster fan grows with every scene you add — same look as the premiere
function renderBuildPosters() {
  const posters = [
    ...new Set(
      builder.scenes.flatMap((s) => [s.start?.img, s.goal?.img]).filter(Boolean)
    ),
  ].slice(0, 6);
  $("#build-posters").innerHTML = posters
    .map((p, i) => `<img src="${p.replace("/w342/", "/w500/")}" class="fan-${i}" alt="">`)
    .join("");
}

// One line on the rules pill — what this scene asks for beyond the matchup.
function sceneRulesSummary() {
  const parts = [];
  if (builder.mode === "knowledge") {
    parts.push(`${builder.minutes} min`);
    if (builder.target) parts.push(`name ${builder.target}`);
  } else {
    if (builder.timer === "yes") parts.push(`${builder.minutes} min`);
    if (builder.hints === "yes") parts.push("hints");
    if (builder.budget) parts.push(`≤${builder.budget} moves`);
    if (builder.waypoints.length === 1)
      parts.push(`via ${builder.waypoints[0].name}`);
    else if (builder.waypoints.length)
      parts.push(`via ${builder.waypoints.length} stops`);
  }
  const types = Object.keys(builder.types).filter((t) => builder.types[t]);
  if (types.length < 3)
    parts.push(
      types
        .map((t) => (t === "movie" ? "movies" : t === "tv" ? "shows" : "people"))
        .join(" + ") + " only"
    );
  return parts.length ? parts.join(" · ") : "none — anything goes";
}

function updateRulesSummary() {
  $("#scene-rules-summary").textContent = sceneRulesSummary();
}

// The scene editor: a full screen, built like the quick-play setup screen.
function renderSceneEditor() {
  const k = builder.mode === "knowledge";
  const editing = builder.editing >= 0;
  $("#screen-scene").classList.toggle("k-mode", k);
  $("#scene-rules-sheet").classList.toggle("k-mode", k);
  $("#scene-eyebrow").textContent = editing
    ? `Scene ${builder.editing + 1}`
    : `Scene ${builder.scenes.length + 1} — new`;
  $("#scene-title").innerHTML = k
    ? `Name everything tied to <em>this</em>.`
    : `Connect <em>this</em> to <em>that</em>.`;
  $("#btn-scene-save").textContent = editing ? "✓ Save Scene" : "＋ Add Scene";
  document.querySelectorAll("#scene-mode-chips .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.value === builder.mode)
  );
  document.querySelectorAll("#build-timer .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.value === builder.timer)
  );
  $("#build-minutes").value = builder.minutes;
  $("#build-minutes-wrap").classList.toggle(
    "disabled",
    builder.mode === "classic" && builder.timer !== "yes"
  );
  $("#build-budget").value = builder.budget || "";
  $("#build-target").value = builder.target || "";
  document.querySelectorAll("#build-hints .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.value === builder.hints)
  );
  document.querySelectorAll("#build-types .chip").forEach((c) =>
    c.classList.toggle("active", builder.types[c.dataset.value])
  );
  renderBuilderPick("start");
  renderBuilderPick("goal");
  renderRuleChips();
}

function voidPar() {
  builder.par = 0;
  builder.parRounds = [];
  renderParStatus();
}

// scene-editor draft controls — nothing counts until Save Scene
$("#scene-mode-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || chip.dataset.value === builder.mode) return;
  builder.mode = chip.dataset.value;
  renderSceneEditor();
  // a knowledge scene flipped to classic may have no goal yet — deal one
  if (builder.mode === "classic" && !builder.goal) builderRoll("goal");
});
$("#build-timer").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  builder.timer = chip.dataset.value;
  renderSceneEditor();
});
$("#build-minutes").addEventListener("change", () => {
  builder.minutes = Math.max(1, Math.min(120, +$("#build-minutes").value || 5));
  renderSceneEditor();
});
$("#build-budget").addEventListener("change", () => {
  builder.budget = Math.max(0, Math.min(50, +$("#build-budget").value || 0));
  renderSceneEditor();
});
$("#build-target").addEventListener("change", () => {
  builder.target = Math.max(0, Math.min(50, +$("#build-target").value || 0));
  renderSceneEditor();
});

// hints + allowed types are per-scene draft knobs, like the clock
$("#build-hints").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  builder.hints = chip.dataset.value;
  renderSceneEditor();
});
$("#build-types").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const t = chip.dataset.value;
  const on = Object.values(builder.types).filter(Boolean).length;
  if (builder.types[t] && on === 1) return; // at least one type stays allowed
  builder.types[t] = !builder.types[t];
  renderSceneEditor();
});

$("#build-title").addEventListener("input", () => (builder.title = $("#build-title").value));
$("#build-tag").addEventListener("input", () => (builder.tag = $("#build-tag").value));
$("#build-by").addEventListener("input", () => (builder.by = $("#build-by").value));

document.querySelectorAll(".scene-reroll").forEach((btn) =>
  btn.addEventListener("click", () => builderRoll(btn.dataset.pick))
);
document.querySelectorAll(".scene-pick-search").forEach((input) => {
  const listEl = input.parentElement.querySelector(".suggestions");
  attachAutocomplete(input, listEl, (item) => {
    buildRollSeq[input.dataset.pick]++; // cancel any in-flight roll for this pick
    builder[input.dataset.pick] = item; // draft only — final on Save Scene
    renderBuilderPick(input.dataset.pick);
  });
});
attachAutocomplete(
  $("#build-wp-search"),
  $("#build-wp-search").parentElement.querySelector(".suggestions"),
  (item) => {
    if (builder.waypoints.length >= 3) return; // keep gauntlets (and links) sane
    if (!builder.waypoints.some((w) => w.key === item.key))
      builder.waypoints.push(item);
    renderRuleChips();
  }
);
attachAutocomplete(
  $("#build-ban-search"),
  $("#build-ban-search").parentElement.querySelector(".suggestions"),
  (item) => {
    if (!builder.bans.some((b) => b.key === item.key)) builder.bans.push(item);
    voidPar(); // bans hit the whole feature immediately
    renderRuleChips();
  }
);

// remove waypoint chips (sheet draft) / ban chips (global, voids par)
$("#build-wp-chips").addEventListener("click", (e) => {
  const wp = e.target.closest("[data-wp]");
  if (!wp) return;
  builder.waypoints.splice(+wp.dataset.wp, 1);
  renderRuleChips();
});
$("#build-ban-chips").addEventListener("click", (e) => {
  const ban = e.target.closest("[data-ban]");
  if (!ban) return;
  builder.bans.splice(+ban.dataset.ban, 1);
  voidPar();
  renderRuleChips();
});

// ---- Scenes: the feature reel ----
const MAX_SCENES = 5; // raise once features live in a backend, not the URL

function sceneFromDraft() {
  const allTypes = Object.values(builder.types).every(Boolean);
  return {
    mode: builder.mode,
    start: structuredClone(builder.start),
    goal: builder.mode === "classic" ? structuredClone(builder.goal) : null,
    minutes:
      builder.mode === "knowledge"
        ? builder.minutes
        : builder.timer === "yes"
          ? builder.minutes
          : 0,
    target: builder.mode === "knowledge" ? builder.target : 0,
    budget: builder.mode === "classic" ? builder.budget : 0,
    waypoints: builder.mode === "classic" ? structuredClone(builder.waypoints) : [],
    hints: builder.mode === "classic" && builder.hints === "yes",
    types: allTypes
      ? null
      : Object.keys(builder.types).filter((t) => builder.types[t]), // array of allowed
  };
}

// scenes are always explicit — a feature is 1–5 of them, no hidden fallback
function builderScenes() {
  return builder.scenes;
}

// ---- The scene editor: open, save, leave ----
// Backing out of a dirty draft asks first — no more silent discards.
let sceneSnapshot0 = "";
function sceneSnapshot() {
  return JSON.stringify({
    m: builder.mode,
    s: builder.start?.key,
    g: builder.goal?.key,
    t: builder.timer,
    min: builder.minutes,
    n: builder.target,
    b: builder.budget,
    h: builder.hints,
    ty: builder.types,
    wp: builder.waypoints.map((w) => w.key),
  });
}

async function openSceneEditor(i = -1) {
  builder.editing = i;
  buildRollSeq.start++; // orphan any roll still in flight from a previous visit
  buildRollSeq.goal++;
  if (i >= 0) {
    // load the scene into the draft
    const s = builder.scenes[i];
    builder.mode = s.mode;
    builder.start = structuredClone(s.start);
    builder.goal = s.goal ? structuredClone(s.goal) : null;
    if (s.minutes) builder.minutes = s.minutes;
    if (s.mode === "classic") builder.timer = s.minutes ? "yes" : "no";
    builder.target = s.target || 0;
    builder.budget = s.budget || 0;
    builder.waypoints = structuredClone(s.waypoints || []);
    builder.hints = s.hints ? "yes" : "no";
    builder.types = {
      movie: !s.types || s.types.includes("movie"),
      tv: !s.types || s.types.includes("tv"),
      person: !s.types || s.types.includes("person"),
    };
    renderSceneEditor();
    showT("scene");
    sceneSnapshot0 = sceneSnapshot();
    return;
  }
  // fresh scene — fresh draft with a fresh random matchup
  builder.start = null;
  builder.goal = null;
  builder.target = 0;
  builder.budget = 0;
  builder.waypoints = [];
  builder.hints = "no";
  builder.types = { movie: true, tv: true, person: true };
  renderSceneEditor();
  showT("scene");
  sceneSnapshot0 = sceneSnapshot(); // pre-roll, in case the user bails early
  await Promise.all([builderRoll("start"), builderRoll("goal")]);
  sceneSnapshot0 = sceneSnapshot(); // the auto-rolled matchup isn't "changes"
}

$("#btn-add-scene").addEventListener("click", () => {
  if (builder.scenes.length >= MAX_SCENES) return;
  openSceneEditor(-1);
});

// scene rows open the editor; the row tools reorder/cut in place
$("#build-scenes").addEventListener("click", (e) => {
  const tool = e.target.closest("[data-act]");
  if (tool) {
    const i = +tool.dataset.i;
    const sc = builder.scenes;
    if (tool.dataset.act === "up" && i > 0) {
      [sc[i - 1], sc[i]] = [sc[i], sc[i - 1]];
    } else if (tool.dataset.act === "down" && i < sc.length - 1) {
      [sc[i], sc[i + 1]] = [sc[i + 1], sc[i]];
    } else if (tool.dataset.act === "cut") {
      if (!confirm(`Cut scene ${i + 1} from the feature?`)) return;
      sc.splice(i, 1);
    } else {
      return;
    }
    voidPar();
    renderBuilder();
    return;
  }
  const row = e.target.closest(".build-scene[data-i]");
  if (row) openSceneEditor(+row.dataset.i);
});

$("#btn-scene-save").addEventListener("click", () => {
  if (!(builder.start && (builder.mode === "knowledge" || builder.goal))) return;
  if (builder.editing >= 0) builder.scenes[builder.editing] = sceneFromDraft();
  else builder.scenes.push(sceneFromDraft());
  builder.editing = -1;
  voidPar();
  showT("build");
  renderBuilder();
});

$("#btn-scene-back").addEventListener("click", () => {
  if (
    sceneSnapshot() !== sceneSnapshot0 &&
    !confirm("Leave without saving? This scene's changes will be lost.")
  )
    return;
  builder.editing = -1;
  showT("build");
  renderBuilder();
});
// the scene-rules sheet edits the live draft — closing it discards nothing
$("#btn-scene-rules").addEventListener("click", () =>
  $("#scene-rules-sheet").classList.remove("hidden")
);
$("#btn-scene-rules-done").addEventListener("click", () =>
  $("#scene-rules-sheet").classList.add("hidden")
);
$("#scene-rules-sheet").addEventListener("click", (e) => {
  if (e.target === e.currentTarget)
    $("#scene-rules-sheet").classList.add("hidden");
});

$("#rules-sheet").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("#rules-sheet").classList.add("hidden");
});
$("#btn-build-rules").addEventListener("click", () => {
  renderRuleChips();
  $("#rules-sheet").classList.remove("hidden");
});
$("#btn-rules-done").addEventListener("click", () =>
  $("#rules-sheet").classList.add("hidden")
);

function builderReady() {
  return builder.scenes.length > 0;
}

function buildStudioBlob() {
  const c = {
    v: 3,
    sc: builderScenes().map((s) => {
      const r = { m: s.mode === "knowledge" ? "k" : "c", s: s.start.key };
      if (r.m === "c") {
        r.g = s.goal.key;
        if (s.minutes) r.t = s.minutes;
        if (s.budget) r.b = s.budget;
        if (s.waypoints?.length) r.wps = s.waypoints.map((w) => w.key);
        if (s.hints) r.h = 1;
      } else {
        r.t = s.minutes || 2;
        if (s.target) r.n = s.target;
      }
      if (s.types) r.ty = s.types.map((t) => t[0]).join(""); // m / t / p
      return r;
    }),
  };
  if (builder.bans.length) c.bans = builder.bans.map((b) => b.key);
  if (builder.title.trim()) c.ti = builder.title.trim();
  if (builder.tag.trim()) c.tg = builder.tag.trim();
  if (builder.by.trim()) c.by = builder.by.trim();
  const par = builder.parRounds.length
    ? builder.parRounds
    : builder.par
      ? [builder.par]
      : null;
  if (par) c.par = par;
  return c;
}

function buildStudioLink() {
  return (
    location.href.split("#")[0] + "#c=" + b64url(JSON.stringify(buildStudioBlob()))
  );
}

// Releasing a feature also files it on your Box Office shelf — a copied
// link shouldn't be the only place your work exists.
function saveToShelf(blob) {
  const shelf = JSON.parse(localStorage.getItem("shelf") || "[]");
  const json = JSON.stringify(blob);
  if (shelf.some((f) => JSON.stringify(f.blob) === json)) return; // re-release, unchanged
  shelf.unshift({ id: Date.now(), blob, savedAt: Date.now() });
  localStorage.setItem("shelf", JSON.stringify(shelf.slice(0, 30)));
}

// Test Run plays the whole feature through the same premiere the player
// will see; finishing stamps your per-scene scores as the par.
$("#btn-build-test").addEventListener("click", () => {
  if (!builderReady()) return;
  builderTest = true;
  const bans = new Set(builder.bans.map((b) => b.key));
  quest.active = true;
  quest.hints = false; // hints are per-scene now
  quest.title = builder.title.trim();
  quest.tag = builder.tag.trim();
  quest.by = builder.by.trim();
  quest.par = []; // you're setting the par, not chasing one
  quest.link = buildStudioLink();
  quest.idx = 0;
  quest.results = [];
  quest.nodes = new Map();
  quest.edges = new Map();
  quest.rounds = builderScenes().map((s) => ({
    mode: s.mode,
    start: structuredClone(s.start),
    goal: s.goal ? structuredClone(s.goal) : null,
    minutes: s.minutes,
    target: s.target,
    budget: s.budget,
    hints: !!s.hints,
    rules: {
      budget: s.budget || 0,
      bans,
      waypoints: s.waypoints ? structuredClone(s.waypoints) : [],
      types: s.types ? new Set(s.types) : null,
      target: s.target || 0,
      par: 0,
      title: builder.title.trim(),
      by: builder.by.trim(),
    },
  }));
  showPremiere();
});

$("#btn-build-copy").addEventListener("click", (e) => {
  if (!builderReady()) return;
  copyWithFeedback(e.currentTarget, buildStudioLink());
  saveToShelf(buildStudioBlob()); // released = on your filmography shelf
});

$("#btn-build-back").addEventListener("click", () => showT("home"));

// ===== The casting call: full-page TMDB browse =====
// One screen, two moods. From quick-play setup ("slot" mode) a tap fills
// the slot you came from and returns — little clicks. From the Studio
// ("studio" mode) it's a casting session: pick a target chip (Start /
// Goal / Via / Ban), tap results to assign, leave when you're done.
const cast = {
  ctx: null, // { mode: "slot", slot } | { mode: "studio", target }
  query: "",
  type: "any", // any | movie | tv | person
  page: 1,
  totalPages: 1,
  results: [], // raw TMDB results backing the grid (raw: fame/year/known_for)
  seq: 0, // guards against out-of-order responses
  trail: [], // research mode: the chain of items walked in the detail panel
};

// vote_count for titles / popularity for people, mapped onto the same
// obscurity vocabulary the difficulty presets use (thresholds live in fameTier)
function fameBadge(raw, type) {
  // pass missing fame through as null (no badge) — coercing to 0 used to
  // mislabel unknown-fame items as "crazy", the most obscure tier
  const fame = type === "person" ? raw.popularity : raw.vote_count;
  return fameTier(fame ?? null, type);
}

function openCasting(ctx) {
  cast.ctx = ctx;
  cast.query = "";
  cast.type = "any";
  cast.results = [];
  $("#cast-search").value = "";
  $("#cast-grid").innerHTML = "";
  $("#btn-cast-more").classList.add("hidden");
  $("#cast-eyebrow").textContent =
    ctx.mode === "slot"
      ? ctx.goal != null
        ? `Casting Goal ${ctx.goal + 1}`
        : `Casting your ${ctx.slot === "start" ? "Start" : "Goal"}`
      : ctx.mode === "studio"
        ? "Casting for your feature"
        : "The Back Lot";
  $("#cast-title").innerHTML =
    ctx.mode === "research"
      ? `Follow the <em>threads</em>.`
      : `Cast <em>anything</em>.`;
  $("#btn-cast-back").innerHTML =
    ctx.mode === "slot" ? "← back" : ctx.mode === "studio" ? "✓ done" : "← home";
  $("#screen-cast").classList.toggle(
    "k-mode",
    ctx.mode === "studio" && builder.mode === "knowledge"
  );
  renderCastTargets();
  renderCastSession();
  document.querySelectorAll("#cast-types .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.value === "any")
  );
  showT("cast");
  $("#cast-search").focus();
  castSearch();
}

function renderCastTargets() {
  const studio = cast.ctx?.mode === "studio";
  $("#cast-targets").classList.toggle("hidden", !studio);
  if (!studio) return;
  document.querySelectorAll("#cast-targets .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.value === cast.ctx.target)
  );
}

// the running tally of what's been cast so far (studio sessions only)
function renderCastSession(flash) {
  const el = $("#cast-session");
  if (cast.ctx?.mode !== "studio") {
    el.textContent = "";
    return;
  }
  el.innerHTML = flash
    ? flash
    : `Start: <b>${builder.start ? esc(builder.start.name) : "—"}</b> · ` +
      (builder.mode === "knowledge"
        ? ""
        : `Goal: <b>${builder.goal ? esc(builder.goal.name) : "—"}</b> · `) +
      `via ${builder.waypoints.length} · bans ${builder.bans.length}`;
  el.classList.toggle("flash", !!flash);
  if (flash) {
    clearTimeout(renderCastSession.t);
    renderCastSession.t = setTimeout(() => renderCastSession(), 1400);
  }
}

async function castSearch(append = false) {
  const token = ++cast.seq;
  if (!append) cast.page = 1;
  const q = cast.query.trim();
  let path;
  let params = { page: cast.page, include_adult: "false" };
  if (q) {
    path = cast.type === "any" ? "/search/multi" : `/search/${cast.type}`;
    params.query = q;
  } else {
    // nothing typed — show what's trending so the stage is never empty
    path = cast.type === "any" ? "/trending/all/week" : `/trending/${cast.type}/week`;
  }
  try {
    const data = await tmdb(path, params);
    if (token !== cast.seq) return; // a newer search superseded this one
    const raws = (data.results || []).filter((r) =>
      ["movie", "tv", "person"].includes(r.media_type || cast.type)
    );
    cast.totalPages = Math.min(data.total_pages || 1, 20);
    cast.results = append ? cast.results.concat(raws) : raws;
    renderCastGrid();
  } catch {
    if (token === cast.seq)
      $("#cast-grid").innerHTML = `<p class="cast-empty">TMDB didn't answer — try again.</p>`;
  }
}

function castCardHTML(raw, i) {
  const type = raw.media_type || cast.type;
  const name = raw.title || raw.name || "?";
  const img = raw.poster_path || raw.profile_path;
  const year = (raw.release_date || raw.first_air_date || "").slice(0, 4);
  const dept =
    type === "person" && raw.known_for_department !== "Acting"
      ? raw.known_for_department
      : "";
  const known = (raw.known_for || [])
    .map((k) => k.title || k.name)
    .filter(Boolean)
    .slice(0, 2)
    .join(", ");
  const fame = fameBadge(raw, type);
  return `<button class="cast-card" data-i="${i}">
    ${fame ? `<span class="cast-fame">${fame}</span>` : ""}
    <div class="cast-poster">${
      img
        ? `<img loading="lazy" src="${IMG + img}" alt="">`
        : `<span class="cast-fallback">${TYPE_EMOJI[type]}</span>`
    }</div>
    <div class="cast-info">
      <div class="cast-name">${esc(name)}</div>
      <div class="cast-meta">${TYPE_LABEL[type]}${year ? " · " + year : ""}${dept ? " · " + esc(dept) : ""}</div>
      ${known ? `<div class="cast-known">known for ${esc(known)}</div>` : ""}
    </div>
  </button>`;
}

function renderCastGrid() {
  $("#cast-grid").innerHTML = cast.results.length
    ? cast.results.map(castCardHTML).join("")
    : `<p class="cast-empty">Nothing found — try another name.</p>`;
  $("#btn-cast-more").classList.toggle(
    "hidden",
    cast.page >= cast.totalPages || !cast.results.length
  );
  updateCastMarks();
}

// Light up cards that hold a role, so the grid shows what's already cast.
function updateCastMarks() {
  const roleOf = (key) => {
    if (cast.ctx?.mode === "slot")
      return slots.start?.key === key
        ? "start"
        : slots.end?.key === key ||
            goalSlots.some((g, i) => i < settings.hybridN && g?.key === key)
          ? "goal"
          : "";
    if (builder.start?.key === key) return "start";
    if (builder.goal?.key === key) return "goal";
    if (builder.waypoints.some((w) => w.key === key)) return "via";
    if (builder.bans.some((b) => b.key === key)) return "ban";
    return "";
  };
  document.querySelectorAll("#cast-grid .cast-card").forEach((el) => {
    const raw = cast.results[+el.dataset.i];
    if (!raw) return;
    const role = roleOf((raw.media_type || cast.type) + "-" + raw.id);
    if (role) el.dataset.role = role;
    else delete el.dataset.role;
  });
}

// tap a card: slot mode assigns and returns; studio mode assigns and stays
$("#cast-grid").addEventListener("click", (e) => {
  const cardEl = e.target.closest(".cast-card");
  if (!cardEl) return;
  const raw = cast.results[+cardEl.dataset.i];
  if (!raw) return;
  const item = makeItem(raw, raw.media_type || cast.type);
  const ctx = cast.ctx;
  if (ctx.mode === "research") {
    cast.trail = []; // a fresh walk starts at this card
    openCastDetail(item);
    return;
  }
  if (ctx.mode === "slot") {
    if (ctx.goal != null) {
      goalRollSeq[ctx.goal]++; // cancel any in-flight roll
      goalSlots[ctx.goal] = item;
      renderItemDisplay(
        document.querySelector(`.item-display[data-goal-slot="${ctx.goal}"]`),
        item
      );
    } else {
      rerollSeq[ctx.slot]++; // cancel any in-flight reroll
      slots[ctx.slot] = item;
      renderSlotDisplays(ctx.slot, item);
    }
    showT("mode");
    return;
  }
  const t = ctx.target;
  if (t === "start" || t === "goal") {
    buildRollSeq[t]++;
    builder[t] = item;
    renderCastSession(`✓ <b>${esc(item.name)}</b> → ${t === "start" ? "Start" : "Goal"}`);
  } else if (t === "via") {
    const i = builder.waypoints.findIndex((w) => w.key === item.key);
    if (i >= 0) {
      builder.waypoints.splice(i, 1); // second tap un-casts
      renderCastSession(`<b>${esc(item.name)}</b> removed from via`);
    } else if (builder.waypoints.length >= 3) {
      renderCastSession("via is full — 3 stops max");
      return;
    } else {
      builder.waypoints.push(item);
      renderCastSession(`✓ via <b>${esc(item.name)}</b>`);
    }
  } else if (t === "ban") {
    const i = builder.bans.findIndex((b) => b.key === item.key);
    if (i >= 0) {
      builder.bans.splice(i, 1); // second tap un-bans
      renderCastSession(`<b>${esc(item.name)}</b> un-banned`);
    } else {
      builder.bans.push(item);
      renderCastSession(`🚫 <b>${esc(item.name)}</b> banned`);
    }
    voidPar(); // bans hit the whole feature immediately
  }
  updateCastMarks();
});

$("#cast-targets").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  cast.ctx.target = chip.dataset.value;
  renderCastTargets();
});

$("#cast-types").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || chip.dataset.value === cast.type) return;
  cast.type = chip.dataset.value;
  document.querySelectorAll("#cast-types .chip").forEach((c) =>
    c.classList.toggle("active", c === chip)
  );
  castSearch();
});

let castTimer = null;
$("#cast-search").addEventListener("input", () => {
  clearTimeout(castTimer);
  castTimer = setTimeout(() => {
    cast.query = $("#cast-search").value;
    castSearch();
  }, 350);
});
$("#cast-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(castTimer);
    cast.query = $("#cast-search").value;
    castSearch();
  }
});

$("#btn-cast-more").addEventListener("click", () => {
  cast.page++;
  castSearch(true);
});

$("#btn-cast-back").addEventListener("click", () => {
  if (cast.ctx?.mode === "studio") {
    showT("scene");
    renderSceneEditor(); // repaint picks/chips the session may have changed
    return;
  }
  showT(cast.ctx?.mode === "research" ? "home" : "mode");
});

document.querySelectorAll(".browse-cast").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (btn.dataset.slot) openCasting({ mode: "slot", slot: btn.dataset.slot });
    else openCasting({ mode: "studio", target: btn.dataset.pick });
  })
);

// ---- The Back Lot detail panel: walk the connections ----
// Tapping a card in research mode opens the item; its credits render as
// mini cards; tapping one walks to it. The breadcrumb trail IS a
// connection chain — the same thinking the game tests, with no clock.
const detailCache = new Map(); // key -> { meta, overview, conns[] }
let detailSeq = 0;

async function loadDetail(item) {
  if (detailCache.has(item.key)) return detailCache.get(item.key);
  const [info, credits] = await Promise.all([
    tmdb(`/${item.type}/${item.id}`),
    item.type === "person"
      ? tmdb(`/person/${item.id}/combined_credits`)
      : item.type === "movie"
        ? tmdb(`/movie/${item.id}/credits`)
        : tmdb(`/tv/${item.id}/aggregate_credits`),
  ]);
  let conns;
  if (item.type === "person") {
    conns = (credits.cast || [])
      .filter((c) => c.media_type === "movie" || c.media_type === "tv")
      .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
      .slice(0, 30)
      .map((c) => makeItem(c));
  } else {
    conns = (credits.cast || []).slice(0, 30).map((c) => makeItem(c, "person"));
  }
  const year = (info.release_date || info.first_air_date || "").slice(0, 4);
  const fame = fameBadge(info, item.type);
  const det = {
    meta:
      `${TYPE_LABEL[item.type]}${year ? " · " + year : ""}` +
      (fame ? ` · ${fame}` : ""),
    overview: info.overview || info.biography || "",
    conns,
  };
  detailCache.set(item.key, det);
  return det;
}

async function openCastDetail(item, push = true) {
  const token = ++detailSeq;
  if (push) cast.trail.push(item);
  renderTrail();
  $("#detail-sheet").classList.remove("hidden");
  $("#detail-name").textContent = item.name;
  $("#detail-meta").textContent = TYPE_LABEL[item.type];
  $("#detail-overview").textContent = "";
  $("#detail-poster").innerHTML = item.img
    ? `<img src="${item.img.replace("/w342/", "/w500/")}" alt="">`
    : `<span class="cast-fallback">${TYPE_EMOJI[item.type]}</span>`;
  $("#detail-conns").innerHTML = `<p class="cast-empty">pulling the credits…</p>`;
  try {
    const det = await loadDetail(item);
    if (token !== detailSeq) return; // walked elsewhere meanwhile
    $("#detail-meta").textContent = det.meta;
    $("#detail-overview").textContent = det.overview;
    $("#detail-conns").innerHTML = det.conns.length
      ? det.conns
          .map(
            (c, i) => `<button class="conn-card" data-i="${i}">
              ${c.img ? `<img loading="lazy" src="${c.img}" alt="">` : `<span class="no-img">${TYPE_EMOJI[c.type]}</span>`}
              <span class="conn-name">${esc(c.name)}</span>
            </button>`
          )
          .join("")
      : `<p class="cast-empty">no credited connections found</p>`;
  } catch {
    if (token === detailSeq)
      $("#detail-conns").innerHTML = `<p class="cast-empty">TMDB didn't answer — try again.</p>`;
  }
}

function renderTrail() {
  $("#detail-trail").innerHTML = cast.trail
    .map(
      (it, i) =>
        `<button class="trail-stop${i === cast.trail.length - 1 ? " here" : ""}" data-i="${i}">${esc(it.name)}</button>`
    )
    .join(`<span class="trail-arrow">→</span>`);
}

$("#detail-conns").addEventListener("click", (e) => {
  const el = e.target.closest(".conn-card");
  if (!el) return;
  const cur = cast.trail[cast.trail.length - 1];
  const det = cur && detailCache.get(cur.key);
  const next = det?.conns[+el.dataset.i];
  if (next) openCastDetail(next);
});

$("#detail-trail").addEventListener("click", (e) => {
  const stop = e.target.closest(".trail-stop");
  if (!stop) return;
  const i = +stop.dataset.i;
  if (i === cast.trail.length - 1) return; // already here
  cast.trail = cast.trail.slice(0, i + 1);
  openCastDetail(cast.trail[i], false);
});

// the bridge: research flows straight into a classic game
$("#btn-detail-play").addEventListener("click", () => {
  const item = cast.trail[cast.trail.length - 1];
  if (!item) return;
  $("#detail-sheet").classList.add("hidden");
  quest.active = false;
  playMode = "classic";
  applySetupMode();
  rerollSeq.start++; // cancel any in-flight reroll for the slot
  slots.start = structuredClone(item);
  renderItemDisplay(
    document.querySelector('.item-display[data-slot="start"]'),
    item
  );
  showT("mode");
  if (!slots.end || slots.end.key === item.key) rerollSlot("end");
});

$("#detail-sheet").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("#detail-sheet").classList.add("hidden");
});

// ---- Board peek: tap a placed node to see it big ----
// Reuses loadDetail's cache but renders NO credits — mid-game those are
// the answers. Poster + name show instantly; meta/overview fill in.
let peekSeq = 0;
async function openBoardPeek(item) {
  const token = ++peekSeq;
  $("#peek-name").textContent = item.name;
  $("#peek-meta").textContent = TYPE_LABEL[item.type];
  $("#peek-overview").textContent = "";
  $("#peek-poster").innerHTML = item.img
    ? `<img src="${item.img.replace("/w342/", "/w500/")}" alt="">`
    : `<span class="cast-fallback">${TYPE_EMOJI[item.type]}</span>`;
  $("#peek-modal").classList.remove("hidden");
  try {
    const det = await loadDetail(item);
    if (token !== peekSeq) return;
    $("#peek-meta").textContent = det.meta;
    $("#peek-overview").textContent = det.overview;
  } catch {
    /* poster + name are already up — good enough */
  }
}

$("#peek-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("#peek-modal").classList.add("hidden");
});

// ===== The Box Office: browse features and pick a ticket =====
// Three local shelves today (staff picks bundled with the game, your
// released features, ticket stubs of what you've played); a community
// shelf plugs in here when the backend exists.
const STAFF_PICKS = [
  {
    v: 3,
    ti: "Opening Night",
    tg: "two gentle warmups — find the thread",
    by: "The Studio",
    sc: [
      { m: "c", s: "movie-597", g: "movie-27205" }, // Titanic → Inception
      { m: "k", s: "person-31", t: 2, n: 6 }, // name 6 Tom Hanks credits
    ],
  },
  {
    v: 3,
    ti: "The Nolan Gauntlet",
    tg: "every road runs through Christopher",
    by: "The Studio",
    sc: [
      { m: "c", s: "movie-155", g: "movie-157336" }, // Dark Knight → Interstellar
      { m: "c", s: "movie-27205", g: "movie-872585", b: 8 }, // Inception → Oppenheimer
      { m: "k", s: "person-3894", t: 2, n: 5 }, // name 5 Christian Bale credits
    ],
  },
  {
    v: 3,
    ti: "Small Screen Royalty",
    tg: "television eats the world",
    by: "The Studio",
    sc: [
      { m: "k", s: "tv-1396", t: 2, n: 5 }, // name 5 from Breaking Bad
      { m: "c", s: "tv-1668", g: "tv-66732" }, // Friends → Stranger Things
      { m: "c", s: "tv-1399", g: "tv-2316" }, // Game of Thrones → The Office
    ],
  },
  {
    v: 3,
    ti: "Heavyweights",
    tg: "legends only — no shortcuts",
    by: "The Studio",
    sc: [
      { m: "c", s: "person-1158", g: "person-380" }, // Pacino → De Niro
      { m: "c", s: "movie-238", g: "movie-680", b: 8 }, // Godfather → Pulp Fiction
      { m: "c", s: "movie-603", g: "movie-954" }, // The Matrix → Mission: Impossible
    ],
  },
];

const officePosters = new Map(); // first-scene poster per card, fetched lazily

function officeCard(blob, kind, i) {
  const n = blob.sc?.length || 1;
  return `<button class="office-card" data-kind="${kind}" data-i="${i}">
    <div class="office-poster" data-poster-key="${esc(blob.sc?.[0]?.s || blob.s || "")}">🎞️</div>
    <div class="office-info">
      <div class="office-title">${esc(blob.ti || "Untitled feature")}</div>
      <div class="office-meta">${n} scene${n === 1 ? "" : "s"}${blob.by ? ` · by ${esc(blob.by)}` : ""}${blob.par ? " · par set" : ""}</div>
      ${blob.tg ? `<div class="office-tag">${esc(blob.tg)}</div>` : ""}
    </div>
  </button>`;
}

function stubCard(s, i) {
  const d = new Date(s.when);
  return `<button class="office-card stub${s.blob ? "" : " dead"}" data-kind="stub" data-i="${i}">
    <div class="office-poster">${s.img ? `<img src="${s.img}" alt="">` : "🎞️"}</div>
    <div class="office-info">
      <div class="office-title">${esc(s.ti)}</div>
      <div class="office-meta">${s.ok ? "✓" : "✗"} ${esc(s.line)}</div>
      <div class="office-tag">${d.toLocaleDateString()}${s.by ? ` · by ${esc(s.by)}` : ""}</div>
    </div>
  </button>`;
}

function shelfSection(label, cards) {
  return `<div class="shelf">
    <p class="shelf-label">${label}</p>
    <div class="shelf-row">${cards.join("")}</div>
  </div>`;
}

function renderOffice() {
  const films = JSON.parse(localStorage.getItem("shelf") || "[]");
  const stubs = JSON.parse(localStorage.getItem("stubs") || "[]");
  $("#office-shelves").innerHTML =
    shelfSection("Staff picks", STAFF_PICKS.map((c, i) => officeCard(c, "staff", i))) +
    (films.length
      ? shelfSection("Your filmography", films.map((f, i) => officeCard(f.blob, "film", i)))
      : `<p class="office-empty">Release a feature in The Studio and it lands on your shelf here.</p>`) +
    (stubs.length
      ? shelfSection("Ticket stubs", stubs.map((s, i) => stubCard(s, i)))
      : "");
  hydrateOfficePosters();
}

// pull the first scene's poster for each card (cached per item key)
function hydrateOfficePosters() {
  document.querySelectorAll(".office-poster[data-poster-key]").forEach(async (el) => {
    const key = el.dataset.posterKey;
    if (!key) return;
    try {
      if (!officePosters.has(key))
        officePosters.set(key, fetchItemByKey(key).then((it) => it.img));
      const img = await officePosters.get(key);
      if (img && el.isConnected) el.innerHTML = `<img src="${img}" alt="">`;
    } catch {
      /* no poster, keep the reel emoji */
    }
  });
}

function openOffice() {
  renderOffice();
  showT("office");
}

$("#btn-office").addEventListener("click", openOffice);
$("#btn-office-back").addEventListener("click", () => showT("home"));

$("#office-shelves").addEventListener("click", async (e) => {
  const card = e.target.closest(".office-card");
  if (!card) return;
  const i = +card.dataset.i;
  let blob = null;
  if (card.dataset.kind === "staff") blob = STAFF_PICKS[i];
  else if (card.dataset.kind === "film")
    blob = JSON.parse(localStorage.getItem("shelf") || "[]")[i]?.blob;
  else blob = JSON.parse(localStorage.getItem("stubs") || "[]")[i]?.blob;
  if (!blob) return;
  card.classList.add("loading");
  const ok = await loadFeature(JSON.parse(JSON.stringify(blob)));
  card.classList.remove("loading");
  if (!ok) alert("That feature failed to load — TMDB may be unreachable.");
});

// ===== Tickets: a feature as an image file =====
// "Print a ticket" draws a real movie ticket on a canvas and embeds the
// feature blob in a PNG tEXt chunk — the image IS the game. Redeeming
// reads the chunk back and boots loadFeature. v1 is metadata-only by
// decision (2026-06-12): send the ORIGINAL file (photo apps that
// re-compress to JPEG strip it). The barcode is decorative until a real
// QR lands in v2.
const TICKET_KEYWORD = "connection-game";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// splice a tEXt chunk in front of IEND (always the final 12 bytes)
function pngAddText(buf, keyword, text) {
  const src = new Uint8Array(buf);
  const data = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i);
  for (let i = 0; i < text.length; i++)
    data[keyword.length + 1 + i] = text.charCodeAt(i);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const iend = src.length - 12;
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, iend));
  out.set(chunk, iend);
  out.set(src.subarray(iend), iend + chunk.length);
  return out;
}

function pngReadText(buf, keyword) {
  const b = new Uint8Array(buf);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 20 || sig.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(buf);
  let p = 8;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === "tEXt") {
      const data = b.subarray(p + 8, p + 8 + len);
      const z = data.indexOf(0);
      if (z > 0 && String.fromCharCode(...data.subarray(0, z)) === keyword)
        return String.fromCharCode(...data.subarray(z + 1));
    }
    p += 12 + len;
  }
  return null;
}

// the ticket itself — warm paper, marquee title, stub with barcode
async function drawTicket(c) {
  await document.fonts.ready;
  const W = 1320;
  const H = 520;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const x = cv.getContext("2d");
  const ink = "#221d15";
  const muted = "rgba(34,29,21,0.62)";
  const gold = "#b98a2e";
  const clay = "#c05c3f";

  x.fillStyle = "#f6f1e6";
  x.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = `rgba(27,24,18,${Math.random() * 0.05})`;
    x.fillRect(Math.random() * W, Math.random() * H, 1.2, 1.2);
  }
  x.strokeStyle = ink;
  x.lineWidth = 3;
  x.strokeRect(14, 14, W - 28, H - 28);
  x.lineWidth = 1;
  x.strokeRect(24, 24, W - 48, H - 48);

  const SX = 950; // the perforation line
  x.setLineDash([2, 10]);
  x.beginPath();
  x.moveTo(SX, 30);
  x.lineTo(SX, H - 30);
  x.stroke();
  x.setLineDash([]);

  // main section
  const lx = 64;
  x.fillStyle = muted;
  x.font = "600 17px Inter, sans-serif";
  x.fillText("THE CONNECTION GAME — A FEATURE PRESENTATION", lx, 96);

  const title = c.ti || "Untitled Feature";
  let size = 74;
  x.font = `italic ${size}px "Instrument Serif", Georgia, serif`;
  while (x.measureText(title).width > SX - lx - 50 && size > 30) {
    size -= 4;
    x.font = `italic ${size}px "Instrument Serif", Georgia, serif`;
  }
  x.fillStyle = ink;
  x.fillText(title, lx, 196);
  x.strokeStyle = gold;
  x.lineWidth = 3;
  x.beginPath();
  x.moveTo(lx, 226);
  x.lineTo(lx + 130, 226);
  x.stroke();

  let ty = 274;
  if (c.tg) {
    x.fillStyle = muted;
    x.font = 'italic 28px "Instrument Serif", Georgia, serif';
    x.fillText(c.tg, lx, ty);
    ty += 46;
  }
  x.fillStyle = ink;
  x.font = "600 20px Inter, sans-serif";
  x.fillText(`a production by ${c.by || "anonymous"}`, lx, ty);

  const n = c.sc.length;
  x.fillStyle = muted;
  x.font = "600 17px Inter, sans-serif";
  x.fillText(
    `${n} SCENE${n === 1 ? "" : "S"}${c.par ? ` · CREATOR'S PAR ${c.par.join(" / ")}` : ""}`,
    lx,
    H - 110
  );
  x.fillStyle = clay;
  x.font = "700 22px Inter, sans-serif";
  x.fillText("ADMIT ONE — REDEEM AT THE BOX OFFICE", lx, H - 70);

  // the stub
  x.save();
  x.translate(SX + 56, H / 2);
  x.rotate(-Math.PI / 2);
  x.fillStyle = clay;
  x.font = "800 34px Inter, sans-serif";
  x.textAlign = "center";
  x.fillText("ADMIT ONE", 0, 0);
  x.restore();

  // decorative barcode, deterministic per feature
  const json = JSON.stringify(c);
  let seed = 0;
  for (let i = 0; i < json.length; i++)
    seed = (seed * 31 + json.charCodeAt(i)) >>> 0;
  let bx = SX + 110;
  x.fillStyle = ink;
  while (bx < W - 70) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const w = 2 + (seed % 6);
    if (seed & 64) x.fillRect(bx, 110, w, H - 270);
    bx += w + 3;
  }
  x.fillStyle = muted;
  x.font = "600 14px Inter, sans-serif";
  x.textAlign = "center";
  x.fillText("data inside — send the original file", SX + 90 + (W - SX - 160) / 2, H - 96);
  return cv;
}

async function printTicket() {
  const c = buildStudioBlob();
  saveToShelf(c); // printed = released, as far as your shelf cares
  const cv = await drawTicket(c);
  const pngBlob = await new Promise((r) => cv.toBlob(r, "image/png"));
  const bytes = pngAddText(
    await pngBlob.arrayBuffer(),
    TICKET_KEYWORD,
    b64url(JSON.stringify(c))
  );
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const a = document.createElement("a");
  a.href = url;
  a.download =
    ((c.ti || "feature").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() ||
      "feature") + "-ticket.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

$("#btn-build-ticket").addEventListener("click", async (e) => {
  if (!builderReady()) return;
  const btn = e.currentTarget;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "printing…";
  try {
    await printTicket();
    btn.innerHTML = "✓ printed!";
  } catch {
    btn.innerHTML = "couldn't print";
  }
  setTimeout(() => {
    btn.innerHTML = orig;
    btn.disabled = false;
  }, 1600);
});

async function redeemTicket(file) {
  try {
    const text = pngReadText(await file.arrayBuffer(), TICKET_KEYWORD);
    if (!text) throw new Error("no chunk");
    const c = JSON.parse(unb64url(text));
    if (!(await loadFeature(c))) throw new Error("bad blob");
  } catch {
    alert(
      "No ticket found in that image. It must be the ORIGINAL ticket file — photos and re-compressed copies lose the data."
    );
  }
}

$("#btn-redeem").addEventListener("click", () => $("#redeem-file").click());
$("#redeem-file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) redeemTicket(f);
});

// a ticket dropped anywhere on the app redeems itself
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type === "image/png") redeemTicket(f);
});

// ===== The lobby card: your win as a shareable image =====
// Reuses the ticket's warm-paper canvas aesthetic, but draws the chain you
// actually built — posters, deep-cut badges on the connections, stars — so a
// win travels as an IMAGE. `lastCard` is captured by each win path.
let lastCard = null;

function cardDateNice() {
  return new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

// Load a poster for canvas use. crossOrigin so toBlob isn't tainted (TMDB's
// image CDN sends Access-Control-Allow-Origin: *). Resolves null on failure.
function loadCardImg(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url.replace("/w342/", "/w500/");
  });
}

const CARD = {
  ink: "#221d15",
  muted: "rgba(34,29,21,0.62)",
  paper: "#f6f1e6",
  gold: "#b98a2e",
  clay: "#c05c3f",
  sage: "#6f7d54",
};

function cardPaper(x, W, H) {
  x.fillStyle = CARD.paper;
  x.fillRect(0, 0, W, H);
  for (let i = 0; i < (W * H) / 260; i++) {
    x.fillStyle = `rgba(27,24,18,${Math.random() * 0.05})`;
    x.fillRect(Math.random() * W, Math.random() * H, 1.2, 1.2);
  }
  x.strokeStyle = CARD.ink;
  x.lineWidth = 3;
  x.strokeRect(14, 14, W - 28, H - 28);
  x.lineWidth = 1;
  x.strokeRect(24, 24, W - 48, H - 48);
}

// rounded poster tile with a cover-fit image (or an emoji fallback), name below
function cardPoster(x, img, type, name, px, py, pw, ph) {
  const r = 10;
  x.save();
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + pw, py, px + pw, py + ph, r);
  x.arcTo(px + pw, py + ph, px, py + ph, r);
  x.arcTo(px, py + ph, px, py, r);
  x.arcTo(px, py, px + pw, py, r);
  x.closePath();
  x.clip();
  if (img) {
    // cover-fit
    const s = Math.max(pw / img.width, ph / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    x.drawImage(img, px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh);
  } else {
    x.fillStyle = "#e7ddc9";
    x.fillRect(px, py, pw, ph);
    x.fillStyle = CARD.muted;
    x.font = `${Math.round(pw * 0.4)}px serif`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(TYPE_EMOJI[type] || "🎞️", px + pw / 2, py + ph / 2);
  }
  x.restore();
  x.strokeStyle = "rgba(34,29,21,0.25)";
  x.lineWidth = 1.5;
  x.strokeRect(px + 0.75, py + 0.75, pw - 1.5, ph - 1.5);
  // name label
  x.fillStyle = CARD.ink;
  x.font = "600 15px Inter, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "top";
  let label = name;
  while (x.measureText(label).width > pw && label.length > 4)
    label = label.slice(0, -2);
  if (label !== name) label = label.slice(0, -1) + "…";
  x.fillText(label, px + pw / 2, py + ph + 8);
}

function cardHeader(x, card, W, LX) {
  x.textAlign = "left";
  x.textBaseline = "alphabetic";
  x.fillStyle = CARD.muted;
  x.font = "600 16px Inter, sans-serif";
  x.fillText("THE CONNECTION GAME", LX, 78);

  x.fillStyle = CARD.ink;
  x.font = 'italic 60px "Instrument Serif", Georgia, serif';
  x.fillText(card.headline, LX, 150);
  x.strokeStyle = CARD.gold;
  x.lineWidth = 3;
  x.beginPath();
  x.moveTo(LX, 174);
  x.lineTo(LX + 120, 174);
  x.stroke();

  x.fillStyle = CARD.muted;
  x.font = 'italic 26px "Instrument Serif", Georgia, serif';
  x.fillText(card.subtitle, LX, 214);

  if (card.stars != null) {
    x.fillStyle = CARD.gold;
    x.font = "30px Inter, sans-serif";
    x.fillText("★".repeat(card.stars), LX, 260);
    x.fillStyle = "rgba(34,29,21,0.25)";
    const starW = x.measureText("★".repeat(card.stars)).width;
    x.fillText("☆".repeat(3 - card.stars), LX + starW, 260);
  }
}

function cardFooter(x, card, W, H, LX) {
  x.textAlign = "left";
  x.fillStyle = CARD.clay;
  x.font = "700 20px Inter, sans-serif";
  x.fillText(card.stat, LX, H - 46);
  x.fillStyle = CARD.muted;
  x.font = "600 14px Inter, sans-serif";
  x.textAlign = "right";
  x.fillText("eschernadeau.github.io/connection-game", W - LX, H - 46);
}

async function drawCard(card) {
  await document.fonts.ready;
  const W = 1200;
  const LX = 72;
  const headerH = card.stars != null ? 300 : 258;
  const footerH = 80;

  if (card.kind === "web") {
    // knowledge: center subject big, named connections in a grid below
    const cp = 210; // center poster width
    const gw = 108; // grid poster width
    const gh = gw * 1.5;
    const cols = Math.min(6, Math.max(1, card.named.length || 1));
    const gridW = cols * gw + (cols - 1) * 26;
    const rows = Math.ceil(card.named.length / cols) || 0;
    const centerH = cp * 1.5 + 34;
    const gridH = rows ? rows * (gh + 34) : 0;
    const H = headerH + centerH + gridH + footerH + 20;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const x = cv.getContext("2d");
    cardPaper(x, W, H);
    cardHeader(x, card, W, LX);
    const imgs = await Promise.all(
      [card.center, ...card.named].map((it) => loadCardImg(it.img))
    );
    let y = headerH;
    cardPoster(x, imgs[0], card.center.type, card.center.name, (W - cp) / 2, y, cp, cp * 1.5);
    y += centerH;
    card.named.forEach((it, i) => {
      const c = i % cols;
      const rr = Math.floor(i / cols);
      const gx = (W - gridW) / 2 + c * (gw + 26);
      const gy = y + rr * (gh + 34);
      cardPoster(x, imgs[i + 1], it.type, it.name, gx, gy, gw, gh);
    });
    cardFooter(x, card, W, H, LX);
    return cv;
  }

  // chain: one row per path (hybrid can have several; classic has one)
  const longest = Math.max(...card.lines.map((l) => l.items.length));
  const arrowGap = 58;
  const usable = W - 2 * LX;
  const pw = Math.max(84, Math.min(150, (usable - (longest - 1) * arrowGap) / longest));
  const ph = pw * 1.5;
  const rowH = ph + 34 + 46; // poster + label + arrow-badge breathing room
  const H = headerH + card.lines.length * rowH + footerH;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const x = cv.getContext("2d");
  cardPaper(x, W, H);
  cardHeader(x, card, W, LX);

  // preload every poster once (dedupe by url)
  const urls = [...new Set(card.lines.flatMap((l) => l.items.map((it) => it.img)).filter(Boolean))];
  const imgMap = new Map();
  await Promise.all(urls.map(async (u) => imgMap.set(u, await loadCardImg(u))));

  card.lines.forEach((line, li) => {
    const n = line.items.length;
    const rowW = n * pw + (n - 1) * arrowGap;
    const startX = (W - rowW) / 2;
    const rowY = headerH + li * rowH;
    line.items.forEach((it, i) => {
      const px = startX + i * (pw + arrowGap);
      cardPoster(x, imgMap.get(it.img), it.type, it.name, px, rowY, pw, ph);
      if (i < n - 1) {
        const ax = px + pw + arrowGap / 2;
        const ay = rowY + ph / 2;
        const tier = line.tiers[i];
        const deep = tier === "deep cut" || tier === "crazy";
        x.fillStyle = deep ? CARD.clay : CARD.muted;
        x.font = "700 30px Inter, sans-serif";
        x.textAlign = "center";
        x.textBaseline = "middle";
        x.fillText("→", ax, ay);
        if (deep) {
          x.fillStyle = CARD.clay;
          x.font = "700 12px Inter, sans-serif";
          x.fillText(tier === "crazy" ? "CRAZY PULL" : "DEEP CUT", ax, ay - 30);
        }
      }
    });
  });
  cardFooter(x, card, W, H, LX);
  return cv;
}

async function saveCard() {
  if (!lastCard) return;
  const cv = await drawCard(lastCard);
  const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    (lastCard.headline.replace(/[^\w ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() ||
      "connection") + "-card.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

$("#btn-save-card").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "drawing…";
  try {
    await saveCard();
    btn.innerHTML = "✓ saved!";
  } catch {
    btn.innerHTML = "couldn't save";
  }
  setTimeout(() => {
    btn.innerHTML = orig;
    btn.disabled = false;
  }, 1600);
});

// ===== Opening Night — couch multiplayer, screens-first (TODO #19) =====
// The PC hosts the stage; phones are controllers. No transport yet: fake
// friends and the phone preview drive the whole flow locally, so the UX is
// real tonight and Supabase realtime only swaps the wires later.

const PARTY_COLORS = [
  { id: "coral", hex: "#e2725b" },
  { id: "gold", hex: "#cf9c3a" },
  { id: "sage", hex: "#7d9471" },
  { id: "sky", hex: "#6b93b8" },
  { id: "lavender", hex: "#8a7ae0" },
  { id: "rose", hex: "#c76b8e" },
  { id: "moss", hex: "#8a9a4b" },
  { id: "slate", hex: "#7a8896" },
];

const ICEBREAKERS = [
  "What's your favorite movie?",
  "Who's your favorite actor?",
  "A show you'd rewatch forever?",
  "Best villain performance ever?",
  "A movie everyone should see once?",
  "Your comfort watch?",
];

const FAKE_NAMES = ["Greta", "Deakins", "Bong", "Agnès", "Spike", "Sofia", "Quentin", "Wong"];

const party = {
  code: "",
  question: "",
  players: [], // { id, name, color: PARTY_COLORS entry, answer: item|null, fake, score }
  seq: 0,
  roundNum: 0,
};

function partyFreeColors() {
  const used = new Set(party.players.map((p) => p.color.id));
  return PARTY_COLORS.filter((c) => !used.has(c.id));
}

function openLobby() {
  if (!party.code) {
    // fresh room — code avoids ambiguous glyphs; question is the night's
    const glyphs = "ABCDEFGHJKMNPQRSTUVWXYZ";
    party.code = Array.from(
      { length: 4 },
      () => glyphs[Math.floor(Math.random() * glyphs.length)]
    ).join("");
    party.question = ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)];
  }
  $("#lobby-code").textContent = party.code;
  $("#lobby-question").textContent = party.question;
  renderLobby();
  showT("lobby");
}

function renderLobby() {
  $("#lobby-players").innerHTML = party.players
    .map(
      (p) =>
        `<span class="player-chip" style="--pc:${p.color.hex}">${esc(p.name)}${p.fake ? " 🤖" : ""}</span>`
    )
    .join("");
  $("#lobby-answers").innerHTML = party.players
    .filter((p) => p.answer)
    .map(
      (p) => `<div class="lobby-answer" style="--pc:${p.color.hex}">
        ${p.answer.img ? `<img src="${p.answer.img}" alt="">` : `<div class="no-img">${TYPE_EMOJI[p.answer.type]}</div>`}
        <span class="lobby-answer-name">${esc(p.name)}</span>
      </div>`
    )
    .join("");
  // the show needs an audience and at least one answered pick to seed rounds
  $("#btn-lobby-start").disabled =
    party.players.length < 2 || !party.players.some((p) => p.answer);
}

function seatPlayer(name, color, fake = false) {
  const p = {
    id: "p" + ++party.seq,
    name,
    color,
    answer: null,
    fake,
    score: 0, // the night's running total across rounds
  };
  party.players.push(p);
  renderLobby();
  return p;
}

// ---- fake friends: they join, think, and answer from the warmed pools ----
$("#btn-lobby-fake").addEventListener("click", async () => {
  const free = partyFreeColors();
  if (!free.length) return;
  const used = new Set(party.players.map((p) => p.name));
  const name = FAKE_NAMES.filter((n) => !used.has(n))[0] || "Extra #" + party.seq;
  const p = seatPlayer(name, free[Math.floor(Math.random() * free.length)], true);
  try {
    await fillPool();
    const pool = pools[settings.obscurity];
    // a little think, then the pick pops onto the stage
    setTimeout(() => {
      const it = pool[Math.floor(Math.random() * Math.min(pool.length, 24))];
      if (it && party.players.includes(p)) {
        p.answer = structuredClone(it);
        renderLobby();
      }
    }, 900 + Math.random() * 2200);
  } catch {
    /* no pool — the fake friend sits quietly */
  }
});

$("#btn-lobby-back").addEventListener("click", () => showT("home"));
$("#btn-opening").addEventListener("click", openLobby);

$("#btn-lobby-start").addEventListener("click", () => {
  party.roundNum = 0;
  for (const p of party.players) p.score = 0;
  nextPartyRound();
});

function nextPartyRound() {
  party.roundNum++;
  // Blitz is the opener — The Ensemble and The Pitch join the bill next
  startBlitz();
}

// ---- the phone preview: a REAL local controller in a phone shell ----
const phone = { player: null, pick: null };

function phoneShow(step) {
  for (const id of ["phone-join", "phone-ice", "phone-seated", "phone-vote", "phone-round"])
    $("#" + id).classList.toggle("hidden", id !== step);
}

$("#btn-lobby-phone").addEventListener("click", () => {
  phone.player = null;
  phone.pick = null;
  $("#phone-code").value = party.code; // local demo — prefilled, editable
  $("#phone-name").value = "";
  $("#phone-ice-pick").innerHTML = "";
  $("#phone-search").value = "";
  $("#phone-ice-send").disabled = true;
  renderPhoneColors();
  phoneShow("phone-join");
  $("#phone-frame").classList.remove("hidden");
});

function renderPhoneColors(selected) {
  $("#phone-colors").innerHTML = partyFreeColors()
    .map(
      (c) =>
        `<button class="phone-color${selected === c.id ? " sel" : ""}" data-c="${c.id}" style="--pc:${c.hex}"></button>`
    )
    .join("");
  phoneJoinReady();
}

let phoneColor = null;
$("#phone-colors").addEventListener("click", (e) => {
  const el = e.target.closest(".phone-color");
  if (!el) return;
  phoneColor = PARTY_COLORS.find((c) => c.id === el.dataset.c);
  renderPhoneColors(phoneColor.id);
});
$("#phone-name").addEventListener("input", phoneJoinReady);
$("#phone-code").addEventListener("input", phoneJoinReady);

function phoneJoinReady() {
  $("#phone-enter").disabled = !(
    $("#phone-name").value.trim() &&
    phoneColor &&
    $("#phone-code").value.trim().toUpperCase() === party.code
  );
}

$("#phone-enter").addEventListener("click", () => {
  if ($("#phone-enter").disabled) return;
  phone.player = seatPlayer($("#phone-name").value.trim(), phoneColor);
  phoneColor = null;
  $("#phone-ice-q").textContent = party.question;
  phoneShow("phone-ice");
  $("#phone-search").focus();
});

// phone search — same TMDB well, phone-sized. One wiring serves every
// phone-shell search box (icebreaker, blitz); each keeps its own stale token.
function wirePhoneSearch(inputSel, ulSel, onPick) {
  let seq = 0;
  const input = $(inputSel);
  const ul = $(ulSel);
  input.addEventListener("input", async () => {
    const q = input.value.trim();
    const token = ++seq;
    if (q.length < 2) {
      ul.classList.add("hidden");
      return;
    }
    try {
      const data = await tmdb("/search/multi", { query: q, include_adult: "false" });
      if (token !== seq) return;
      const rows = (data.results || [])
        .filter((r) => r.media_type !== "person" || r.known_for_department === "Acting")
        .filter((r) => ["movie", "tv", "person"].includes(r.media_type))
        .slice(0, 5);
      ul.innerHTML = rows
        .map((r, i) => {
          const img = r.poster_path || r.profile_path;
          return `<li data-i="${i}">
            ${img ? `<img src="${IMG}${img}" alt="">` : `<span class="no-img">${TYPE_EMOJI[r.media_type]}</span>`}
            <span>${esc(r.title || r.name)}</span></li>`;
        })
        .join("");
      ul.classList.toggle("hidden", !rows.length);
      ul.dataset.rows = JSON.stringify(rows);
    } catch {
      ul.classList.add("hidden");
    }
  });
  ul.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const raw = JSON.parse(ul.dataset.rows || "[]")[+li.dataset.i];
    if (!raw) return;
    ul.classList.add("hidden");
    onPick(makeItem(raw, raw.media_type));
  });
}

wirePhoneSearch("#phone-search", "#phone-suggestions", (item) => {
  phone.pick = item;
  $("#phone-search").value = item.name;
  $("#phone-ice-pick").innerHTML = `<div class="lobby-answer" style="--pc:${phone.player.color.hex}">
    ${item.img ? `<img src="${item.img}" alt="">` : `<div class="no-img">${TYPE_EMOJI[item.type]}</div>`}
    <span class="lobby-answer-name">${esc(item.name)}</span></div>`;
  $("#phone-ice-send").disabled = false;
});

$("#phone-ice-send").addEventListener("click", () => {
  if (!phone.pick || !phone.player) return;
  phone.player.answer = phone.pick;
  renderLobby(); // the poster pops onto the stage behind the phone
  $("#phone-seat-swatch").style.setProperty("--pc", phone.player.color.hex);
  $("#phone-seat-name").textContent = phone.player.name;
  phoneShow("phone-seated");
});

$("#phone-close").addEventListener("click", () =>
  $("#phone-frame").classList.add("hidden")
);
$("#phone-round-close").addEventListener("click", () =>
  $("#phone-frame").classList.add("hidden")
);
$("#phone-frame").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("#phone-frame").classList.add("hidden");
});

// ---- ⚡ Blitz — the opener round (first of three, per the 2026-07-02 study) ----
// The stage borrows the knowledge-mode board: one fixed center (someone's
// icebreaker pick), everyone types at once on phones, valid answers land
// color-coded with the namer's tag. game.mode = "party" keeps every solo
// code path (win checks, undo, stub recording) out of the way; the round
// runs its own clock, scoring, and end-of-round ceremony.
// Scoring (cozy couch rules): speed pays nothing; the LINK's fame tier is
// the multiplier; answers nobody else got pay double at the ceremony.

const BLITZ_SECONDS = 90;
const BLITZ_PTS = { famous: 100, known: 200, "deep cut": 300, crazy: 400 };

const blitz = {
  on: false,
  seed: null,
  answers: new Map(), // item key -> { item, tier, pts, byIds } — byIds[0] named it first
  named: new Map(), // player id -> Set of keys they answered (echoes pay, repeats don't)
  pts: new Map(), // player id -> round points (ceremony bonuses land here too)
  clockId: null,
  botTimers: [],
};

async function startBlitz() {
  // The marquee vote (2026-07-02, replaced icebreaker-pick seeding): three
  // RANDOM famous candidates — nobody's pick, nobody's edge. The couch votes
  // what it knows, so the seed self-selects common ground; picks still seed
  // Ensemble/Pitch, where a route matters more than a cast list in every head.
  // titles only: famous-band titles are vote-count-sorted (truly known);
  // famous-band PEOPLE ride TMDB's trending signal and can be nobodies
  const candType = () => (Math.random() < 0.65 ? "movie" : "tv");
  let cands;
  try {
    cands = [
      await takeRandomItem(null, candType(), "famous"),
      await takeRandomItem(null, candType(), "famous"),
      await takeRandomItem(null, candType(), "famous"),
    ];
  } catch {
    alert("TMDB isn't answering — the marquee stays dark. Try again in a moment.");
    showT("lobby");
    return;
  }

  blitz.on = true;
  blitz.seed = null; // the vote decides
  blitz.answers = new Map();
  blitz.named = new Map(party.players.map((p) => [p.id, new Set()]));
  blitz.pts = new Map(party.players.map((p) => [p.id, 0]));
  blitz.botTimers = [];

  // the shared game object hosts the board; "party" mode sidelines solo paths
  game.mode = "party";
  game.nodes = new Map();
  game.edges = new Map();
  game.startKey = null;
  game.endKey = null;
  game.placed = 0;
  game.lastPlaced = null;
  game.won = false;
  game.over = false;
  game.rules = null;
  game.target = 0;
  game.bar = 0;
  game.phase = 0;
  game.goals = [];
  game.goalKeys = null;

  stopTimer();
  sim.clear();
  edgeEls.length = 0;
  nodesLayer.innerHTML = "";
  edgesSvg.innerHTML = "";
  $("#btn-show-results").classList.add("hidden");
  $("#btn-hint").classList.add("hidden");
  $("#btn-finish").classList.add("hidden");
  $("#btn-game-phone").classList.toggle("hidden", !phone.player);
  $("#screen-game").classList.add("party-live");
  $("#game-goal").innerHTML =
    `<span class="goal-start">⚡ Blitz</span><span class="goal-sep">·</span>` +
    `<span class="goal-end">the marquee vote…</span>`;
  setMessage("");
  renderPartyStrip();
  await showT("game");

  // --- the vote: cards on the stage, one tap on the phones, dots as they land
  marquee.cands = cands;
  marquee.votes = new Map();
  marquee.open = true;
  renderMarquee();
  $("#pi-eyebrow").textContent = `Round ${party.roundNum} · Opening Night`;
  $("#pi-vote").classList.remove("hidden");
  $("#party-intro .pi-seed").classList.add("hidden");
  $("#pi-rules").textContent = "which one does the couch know? vote on your phones";
  const count = $("#pi-count");
  $("#party-intro").classList.remove("hidden");
  if (phone.player) {
    $("#phone-frame").classList.remove("hidden"); // the ballot opens itself
    renderPhoneVote();
    phoneShow("phone-vote");
  }
  for (const b of party.players.filter((p) => p.fake))
    blitz.botTimers.push(
      setTimeout(() => castVote(b, Math.floor(Math.random() * 3)), 900 + Math.random() * 4000)
    );
  await new Promise((res) => {
    let left = VOTE_SECONDS;
    count.textContent = left;
    const iv = setInterval(() => {
      left--;
      count.textContent = left;
      if (left <= 0) finish();
    }, 1000);
    function finish() {
      clearInterval(iv);
      marquee.resolve = null;
      res();
    }
    marquee.resolve = finish; // castVote short-circuits when everyone has voted
  });
  marquee.open = false;
  if (!blitz.on) return; // torn down mid-vote

  // tally — majority wins, ties draw straws
  const tally = [0, 0, 0];
  for (const i of marquee.votes.values()) tally[i]++;
  const max = Math.max(...tally);
  const top = [0, 1, 2].filter((i) => tally[i] === max);
  const winIdx = top[Math.floor(Math.random() * top.length)];
  const seed = structuredClone(marquee.cands[winIdx]);
  blitz.seed = seed;
  for (const [i, el] of [...$("#pi-vote").children].entries())
    el.classList.add(i === winIdx ? "won" : "lost");
  await new Promise((r) => setTimeout(r, 1400));
  if (!blitz.on) return;

  // --- the winner takes the marquee, then action
  $("#pi-vote").classList.add("hidden");
  $("#party-intro .pi-seed").classList.remove("hidden");
  $("#pi-poster").innerHTML = seed.img
    ? `<img src="${seed.img}" alt="">`
    : `<div class="no-img">${TYPE_EMOJI[seed.type]}</div>`;
  $("#pi-seed-by").textContent = "the couch's pick";
  $("#pi-seed-by").style.setProperty("--pc", "var(--gold)");
  $("#pi-seed-name").textContent = seed.name;
  $("#pi-rules").textContent =
    `name anything connected — ${BLITZ_SECONDS} seconds — deep cuts pay triple · uniques pay double · echoes half`;
  count.textContent = "🎬";

  // seat the seed on the board while the card lingers
  game.nodes.set(seed.key, seed);
  game.edges.set(seed.key, new Set());
  game.startKey = seed.key;
  $("#game-goal").innerHTML =
    `<span class="goal-start">⚡ Blitz</span><span class="goal-sep">·</span>` +
    `<span class="goal-end">${esc(seed.name)}</span>`;
  addBoardNode(seed, 0, 0, true);
  const rect = viewport.getBoundingClientRect();
  view.scale = 1;
  view.x = rect.width / 2;
  view.y = rect.height / 2 - 30;
  applyView();
  boardActive = true;
  getConnections(seed).catch(() => {}); // validates answers AND waters the bots

  // the phone flips to its round controller (feed starts clean each round)
  $("#phone-round-seed").textContent = seed.name;
  $("#phone-round-feed").innerHTML = "";
  if (phone.player) {
    $("#phone-round-score").textContent = "0";
    $("#phone-round-score").style.setProperty("--pc", phone.player.color.hex);
  }

  await new Promise((r) => setTimeout(r, 1600));
  $("#party-intro").classList.add("hidden");
  if (!blitz.on) return; // quit during the reveal — nothing to start

  blitzClock(BLITZ_SECONDS);
  scheduleBots();
  if (phone.player && !$("#phone-frame").classList.contains("hidden"))
    phoneRoundShow();
}

// ---- the marquee vote: three random famous candidates, the couch picks ----
const VOTE_SECONDS = 10;
const marquee = { cands: [], votes: new Map(), open: false, resolve: null };

function castVote(player, idx) {
  if (!marquee.open || marquee.votes.has(player.id)) return;
  marquee.votes.set(player.id, idx);
  renderMarquee();
  if (marquee.votes.size >= party.players.length) marquee.resolve?.();
}

function renderMarquee() {
  $("#pi-vote").innerHTML = marquee.cands
    .map((c, i) => {
      const dots = party.players
        .filter((p) => marquee.votes.get(p.id) === i)
        .map((p) => `<span class="vote-dot" style="--pc:${p.color.hex}"></span>`)
        .join("");
      return `<div class="pi-cand" data-i="${i}">
        ${c.img ? `<img src="${c.img}" alt="">` : `<div class="no-img">${TYPE_EMOJI[c.type]}</div>`}
        <span class="pi-cand-name">${esc(c.name)}</span>
        <div class="vote-dots">${dots}</div>
      </div>`;
    })
    .join("");
}

function renderPhoneVote() {
  $("#phone-vote-cards").innerHTML = marquee.cands
    .map(
      (c, i) => `<button class="phone-vote-card" data-i="${i}">
        ${c.img ? `<img src="${c.img}" alt="">` : `<div class="no-img">${TYPE_EMOJI[c.type]}</div>`}
        <span>${esc(c.name)}</span>
      </button>`
    )
    .join("");
}

$("#phone-vote-cards").addEventListener("click", (e) => {
  const el = e.target.closest(".phone-vote-card");
  if (!el || !phone.player || marquee.votes.has(phone.player.id)) return;
  castVote(phone.player, +el.dataset.i);
  el.classList.add("sel");
});

// reuses the header clock element + its warn styling, but not startTimer —
// timeUp() routes to solo results, and 90s is the round's own rule
function blitzClock(seconds) {
  timeLeft = seconds;
  $("#game-timer").classList.remove("hidden");
  renderTimer();
  blitz.clockId = setInterval(() => {
    timeLeft--;
    renderTimer();
    if (timeLeft <= 0) endBlitz();
  }, 1000);
}

function renderPartyStrip() {
  $("#party-strip").classList.remove("hidden");
  $("#party-strip").innerHTML = [...party.players]
    .sort(
      (a, b) =>
        (b.score || 0) + (blitz.pts.get(b.id) || 0) -
        ((a.score || 0) + (blitz.pts.get(a.id) || 0))
    )
    .map(
      (p) =>
        `<span class="party-score" style="--pc:${p.color.hex}">${esc(p.name)}${p.fake ? " 🤖" : ""}<b>${(p.score || 0) + (blitz.pts.get(p.id) || 0)}</b></span>`
    )
    .join("");
}

// One answer, any player. Returns { ok, note?, pts?, tier? } for the phone feed.
async function blitzAnswer(player, item) {
  if (!blitz.on || !blitz.seed) return { ok: false, note: "the round is over" };
  if (item.key === blitz.seed.key)
    return { ok: false, note: "that's the center itself" };
  const mine = blitz.named.get(player.id);
  if (mine.has(item.key)) return { ok: false, note: "you already had it" };
  let ans = blitz.answers.get(item.key);
  if (!ans) {
    if (!(await connects(item, blitz.seed)))
      return { ok: false, note: `not connected to ${blitz.seed.name}` };
    if (!blitz.on) return { ok: false, note: "the round is over" }; // clock beat the check
    if (mine.has(item.key)) return { ok: false, note: "you already had it" };
    ans = blitz.answers.get(item.key); // someone may have landed it mid-await
  }
  mine.add(item.key);
  let paid = ans ? Math.round(ans.pts / 2) : 0;
  if (ans) {
    // an echo — pays HALF (decided 2026-07-02): knowing it first matters,
    // but parroting the couch still keeps you on the board
    ans.byIds.push(player.id);
    blitz.pts.set(player.id, blitz.pts.get(player.id) + paid);
    sim
      .get(item.key)
      ?.el.querySelector(".token")
      ?.animate(
        [
          { boxShadow: `0 0 0 0 ${player.color.hex}` },
          { boxShadow: "0 0 0 18px transparent" },
        ],
        { duration: 550, easing: "ease-out" }
      );
  } else {
    const tier = edgeTier(item, blitz.seed);
    const pts = BLITZ_PTS[tier] ?? 100; // unknown fame pays base — never punished
    ans = { item, tier, pts, byIds: [player.id] };
    paid = pts;
    blitz.answers.set(item.key, ans);
    blitz.pts.set(player.id, blitz.pts.get(player.id) + pts);
    game.nodes.set(item.key, item);
    game.edges.get(blitz.seed.key).add(item.key);
    game.edges.set(item.key, new Set([blitz.seed.key]));
    const c = sim.get(blitz.seed.key);
    const s = addBoardNode(
      item,
      c.x + (Math.random() - 0.5) * 260,
      c.y + (Math.random() - 0.5) * 260
    );
    s.el.classList.add("party");
    s.el.style.setProperty("--pc", player.color.hex);
    s.el
      .querySelector(".gnode-label")
      .insertAdjacentHTML("afterend", `<div class="gnode-by">${esc(player.name)}</div>`);
    addEdgeLine(item.key, blitz.seed.key);
    fitBoard();
    const flare =
      tier === "crazy" ? " 🤯 crazy pull!" : tier === "deep cut" ? " 🎉 deep cut!" : "";
    setMessage(`⚡ ${player.name} — ${item.name}.${flare}`, flare ? "ok" : undefined);
  }
  renderPartyStrip();
  if (player === phone.player)
    $("#phone-round-score").textContent = blitz.pts.get(player.id);
  return { ok: true, pts: paid, tier: ans.tier, echo: ans.byIds.length > 1 };
}

// ---- fake friends play too: they draw from the seed's real credit set ----
function scheduleBots() {
  for (const p of party.players.filter((pl) => pl.fake)) {
    let t = 3500 + Math.random() * 6000; // first thought takes a moment
    const n = 3 + Math.floor(Math.random() * 5); // 3-7 answers a round
    for (let i = 0; i < n; i++) {
      if (t > BLITZ_SECONDS * 1000 - 2000) break;
      blitz.botTimers.push(setTimeout(() => botAnswer(p), t));
      t += 5000 + Math.random() * 9000;
    }
  }
}

async function botAnswer(p) {
  if (!blitz.on) return;
  try {
    const well = [...(await getConnections(blitz.seed))].filter(
      (k) => !blitz.named.get(p.id).has(k)
    );
    if (!well.length) return;
    let item = await fetchItemByKey(well[Math.floor(Math.random() * well.length)]);
    // savant guard: bots re-roll most crazy pulls so they read as human
    if (edgeTier(item, blitz.seed) === "crazy" && Math.random() < 0.65)
      item = await fetchItemByKey(well[Math.floor(Math.random() * well.length)]);
    if (blitz.on) await blitzAnswer(p, item);
  } catch {
    /* the fake friend blanked on that one */
  }
}

// ---- round end: TIME! → the uniqueness ceremony → the podium ----
function endBlitz() {
  if (!blitz.on) return;
  blitz.on = false;
  clearInterval(blitz.clockId);
  for (const id of blitz.botTimers) clearTimeout(id);
  blitz.botTimers = [];
  setMessage("🎬 TIME! Eyes on the stage.", "ok");
  if (phone.player) {
    $("#phone-seat-swatch").style.setProperty("--pc", phone.player.color.hex);
    $("#phone-seat-name").textContent = phone.player.name;
    phoneShow("phone-seated");
    // the local demo phone would otherwise cover the ceremony — put it
    // down automatically; the next round's ballot picks it back up
    $("#phone-frame").classList.add("hidden");
  }
  setTimeout(startCeremony, 1200);
}

let cerQueue = [];
let cerTimer = null;

function startCeremony() {
  cerQueue = [...blitz.answers.values()]
    .filter((a) => a.byIds.length === 1)
    .sort((a, b) => a.pts - b.pts); // crescendo — the wildest pull goes last
  $("#podium").classList.add("hidden");
  $("#party-results").classList.remove("hidden");
  if (!cerQueue.length) {
    $("#ceremony").classList.add("hidden");
    renderPodium();
    return;
  }
  $("#ceremony").classList.remove("hidden");
  stepCeremony();
}

function stepCeremony() {
  clearTimeout(cerTimer);
  const a = cerQueue.shift();
  if (!a) {
    $("#ceremony").classList.add("hidden");
    renderPodium();
    return;
  }
  const p = party.players.find((pl) => pl.id === a.byIds[0]);
  blitz.pts.set(p.id, blitz.pts.get(p.id) + a.pts); // nobody else had it — it pays double
  $("#cer-card").innerHTML = `
    <div class="lobby-answer" style="--pc:${p.color.hex}">
      ${a.item.img ? `<img src="${a.item.img}" alt="">` : `<div class="no-img">${TYPE_EMOJI[a.item.type]}</div>`}
      <span class="lobby-answer-name">${esc(p.name)}</span>
    </div>
    <div class="cer-info">
      <span class="cer-item">${esc(a.item.name)}</span>
      <span class="cer-note">only ${esc(p.name)} had it${a.tier === "crazy" || a.tier === "deep cut" ? ` — a ${a.tier}` : ""}</span>
      <span class="cer-pts">+${a.pts} · ×2</span>
    </div>`;
  cerTimer = setTimeout(stepCeremony, 2600);
}

// tapping the ceremony advances it; podium buttons handle themselves
$("#party-results").addEventListener("click", (e) => {
  if (!$("#ceremony").classList.contains("hidden") && !e.target.closest(".btn"))
    stepCeremony();
});

function renderPodium() {
  clearTimeout(cerTimer);
  for (const p of party.players) p.score = (p.score || 0) + (blitz.pts.get(p.id) || 0);
  blitz.pts = new Map(); // banked — the strip and podium now read p.score
  const ranked = [...party.players].sort((a, b) => b.score - a.score);
  const medals = ["🥇", "🥈", "🥉"];
  $("#pod-eyebrow").textContent = `Round ${party.roundNum} · the night so far`;
  $("#pod-list").innerHTML = ranked
    .map(
      (p, i) => `<div class="pod-row" style="--pc:${p.color.hex}">
        <span class="pod-medal">${medals[i] || ""}</span>
        <span class="pod-name">${esc(p.name)}${p.fake ? " 🤖" : ""}</span>
        <span class="pod-total">${p.score}</span>
      </div>`
    )
    .join("");
  $("#podium").classList.remove("hidden");
}

$("#btn-party-next").addEventListener("click", () => {
  $("#party-results").classList.add("hidden");
  boardActive = false;
  nextPartyRound();
});

$("#btn-party-lobby").addEventListener("click", () => {
  blitzTeardown();
  showT("lobby");
});

// hands the shared board back to solo play; the party stays seated
function blitzTeardown() {
  blitz.on = false;
  marquee.open = false;
  marquee.resolve = null;
  clearInterval(blitz.clockId);
  clearTimeout(cerTimer);
  for (const id of blitz.botTimers) clearTimeout(id);
  blitz.botTimers = [];
  boardActive = false;
  game.mode = "classic";
  $("#screen-game").classList.remove("party-live");
  $("#party-strip").classList.add("hidden");
  $("#btn-game-phone").classList.add("hidden");
  $("#game-timer").classList.add("hidden");
  $("#party-intro").classList.add("hidden");
  $("#party-results").classList.add("hidden");
  if (phone.player) {
    $("#phone-seat-swatch").style.setProperty("--pc", phone.player.color.hex);
    $("#phone-seat-name").textContent = phone.player.name;
    phoneShow("phone-seated");
  }
}

function phoneRoundShow() {
  $("#phone-round-seed").textContent = blitz.seed.name;
  $("#phone-round-score").textContent = blitz.pts.get(phone.player.id) || 0;
  $("#phone-round-score").style.setProperty("--pc", phone.player.color.hex);
  phoneShow("phone-round");
  $("#phone-round-search").focus();
}

$("#btn-game-phone").addEventListener("click", () => {
  $("#phone-frame").classList.remove("hidden");
  if (blitz.on && phone.player) phoneRoundShow();
});

wirePhoneSearch("#phone-round-search", "#phone-round-suggestions", async (item) => {
  const input = $("#phone-round-search");
  input.value = "";
  input.focus();
  if (!phone.player || !blitz.on) return;
  const row = phoneFeedRow(`⏳ ${esc(item.name)}…`);
  const res = await blitzAnswer(phone.player, item);
  row.innerHTML = res.ok
    ? `✓ ${esc(item.name)} <b>+${res.pts}</b>${res.echo ? " · echo" : ""}${res.tier === "deep cut" || res.tier === "crazy" ? ` · ${res.tier}` : ""}`
    : `✗ ${esc(item.name)} — ${esc(res.note)}`;
  row.classList.toggle("bad", !res.ok);
});

function phoneFeedRow(html) {
  const feed = $("#phone-round-feed");
  const row = document.createElement("div");
  row.className = "phone-feed-row";
  row.innerHTML = html;
  feed.prepend(row);
  while (feed.children.length > 8) feed.lastChild.remove();
  return row;
}

// ===== Now Showing — the daily connection (IDEAS #4, no backend) =====
// One date-seeded double bill for everyone: a seeded RNG drives every pick,
// so every player resolves the same discover pages and rows on the same day.
// The first resolution is cached per-date in localStorage, so mid-day TMDB
// vote drift can't change YOUR bill once the marquee has shown it.
// Results live in localStorage "dailyLog"; the leaderboard is Supabase-era.
let pendingDaily = false; // set by the strip, consumed by startGame
let dailyActive = false; // the running classic game IS today's daily

function dailyDateStr(d = new Date()) {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function hashSeed(str) {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let dailyPromise = null;
let dailyPromiseDate = ""; // memo is per-date — a tab left open past midnight re-resolves
function resolveDaily() {
  const date = dailyDateStr();
  if (dailyPromise && dailyPromiseDate === date) return dailyPromise;
  dailyPromiseDate = date;
  dailyPromise = (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem("dailyPuzzle") || "null");
      if (cached?.date === date) return cached;
    } catch {}
    const rand = mulberry32(hashSeed("now-showing-" + date));
    // a double bill: both endpoints are titles, from the approachable end
    // of the catalogue (pages 1-8 by vote count) — same for everyone
    const pickType = () => (rand() < 0.7 ? "movie" : "tv");
    const types = [pickType(), pickType()];
    const pages = [1 + Math.floor(rand() * 8), 1 + Math.floor(rand() * 8)];
    const rolls = [rand(), rand()];
    // v1 tradeoff: English originals only — cross-industry bills (a K-drama
    // to a '70s Hollywood film) are near-unsolvable for most players. The
    // MAIN game stays unrestricted; themed language days could be a feature.
    const fetchRows = async (type, page) =>
      (
        (
          await tmdb(`/discover/${type}`, {
            page,
            sort_by: "vote_count.desc",
            include_adult: "false",
            with_original_language: "en",
          })
        ).results || []
      ).filter((r) => r.poster_path);
    const rowsA = await fetchRows(types[0], pages[0]);
    const rowsB = await fetchRows(types[1], pages[1]);
    if (!rowsA.length || !rowsB.length) return null;
    const start = makeItem(rowsA[Math.floor(rolls[0] * rowsA.length)], types[0]);
    // walk forward deterministically past dupes and one-link anticlimaxes
    // (every player takes the same walk); the last try accepts anything
    const gi = Math.floor(rolls[1] * rowsB.length);
    let goal = null;
    for (let t = 0; t < 6 && !goal; t++) {
      const cand = makeItem(rowsB[(gi + t) % rowsB.length], types[1]);
      if (cand.key === start.key) continue;
      if (t < 5 && (await connects(start, cand))) continue;
      goal = cand;
    }
    if (!goal) return null;
    const puzzle = { date, s: start, g: goal };
    localStorage.setItem("dailyPuzzle", JSON.stringify(puzzle));
    return puzzle;
  })().catch(() => null);
  return dailyPromise;
}

function dailyLog() {
  try {
    return JSON.parse(localStorage.getItem("dailyLog") || "{}");
  } catch {
    return {};
  }
}

function dailyStreak(log = dailyLog()) {
  let streak = 0;
  const d = new Date();
  while (log[dailyDateStr(d)]) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

async function initDailyStrip() {
  const puzzle = await resolveDaily();
  if (!puzzle) return; // TMDB down — the marquee stays dark
  $("#daily-bill").innerHTML =
    `${esc(puzzle.s.name)} <span class="daily-sep">→</span> ${esc(puzzle.g.name)}`;
  const res = dailyLog()[puzzle.date];
  $("#daily-status").textContent = res
    ? `${"★".repeat(res.stars)} in ${res.steps} · 🔥 ${dailyStreak()}`
    : "play today's connection";
  $("#daily-strip").classList.remove("hidden");
}

// a tab waking up on a new day repaints the marquee with the new bill
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && dailyPromiseDate && dailyPromiseDate !== dailyDateStr())
    initDailyStrip();
});

$("#daily-strip").addEventListener("click", async () => {
  const puzzle = await resolveDaily();
  if (!puzzle) return;
  quest.active = false;
  pendingDaily = true;
  startGame(structuredClone(puzzle.s), structuredClone(puzzle.g));
});

$("#btn-share-daily").addEventListener("click", async (e) => {
  const res = dailyLog()[dailyDateStr()];
  const puzzle = await resolveDaily();
  if (!res || !puzzle) return;
  const nice = new Date().toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const text =
    `🎞 Now Showing — ${nice}\n` +
    `${puzzle.s.name} → ${puzzle.g.name}\n` +
    `${"★".repeat(res.stars)}${"☆".repeat(3 - res.stars)} in ${res.steps} link${res.steps === 1 ? "" : "s"}` +
    `${res.hints ? ` (${res.hints} hint${res.hints === 1 ? "" : "s"})` : " (no hints)"}\n` +
    location.href.split("#")[0];
  copyWithFeedback(e.currentTarget, text);
});

// ---- Boot ----
if (apiKey) {
  show("home");
  fillPool().catch(() => {}); // warm the pool before the user even hits Play
  initPosterRain();
  initDailyStrip();
  tryLoadChallenge(); // arrived via a shared link? jump straight in
} else {
  show("key");
}
