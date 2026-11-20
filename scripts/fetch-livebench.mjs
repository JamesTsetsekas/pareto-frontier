#!/usr/bin/env node
// Fetches the latest LiveBench release (scores and measured run cost per suite)
// and normalizes it into data/livebench.json, in the same shape as data/arc.json.
// No dependencies; Node 18+.
//
// LiveBench publishes each release as static files under livebench.ai/data/<release>/.
// The list of releases and the model metadata (display name, organization, effort)
// live in the site's JavaScript bundle, so this script reads them from there. If
// LiveBench changes its site and that stops working, the last good snapshot is kept.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://livebench.ai";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/livebench.json");
const UA = { "user-agent": "pareto-frontier-viewer (static site data refresh)" };

// LiveBench organization -> provider id used by the site (matches ARC Prize's ids where they overlap).
const ORG_ALIAS = {
  "Z.AI": "Z.ai", "Mistral AI": "Mistral", MiniMax: "Minimax", "Reflection AI": "Reflection",
  AbacusAI: "Abacus.AI", AllenAI: "Ai2",
};
const EFFORT = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

async function get(path, type = "text") {
  const res = await fetch(ORIGIN + path, { headers: UA });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  // GitHub Pages answers missing files with an HTML 404 page; treat HTML as missing.
  const ct = res.headers.get("content-type") || "";
  if (type !== "html" && ct.includes("text/html")) throw new Error(`${path} -> not found`);
  return { body: type === "json" ? await res.json() : await res.text(), lastModified: res.headers.get("last-modified") };
}

function parseCsv(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/).map((l) => l.split(","));
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i].trim()])));
}
const num = (v) => (v === "" || v == null || !Number.isFinite(+v) ? null : +v);
const iso = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

