#!/usr/bin/env node
// Fetches the Artificial Analysis Intelligence Index (free API tier) and normalizes it
// into data/aa.json, in the same shape as data/arc.json. No dependencies; Node 18+.
//
// Needs a free API key from https://artificialanalysis.ai, read from the AA_API_KEY
// environment variable (a repo secret in the workflow) or from a file passed with
// --key-file <path>. Without a key, or if the API is unreachable, the last good snapshot
// is kept and the script exits cleanly so the deploy still runs.
//
// Attribution is required by the API terms: the site credits Artificial Analysis
// wherever this data is shown.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://artificialanalysis.ai/api/v2/language/models/free";
const SITE = "https://artificialanalysis.ai";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/aa.json");
const MAX_PAGES = 10; // the free tier allows 100 requests a day

// Artificial Analysis creator names -> provider ids used by the site.
const CREATOR_ALIAS = {
  "Google DeepMind": "Google", "Meta AI": "Meta", "Mistral AI": "Mistral", MiniMax: "Minimax",
  "Z AI": "Z.ai", "Zhipu AI": "Z.ai", "Z.AI": "Z.ai", Kimi: "Moonshot AI", "Moonshot": "Moonshot AI",
  "Alibaba Cloud": "Alibaba", Qwen: "Alibaba", "Microsoft Azure": "Microsoft", "Amazon Web Services": "Amazon", AWS: "Amazon",
  "Reflection AI": "Reflection", "Allen Institute for AI": "Ai2", AllenAI: "Ai2", "Xiaomi MiMo": "Xiaomi", "Nvidia": "NVIDIA",
  SpaceXAI: "xAI", "SpaceX AI": "xAI", "xAI Corp": "xAI",
  "Cohere For AI": "Cohere", "Perplexity AI": "Perplexity", "Arcee AI": "Arcee", "Inception Labs": "Inception",
};
const EFFORT_WORDS = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", "x-high": "XHigh", "extra high": "XHigh", max: "Max", maximum: "Max" };

// "GPT-6.2 Sol (xhigh)" -> { base: "GPT-6.2 Sol", effort: "XHigh" }
// "Claude Opus 5.5 (Adaptive Reasoning, Max Effort)" -> effort "Max"
// "Gemini 4 Neon (Non-reasoning)" -> effort "None"; "(Reasoning)" -> "Reasoning"
// A parenthetical that isn't about reasoning, like "(Preview)", stays part of the name.
export function splitEffort(name) {
  const m = name.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!m) return { base: name.trim(), effort: "" };
  const inner = m[2].trim();
  const low = inner.toLowerCase();
  if (!/reason|think|effort|budget|\b(none|minimal|low|medium|high|xhigh|x-high|max|maximum)\b/.test(low)) return { base: name.trim(), effort: "" };
  if (/non-?reasoning|no reasoning|reasoning off|thinking off/.test(low)) return { base: m[1].trim(), effort: "None" };
  const word = low.match(/\b(extra high|x-high|xhigh|maximum|max|minimal|none|low|medium|high)\b/);
  if (word) return { base: m[1].trim(), effort: EFFORT_WORDS[word[1]] };
  const budget = inner.match(/(\d+(?:\.\d+)?\s*[kKmM])\b/);
  if (budget) return { base: m[1].trim(), effort: budget[1].replace(/\s+/g, "").toUpperCase() };
  return { base: m[1].trim(), effort: inner.replace(/\b\w/g, (c) => c.toUpperCase()) };
}

async function readKey() {
  const i = process.argv.indexOf("--key-file");
  if (i > 0 && process.argv[i + 1]) return (await readFile(process.argv[i + 1], "utf8")).trim();
  return (process.env.AA_API_KEY || "").trim();
}

async function getPage(key, page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}?page=${page}`, { headers: { "x-api-key": key, accept: "application/json" } });
    if (res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`page ${page} -> HTTP ${res.status}`); // never echo the key or the response headers
    return res.json();
  }
  throw new Error(`page ${page} -> server error after retries`);
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");

async function main() {
  const key = await readKey();
  if (!key) {
    console.error("No AA_API_KEY set; skipping Artificial Analysis.");
    process.exit(0);
  }

  const rows = [];
  let version = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await getPage(key, page);
    version ??= body.intelligence_index_version ?? null;
    rows.push(...(body.data || []));
    if (!body.pagination?.has_more) break;
  }

  const seriesByKey = new Map();
  const points = [];
  for (const r of rows) {
    const score = num(r.evaluations?.artificial_analysis_intelligence_index);
    const cost = num(r.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost);
    const costTotal = num(r.artificial_analysis_intelligence_index_cost?.total_cost);
    if (score == null || cost == null || cost <= 0) continue;
    const creator = r.model_creator?.name || "Other";
    const provider = CREATOR_ALIAS[creator] || creator;
    const { base, effort } = splitEffort(r.name || r.slug || "");
    const skey = "aa:" + slugify(provider + "-" + base);
    const priceIn = num(r.pricing?.price_1m_input_tokens), priceOut = num(r.pricing?.price_1m_output_tokens);
    const released = /^\d{4}-\d{2}-\d{2}/.test(r.release_date || "") ? r.release_date.slice(0, 10) : null;
    let s = seriesByKey.get(skey);
    if (!s) {
      s = { key: skey, name: base, provider, released };
      seriesByKey.set(skey, s);
    }
    if (released && (!s.released || released < s.released)) s.released = released;
    if (priceIn != null && priceOut != null && !s.price) s.price = { in: priceIn, out: priceOut };
    const p = { d: "aa_index", s: skey, id: r.slug || r.id, effort, score: score / 100, cost };
    if (costTotal != null) p.costTotal = costTotal;
    const tps = num(r.performance_v3?.mean_output_tokens_per_second) ?? num(r.performance?.median_output_tokens_per_second);
    if (tps != null && tps > 0) p.tps = tps;
    if (r.slug) p.url = `${SITE}/models/${r.slug}`;
    points.push(p);
  }

  // Two rows that parse to the same model and effort: keep the cheaper one.
  const seen = new Map();
  for (const p of points) {
    const k = p.s + "|" + p.effort;
    const prev = seen.get(k);
    if (!prev || p.cost < prev.cost) seen.set(k, p);
  }
  const kept = [...seen.values()];
  const used = new Set(kept.map((p) => p.s));
  const series = [...seriesByKey.values()].filter((s) => used.has(s.key));

  const out = {
    source: "Artificial Analysis",
    sourceUrl: SITE + "/",
    fetchedAt: new Date().toISOString(),
    indexVersion: version,
    datasets: [{
      id: "aa_index", name: "AA Intelligence Index", short: "Intelligence Index", costLabel: "Cost per task", scoreUnit: "index",
      note: `Artificial Analysis Intelligence Index${version ? " v" + version : ""}, a composite of its independent evaluations (0–100). Cost per task is what it cost Artificial Analysis to run the index on the model, divided by the number of tasks.`,
    }],
    providers: {},
    series,
    points: kept,
  };
  if (series.length < 10 || kept.length < 20) {
    throw new Error(`Suspiciously small dataset (${series.length} models, ${kept.length} points) - refusing to overwrite`);
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT}: index v${version}, ${series.length} models, ${kept.length} points`);
}

main().catch(async (err) => {
  console.error("Artificial Analysis fetch failed:", err.message);
  try {
    await readFile(OUT);
    console.error("Keeping existing snapshot at", OUT);
  } catch {
    console.error("No snapshot yet; the site will run without Artificial Analysis.");
  }
  process.exit(0);
});
