#!/usr/bin/env node
// Fetches the public ARC Prize leaderboard data and normalizes it into
// data/arc.json for the static site. No dependencies; Node 18+.
//
// arcprize.org does not send CORS headers, so browsers can't read it from
// GitHub Pages directly. The Pages workflow runs this on a schedule instead,
// so the deployed site stays current without anyone committing data.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://arcprize.org/media/data";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/arc.json");

async function getJson(name) {
  const res = await fetch(`${BASE}/${name}.json`, {
    headers: { "user-agent": "pareto-frontier-viewer (static site data refresh)" },
  });
  if (!res.ok) throw new Error(`${name}.json -> HTTP ${res.status}`);
  return { body: await res.json(), lastModified: res.headers.get("last-modified") };
}

// "Claude Fable 5.2 (Max)" -> { base: "Claude Fable 5.2", effort: "Max" }
// "GPT-6 Astra - Provider Adapter (High)" -> { base: "GPT-6 Astra", effort: "High", adapter: true }
function splitName(displayName, id) {
  let name = (displayName || id || "").trim();
  let effort = "";
  const m = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m) {
    name = m[1].trim();
    effort = m[2].trim();
  }
  let adapter = /provider[- ]adapter/i.test(id || "");
  const a = name.match(/^(.*?)\s*[-–]\s*Provider Adapter$/i);
  if (a) {
    name = a[1].trim();
    adapter = true;
  }
  if (/provider adapter/i.test(effort)) {
    effort = effort.replace(/,?\s*provider adapter,?\s*/i, "").trim();
    adapter = true;
  }
  return { base: name, effort, adapter };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function main() {
  const [evals, models, datasets, providers] = await Promise.all(
    ["evaluations", "models", "datasets", "providers"].map(getJson),
  );

  const modelById = new Map(models.body.map((m) => [m.id, m]));
  const series = new Map(); // key -> series
  const points = [];

  for (const e of evals.body) {
    if (e.display === false) continue;
    const m = modelById.get(e.modelId);
    if (!m) continue;
    const score = num(e.score);
    const cost = num(e.costPerTask) ?? num(e.cost);
    if (score == null || cost == null || cost <= 0) continue;

    const { base, effort, adapter } = splitName(m.displayName, m.id);
    const key = (m.modelGroup || m.id) + (adapter ? "::adapter" : "");
    let s = series.get(key);
    if (!s) {
      s = {
        key,
        name: base + (adapter ? " (provider adapter)" : ""),
        provider: m.providerId || "Other",
        type: m.modelType || "",
        released: m.modelReleaseDate ? m.modelReleaseDate.slice(0, 10) : null,
      };
      series.set(key, s);
    }
    if (m.modelReleaseDate && (!s.released || m.modelReleaseDate.slice(0, 10) > s.released)) {
      s.released = m.modelReleaseDate.slice(0, 10);
    }
    const p = {
      d: e.datasetId,
      s: key,
      id: m.id,
      effort,
      score,
      cost,
    };
    if (e.resultsUrl) p.url = e.resultsUrl;
    const note = e.tooltipNote || m.notes;
    if (note) p.note = String(note).slice(0, 400);
    points.push(p);
  }

  const usedDatasets = new Set(points.map((p) => p.d));
  const out = {
    source: "ARC Prize leaderboard (arcprize.org/leaderboard)",
    sourceUrl: "https://arcprize.org/leaderboard",
    fetchedAt: new Date().toISOString(),
    sourceLastModified: evals.lastModified,
    datasets: datasets.body
      .filter((d) => usedDatasets.has(d.id))
      .map((d) => ({
        id: d.id,
        name: d.displayName,
        // ARC-AGI-3 reports total run cost rather than cost per task.
        costLabel: points.some((p) => p.d === d.id && /^v3/.test(d.id)) ? "Cost per run" : "Cost per task",
      })),
    providers: Object.fromEntries(providers.body.map((p) => [p.id, { name: p.displayName }])),
    series: [...series.values()],
    points,
  };

  if (out.points.length < 50 || out.series.length < 10) {
    throw new Error(`Suspiciously small dataset (${out.points.length} points) - refusing to overwrite`);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(
    `Wrote ${OUT}: ${out.points.length} points, ${out.series.length} series, ${out.datasets.length} datasets`,
  );
}

main().catch(async (err) => {
  console.error("ARC fetch failed:", err.message);
  try {
    await readFile(OUT);
    console.error("Keeping existing snapshot at", OUT);
    process.exit(0); // deploy the last good snapshot rather than failing the site
  } catch {
    process.exit(1);
  }
});