// Model metadata objects in the bundle look like
//   "gpt-6.2-astra":{displayName:"GPT-6.2 Astra",organization:"OpenAI",...,effort:"max",...}
// The same id can appear more than once (older and newer leaderboard versions); entries
// that carry an effort setting come from the current version and win.
function parseModelMeta(bundle) {
  const meta = new Map();
  const re = /(?:"([\w.\-]+)"|\b([A-Za-z_][\w]*)):\{([^{}]*displayName:"[^"]*"[^{}]*)\}/g;
  for (const m of bundle.matchAll(re)) {
    const id = m[1] || m[2];
    const body = m[3];
    const field = (k) => body.match(new RegExp(`\\b${k}:"([^"]*)"`))?.[1];
    const entry = { name: field("displayName"), org: field("organization"), effort: field("effort"), version: field("version") };
    const prev = meta.get(id);
    if (!prev || (entry.effort && !prev.effort)) meta.set(id, { ...prev, ...entry });
  }
  return meta;
}

async function main() {
  const html = (await get("/", "html")).body;
  const bundlePath = html.match(/src="\.?(\/static\/js\/main\.[\w]+\.js)"/)?.[1];
  if (!bundlePath) throw new Error("couldn't find the site bundle");
  const bundle = (await get(bundlePath)).body;

  // Current-format releases are 8-digit ids such as "20261106".
  const releases = [...new Set([...bundle.matchAll(/"(20\d{6})"/g)].map((m) => m[1]))].sort().reverse().slice(0, 12);
  if (!releases.length) throw new Error("no releases found in the site bundle");

  // Latest release that publishes both scores and cost.
  let release = null, table, cost, categories, notes, lastModified;
  for (const r of releases) {
    try {
      const [t, c, cat, n] = await Promise.all([
        get(`/data/${r}/table.csv`), get(`/data/${r}/cost.csv`),
        get(`/data/${r}/categories.json`, "json"), get(`/data/${r}/notes.json`, "json").catch(() => ({ body: [] })),
      ]);
      table = parseCsv(t.body); cost = parseCsv(c.body); categories = cat.body; notes = n.body;
      lastModified = t.lastModified;
      if (table.length < 10) continue;
      release = r;
      break;
    } catch { /* try the previous release */ }
  }
  if (!release) throw new Error("no release with scores and cost data");

  // When each model first appeared on LiveBench: a fallback release date.
  const firstSeen = new Map();
  for (const r of [...releases].reverse()) {
    if (r > release) continue;
    try {
      for (const row of parseCsv((await get(`/data/${r}/table.csv`)).body)) {
        if (!firstSeen.has(row.model)) firstSeen.set(row.model, iso(r));
      }
    } catch { /* release without a table */ }
  }

  const meta = parseModelMeta(bundle);
  const costBy = new Map(cost.map((r) => [r.model, r]));
  // Suites: {"Coding": ["coding"], ...}; keys starting with "_" are settings, not suites.
  const suites = Object.entries(categories)
    .filter(([name, cols]) => !name.startsWith("_") && Array.isArray(cols) && cols.length === 1)
    .map(([name, [col]]) => ({ name, col }));

  const series = [];
  const points = [];
  for (const row of table) {
    const id = row.model;
    const c = costBy.get(id);
    if (!c) continue;
    const m = meta.get(id) || {};
    const org = m.org || "Other";
    const provider = ORG_ALIAS[org] || org;
    // Without a version date, fall back to when the model first appeared on LiveBench.
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(m.version || "");
    const released = dated ? m.version : firstSeen.get(id) || null;
    const key = "lb:" + id;
    // "Claude Fable 5.2 (xhigh)" -> name "Claude Fable 5.2", effort "XHigh"
    let name = m.name || id;
    let effortRaw = m.effort || "";
    const paren = name.match(/^(.*?)\s*\(([^()]+)\)$/);
    if (paren && EFFORT[paren[2].toLowerCase()]) { name = paren[1]; effortRaw ||= paren[2]; }
    series.push({ key, name, provider, released, ...(dated ? {} : { releasedApprox: true }), lbId: id });
    const effort = EFFORT[effortRaw.toLowerCase()] || "";

    let totalCost = 0, totalTasks = 0, scoreSum = 0, complete = true;
    for (const { col } of suites) {
      const score = num(row[col]);
      const spent = num(c[col]);
      const tasks = num(c["nq_" + col]);
      if (score == null || spent == null || !tasks || spent <= 0) { complete = false; continue; }
      points.push({ d: "lb_" + col, s: key, id: `${id}:${col}`, effort, score: score / 100, cost: spent / tasks });
      totalCost += spent; totalTasks += tasks; scoreSum += score;
    }
    // Overall needs every suite, otherwise its cost isn't comparable.
    if (complete && suites.length) {
      points.push({ d: "lb_overall", s: key, id: `${id}:overall`, effort, score: scoreSum / suites.length / 100, cost: totalCost / totalTasks });
    }
  }

  const used = new Set(points.map((p) => p.d));
  // Suite descriptions from notes.json, e.g. "Browser Use: multi-step tasks ..." for the "Browser" suite.
  const describe = (name) => {
    const want = name.toLowerCase();
    for (const n of Array.isArray(notes) ? notes : []) {
      const m = typeof n === "string" && n.match(/^([^:]{2,30}):\s*(.+)$/);
      if (!m) continue;
      const head = m[1].toLowerCase();
      if (head === want || head.includes(want) || want.includes(head)) return m[2].charAt(0).toUpperCase() + m[2].slice(1);
    }
    return "";
  };
  const datasets = [
    { id: "lb_overall", name: "LiveBench Overall", short: "Overall (all suites)", costLabel: "Cost per task",
      note: `Mean score across all ${suites.length} suites. Cost per task is LiveBench's measured spend for every suite divided by the number of tasks.` },
    ...suites.map(({ name, col }) => ({
      id: "lb_" + col, name: "LiveBench " + name, short: name, costLabel: "Cost per task",
      note: (describe(name) + " Cost per task is LiveBench's measured spend for the suite divided by its number of tasks.").trim(),
    })),
  ].filter((d) => used.has(d.id));

  const out = {
    source: "LiveBench",
    sourceUrl: ORIGIN + "/",
    group: "LiveBench",
    release: iso(release),
    fetchedAt: new Date().toISOString(),
    sourceLastModified: lastModified,
    method: "One point per model, at the effort setting LiveBench ran it at (usually its highest).",
    datasets,
    providers: {},
    series,
    points,
  };

  if (out.series.length < 10 || out.points.length < 50) {
    throw new Error(`Suspiciously small dataset (${out.series.length} models, ${out.points.length} points) - refusing to overwrite`);
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT}: release ${out.release}, ${out.series.length} models, ${out.points.length} points, ${out.datasets.length} datasets`);
}

main().catch(async (err) => {
  console.error("LiveBench fetch failed:", err.message);
  try {
    await readFile(OUT);
    console.error("Keeping existing snapshot at", OUT);
    process.exit(0);
  } catch {
    process.exit(1);
  }
});
