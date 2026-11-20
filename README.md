# Pareto Frontier Explorer

Interactive score-vs-cost chart for AI models, with the Pareto frontier drawn on top: the set of models that no other model beats on both score and price. Data comes from two independent leaderboards that measure what each model actually costs to run, [ARC Prize](https://arcprize.org/leaderboard) and [LiveBench](https://livebench.ai/).

**Live site:** https://jamestsetsekas.github.io/pareto-frontier/

## Features

- Benchmarks, grouped by source:
  - **ARC Prize:** ARC-AGI-1, ARC-AGI-2, ARC-AGI-3, plus the public and private eval variants
  - **LiveBench:** Overall, plus each suite (Long Agentic, Reasoning, Coding, Browser, Data Analysis, Research, Design)
- On ARC Prize, each model is one line with a point per reasoning-effort level (Low → Max). Hover a model to label its effort levels. LiveBench runs each model at one setting, so it shows one point per model
- A model's selection carries across benchmarks and sources. When switching source, the new source's own recommended models are added, so its newest models show up too
- The header badge, cost note and footer always name the source behind the chart and when it was last updated
- Real provider logos in the end labels, legend, tooltips and table. Each provider has one brand hue, and its models get different shades of it
- Pareto frontier computed from the models on the chart, or from every model on the benchmark. Frontier points are enlarged and haloed
- Hover shows a crosshair with axis readouts and a compact tooltip (score, cost, and which frontier model beats it). The tooltip places itself where it hides the least of the hovered model's line and effort labels
- Click a point to pin the full tooltip: cost per point, ARC Prize's notes, and actions to show only that model, remove it, or open its ARC Prize results
- Models are grouped by provider (collapsible, with all/none toggles), searchable, and sortable. There are presets (Recommended, Frontier, Newest 12, All) and a release-date filter
- Zoom and pan (scroll or pinch, drag, double-click to reset), log or linear cost axis
- Export the chart as a PNG or the visible points as CSV
- Add your own points to compare against the field
- Shareable URLs: benchmark, selection, filters, and custom points are kept in the link
- Light and dark themes, a sortable data table, and a layout that works on phones

## Data

| Source | What it publishes | Cost on the chart | Snapshot |
|---|---|---|---|
| [ARC Prize](https://arcprize.org/leaderboard) | Leaderboard JSON (`arcprize.org/media/data/*.json`) | Measured spend per task (per run on ARC-AGI-3), at each effort level | `data/arc.json` |
| [LiveBench](https://livebench.ai/) | Per-release CSVs of scores and measured cost per suite (`livebench.ai/data/<release>/`) | Measured spend divided by tasks, LiveBench's own definition of cost per task | `data/livebench.json` |

Each source measures cost its own way, so a chart only ever shows one source's benchmark. Models that appear in both sources are matched by name, so a selection carries across.

The [workflow](.github/workflows/pages.yml) runs every 3 hours (and on every push):

1. `scripts/fetch-arc.mjs` and `scripts/fetch-livebench.mjs` download the latest data and normalize it into the snapshots above
2. Any snapshot whose data changed is committed to the repo
3. It redeploys GitHub Pages

The site never needs a manual rebuild. arcprize.org doesn't allow cross-site requests, so its data has to be fetched by the workflow rather than by the browser. LiveBench lists its releases and model names only inside its site's JavaScript, so the LiveBench fetcher reads them from there. If either source is unreachable or changes format, its fetcher keeps the last good snapshot so the deploy still succeeds.

> GitHub pauses scheduled workflows in repos with no activity for 60 days. The snapshot commits count as activity whenever the leaderboard changes. If it does get paused, re-enable it from the Actions tab.

## Run locally

```bash
node scripts/fetch-arc.mjs         # refresh data/arc.json (Node 18+)
node scripts/fetch-livebench.mjs   # refresh data/livebench.json
npx http-server .                  # or any static server
```

There's no build step and no dependencies. D3 v7 loads from cdnjs.

Provider logos come from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT) and are bundled into `assets/logos.svg`. To add a provider, add its icon name to `scripts/build-logos.mjs` and `PROVIDER_LOGO` in `assets/app.js`, then run `node scripts/build-logos.mjs`.

## Adding another data source

1. Write a fetcher that outputs the same shape as `data/arc.json`: `datasets` (with a `costLabel`), `series`, and `points` with `d`, `s`, `score` in 0–1 and `cost` in USD.
2. Add a step for it in the workflow, and add its file to the commit step's list.
3. Add an entry to `SOURCES` in `assets/app.js` with its name, URL and a one-line description of how it measures cost.

A good next candidate is the Artificial Analysis API. It needs a free key, stored as a repo secret, and asks for attribution. Its main cost figure is list price per token rather than measured spend, so its cost note should say so.
