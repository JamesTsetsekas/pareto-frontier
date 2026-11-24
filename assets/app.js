/* Pareto Frontier Explorer - vanilla JS + d3 v7. */
(() => {
  "use strict";

  // Each source is a snapshot refreshed by the Pages workflow. Cost means something
  // different in each, so a chart only ever shows one source's benchmark.
  const SOURCES = [
    {
      id: "arc", url: "data/arc.json", name: "ARC Prize", origin: "https://arcprize.org",
      order: ["v2_Semi_Private", "v1_Semi_Private", "v3_Semi_Private"],
      note: (d) => (d.costLabel === "Cost per run"
        ? "Cost per run is ARC Prize's measured spend for a full run of the benchmark."
        : "Cost per task is ARC Prize's measured API spend per puzzle.") + " Each line is one model across the reasoning-effort settings ARC Prize tested.",
    },
    {
      id: "livebench", url: "data/livebench.json", name: "LiveBench", origin: "https://livebench.ai",
      order: ["lb_overall"],
      note: (d) => d.note + " Tokens are LiveBench's average output tokens per task. One point per model, at the effort setting LiveBench ran it at.",
    },
    {
      id: "aa", url: "data/aa.json", name: "Artificial Analysis", origin: "https://artificialanalysis.ai", optional: true,
      order: ["aa_index"],
      note: (d) => d.note + " Each line is one model across the reasoning-effort settings Artificial Analysis tested.",
    },
  ];

  // Chart views. Scatter views plot score against the metric; bar views rank the metric.
  const VIEWS = [
    { id: "cost", metric: "cost", modes: ["scatter"], tab: () => "Score vs cost" },
    { id: "tokens", metric: "tokens", modes: ["bars", "scatter"], tab: () => "Tokens per task", sep: true },
    { id: "tokensTotal", metric: "tokensTotal", modes: ["bars"], tab: () => "Total tokens" },
    { id: "costBars", metric: "cost", modes: ["bars"], tab: (meta) => meta?.costLabel || "Cost per task" },
    { id: "costTotal", metric: "costTotal", modes: ["bars"], tab: () => "Total cost" },
  ];
  const METRIC = {
    cost: { label: () => ds.meta.costLabel, unit: "USD", money: true, lowerIs: "cheaper" },
    costTotal: { label: () => "Total cost", unit: "USD, full benchmark run", money: true },
    tokens: { label: () => "Output tokens per task", unit: "tokens", money: false, lowerIs: "fewer tokens" },
    tokensTotal: { label: () => "Total output tokens", unit: "tokens, full benchmark run", money: false },
  };

  const LOGO_URL = "assets/logos.svg";
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Fixed provider -> color slot. Color follows the provider, never rank. Models from one
  // provider get shades of its hue, and the logo carries identity.
  const PROVIDER_SLOT = {
    OpenAI: "neutral", Anthropic: 1, Google: 2, Meta: 3, "Meta AI": 3, xAI: 4, DeepSeek: 5, "Moonshot AI": 6,
  };
  const PROVIDER_LOGO = {
    OpenAI: "openai", Anthropic: "anthropic", Google: "google-color", xAI: "xai",
    DeepSeek: "deepseek-color", "Moonshot AI": "kimi-color", Alibaba: "qwen-color",
    Meta: "meta-color", "Meta AI": "meta-color", Mistral: "mistral-color",
    Minimax: "minimax-color", "Z.ai": "zai", NVIDIA: "nvidia-color",
    Reflection: "reflection", Inception: "inception", "Dots Studio": "dotsstudio",
    Xiaomi: "xiaomimimo", StepFun: "stepfun-color", Microsoft: "microsoft-color", Cohere: "cohere-color",
    Amazon: "aws-color", Perplexity: "perplexity-color", Tencent: "tencent-color", Arcee: "arcee-color", Ai2: "ai2",
    Human: "human",
  };
  const TINTS = [0, 15, -14, 27, -24, 8, -7, 21];
  const REFERENCE_PROVIDERS = new Set(["Human"]); // shown if picked, never in frontier or defaults
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reasoning effort, normalized across sources ("Thinking, Low" and "120K, Low" are low).
  const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "other"];
  const EFFORT_SHORT = { none: "N", minimal: "Mn", low: "L", medium: "M", high: "H", xhigh: "X", max: "Mx" };
  const effortBucket = (e) => {
    const last = String(e || "").split(",").pop().trim().toLowerCase();
    if (last === "instant") return "none";
    return EFFORTS.includes(last) ? last : "other";
  };
  const effortShort = (e) => EFFORT_SHORT[effortBucket(e)] || (e ? e.replace(/^Thinking,?\s*/i, "").slice(0, 4) : "");

  // Price tiers by list price per million output tokens.
  const TIERS = [
    { id: "budget", label: "budget", max: 3, title: "Under $3 per million output tokens" },
    { id: "mid", label: "mid", max: 15, title: "$3 to $15 per million output tokens" },
    { id: "premium", label: "premium", max: Infinity, title: "$15 or more per million output tokens" },
  ];
  const tierOf = (s) => (s.price ? TIERS.find((t) => s.price.out < t.max).id : null);

  const state = {
    data: null,
    datasetId: "v2_Semi_Private",
    view: "cost",
    modes: { tokens: "bars" },
    scale: "log",
    frontierMode: "visible",
    frontierScope: "visible",
    releasedDays: 0,
    hiddenEfforts: new Set(),
    hiddenTiers: new Set(),
    opts: { labels: true, group: true, highestLast: true },
    selected: new Set(),
    search: "",
    sort: "recent",
    custom: [],
    hoverSeries: null,
    hoverPoint: null,
    pinned: null,
    transform: d3.zoomIdentity,
    groupOpen: new Map(),
  };

  let seriesByKey = new Map();
  let ds = null; // derived per-dataset view
  const theme = {};
  const colorCache = new Map();

  const $ = (sel) => document.querySelector(sel);
  const chartEl = $("#chart");
  const tooltip = $("#tooltip");

  // ---------- formatting ----------
  const fmtPct = (s) => {
    const p = s * 100;
    if (p === 0) return "0%";
    if (p < 1) return p.toFixed(2) + "%";
    return p.toFixed(1) + "%";
  };
  const isIndex = () => ds?.meta.scoreUnit === "index";
  const fmtScore = (s) => (isIndex() ? (s * 100).toFixed(1) : fmtPct(s));
  const fmtCost = (c) => {
    if (c >= 1000) return "$" + d3.format(",.0f")(c);
    if (c >= 100) return "$" + c.toFixed(0);
    if (c >= 1) return "$" + c.toFixed(2);
    if (c >= 0.01) return "$" + c.toFixed(3);
    return "$" + c.toPrecision(2);
  };
  const fmtCostShort = (c) => (c >= 1000 ? "$" + d3.format(".2~s")(c).replace("G", "B") : c >= 10 ? "$" + c.toFixed(0) : fmtCost(c));
  const fmtTok = (t) => (t >= 1e6 ? d3.format(".3~s")(t).replace("G", "B") : t >= 1000 ? (t / 1000).toFixed(t >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "k" : String(Math.round(t)));
  const fmtTick = (v) => {
    if (v >= 1000) return "$" + d3.format("~s")(v).replace("G", "B");
    return "$" + (+v.toPrecision(3)).toString();
  };
  const fmtTokTick = (v) => (v >= 1000 ? d3.format("~s")(v).replace("G", "B") : String(+v.toPrecision(3)));
  const fmtMetric = (metric, v) => (METRIC[metric].money ? fmtCost(v) : fmtTok(v));
  const fmtMetricShort = (metric, v) => (METRIC[metric].money ? fmtCostShort(v) : fmtTok(v));
  const fmtDate = (iso, opts = { year: "numeric", month: "short", day: "numeric" }) =>
    iso ? new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { ...opts, timeZone: "UTC" }) : "—";
  const fmtShortDate = (iso) => fmtDate(iso, { year: "numeric", month: "short" });
  const relTime = (iso) => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return "just now";
    if (mins < 60) return mins + " min ago";
    const h = Math.round(mins / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const isAdapter = (s) => s.key.endsWith("::adapter");
  const providerName = (p) => state.data.providers[p]?.name || p;

  const viewDef = () => VIEWS.find((v) => v.id === state.view) || VIEWS[0];
  const metricOf = () => viewDef().metric;
  const modeOf = () => { const v = viewDef(); return v.modes.includes(state.modes[v.id]) ? state.modes[v.id] : v.modes[0]; };
  const xv = (p) => p[metricOf()];

  // ---------- theme + color ----------
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["s1", "s2", "s3", "s4", "s5", "s6", "s-neutral", "s-other", "text", "text-2", "text-3", "surface", "surface-3", "bg"]) {
      theme[k] = cs.getPropertyValue("--" + k).trim();
    }
    theme.dark = cs.colorScheme.includes("dark");
    colorCache.clear();
    const btn = $("#theme");
    btn.innerHTML = theme.dark
      ? `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><g stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></g></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
    btn.setAttribute("aria-label", theme.dark ? "Switch to light theme" : "Switch to dark theme");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.bg);
  }

  function seriesColor(s) {
    if (s.custom) return theme.text;
    let c = colorCache.get(s.key);
    if (c) return c;
    const slot = PROVIDER_SLOT[s.provider];
    const base = slot === "neutral" ? theme["s-neutral"] : slot ? theme["s" + slot] : theme["s-other"];
    const hcl = d3.hcl(base);
    const t = TINTS[(s.tint || 0) % TINTS.length];
    // The neutral stays clear of the "other" gray: bright in dark mode, dark in light mode.
    const [lo, hi] = slot === "neutral" ? (theme.dark ? [62, 96] : [14, 44]) : slot ? [30, 86] : (theme.dark ? [38, 62] : [45, 70]);
    hcl.l = Math.max(lo, Math.min(hi, hcl.l + (slot === "neutral" && !theme.dark ? -t : t)));
    c = hcl.formatHex();
    colorCache.set(s.key, c);
    return c;
  }
  // Shades of one model's color for its effort levels in bar charts: low effort darker.
  function shade(color, i, n) {
    if (n <= 1) return color;
    const hcl = d3.hcl(color);
    const span = Math.min(30, 8 * (n - 1));
    hcl.l = Math.max(18, Math.min(94, hcl.l - span / 2 + (span * i) / (n - 1)));
    return hcl.formatHex();
  }

  // ---------- logos ----------
  const logoId = (provider) => (PROVIDER_LOGO[provider] ? "logo-" + PROVIDER_LOGO[provider] : null);
  const initials = (provider) => provider.split(/[\s_\-.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  function logoHTML(provider, size = 16) {
    if (provider === "__custom") return `<span class="mono" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.6)}px" aria-hidden="true">+</span>`;
    const id = logoId(provider);
    if (id) return `<svg class="logo" width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"></use></svg>`;
    return `<span class="mono" style="width:${size}px;height:${size}px;font-size:${Math.max(7, Math.round(size * 0.42))}px" aria-hidden="true">${esc(initials(provider))}</span>`;
  }
  function drawLogo(g, provider, size) {
    g.selectAll("*").remove();
    const id = provider === "__custom" ? null : logoId(provider);
    if (id) {
      g.append("use").attr("class", "logo-use").attr("href", "#" + id)
        .attr("x", -size / 2).attr("y", -size / 2).attr("width", size).attr("height", size);
    } else {
      g.append("rect").attr("x", -size / 2).attr("y", -size / 2).attr("width", size).attr("height", size).attr("rx", 3).style("fill", theme["surface-3"]);
      g.append("text").attr("text-anchor", "middle").attr("dy", "0.35em")
        .style("font-size", (provider === "__custom" ? size * 0.7 : size * 0.42) + "px").style("font-weight", 700).style("fill", theme["text-2"])
        .text(provider === "__custom" ? "+" : initials(provider));
    }
  }

  // ---------- data ----------
  async function load() {
    readTheme();
    try {
      const [results, logos] = await Promise.all([
        Promise.allSettled(SOURCES.map((src) => fetch(src.url, { cache: "no-cache" })
          .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }))),
        fetch(LOGO_URL).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
        Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]),
      ]);
      // A source with no datasets yet (Artificial Analysis before its key is set) is left out.
      const loaded = SOURCES.map((src, i) => [src, results[i].value]).filter(([, d]) => d?.datasets?.length);
      if (!loaded.length) throw new Error(results[0].reason?.message || "no data");
      state.data = mergeSources(loaded);
      const sprite = $("#logo-sprite");
      sprite.innerHTML = logos;
      sprite.hidden = false;
      const svgEl = sprite.querySelector("svg");
      if (svgEl) svgEl.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    } catch (err) {
      setStatus("Couldn't load leaderboard data (" + esc(err.message) + "). Try reloading.", true);
      return;
    }
    prepare();
    readHash();
    buildSourceTabs();
    buildDatasetSelect();
    buildFilters();
    bindUI();
    selectDataset(state.datasetId, { keepSelection: state.selected.size > 0 });
    let first = true;
    new ResizeObserver(() => { if (first) { first = false; return; } render(); }).observe(chartEl);
    const onTheme = () => {
      readTheme();
      layers?.labels.selectAll(".lbl-logo").attr("data-prov", null);
      bl?.groups.selectAll(".bar-logo").attr("data-prov", null);
      renderList();
      render();
      renderTable();
    };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
    new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  // Combine the per-source snapshots into one dataset list. A model that appears in
  // several sources keeps one key (the first source's), so a selection carries over
  // when switching between benchmarks from different sources.
  // Parentheses stay significant: "(NVFP4)" or "(Preview)" marks a different model.
  const normName = (n) => n.toLowerCase().replace(/^(claude|meta|google|openai)\s+/, "").replace(/[^a-z0-9.()]+/g, "");
  function mergeSources(loaded) {
    const out = { sources: new Map(), datasets: [], providers: {}, series: [], points: [] };
    const byName = new Map(); // normalized model name -> series
    for (const [src, data] of loaded) {
      out.sources.set(src.id, {
        ...src, fetchedAt: data.fetchedAt, sourceLastModified: data.sourceLastModified,
        sourceUrl: data.sourceUrl, release: data.release,
      });
      for (const d of data.datasets) out.datasets.push({ ...d, source: src.id, short: d.short || d.name });
      Object.assign(out.providers, data.providers);
      const keyMap = new Map();
      const added = [];
      for (const s of data.series) {
        // Only match against earlier sources: within one source, similar names are distinct models.
        const n = isAdapter(s) ? null : normName(s.name);
        const match = n && byName.get(n);
        if (match && ![...keyMap.values()].includes(match.key)) {
          keyMap.set(s.key, match.key);
          if (s.price && !match.price) match.price = s.price;
          continue;
        }
        const copy = { ...s };
        out.series.push(copy);
        if (n) added.push([n, copy]);
      }
      for (const [n, s] of added) if (!byName.has(n)) byName.set(n, s);
      for (const p of data.points) {
        const url = p.url ? (/^https?:/.test(p.url) ? p.url : src.origin + p.url) : null;
        out.points.push({ ...p, s: keyMap.get(p.s) || p.s, url, source: src.id });
      }
    }
    return out;
  }
  const sourceOf = (datasetId) => state.data.sources.get(state.data.datasets.find((d) => d.id === datasetId)?.source);

  function prepare() {
    const { series, points } = state.data;
    seriesByKey = new Map(series.map((s) => [s.key, { ...s, tier: tierOf(s) }]));
    // Newest model in each provider gets the base hue; older ones get shades.
    for (const list of d3.group([...seriesByKey.values()], (s) => s.provider).values()) {
      list.sort((a, b) => (b.released || "").localeCompare(a.released || "") || a.key.localeCompare(b.key));
      list.forEach((s, i) => (s.tint = i));
    }
    for (const p of points) { p.series = seriesByKey.get(p.s); p.bucket = effortBucket(p.effort); }
  }

  // Footer and cost note follow the source of the selected benchmark.
  function renderSourceInfo() {
    const src = sourceOf(state.datasetId);
    if (!src) return;
    const ageH = (Date.now() - new Date(src.fetchedAt).getTime()) / 3.6e6;
    const title = `Fetched ${new Date(src.fetchedAt).toLocaleString()}` +
      (src.release ? ` · latest LiveBench release ${fmtDate(src.release)}` : "") +
      (src.sourceLastModified ? ` · leaderboard last changed ${new Date(src.sourceLastModified).toLocaleString()}` : "");
    $("#source").innerHTML = `Data from <a href="${esc(src.sourceUrl)}" target="_blank" rel="noopener">${esc(src.name)}</a>` +
      ` <span title="${esc(title)}">· updated ${relTime(src.fetchedAt)}${ageH > 24 ? " (refresh pending)" : ""}</span>`;
    $("#cost-note").innerHTML = esc(src.note(ds.meta));
  }

  function deriveDataset() {
    const pts = state.data.points.filter((p) => p.d === state.datasetId && !state.hiddenEfforts.has(p.bucket));
    const cutoff = state.releasedDays ? new Date(Date.now() - state.releasedDays * 864e5).toISOString().slice(0, 10) : null;
    const list = [];
    const has = { cost: true, costTotal: false, tokens: false, tokensTotal: false };
    const efforts = new Map();
    for (const p of state.data.points) if (p.d === state.datasetId) efforts.set(p.bucket, (efforts.get(p.bucket) || 0) + 1);
    for (const [key, ps] of d3.group(pts, (p) => p.s)) {
      const s = seriesByKey.get(key);
      if (cutoff && (!s.released || s.released < cutoff)) continue;
      if (s.tier && state.hiddenTiers.has(s.tier)) continue;
      ps.sort((a, b) => EFFORTS.indexOf(a.bucket) - EFFORTS.indexOf(b.bucket) || a.cost - b.cost);
      for (const p of ps) for (const k of ["costTotal", "tokens", "tokensTotal"]) if (p[k] != null) has[k] = true;
      const best = ps.reduce((m, p) => (p.score > m.score || (p.score === m.score && p.cost < m.cost) ? p : m), ps[0]);
      const view = { ...s, ref: REFERENCE_PROVIDERS.has(s.provider), points: ps, best, minCost: d3.min(ps, (p) => p.cost) };
      for (const p of ps) p.series = view;
      list.push(view);
    }
    const meta = state.data.datasets.find((d) => d.id === state.datasetId) || { name: state.datasetId, costLabel: "Cost" };
    ds = { meta, series: list, byKey: new Map(list.map((s) => [s.key, s])), has, efforts };
    const globalFrontier = paretoFrontier(list.filter((s) => !s.ref).flatMap((s) => s.points), (p) => p.cost);
    ds.frontierKeys = new Set(globalFrontier.map((p) => p.s));
  }
  const viewAvailable = (v) => !ds || ds.has[v.metric];

  // Points sorted by the metric; keep each one that beats every cheaper point.
  function paretoFrontier(points, val = xv) {
    const sorted = points.filter((p) => val(p) != null).sort((a, b) => val(a) - val(b) || b.score - a.score);
    const out = [];
    let best = -Infinity;
    for (const p of sorted) {
      if (p.score > best) { out.push(p); best = p.score; }
    }
    return out;
  }

  // ---------- presets ----------
  function preset(name) {
    const eligible = ds.series.filter((s) => !s.ref && !isAdapter(s));
    const recent = [...eligible].sort((a, b) => (b.released || "").localeCompare(a.released || ""));
    let keys;
    if (name === "all") keys = ds.series.map((s) => s.key);
    else if (name === "none") keys = [];
    else if (name === "frontier") keys = [...ds.frontierKeys];
    else if (name === "recent") keys = recent.slice(0, 12).map((s) => s.key);
    else {
      // Recommended: the newest releases plus frontier models, capped for legibility.
      const set = new Set(recent.slice(0, 7).map((s) => s.key));
      for (const s of recent) {
        if (set.size >= 12) break;
        if (ds.frontierKeys.has(s.key)) set.add(s.key);
      }
      keys = [...set];
    }
    state.selected = new Set(keys);
  }

  function selectDataset(id, { keepSelection = false } = {}) {
    if (!state.data.datasets.some((d) => d.id === id)) id = state.data.datasets.find((d) => d.id === "v2_Semi_Private")?.id || state.data.datasets[0].id;
    const prevSource = ds && sourceOf(state.datasetId)?.id;
    state.datasetId = id;
    $("#dataset").value = id;
    deriveDataset();
    if (!viewAvailable(viewDef())) state.view = "cost";
    const carried = [...state.selected].filter((k) => ds.byKey.has(k));
    if (!keepSelection || !carried.length) {
      preset("default");
    } else if (prevSource && prevSource !== sourceOf(id)?.id) {
      // New source, different model list: keep the models it shares with the old one and
      // add this source's recommended set, so its own newest models show up too.
      preset("default");
      state.selected = new Set([...carried, ...state.selected]);
    }
    resetZoom(false);
    renderSourceInfo();
    update({ animate: true });
  }
  function selectSource(srcId) {
    const src = state.data.sources.get(srcId);
    if (!src || sourceOf(state.datasetId)?.id === srcId) return;
    const list = state.data.datasets.filter((d) => d.source === srcId);
    const first = src.order.map((id) => list.find((d) => d.id === id)).find(Boolean) || list[0];
    selectDataset(first.id, { keepSelection: true });
  }
  function selectView(id) {
    const v = VIEWS.find((x) => x.id === id);
    if (!v || !viewAvailable(v) || state.view === id) return;
    state.view = id;
    resetZoom(false);
    update({ animate: true });
  }

  // ---------- URL state ----------
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("d")) state.datasetId = h.get("d");
    if (VIEWS.some((v) => v.id === h.get("v"))) state.view = h.get("v");
    if (h.get("b") === "scatter") state.modes.tokens = "scatter";
    if (h.get("x") === "linear") state.scale = "linear";
    if (["visible", "all", "off"].includes(h.get("f"))) state.frontierMode = h.get("f");
    if (state.frontierMode !== "off") state.frontierScope = state.frontierMode;
    if (["365", "182", "91"].includes(h.get("r"))) state.releasedDays = +h.get("r");
    if (h.get("e")) state.hiddenEfforts = new Set(h.get("e").split(",").filter((e) => EFFORTS.includes(e)));
    if (h.get("t")) state.hiddenTiers = new Set(h.get("t").split(",").filter((t) => TIERS.some((x) => x.id === t)));
    if (h.get("o")) for (const k of h.get("o").split(",")) if (k in state.opts) state.opts[k] = false;
    if (h.get("m")) state.selected = new Set(h.get("m").split(",").filter(Boolean));
    if (h.get("c")) {
      state.custom = h.get("c").split("|").map((t) => {
        const [name, cost, score] = t.split("~");
        return { name, cost: +cost, score: +score / 100 };
      }).filter((c) => c.name && c.cost > 0 && c.score >= 0 && c.score <= 1).slice(0, 20);
    }
  }
  function writeHash() {
    const h = new URLSearchParams();
    h.set("d", state.datasetId);
    if (state.view !== "cost") h.set("v", state.view);
    if (state.modes.tokens === "scatter") h.set("b", "scatter");
    if (state.scale !== "log") h.set("x", state.scale);
    if (state.frontierMode !== "visible") h.set("f", state.frontierMode);
    if (state.releasedDays) h.set("r", state.releasedDays);
    if (state.hiddenEfforts.size) h.set("e", [...state.hiddenEfforts].join(","));
    if (state.hiddenTiers.size) h.set("t", [...state.hiddenTiers].join(","));
    const off = Object.keys(state.opts).filter((k) => !state.opts[k]);
    if (off.length) h.set("o", off.join(","));
    h.set("m", [...state.selected].filter((k) => ds.byKey.has(k)).join(","));
    if (state.custom.length) h.set("c", state.custom.map((c) => [c.name.replace(/[~|]/g, " "), c.cost, +(c.score * 100).toFixed(3)].join("~")).join("|"));
    history.replaceState(null, "", "#" + h.toString());
  }

  // ---------- UI ----------
  function buildSourceTabs() {
    $("#src-tabs").innerHTML = [...state.data.sources.values()]
      .map((s) => `<button type="button" data-src="${esc(s.id)}">${esc(s.name)}</button>`).join("");
  }
  function buildDatasetSelect() {
    $("#dataset").innerHTML = [...state.data.sources.values()].map((src) => {
      const list = state.data.datasets.filter((d) => d.source === src.id);
      const rank = (d) => { const i = src.order.indexOf(d.id); return i < 0 ? 99 : i; };
      // ARC Prize: listed order then name. LiveBench: overall first, then suites in published order.
      list.sort((a, b) => rank(a) - rank(b) || (src.id === "arc" ? a.name.localeCompare(b.name) : 0));
      return `<optgroup label="${esc(src.name)}">${list.map((d) => `<option value="${esc(d.id)}">${esc(d.short)}</option>`).join("")}</optgroup>`;
    }).join("");
  }
  function buildFilters() {
    $("#tier-chips").innerHTML = TIERS.map((t) => `<button type="button" data-tier="${t.id}" title="${esc(t.title)}">${t.label}</button>`).join("");
  }
  function renderFilters() {
    // Only the effort levels this benchmark actually has.
    const present = EFFORTS.filter((e) => ds.efforts.has(e));
    $("#effort-filter").hidden = present.length < 2;
    $("#effort-chips").innerHTML = present.map((e) =>
      `<button type="button" data-effort="${e}" aria-pressed="${!state.hiddenEfforts.has(e)}" title="${e === "other" ? "No effort setting, or a custom one (thinking budgets, previews)" : ""}">${e}</button>`).join("");
    document.querySelectorAll("[data-tier]").forEach((b) => b.setAttribute("aria-pressed", !state.hiddenTiers.has(b.dataset.tier)));
    document.querySelectorAll("[data-released]").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.released === state.releasedDays));
  }
  function renderTabs() {
    const src = sourceOf(state.datasetId);
    document.querySelectorAll("[data-src]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.src === src?.id));
    $("#view-tabs").innerHTML = VIEWS.map((v) => {
      const ok = viewAvailable(v);
      return `${v.sep ? '<span class="sep" aria-hidden="true"></span>' : ""}<button type="button" data-view="${v.id}" aria-pressed="${v.id === state.view}" ${ok ? "" : `disabled title="${esc(src?.name || "This source")} doesn't publish this"`}>${esc(v.tab(ds?.meta))}</button>`;
    }).join("");
  }
  function syncControls() {
    const v = viewDef(), mode = modeOf();
    const scatter = mode === "scatter";
    $("#view-title").textContent = scatter && v.metric !== "cost" ? `Score vs ${v.tab(ds.meta).toLowerCase()}` : v.tab(ds.meta);
    $("#pareto-ctl").hidden = !scatter;
    $("#pareto").checked = state.frontierMode !== "off";
    $("#scope-seg").hidden = !scatter || state.frontierMode === "off";
    $("#scale-seg").hidden = !scatter;
    $("#mode-seg").hidden = v.modes.length < 2;
    document.querySelectorAll("[data-scale]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.scale === state.scale));
    document.querySelectorAll("[data-frontier]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.frontier === state.frontierScope));
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
    document.querySelectorAll("[data-opt]").forEach((b) => {
      b.setAttribute("aria-checked", state.opts[b.dataset.opt]);
      if (b.dataset.opt !== "labels") b.hidden = scatter;
    });
    chartEl.classList.toggle("bars", !scatter);
    $("#hint").textContent = scatter
      ? (state.frontierMode !== "off" ? "The dashed staircase is the Pareto frontier: no model beats it on both score and " + (v.metric === "cost" ? "cost" : "tokens") + ". " : "") +
        "Hover for details, click a point to pin it. Scroll or pinch to zoom, drag to pan, double-click to reset."
      : "Hover a bar for details, click to pin it. Bars are shaded from lowest to highest effort.";
  }

  function bindUI() {
    $("#dataset").addEventListener("change", (e) => selectDataset(e.target.value, { keepSelection: true }));
    $("#src-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-src]"); if (b) selectSource(b.dataset.src); });
    $("#view-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) selectView(b.dataset.view); });
    document.querySelectorAll("[data-released]").forEach((b) => b.addEventListener("click", () => {
      state.releasedDays = +b.dataset.released;
      deriveDataset();
      update({ animate: true });
    }));
    $("#effort-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-effort]");
      if (!b) return;
      const k = b.dataset.effort;
      state.hiddenEfforts.has(k) ? state.hiddenEfforts.delete(k) : state.hiddenEfforts.add(k);
      deriveDataset();
      update({ animate: true });
    });
    $("#tier-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tier]");
      if (!b) return;
      const k = b.dataset.tier;
      state.hiddenTiers.has(k) ? state.hiddenTiers.delete(k) : state.hiddenTiers.add(k);
      deriveDataset();
      update({ animate: true });
    });
    document.querySelectorAll("[data-scale]").forEach((b) => b.addEventListener("click", () => {
      if (state.scale === b.dataset.scale) return;
      state.scale = b.dataset.scale;
      resetZoom(false);
      update({ animate: true });
    }));
    $("#pareto").addEventListener("change", (e) => {
      state.frontierMode = e.target.checked ? state.frontierScope : "off";
      update({ animate: true });
    });
    document.querySelectorAll("[data-frontier]").forEach((b) => b.addEventListener("click", () => {
      state.frontierScope = state.frontierMode = b.dataset.frontier;
      update({ animate: true });
    }));
    document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      state.modes[state.view] = b.dataset.mode;
      resetZoom(false);
      update({ animate: true });
    }));
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      preset(b.dataset.preset);
      state.groupOpen.clear();
      update({ animate: true });
    }));
    $("#reset-sel").addEventListener("click", () => {
      preset("default");
      state.groupOpen.clear();
      update({ animate: true });
    });
    $("#search").addEventListener("input", (e) => { state.search = e.target.value.trim().toLowerCase(); renderList(); });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    $("#theme").addEventListener("click", () => {
      const next = theme.dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch {}
    });

    // Overflow menu
    const menu = $("#menu"), menuBtn = $("#menu-btn");
    const setMenu = (open) => { menu.hidden = !open; menuBtn.setAttribute("aria-expanded", open); };
    menuBtn.addEventListener("click", () => setMenu(menu.hidden));
    menu.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-opt]");
      if (opt) {
        state.opts[opt.dataset.opt] = !state.opts[opt.dataset.opt];
        update({ animate: true });
        return;
      }
      if (e.target.closest("button,a")) setMenu(false);
    });
    document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !e.target.closest(".menu-wrap")) setMenu(false); });

    $("#share").addEventListener("click", async () => {
      writeHash();
      try { await navigator.clipboard.writeText(location.href); toast("Link copied"); }
      catch { toast("Couldn't copy the link"); }
    });
    $("#export-png").addEventListener("click", () => exportPNG().catch((err) => { console.error(err); toast("PNG export failed"); }));
    $("#export-csv").addEventListener("click", exportCSV);
    $("#reset-zoom").addEventListener("click", () => resetZoom(true));

    // Models drawer on small screens
    const panel = $("#panel"), scrim = $("#scrim");
    const setDrawer = (open) => {
      panel.classList.toggle("open", open);
      scrim.hidden = !open;
      $("#models-btn").setAttribute("aria-expanded", open);
    };
    $("#models-btn").addEventListener("click", () => setDrawer(true));
    $("#close-panel").addEventListener("click", () => setDrawer(false));
    scrim.addEventListener("click", () => setDrawer(false));

    const listEl = $("#model-list");
    listEl.addEventListener("change", (e) => {
      const key = e.target.dataset.key;
      if (!key) return;
      e.target.checked ? state.selected.add(key) : state.selected.delete(key);
      update({ animate: true });
    });
    listEl.addEventListener("click", (e) => {
      const toggle = e.target.closest(".prov-toggle");
      if (toggle) {
        const li = toggle.closest(".prov");
        const open = li.dataset.open !== "true";
        li.dataset.open = open;
        toggle.setAttribute("aria-expanded", open);
        state.groupOpen.set(li.dataset.prov, open);
        return;
      }
      const all = e.target.closest("[data-prov-all]");
      if (all) {
        const prov = all.dataset.provAll;
        const keys = listSeries().filter((s) => s.provider === prov).map((s) => s.key);
        const allOn = keys.every((k) => state.selected.has(k));
        keys.forEach((k) => (allOn ? state.selected.delete(k) : state.selected.add(k)));
        state.groupOpen.set(prov, true);
        update({ animate: true });
        return;
      }
      const only = e.target.closest("[data-only]");
      if (only) {
        e.preventDefault();
        state.selected = new Set([only.dataset.only]);
        update({ animate: true });
      }
    });
    listEl.addEventListener("pointerover", (e) => {
      const row = e.target.closest(".model-row");
      setHover(row && state.selected.has(row.dataset.key) ? row.dataset.key : null);
    });
    listEl.addEventListener("pointerleave", () => setHover(null));

    $("#legend").addEventListener("pointerover", (e) => { const b = e.target.closest("[data-key]"); setHover(b ? b.dataset.key : null); });
    $("#legend").addEventListener("pointerleave", () => setHover(null));

    $("#custom-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const c = { name: String(f.get("name")).trim().slice(0, 40), cost: +f.get("cost"), score: +f.get("score") / 100 };
      if (!c.name || !(c.cost > 0) || !(c.score >= 0 && c.score <= 1)) return;
      state.custom.push(c);
      e.target.reset();
      if (state.view !== "cost") state.view = "cost";
      update({ animate: true });
    });
    $("#custom-list").addEventListener("click", (e) => {
      const i = e.target.dataset.rm;
      if (i == null) return;
      state.custom.splice(+i, 1);
      update({ animate: true });
    });

    tooltip.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act || !state.pinned) return;
      const key = state.pinned.s;
      if (act === "only") state.selected = new Set([key]);
      if (act === "remove") state.selected.delete(key);
      unpin();
      if (act !== "close") update({ animate: true });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { unpin(); setMenu(false); setDrawer(false); }
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (getComputedStyle($("#models-btn")).display !== "none") setDrawer(true);
        $("#search").focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (state.pinned && !tooltip.contains(e.target) && !chartEl.contains(e.target)) unpin();
    });
  }

  let toastEl = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.setAttribute("role", "status");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;padding:8px 14px;border-radius:8px;font-size:13px;background:var(--text);color:var(--bg);box-shadow:var(--shadow);transition:opacity 200ms";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = 1;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.style.opacity = 0), 1600);
  }

  function setStatus(html, isError = false) {
    const el = $("#status");
    el.innerHTML = html;
    el.classList.toggle("error", isError);
  }

  function update({ animate = false } = {}) {
    unpin(false);
    renderTabs();
    renderFilters();
    syncControls();
    const shown = currentSeries();
    $("#count").textContent = shown.length;
    $("#models-count").textContent = shown.length;
    const metric = metricOf();
    const nPts = shown.reduce((n, s) => n + s.points.filter((p) => p[metric] != null).length, 0);
    const nFront = modeOf() === "scatter" ? frontierPool().length : 0;
    setStatus(`${shown.length} of ${ds.series.length} models · ${nPts} points` + (nFront ? ` · ${nFront} on the frontier` : ""));
    // Size the benchmark menu to its current label so the chevron sits beside it.
    const sel = $("#dataset");
    sel.style.width = Math.ceil(textWidth(sel.selectedOptions[0]?.textContent || "", '400 14px "DM Sans", system-ui, sans-serif') + 22) + "px";
    renderList();
    renderCustomList();
    render({ animate });
    renderTable();
    writeHash();
  }

  function listSeries() {
    const q = state.search;
    return ds.series.filter((s) => !q || s.name.toLowerCase().includes(q) || providerName(s.provider).toLowerCase().includes(q));
  }

  function renderList() {
    const ul = $("#model-list");
    const list = listSeries();
    const cmp = {
      recent: (a, b) => (b.released || "").localeCompare(a.released || "") || a.name.localeCompare(b.name),
      score: (a, b) => b.best.score - a.best.score,
      cost: (a, b) => a.minCost - b.minCost,
      name: (a, b) => a.name.localeCompare(b.name),
    }[state.sort];
    const groups = d3.groups(list, (s) => s.provider)
      .map(([prov, items]) => [prov, items.sort(cmp)])
      .sort((a, b) => (state.sort === "name" ? providerName(a[0]).localeCompare(providerName(b[0])) : cmp(a[1][0], b[1][0])));
    if (!list.length) {
      ul.innerHTML = `<li class="empty">${state.search ? `No models match “${esc(state.search)}”.` : "No models match these filters."}</li>`;
      return;
    }
    ul.innerHTML = groups.map(([prov, items]) => {
      const sel = items.filter((s) => state.selected.has(s.key)).length;
      const open = state.search ? true : state.groupOpen.has(prov) ? state.groupOpen.get(prov) : sel > 0;
      return `<li class="prov" data-prov="${esc(prov)}" data-open="${open}">
        <div class="prov-head">
          <button type="button" class="prov-toggle" aria-expanded="${open}">
            <svg class="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${logoHTML(prov, 15)}
            <span class="prov-name">${esc(providerName(prov))}</span>
            <span class="prov-count">${sel}/${items.length}</span>
          </button>
          <button type="button" class="prov-all" data-prov-all="${esc(prov)}">${sel === items.length ? "none" : "all"}</button>
        </div>
        <ul class="prov-models">${items.map(rowHTML).join("")}</ul>
      </li>`;
    }).join("");
    applyHover();
  }
  function rowHTML(s) {
    const on = state.selected.has(s.key);
    const price = s.price ? ` · $${s.price.in}/$${s.price.out} per 1M tokens` : "";
    return `<li class="model-row${on ? "" : " off"}" data-key="${esc(s.key)}">
      <label title="${esc(s.name)} · ${esc(providerName(s.provider))} · ${s.releasedApprox ? "first on LiveBench" : "released"} ${esc(fmtDate(s.released))} · from ${fmtCost(s.minCost)}${esc(price)}">
        <input type="checkbox" data-key="${esc(s.key)}" ${on ? "checked" : ""} />
        <span class="nm">${esc(s.name)}</span>
        <span class="meta">${fmtScore(s.best.score)}</span>
        <span class="dot" style="background:${seriesColor(s)}"></span>
      </label>
      <button type="button" class="only" data-only="${esc(s.key)}" title="Show only this model">only</button>
    </li>`;
  }
  function renderCustomList() {
    $("#custom-list").innerHTML = state.custom.map((c, i) =>
      `<li><span>${esc(c.name)} — ${fmtScore(c.score)} @ ${fmtCost(c.cost)}</span><button type="button" data-rm="${i}" aria-label="Remove ${esc(c.name)}">✕</button></li>`).join("");
  }

  // ---------- chart ----------
  let svg, zoomBehavior, gRoot, gBars, layers, bl, ctx = null;
  let screenPts = [];
  let barRects = [];
  let delaunay = null;
  const measureCtx = document.createElement("canvas").getContext("2d");
  const textWidth = (t, font = '500 13.5px "DM Sans", system-ui, sans-serif') => { measureCtx.font = font; return measureCtx.measureText(t).width; };

  function ensureSvg() {
    if (svg) return;
    svg = d3.select(chartEl).append("svg").attr("role", "img");
    svg.append("defs").append("clipPath").attr("id", "plot-clip").append("rect");
    gRoot = svg.append("g");
    layers = {
      gridY: gRoot.append("g").attr("class", "grid grid-y"),
      axisX: gRoot.append("g").attr("class", "axis axis-x"),
      axisY: gRoot.append("g").attr("class", "axis axis-y"),
      titleX: gRoot.append("text").attr("class", "axis-title").attr("text-anchor", "middle"),
      titleY: gRoot.append("text").attr("class", "axis-title").attr("text-anchor", "start"),
      leaders: gRoot.append("g"),
      plot: gRoot.append("g").attr("clip-path", "url(#plot-clip)"),
      labels: gRoot.append("g"),
      readout: gRoot.append("g").attr("class", "readout").style("display", "none"),
    };
    const p = layers.plot;
    layers.frontierArea = p.append("path").attr("class", "frontier-area");
    layers.frontier = p.append("path").attr("class", "frontier-line");
    layers.frontierTag = p.append("text").attr("class", "frontier-tag").text("Pareto frontier");
    layers.guides = p.append("g");
    layers.lines = p.append("g");
    layers.halos = p.append("g");
    layers.points = p.append("g");
    layers.custom = p.append("g");
    layers.ring = p.append("circle").attr("class", "hover-ring").attr("r", 9).style("display", "none");
    layers.effort = p.append("g");
    layers.empty = gRoot.append("text").attr("class", "empty-msg").attr("text-anchor", "middle");
    layers.readX = layers.readout.append("g");
    layers.readX.append("rect").attr("rx", 4).attr("height", 18);
    layers.readX.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").attr("y", 9);
    layers.readY = layers.readout.append("g");
    layers.readY.append("rect").attr("rx", 4).attr("height", 18).attr("y", -9);
    layers.readY.append("text").attr("text-anchor", "end").attr("dy", "0.35em");

    // Bar chart layers
    gBars = svg.append("g").style("display", "none");
    bl = {
      grid: gBars.append("g").attr("class", "grid"),
      axisY: gBars.append("g").attr("class", "axis axis-y"),
      title: gBars.append("text").attr("class", "axis-title").attr("text-anchor", "start"),
      groups: gBars.append("g"),
      base: gBars.append("line").attr("class", "axis").style("stroke", "var(--axis)"),
      empty: gBars.append("text").attr("class", "empty-msg").attr("text-anchor", "middle"),
    };

    zoomBehavior = d3.zoom()
      .scaleExtent([0.5, 80])
      .filter((e) => modeOf() === "scatter" && (!e.ctrlKey || e.type === "wheel") && !e.button)
      .on("start", (e) => { if (e.sourceEvent) unpin(); })
      .on("zoom", (e) => {
        state.transform = e.transform;
        $("#reset-zoom").hidden = e.transform.k === 1 && e.transform.x === 0 && e.transform.y === 0;
        state.hoverPoint = null;
        hideTooltip();
        render();
      });
    svg.call(zoomBehavior).on("dblclick.zoom", null);
    svg.on("dblclick", () => { if (modeOf() === "scatter") resetZoom(true); });
    svg.on("pointermove", onPointerMove)
      .on("pointerleave", () => { if (!state.pinned) { state.hoverPoint = null; hideTooltip(); setHover(null); } })
      .on("click", onClick);
  }

  function resetZoom(animated) {
    state.transform = d3.zoomIdentity;
    $("#reset-zoom").hidden = true;
    if (!svg) return;
    (animated ? svg.transition().duration(350) : svg).call(zoomBehavior.transform, d3.zoomIdentity);
  }

  function currentSeries() {
    return ds.series.filter((s) => state.selected.has(s.key));
  }
  function customPoints() {
    if (metricOf() !== "cost" || modeOf() !== "scatter") return [];
    return state.custom.map((c, i) => ({
      d: state.datasetId, s: "custom:" + i, id: "custom:" + i, effort: "", score: c.score, cost: c.cost,
      series: { key: "custom:" + i, name: c.name, provider: "__custom", custom: true },
    }));
  }
  function frontierPool() {
    if (state.frontierMode === "off") return [];
    const base = (state.frontierMode === "all" ? ds.series : currentSeries()).filter((s) => !s.ref).flatMap((s) => s.points);
    return paretoFrontier(base.concat(customPoints()));
  }

  function logTicks(domain) {
    const [lo, hi] = domain;
    const out = [];
    for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)) + 1; e++) {
      for (const m of [1, 2, 5]) {
        const v = +(m * Math.pow(10, e)).toPrecision(3);
        if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
      }
    }
    return out.length > 12 ? out.filter((v) => /^1/.test(v.toExponential())) : out;
  }

  function render(opts = {}) {
    if (!ds) return;
    ensureSvg();
    const scatter = modeOf() === "scatter";
    gRoot.style("display", scatter ? null : "none");
    gBars.style("display", scatter ? "none" : null);
    svg.attr("aria-label", scatter ? `${ds.meta.name}: score versus ${METRIC[metricOf()].label().toLowerCase()}` : `${ds.meta.name}: ${METRIC[metricOf()].label().toLowerCase()} by model`);
    if (scatter) renderScatter(opts); else renderBars(opts);
    renderLegend();
  }

  function renderScatter({ animate = false } = {}) {
    const W = chartEl.clientWidth, H = chartEl.clientHeight;
    if (!W || !H) return;
    const T = animate && !reducedMotion ? svg.transition().duration(420).ease(d3.easeCubicOut) : null;
    const tr = (sel) => (T ? sel.transition(T) : sel.interrupt());
    const metric = metricOf();
    const M = METRIC[metric];

    const series = currentSeries()
      .map((s) => ({ ...s, points: s.points.filter((p) => p[metric] != null).sort((a, b) => a[metric] - b[metric]) }))
      .filter((s) => s.points.length);
    const custom = customPoints();
    const labelMode = !state.opts.labels ? "none" : W >= 720 ? "full" : "none";

    // Gutter for end labels, sized to the longest visible name.
    const longest = d3.max(series.concat(custom.map((p) => p.series)), (s) => textWidth(s.name)) || 60;
    const gutter = labelMode === "full" ? Math.min(280, Math.max(130, 18 + 30 + longest + 10)) : 18;
    const m = { top: 40, right: gutter, bottom: 52, left: 54 };
    const iw = Math.max(50, W - m.left - m.right), ih = Math.max(50, H - m.top - m.bottom);

    svg.attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
    gRoot.attr("transform", `translate(${m.left},${m.top})`);
    svg.select("#plot-clip rect").attr("x", -10).attr("y", -10).attr("width", iw + 20).attr("height", ih + 20);
    zoomBehavior.extent([[0, 0], [iw, ih]]).translateExtent([[-iw * 3, -ih * 3], [iw * 4, ih * 4]]);

    const allPts = series.flatMap((s) => s.points).concat(custom);
    const vals = allPts.length ? d3.extent(allPts, (p) => p[metric]) : [0.01, 10];
    const maxScore = allPts.length ? d3.max(allPts, (p) => p.score) : 1;

    const x0 = state.scale === "log"
      ? d3.scaleLog().domain([vals[0] / 1.5, vals[1] * 1.5]).range([0, iw])
      : d3.scaleLinear().domain([0, vals[1] * 1.06]).range([0, iw]);
    const top = Math.max(Math.min(1, Math.ceil(maxScore * 1.05 * 10) / 10), maxScore * 1.04) || 1;
    const y0 = d3.scaleLinear().domain([0, top]).range([ih, 0]);
    const x = state.transform.rescaleX(x0);
    const y = state.transform.rescaleY(y0);

    // Axes + grid: dotted horizontal rules only.
    let xTicks = state.scale === "log" ? logTicks(x.domain()) : x.ticks(Math.max(3, Math.floor(iw / 100)));
    const maxTicks = Math.max(2, Math.floor(iw / 54));
    if (xTicks.length > maxTicks) xTicks = xTicks.filter((v) => /^1/.test(v.toExponential()));
    if (xTicks.length > maxTicks) xTicks = xTicks.filter((v, i) => i % 2 === 0);
    const yTicks = y.ticks(Math.max(3, Math.floor(ih / 80)));
    const tickFmt = M.money ? fmtTick : fmtTokTick;
    tr(layers.axisX.attr("transform", `translate(0,${ih})`)).call(d3.axisBottom(x).tickValues(xTicks).tickFormat(tickFmt).tickSizeOuter(0).tickSize(5).tickPadding(8));
    tr(layers.axisY).call(d3.axisLeft(y).tickValues(yTicks).tickFormat((v) => (isIndex() ? d3.format(".0f")(v * 100) : d3.format(".0~%")(v))).tickSize(0).tickPadding(14));
    layers.axisY.select(".domain").remove();
    tr(layers.gridY).call(d3.axisLeft(y).tickValues(yTicks).tickSize(-iw).tickFormat(""));
    layers.titleX.attr("x", iw / 2).attr("y", ih + 44).text(`${M.label()} (${M.money ? "USD" : "output tokens"}, ${state.scale === "log" ? "log scale" : "linear"})`);
    layers.titleY.attr("x", 0).attr("y", -20).text(isIndex() ? ds.meta.name : `${ds.meta.name} score`);

    // Frontier staircase
    const frontier = frontierPool();
    const fSet = new Set(frontier);
    if (frontier.length) {
      const fp = frontier.map((p) => [x(p[metric]), y(p.score)]);
      const last = fp[fp.length - 1];
      fp.push([iw + 30, last[1]]);
      tr(layers.frontier.style("display", null)).attr("d", d3.line().curve(d3.curveStepAfter)(fp));
      tr(layers.frontierArea.style("display", null)).attr("d", d3.area().curve(d3.curveStepAfter).y0(ih + 30)(fp));
      const tagY = last[1] < 18 ? last[1] + 16 : last[1] - 8;
      tr(layers.frontierTag.style("display", iw > 420 && last[1] > -10 && last[1] < ih ? null : "none"))
        .attr("x", iw - 6).attr("y", tagY).attr("text-anchor", "end");
    } else {
      layers.frontier.style("display", "none");
      layers.frontierArea.style("display", "none");
      layers.frontierTag.style("display", "none");
    }

    // Series lines
    const lineGen = d3.line().x((p) => x(p[metric])).y((p) => y(p.score));
    const lines = layers.lines.selectAll("path").data(series, (s) => s.key).join(
      (enter) => enter.append("path").attr("class", "series-line").attr("opacity", 0).attr("d", (s) => lineGen(s.points)),
    );
    lines.style("stroke", seriesColor).style("stroke-dasharray", (s) => (s.ref ? "4 4" : null));
    tr(lines).attr("d", (s) => lineGen(s.points)).attr("opacity", 1);

    // Points: frontier points are larger and haloed.
    const ptsData = series.flatMap((s) => s.points);
    const keyOf = (p) => p.s + "|" + p.id;
    const halos = layers.halos.selectAll("circle").data(ptsData.filter((p) => fSet.has(p)), keyOf).join(
      (enter) => enter.append("circle").attr("class", "halo").attr("r", 0).attr("cx", (p) => x(p[metric])).attr("cy", (p) => y(p.score)),
    );
    tr(halos).attr("r", 10).attr("cx", (p) => x(p[metric])).attr("cy", (p) => y(p.score));

    const pts = layers.points.selectAll("circle").data(ptsData, keyOf).join(
      (enter) => enter.append("circle").attr("class", "pt").attr("r", 0).attr("cx", (p) => x(p[metric])).attr("cy", (p) => y(p.score)),
    );
    pts.classed("front", (p) => fSet.has(p)).style("fill", (p) => seriesColor(p.series));
    tr(pts).attr("cx", (p) => x(p[metric])).attr("cy", (p) => y(p.score)).attr("r", (p) => (fSet.has(p) ? 5.5 : 4.5));

    const cps = layers.custom.selectAll("path").data(custom, (p) => p.id).join("path").attr("class", "custom-pt")
      .attr("d", d3.symbol(d3.symbolDiamond, 130)());
    tr(cps).attr("transform", (p) => `translate(${x(p.cost)},${y(p.score)})`);

    layers.empty.attr("x", iw / 2).attr("y", ih / 2)
      .text(series.length || custom.length ? "" : (currentSeries().length ? "These models have no data for this chart." : "No models selected. Pick some from the list, or reset to recommended."));

    ctx = { mode: "scatter", m, iw, ih, x, y, frontier, fSet, labelMode, metric };
    renderLabels(labelMode === "none" ? [] : series.concat(custom.map((p) => ({ ...p.series, best: p, points: [p] }))), T);

    screenPts = ptsData.concat(custom).map((p) => ({ p, sx: x(p[metric]), sy: y(p.score) }))
      .filter((d) => d.sx >= -6 && d.sx <= iw + 6 && d.sy >= -6 && d.sy <= ih + 6);
    barRects = [];
    delaunay = d3.Delaunay.from(screenPts, (d) => d.sx, (d) => d.sy);
    applyHover();
  }

  function renderLabels(series, T) {
    const { x, y, iw, ih, fSet, metric } = ctx;
    const LH = 24;
    let items = series.map((s) => {
      // Anchor at the line's end: its rightmost point that is in view.
      const val = (p) => p[metric] ?? p.cost;
      const inView = s.points.filter((p) => { const px = x(val(p)), py = y(p.score); return px >= 0 && px <= iw && py >= 0 && py <= ih; });
      const a = inView.length ? inView[inView.length - 1] : s.points[s.points.length - 1];
      const ax = x(val(a)), ay = y(a.score);
      return { s, ax, ay, inView: inView.length > 0, target: Math.max(0, Math.min(ih, ay)), onFrontier: s.points.some((p) => fSet.has(p)) };
    });
    const maxFit = Math.floor((ih + 8) / LH);
    if (items.length > maxFit) {
      // Too many to label legibly: keep frontier models, then the best scorers.
      items.sort((a, b) => (b.onFrontier - a.onFrontier) || b.s.best.score - a.s.best.score);
      items = items.slice(0, maxFit);
    }
    items.sort((a, b) => a.target - b.target);
    let prev = -Infinity;
    for (const it of items) { it.ly = Math.max(it.target, prev + LH); prev = it.ly; }
    let bound = ih + 4;
    for (let i = items.length - 1; i >= 0; i--) { items[i].ly = Math.min(items[i].ly, bound); bound = items[i].ly - LH; }

    const gx = iw + 24;
    const leaders = layers.leaders.selectAll("path").data(items.filter((d) => d.inView), (d) => d.s.key).join("path").attr("class", "leader");
    (T ? leaders.transition(T) : leaders.interrupt()).attr("d", (d) => `M${d.ax + 8},${d.ay}H${Math.max(d.ax + 8, iw + 4)}L${gx - 8},${d.ly}`);

    const labelW = ctx.m.right - 26;
    const g = layers.labels.selectAll("g.lbl").data(items, (d) => d.s.key).join((enter) => {
      const e = enter.append("g").attr("class", "lbl").attr("transform", (d) => `translate(${gx},${d.ly})`);
      e.append("rect").attr("class", "lbl-bg").attr("x", -6).attr("y", -11.5).attr("height", 23).attr("rx", 6);
      e.append("circle").attr("class", "lbl-dot").attr("r", 3.5);
      e.append("g").attr("class", "lbl-logo").attr("transform", "translate(16,0)");
      e.append("text").attr("class", "lbl-name").attr("x", 30).attr("dy", "0.35em");
      e.append("title");
      return e;
    });
    g.attr("data-key", (d) => d.s.key).style("opacity", (d) => (d.inView ? null : 0.5));
    (T ? g.transition(T) : g.interrupt()).attr("transform", (d) => `translate(${gx},${d.ly})`);
    g.select("rect").attr("width", labelW + 6);
    g.select(".lbl-dot").style("fill", (d) => seriesColor(d.s));
    g.select(".lbl-logo").each(function (d) {
      const sel = d3.select(this);
      const prov = d.s.custom ? "__custom" : d.s.provider;
      if (sel.attr("data-prov") !== prov || !this.firstChild) { sel.attr("data-prov", prov); drawLogo(sel, prov, 16); }
    });
    g.select(".lbl-name").text((d) => d.s.name);
    g.select("title").text((d) => (d.s.custom ? `${d.s.name} (your point)` : `${d.s.name} · ${providerName(d.s.provider)} — click to remove`));
    g.on("pointerenter", (e, d) => setHover(d.s.custom ? null : d.s.key))
      .on("pointerleave", () => setHover(null))
      .on("click", (e, d) => {
        e.stopPropagation();
        if (d.s.custom) return;
        state.selected.delete(d.s.key);
        setHover(null);
        update({ animate: true });
      });
  }

  // HTML legend under the chart when there's no room for end labels.
  function renderLegend() {
    const el = $("#legend");
    const show = modeOf() === "scatter" && ctx?.labelMode === "none" && state.opts.labels;
    el.hidden = !show;
    if (!show) return;
    const metric = metricOf();
    const series = currentSeries().filter((s) => s.points.some((p) => p[metric] != null))
      .sort((a, b) => b.best.score - a.best.score);
    el.innerHTML = series.map((s) => `<button type="button" data-key="${esc(s.key)}" title="${esc(s.name)} · ${esc(providerName(s.provider))}">
      <span class="dot" style="background:${seriesColor(s)}"></span>${logoHTML(s.provider, 15)}<span class="nm">${esc(s.name)}</span></button>`).join("");
  }

  // Bars: one group per model (bars for its effort levels), or one bar per variant.
  function wrapName(name, width, font) {
    const words = name.split(/\s+/);
    const lines = [""];
    for (const w of words) {
      const cur = lines[lines.length - 1];
      const next = cur ? cur + " " + w : w;
      if (!cur || textWidth(next, font) <= width) lines[lines.length - 1] = next;
      else lines.push(w);
    }
    return lines;
  }
  const roundedTop = (x, y, w, h, r) => {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  };

  function renderBars({ animate = false } = {}) {
    const W = chartEl.clientWidth, H = chartEl.clientHeight;
    if (!W || !H) return;
    const T = animate && !reducedMotion ? svg.transition().duration(420).ease(d3.easeCubicOut) : null;
    const metric = metricOf();
    const M = METRIC[metric];
    const series = currentSeries().map((s) => ({ s, pts: s.points.filter((p) => p[metric] != null) })).filter((g) => g.pts.length);
    let groups = state.opts.group
      ? series.map(({ s, pts }) => ({ key: s.key, s, pts, max: d3.max(pts, (p) => p[metric]) }))
      : series.flatMap(({ s, pts }) => pts.map((p) => ({ key: s.key + "|" + p.id, s, pts: [p], max: p[metric], variant: p.effort })));
    groups.sort((a, b) => (state.opts.highestLast ? a.max - b.max : b.max - a.max) || a.s.name.localeCompare(b.s.name));

    const nameFont = '500 12px "DM Sans", system-ui, sans-serif';
    const m = { top: 40, right: 8, left: 56, bottom: 0 };
    const iw0 = Math.max(50, W - m.left - m.right);
    const step = groups.length ? iw0 / groups.length : iw0;
    const rotate = step < 52;
    const longest = d3.max(groups, (g) => textWidth(g.s.name, nameFont)) || 40;
    const anyEffort = groups.some((g) => g.pts.length > 1 || g.variant);
    const effRow = anyEffort ? 16 : 0;
    m.bottom = rotate ? 30 + effRow + Math.min(150, longest * 0.72 + 12) : 28 + effRow + 34;
    const iw = iw0, ih = Math.max(60, H - m.top - m.bottom);
    svg.attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
    gBars.attr("transform", `translate(${m.left},${m.top})`);

    const xg = d3.scaleBand().domain(groups.map((g) => g.key)).range([0, iw]).paddingInner(groups.length > 1 ? 0.22 : 0).paddingOuter(0.12);
    const vmax = d3.max(groups, (g) => g.max) || 1;
    const y = d3.scaleLinear().domain([0, vmax * 1.08]).nice().range([ih, 0]);
    const yTicks = y.ticks(Math.max(3, Math.floor(ih / 80)));
    bl.axisY.call(d3.axisLeft(y).tickValues(yTicks).tickFormat(M.money ? fmtTick : fmtTokTick).tickSize(0).tickPadding(14));
    bl.axisY.select(".domain").remove();
    bl.grid.call(d3.axisLeft(y).tickValues(yTicks).tickSize(-iw).tickFormat(""));
    bl.title.attr("x", 0).attr("y", -20).text(`${M.label()}${M.unit !== "tokens" && M.unit !== "USD" ? " · " + M.unit.replace(/^USD, /, "") : ""}`);
    bl.base.attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih);
    bl.empty.attr("x", iw / 2).attr("y", ih / 2).text(groups.length ? "" : (currentSeries().length ? "These models have no data for this chart." : "No models selected. Pick some from the list, or reset to recommended."));

    const bw = xg.bandwidth();
    barRects = [];
    const gSel = bl.groups.selectAll("g.bar-group").data(groups, (g) => g.key).join((enter) => {
      const e = enter.append("g").attr("class", "bar-group");
      e.append("g").attr("class", "bars");
      e.append("g").attr("class", "effs");
      e.append("g").attr("class", "bar-logo");
      e.append("text").attr("class", "bar-name");
      return e;
    });
    gSel.attr("data-key", (g) => g.s.key).attr("transform", (g) => `translate(${xg(g.key)},0)`);
    gSel.each(function (g) {
      const gs = d3.select(this);
      const n = g.pts.length;
      const inner = d3.scaleBand().domain(d3.range(n)).range([0, bw]).paddingInner(n > 1 ? 0.12 : 0);
      const barW = Math.min(inner.bandwidth(), 56);
      const off = (inner.bandwidth() - barW) / 2;
      const color = seriesColor(g.s);
      const data = g.pts.map((p, i) => ({ p, i, x: inner(i) + off, w: barW, v: p[metric] }));
      for (const d of data) barRects.push({ p: d.p, x0: xg(g.key) + d.x, x1: xg(g.key) + d.x + d.w, y0: y(d.v), y1: ih });

      const bars = gs.select(".bars").selectAll("g.b").data(data, (d) => d.p.id).join((enter) => {
        const e = enter.append("g").attr("class", "b");
        e.append("path").attr("class", "bar").attr("d", (d) => roundedTop(d.x, ih, d.w, 0, 4));
        e.append("text").attr("class", "bar-val").attr("text-anchor", "middle");
        e.append("rect").attr("class", "bar-hit");
        return e;
      });
      bars.select(".bar").style("fill", (d) => shade(color, d.i, n));
      const path = bars.select(".bar");
      (T ? path.transition(T) : path.interrupt()).attr("d", (d) => roundedTop(d.x, y(d.v), d.w, ih - y(d.v), 4));
      // Value on every bar when it fits; otherwise just the group's highest bar.
      const valFont = '400 11px "DM Sans", system-ui, sans-serif';
      const allFit = data.every((d) => textWidth(fmtMetricShort(metric, d.v), valFont) <= inner.step() + 2);
      const top = data.reduce((a, d) => (d.v > a.v ? d : a), data[0]);
      const showVal = (d) => state.opts.labels && (allFit || (d === top && textWidth(fmtMetricShort(metric, d.v), valFont) <= step - 4));
      bars.select(".bar-val").attr("x", (d) => d.x + d.w / 2).attr("y", (d) => y(d.v) - 6)
        .text((d) => (showVal(d) ? fmtMetricShort(metric, d.v) : ""));
      bars.select(".bar-hit").attr("x", (d) => inner(d.i)).attr("width", inner.step()).attr("y", 0).attr("height", ih)
        .on("pointerenter", (e, d) => hoverBar(d.p, xg(g.key) + d.x + d.w / 2, y(d.v)))
        .on("click", (e, d) => { e.stopPropagation(); pinBar(d.p, xg(g.key) + d.x + d.w / 2, y(d.v)); });

      // Effort letters under the bars, then the logo and name.
      const effData = anyEffort && barW >= 9 ? data : [];
      gs.select(".effs").selectAll("text").data(effData, (d) => d.p.id).join("text").attr("class", "bar-eff")
        .attr("text-anchor", "middle").attr("x", (d) => d.x + d.w / 2).attr("y", ih + 13)
        .text((d) => effortShort(d.p.effort));
      const logoY = ih + effRow + 16;
      const lg = gs.select(".bar-logo").attr("transform", `translate(${bw / 2},${logoY})`);
      if (lg.attr("data-prov") !== g.s.provider || !lg.node().firstChild) { lg.attr("data-prov", g.s.provider); drawLogo(lg, g.s.provider, 16); }
      const name = gs.select(".bar-name").attr("title", null);
      name.selectAll("tspan").remove();
      if (rotate) {
        name.attr("text-anchor", "end").attr("transform", `translate(${bw / 2 + 4},${logoY + 14}) rotate(-40)`).attr("x", 0).attr("y", 0).text(null)
          .append("tspan").attr("dy", "0.7em").text(g.s.name);
      } else {
        const lines = wrapName(g.s.name, step - 6, nameFont).slice(0, 2);
        name.attr("text-anchor", "middle").attr("transform", `translate(${bw / 2},${logoY + 14})`).text(null);
        lines.forEach((ln, i) => name.append("tspan").attr("x", 0).attr("dy", i ? "1.2em" : "0.75em").text(ln));
      }
    });

    ctx = { mode: "bars", m, iw, ih, y, metric, frontier: [], fSet: new Set(), labelMode: "none" };
    screenPts = [];
    delaunay = null;
    applyHover();
  }

  function hoverBar(p, sx, sy) {
    if (state.pinned) return;
    state.hoverPoint = p;
    state.hoverSeries = p.s;
    applyHover();
    showTooltip({ p, sx, sy }, false);
  }
  function pinBar(p, sx, sy) {
    state.pinned = p;
    state.hoverPoint = p;
    applyHover();
    showTooltip({ p, sx, sy }, true);
  }

  // ---------- hover, crosshair, pin ----------
  function setHover(key) {
    if (state.pinned) return;
    if (state.hoverSeries === key) return;
    state.hoverSeries = key;
    applyHover();
  }

  function applyHover() {
    const k = state.pinned ? state.pinned.s : state.hoverSeries;
    const off = (key) => k && key !== k;
    if (bl) bl.groups.selectAll("g.bar-group").classed("dim", (g) => off(g.s.key)).classed("hl", (g) => g.s.key === k);
    if (layers && ctx?.mode === "scatter") {
      layers.lines.selectAll("path").classed("dim", (s) => off(s.key));
      layers.points.selectAll("circle").classed("dim", (p) => off(p.s));
      layers.halos.selectAll("circle").classed("dim", (p) => off(p.s));
      layers.labels.selectAll("g.lbl").classed("dim", (d) => off(d.s.key)).classed("hl", (d) => d.s.key === k);
      layers.leaders.selectAll("path").classed("dim", (d) => off(d.s.key)).classed("hl", (d) => d.s.key === k);

      // Effort-level labels for the focused model.
      const { x, y, ih, metric } = ctx;
      const s = k && ds.byKey.get(k);
      const eff = s && state.selected.has(k) ? s.points.filter((p) => p.effort && p[metric] != null).sort((a, b) => a[metric] - b[metric]) : [];
      layers.effort.selectAll("text").data(eff, (p) => p.id).join("text")
        .attr("class", "effort-lbl")
        .attr("text-anchor", (p, i) => (i % 2 ? "start" : "end"))
        .attr("x", (p, i) => x(p[metric]) + (i % 2 ? 9 : -9))
        .attr("y", (p, i) => y(p.score) + (i % 2 ? 15 : -9))
        .text((p) => p.effort);

      // Crosshair to the axes with value readouts, in the model's color.
      const hp = state.pinned || state.hoverPoint;
      if (hp && hp[metric] != null) {
        const sx = x(hp[metric]), sy = y(hp.score);
        const col = seriesColor(hp.series);
        layers.guides.selectAll("line").data([0, 1]).join("line").attr("class", "guide").style("stroke", col)
          .attr("x1", (i) => (i ? 0 : sx)).attr("x2", sx)
          .attr("y1", sy).attr("y2", (i) => (i ? sy : ih));
        layers.ring.style("display", null).attr("cx", sx).attr("cy", sy).style("stroke", col);
        layers.readout.style("display", null);
        const cx = fmtMetric(metric, hp[metric]), cy = fmtScore(hp.score);
        const wx = textWidth(cx, '600 11px "DM Sans"') + 14, wy = textWidth(cy, '600 11px "DM Sans"') + 12;
        layers.readX.attr("transform", `translate(${Math.max(wx / 2, Math.min(ctx.iw - wx / 2, sx))},${ih + 4})`);
        layers.readX.select("rect").attr("x", -wx / 2).attr("width", wx);
        layers.readX.select("text").text(cx);
        layers.readY.attr("transform", `translate(-4,${Math.max(9, Math.min(ih - 9, sy))})`);
        layers.readY.select("rect").attr("x", -wy).attr("width", wy);
        layers.readY.select("text").attr("x", -6).text(cy);
      } else {
        layers.guides.selectAll("line").remove();
        layers.ring.style("display", "none");
        layers.readout.style("display", "none");
      }
    }
    document.querySelectorAll("#model-list .model-row").forEach((r) => r.classList.toggle("hl", r.dataset.key === k));
    document.querySelectorAll("#legend [data-key]").forEach((b) => b.classList.toggle("dim", !!(k && b.dataset.key !== k)));
  }

  function nearestPoint(e) {
    if (!delaunay || !screenPts.length || ctx?.mode !== "scatter") return null;
    const [px, py] = d3.pointer(e, gRoot.node());
    const hit = screenPts[delaunay.find(px, py)];
    return hit && Math.hypot(hit.sx - px, hit.sy - py) <= 24 ? hit : null;
  }

  function onPointerMove(e) {
    if (state.pinned || e.buttons) return;
    if (ctx?.mode === "bars") {
      if (!e.target.closest?.(".bar-hit")) {
        if (state.hoverPoint) { state.hoverPoint = null; hideTooltip(); }
        if (!e.target.closest?.(".bar-group")) setHover(null);
        else setHover(e.target.closest(".bar-group").dataset.key);
      }
      return;
    }
    const hit = nearestPoint(e);
    if (!hit) {
      if (state.hoverPoint) { state.hoverPoint = null; hideTooltip(); }
      if (!e.target.closest?.(".lbl")) setHover(null);
      applyHover();
      return;
    }
    state.hoverPoint = hit.p;
    state.hoverSeries = hit.p.series.custom ? null : hit.p.s;
    applyHover();
    showTooltip(hit, false);
  }

  function onClick(e) {
    if (e.defaultPrevented) return;
    if (ctx?.mode === "bars") { unpin(); return; }
    const hit = nearestPoint(e);
    if (!hit) { unpin(); return; }
    state.pinned = hit.p;
    state.hoverPoint = hit.p;
    applyHover();
    showTooltip(hit, true);
  }

  function unpin(refresh = true) {
    if (!state.pinned) return;
    state.pinned = null;
    state.hoverPoint = null;
    state.hoverSeries = null;
    hideTooltip();
    if (refresh) applyHover();
  }

  function showTooltip(hit, pinned) {
    const { p } = hit;
    const s = p.series;
    const { frontier, fSet, metric } = ctx;
    // Hover shows the key numbers; pinning adds notes and actions.
    let flag = "";
    if (ctx.mode === "scatter" && state.frontierMode !== "off" && !s.ref) {
      const unit = METRIC[metric].money ? fmtCost : fmtTok;
      if (fSet.has(p)) {
        flag = pinned
          ? `<span>◆</span><span><b>On the Pareto frontier.</b> Nothing scores higher for less.</span>`
          : `<span>◆</span><span><b>On the Pareto frontier</b></span>`;
      } else {
        const atBudget = frontier.filter((f) => f[metric] <= p[metric]).sort((a, b) => b.score - a.score)[0];
        const cheaper = frontier.filter((f) => f.score >= p.score).sort((a, b) => a[metric] - b[metric])[0];
        const tag = (f) => `<b>${esc(f.series.name)}${f.effort ? " (" + esc(f.effort) + ")" : ""}</b>`;
        if (!pinned) {
          if (atBudget || cheaper) flag = `<span>↘</span><span>Beaten by ${tag(atBudget || cheaper)}</span>`;
        } else {
          const parts = [];
          if (atBudget) parts.push(`${tag(atBudget)} scores ${fmtScore(atBudget.score)} for ${unit(atBudget[metric])}`);
          if (cheaper && cheaper !== atBudget && cheaper[metric] < p[metric]) parts.push(`matches this score for ${unit(cheaper[metric])} with <b>${esc(cheaper.series.name)}</b>`);
          if (parts.length) flag = `<span>↘</span><span>Beaten. ${parts.join("; ")}.</span>`;
        }
      }
    }
    const prov = s.custom ? "Your point" : providerName(s.provider);
    const src = state.data.sources.get(p.source);
    const url = p.url || src?.sourceUrl;
    const rows = [[isIndex() ? "Index score" : "Score", fmtScore(p.score)], [ds.meta.costLabel, fmtCost(p.cost)]];
    if (p.costTotal != null) rows.push(["Total cost", fmtCost(p.costTotal)]);
    if (p.tokens != null) rows.push(["Tokens per task", fmtTok(p.tokens)]);
    if (p.tokensTotal != null && pinned) rows.push(["Total tokens", fmtTok(p.tokensTotal)]);
    if (p.tps != null) rows.push(["Output speed", Math.round(p.tps) + " tok/s"]);
    if (pinned && s.price) rows.push(["Price per 1M tokens", `$${s.price.in} in · $${s.price.out} out`]);
    if (pinned && p.score > 0 && !isIndex()) rows.push(["Cost per point", fmtCost(p.cost / (p.score * 100))]);
    tooltip.innerHTML = `
      <div class="tt-head">${logoHTML(s.custom ? "__custom" : s.provider, 18)}<div class="tt-name">${esc(s.name)}</div>
        <button type="button" class="tt-close" data-act="close" aria-label="Close details"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>
      <div class="tt-sub">${p.effort ? esc(p.effort) + " · " : ""}${esc(prov)}${s.released ? " · " + (s.releasedApprox ? "on LiveBench since " : "") + esc(fmtShortDate(s.released)) : ""}</div>
      <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
      ${flag ? `<div class="tt-flag">${flag}</div>` : ""}
      ${pinned && p.note ? `<div class="tt-note">${esc(p.note.length > 220 ? p.note.slice(0, 217) + "…" : p.note)}</div>` : ""}
      ${s.custom ? "" : pinned ? `
      <div class="tt-actions">
        <button type="button" data-act="only">Only this</button>
        <button type="button" data-act="remove">Remove</button>
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(src.name)}</a>` : ""}
      </div>` : `<div class="tt-hint">Click for details</div>`}`;
    tooltip.classList.toggle("pinned", pinned);
    tooltip.hidden = false;
    placeTooltip(hit);
  }

  // The card docks in an empty corner of the plot when one is free (bottom-right on a
  // score-vs-cost chart is almost always empty: expensive and low scoring). Otherwise it
  // sits next to the point, wherever it hides the least of the focused model.
  function placeTooltip(hit) {
    const card = chartEl.parentElement.getBoundingClientRect();
    const box = chartEl.getBoundingClientRect();
    const ox = box.left - card.left + ctx.m.left, oy = box.top - card.top + ctx.m.top;
    const ax = ox + hit.sx, ay = oy + hit.sy;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    const pad = 8;
    const key = hit.p.s;

    const obstacles = []; // [x, y, r, weight] circles in card coordinates
    const rects = []; // [x0, y0, x1, y1, weight]
    if (ctx.mode === "scatter") {
      const own = screenPts.filter((d) => d.p.s === key).sort((a, b) => xv(a.p) - xv(b.p));
      for (const d of screenPts) if (d.p.s !== key) obstacles.push([ox + d.sx, oy + d.sy, 5, 1]);
      for (const d of own) obstacles.push([ox + d.sx, oy + d.sy, 10, 12]);
      for (let i = 1; i < own.length; i++) {
        const a = own[i - 1], b = own[i];
        const n = Math.ceil(Math.hypot(b.sx - a.sx, b.sy - a.sy) / 10);
        for (let j = 1; j < n; j++) obstacles.push([ox + a.sx + ((b.sx - a.sx) * j) / n, oy + a.sy + ((b.sy - a.sy) * j) / n, 3, 3]);
      }
      layers.effort.selectAll("text").each(function () { rects.push(clientRect(this, card, 10)); });
      layers.labels.selectAll("g.lbl.hl").each(function () { rects.push(clientRect(this, card, 4)); });
    } else {
      for (const r of barRects) rects.push([ox + r.x0 - 2, oy + r.y0 - 18, ox + r.x1 + 2, oy + r.y1, r.p.s === key ? 12 : 1]);
    }

    const { iw, ih } = ctx;
    const corners = ctx.mode === "scatter"
      ? [[ox + iw - tw - 12, oy + ih - th - 12], [ox + 12, oy + 4], [ox + iw - tw - 12, oy + 4], [ox + 12, oy + ih - th - 12]]
      : state.opts.highestLast
        ? [[ox + 12, oy + 4], [ox + iw - tw - 12, oy + 4]]
        : [[ox + iw - tw - 12, oy + 4], [ox + 12, oy + 4]];
    const cands = corners.map(([l, t], i) => [l, t, i * 0.3]);
    for (const [gi, g] of [16, 34, 60].entries()) {
      [
        [ax - tw - g, ay - th - g], [ax + g, ay + g], [ax + g, ay - th / 2], [ax - tw - g, ay - th / 2],
        [ax + g, ay - th - g], [ax - tw - g, ay + g], [ax - tw / 2, ay - th - g], [ax - tw / 2, ay + g],
      ].forEach(([l, t], i) => cands.push([l, t, 3 + i * 0.5 + gi * 2]));
    }
    let best = null;
    for (const [l0, t0, base] of cands) {
      const l = Math.max(pad, Math.min(card.width - tw - pad, l0));
      const t = Math.max(pad, Math.min(card.height - th - pad, t0));
      const r = l + tw, b = t + th;
      let cost = base + (Math.abs(l - l0) + Math.abs(t - t0)) * 0.05;
      // Never cover the hovered point or the cursor next to it.
      if (ax > l - 14 && ax < r + 14 && ay > t - 14 && ay < b + 14) cost += 1000;
      for (const [x, y, rad, w] of obstacles) if (x > l - rad && x < r + rad && y > t - rad && y < b + rad) cost += w;
      for (const [x0, y0, x1, y1, w] of rects) {
        const ix = Math.min(r, x1) - Math.max(l, x0), iy = Math.min(b, y1) - Math.max(t, y0);
        if (ix > 0 && iy > 0) cost += w;
      }
      if (!best || cost < best.cost) best = { cost, l, t };
    }
    tooltip.style.left = best.l + "px";
    tooltip.style.top = best.t + "px";
  }
  function clientRect(el, card, w) {
    const r = el.getBoundingClientRect();
    return [r.left - card.left - 4, r.top - card.top - 4, r.right - card.left + 4, r.bottom - card.top + 4, w];
  }
  function hideTooltip() {
    tooltip.hidden = true;
    tooltip.classList.remove("pinned");
  }

  // ---------- export ----------
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function visibleRows() {
    const fSet = new Set(modeOf() === "scatter" ? frontierPool() : []);
    return currentSeries().flatMap((s) => s.points.map((p) => ({
      model: s.name, provider: providerName(s.provider), effort: p.effort || "", score: p.score, cost: p.cost,
      costTotal: p.costTotal ?? null, tokens: p.tokens ?? null, tokensTotal: p.tokensTotal ?? null,
      released: s.released || "", frontier: fSet.has(p), url: p.url, s,
    }))).concat(customPoints().map((p) => ({ model: p.series.name, provider: "Your point", effort: "", score: p.score, cost: p.cost, costTotal: null, tokens: null, tokensTotal: null, released: "", frontier: fSet.has(p), s: p.series })));
  }

  function exportCSV() {
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const rows = visibleRows();
    const n = (v, p = 6) => (v == null ? "" : +v.toPrecision(p));
    const lines = [["benchmark", "model", "provider", "effort", isIndex() ? "score_index" : "score_pct", "cost_usd", "total_cost_usd", "output_tokens_per_task", "total_output_tokens", "released", "on_frontier"].join(",")]
      .concat(rows.map((r) => [ds.meta.name, r.model, r.provider, r.effort, +(r.score * 100).toFixed(3), n(r.cost), n(r.costTotal), n(r.tokens), n(r.tokensTotal, 9), r.released, r.frontier].map(q).join(",")));
    download(new Blob([lines.join("\n")], { type: "text/csv" }), `pareto-${state.datasetId}.csv`);
  }

  async function exportPNG() {
    unpin();
    state.hoverPoint = null;
    state.hoverSeries = null;
    applyHover();
    const node = svg.node();
    const W = chartEl.clientWidth, H = chartEl.clientHeight;
    const clone = node.cloneNode(true);
    const props = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "stroke-linejoin", "stroke-linecap", "opacity", "font-size", "font-weight", "font-family", "letter-spacing", "text-transform", "display", "paint-order", "color"];
    const src = node.querySelectorAll("*"), dst = clone.querySelectorAll("*");
    src.forEach((el, i) => {
      const cs = getComputedStyle(el);
      dst[i].setAttribute("style", props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
    });
    // Uppercase text-transform doesn't survive rasterization everywhere; bake it in.
    clone.querySelectorAll(".frontier-tag").forEach((t) => (t.textContent = t.textContent.toUpperCase()));
    const defs = clone.querySelector("defs");
    const ids = new Set([...clone.querySelectorAll("use")].map((u) => (u.getAttribute("href") || "").slice(1)).filter(Boolean));
    ids.forEach((id) => { const sym = document.getElementById(id); if (sym) defs.appendChild(sym.cloneNode(true)); });
    clone.setAttribute("xmlns", SVG_NS);
    clone.setAttribute("width", W);
    clone.setAttribute("height", H);
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", W);
    bg.setAttribute("height", H);
    bg.setAttribute("fill", theme.bg);
    clone.insertBefore(bg, clone.firstChild);
    const caption = document.createElementNS(SVG_NS, "text");
    caption.setAttribute("x", W - 12);
    caption.setAttribute("y", H - 8);
    caption.setAttribute("text-anchor", "end");
    caption.setAttribute("style", `fill:${theme["text-3"]};font-size:11px;font-family:system-ui,sans-serif`);
    const source = sourceOf(state.datasetId);
    caption.textContent = `${ds.meta.name} · data from ${source.name}, ${new Date(source.fetchedAt).toISOString().slice(0, 10)}`;
    clone.appendChild(caption);

    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    await img.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = H * scale;
    const c2d = canvas.getContext("2d");
    c2d.drawImage(img, 0, 0, W * scale, H * scale);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    download(blob, `pareto-${state.datasetId}-${state.view}.png`);
    toast("PNG saved");
  }

  // ---------- table ----------
  let tableSort = { key: "cost", dir: 1 };
  function renderTable() {
    const rows = visibleRows();
    const k = tableSort.key, dir = tableSort.dir;
    rows.sort((a, b) => {
      if (a[k] == null || b[k] == null) return (a[k] == null) - (b[k] == null);
      return (typeof a[k] === "number" ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k]))) * dir;
    });
    const cols = [["model", "Model"], ["provider", "Provider"], ["effort", "Effort"], ["score", isIndex() ? "Index" : "Score", "num"], ["cost", ds.meta.costLabel, "num"]];
    if (ds.has.costTotal) cols.push(["costTotal", "Total cost", "num"]);
    if (ds.has.tokens) cols.push(["tokens", "Tokens per task", "num"]);
    if (ds.has.tokensTotal) cols.push(["tokensTotal", "Total tokens", "num"]);
    if (modeOf() === "scatter") cols.push(["frontier", "Frontier"]);
    const cell = (r, key) => {
      if (key === "score") return fmtScore(r.score);
      if (key === "cost" || key === "costTotal") return r[key] == null ? "—" : fmtCost(r[key]);
      if (key === "tokens" || key === "tokensTotal") return r[key] == null ? "—" : fmtTok(r[key]);
      if (key === "frontier") return r.frontier ? "◆ yes" : "";
      return esc(r[key] || "—");
    };
    const table = $("#table");
    table.innerHTML = `<thead><tr>${cols.map(([key, label, cls]) => `<th class="${cls || ""}" data-sort="${key}" aria-sort="${key === k ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(label)}${key === k ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => {
        const name = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.model)}</a>` : esc(r.model);
        return `<tr><td><span class="cell-model">${logoHTML(r.s.custom ? "__custom" : r.s.provider, 16)}${name}</span></td>${cols.slice(1).map(([key, , cls]) => `<td class="${cls || ""}">${cell(r, key)}</td>`).join("")}</tr>`;
      }).join("")}</tbody>`;
    table.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.sort;
      tableSort = { key, dir: tableSort.key === key ? -tableSort.dir : 1 };
      renderTable();
    }));
  }

  load();
})();
