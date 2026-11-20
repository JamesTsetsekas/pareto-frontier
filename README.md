# Pareto Frontier Explorer

Interactive score-vs-cost chart for AI models, with the Pareto frontier drawn on top: the set of models that no other model beats on both score and price.

**Live site:** https://jamestsetsekas.github.io/pareto-frontier/

## Features

- Benchmarks: ARC-AGI-1, ARC-AGI-2, ARC-AGI-3, plus the public and private eval variants
- Each model is one line, with a point per reasoning-effort level (Low → Max)
- Pareto frontier computed from the models on the chart, or from every model on the benchmark
- Add or remove models: search, provider-level all/none toggles, and presets (Recommended, Frontier only, Latest 12, All)
- Hover tooltips with score, cost, release date, cost per point, and which frontier point dominates it
- Zoom and pan (scroll or pinch, drag, double-click to reset), log or linear cost axis
- Add your own points to compare against the field
- Shareable URLs: benchmark, selection, axis, and custom points are kept in the link
- Light and dark themes, a sortable data table, and a layout that works on phones

## Data

Data comes from the public [ARC Prize leaderboard](https://arcprize.org/leaderboard) JSON (`arcprize.org/media/data/*.json`).

arcprize.org doesn't send CORS headers, so a browser on GitHub Pages can't read it directly. Instead, the [workflow](.github/workflows/pages.yml) runs every 3 hours (and on every push):

1. `scripts/fetch-arc.mjs` downloads and normalizes the leaderboard into `data/arc.json`
2. If the data changed, it commits the new snapshot to the repo
3. It redeploys GitHub Pages

The site never needs a manual rebuild. If ARC Prize is unreachable, the fetcher keeps the last good snapshot so the deploy still succeeds.

> GitHub pauses scheduled workflows in repos with no activity for 60 days. The snapshot commits count as activity whenever the leaderboard changes. If it does get paused, re-enable it from the Actions tab.

## Run locally

```bash
node scripts/fetch-arc.mjs   # refresh data/arc.json (Node 18+)
npx http-server .            # or any static server
```

There's no build step and no dependencies. D3 v7 loads from cdnjs.

## Adding another data source

Write a fetcher that outputs the same shape as `data/arc.json` (`datasets`, `series`, `points` with `d`, `s`, `score` in 0–1, `cost` in USD), then add a step for it in the workflow. Good candidates: the Artificial Analysis API (free key, stored as a repo secret) and Epoch AI's benchmark CSVs.
