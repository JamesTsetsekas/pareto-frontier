# Pareto Frontier Explorer

Interactive score-vs-cost chart for AI models, with the Pareto frontier drawn on top: the set of models that no other model beats on both score and price. Data comes from independent leaderboards that measure what each model actually costs to run: [ARC Prize](https://arcprize.org/leaderboard), [LiveBench](https://livebench.ai/) and, once its API key is set, [Artificial Analysis](https://artificialanalysis.ai/).

**Live site:** https://jamestsetsekas.github.io/pareto-frontier/

## Features

- Sources as tabs across the top, each with its benchmarks:
  - **ARC Prize:** ARC-AGI-1, ARC-AGI-2, ARC-AGI-3, plus the public and private eval variants
  - **LiveBench:** Overall, plus each suite (Long Agentic, Reasoning, Coding, Browser, Data Analysis, Research, Design)
  - **Artificial Analysis:** the Intelligence Index (appears once the API key is set)
- Chart views:
  - **Score vs cost**: one line per model through its reasoning-effort levels, with the Pareto frontier
  - **Tokens per task**: bars or a score-vs-tokens scatter with its own frontier (LiveBench)
  - **Total tokens**, **Cost per task** and **Total cost**: bars per model, one shaded bar per effort level
  - Views a source doesn't publish are greyed out
- Filters in the side panel: reasoning effort (none → max), price tier (budget, mid, premium, by list price per million output tokens), and release date
- A model's selection carries across benchmarks and sources. When switching source, the new source's own recommended models are added, so its newest models show up too
- Hover shows a dashed crosshair in the model's color with axis readouts, and a detail card (score, cost, total cost, tokens, speed, and which frontier model beats it). The card docks in an empty corner of the chart. Click to pin it, with actions to show only that model, remove it, or open its source page
- Brand-flavored provider colors (checked for colorblind safety), real provider logos, end labels on wide screens and a legend on phones
- Options menu: labels on/off, group bars by model, highest last, CSV download, copy link. PNG download of whichever chart is showing
- Zoom and pan on scatter charts (scroll or pinch, drag, double-click to reset), log or linear axis
- Add your own points to compare against the field
- Shareable URLs: source, benchmark, view, selection, filters, and custom points are kept in the link
- Light and dark themes, a sortable data table, keyboard shortcut `/` to search models, and a layout that works on phones (the model list becomes a drawer)

## Data

| Source | What it publishes | Cost on the chart | Snapshot |
|---|---|---|---|
| [ARC Prize](https://arcprize.org/leaderboard) | Leaderboard JSON (`arcprize.org/media/data/*.json`) | Measured spend per task (per run on ARC-AGI-3), at each effort level | `data/arc.json` |
| [LiveBench](https://livebench.ai/) | Per-release CSVs of scores, measured cost, output tokens and list prices per suite (`livebench.ai/data/<release>/`) | Measured spend divided by tasks, LiveBench's own definition of cost per task | `data/livebench.json` |
| [Artificial Analysis](https://artificialanalysis.ai/) | Free data API: Intelligence Index, cost to run it, list prices, output speed | What it cost Artificial Analysis to run the index, per task | `data/aa.json` |

Each source measures cost its own way, so a chart only ever shows one source's benchmark. Models that appear in both sources are matched by name, so a selection carries across.

The [workflow](.github/workflows/pages.yml) runs every 3 hours (and on every push):

1. `scripts/fetch-arc.mjs`, `scripts/fetch-livebench.mjs` and `scripts/fetch-aa.mjs` download the latest data and normalize it into the snapshots above
2. Any snapshot whose data changed is committed to the repo
3. It redeploys GitHub Pages

The site never needs a manual rebuild. arcprize.org doesn't allow cross-site requests, so its data has to be fetched by the workflow rather than by the browser. LiveBench lists its releases and model names only inside its site's JavaScript, so the LiveBench fetcher reads them from there. If either source is unreachable or changes format, its fetcher keeps the last good snapshot so the deploy still succeeds.

> GitHub pauses scheduled workflows in repos with no activity for 60 days. The snapshot commits count as activity whenever the leaderboard changes. If it does get paused, re-enable it from the Actions tab.

## Run locally

```bash
node scripts/fetch-arc.mjs         # refresh data/arc.json (Node 18+)
node scripts/fetch-livebench.mjs   # refresh data/livebench.json
AA_API_KEY=... node scripts/fetch-aa.mjs   # refresh data/aa.json (or --key-file <path>)
npx http-server .                  # or any static server
```

### Artificial Analysis key

The Artificial Analysis source needs a free API key. Create one on [artificialanalysis.ai](https://artificialanalysis.ai/api-reference#free-api), then add it as a repository secret named `AA_API_KEY` (Settings → Secrets and variables → Actions), or run `gh secret set AA_API_KEY`. The next workflow run fills in `data/aa.json` and the Artificial Analysis tab appears. Until then the fetcher skips cleanly. The free tier allows 100 requests a day; a refresh uses a few. The API terms require crediting Artificial Analysis, which the footer does whenever its data is on screen.

There's no build step and no dependencies. D3 v7 loads from cdnjs.

Provider logos come from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT) and are bundled into `assets/logos.svg`. To add a provider, add its icon name to `scripts/build-logos.mjs` and `PROVIDER_LOGO` in `assets/app.js`, then run `node scripts/build-logos.mjs`.

## Adding another data source

1. Write a fetcher that outputs the same shape as `data/arc.json`: `datasets` (with a `costLabel`), `series`, and `points` with `d`, `s`, `score` in 0–1 and `cost` in USD.
2. Add a step for it in the workflow, and add its file to the commit step's list.
3. Add an entry to `SOURCES` in `assets/app.js` with its name, URL and a one-line description of how it measures cost.

Optional measures go on the points too: `costTotal` (USD for a full run), `tokens` (output tokens per task), `tokensTotal`, and `tps` (output tokens per second); series can carry `price: { in, out }` per million tokens. The chart views and the price filter light up for whichever of these a source provides.
