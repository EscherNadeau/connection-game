// Pre-deploy sanity check — no framework, so this is the whole CI.
// 1. app.js must parse.
// 2. Every #id referenced in app.js must exist in index.html. All listeners
//    attach at script load, so a single missing element crashes the whole app
//    silently — this is the project's #1 footgun (see CLAUDE.md).
// Run with: npm test   (exits non-zero on any failure)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let failed = false;
const fail = (msg) => {
  console.error("✗ " + msg);
  failed = true;
};

// 1. syntax
try {
  execFileSync(process.execPath, ["--check", "app.js"], { stdio: "pipe" });
  console.log("✓ app.js parses");
} catch (e) {
  fail("app.js failed to parse:\n" + (e.stderr || e.message).toString());
}

// 2. id cross-check
const js = readFileSync("app.js", "utf8");
const html = readFileSync("index.html", "utf8");
const refs = new Set();
for (const m of js.matchAll(/\$\("#([\w-]+)"\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/getElementById\("([\w-]+)"\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/querySelector(?:All)?\("#([\w-]+)/g)) refs.add(m[1]);
// screens are addressed as "screen-" + name from the `screens` array
const screensMatch = js.match(/const screens = \[([^\]]+)\]/);
if (screensMatch)
  for (const m of screensMatch[1].matchAll(/"([\w-]+)"/g))
    refs.add("screen-" + m[1]);

const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const missing = [...refs].filter((id) => !htmlIds.has(id));
if (missing.length) fail("ids referenced in app.js but missing from index.html: " + missing.join(", "));
else console.log(`✓ all ${refs.size} referenced ids exist in index.html`);

// 3. duplicate ids — a duplicate silently cross-wires two flows ($ returns
//    the first match). Bit us once: #btn-next-round doubled between the quest
//    intermission and the party podium (TODO #19).
const idCounts = new Map();
for (const m of html.matchAll(/id="([\w-]+)"/g))
  idCounts.set(m[1], (idCounts.get(m[1]) || 0) + 1);
const dupes = [...idCounts].filter(([, n]) => n > 1).map(([id]) => id);
if (dupes.length) fail("duplicate ids in index.html: " + dupes.join(", "));
else console.log(`✓ no duplicate ids in index.html (${idCounts.size} unique)`);

// 4. raw storage access — everything must ride the guarded helpers
//    (lsGet/lsSet/lsJSON at the top of app.js); a raw call throws in
//    private/blocked-storage browsers and kills the flow it's in.
const rawStorage = [...js.matchAll(/localStorage\.(get|set|remove)Item/g)];
if (rawStorage.length)
  fail(`${rawStorage.length} raw localStorage call(s) in app.js — use lsGet/lsSet/lsJSON`);
else console.log("✓ no raw localStorage calls (guarded helpers only)");

process.exit(failed ? 1 : 0);
