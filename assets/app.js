/* Pareto Frontier Explorer - vanilla JS + d3 v7. */
(() => {
  "use strict";

  const DATA_URL = "data/arc.json";
  const ARC_ORIGIN = "https://arcprize.org";

  // Fixed provider -> categorical slot. Color follows the provider, never rank;
  // shape tells models from the same provider apart.
  const PROVIDER_SLOT = {
    OpenAI: 1, Anthropic: 2, Google: 3, xAI: 4, "Moonshot AI": 5,
    Meta: 6, "Meta AI": 6, DeepSeek: 7, Alibaba: 8,
  };
  const SHAPES = [d3.symbolCircle, d3.symbolSquare, d3.symbolTriangle, d3.symbolDiamond, d3.symbolStar, d3.symbolWye, d3.symbolCross];
  const REFERENCE_PROVIDERS = new Set(["Human"]); // shown if picked, never in frontier or defaults

  const state = {
    data: null,
    datasetId: "v2_Semi_Private",
    scale: "log",
    frontierMode: "visible",
    selected: new Set(),
    search: "",
    sort: "recent",
    custom: [],
    hoverSeries: null,
    transform: d3.zoomIdentity,
  };

  let seriesByKey = new Map();
  let ds = null; // derived per-dataset view

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
  const fmtCost = (c) => {
    if (c >= 1000) return "$" + d3.format(",.0f")(c);
    if (c >= 100) return "$" + c.toFixed(0);
    if (c >= 1) return "$" + c.toFixed(2);
    if (c >= 0.01) return "$" + c.toFixed(3);
    return "$" + c.toPrecision(2);
  };
  const fmtTick = (v) => {
    if (v >= 1000) return "$" + d3.format("~s")(v).replace("G", "B");
    return "$" + (+v.toPrecision(3)).toString();
  };
  const fmtDate = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—");
  const relTime = (iso) => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return "just now";
    if (mins < 60) return mins + " min ago";
    const h = Math.round(mins / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const colorOf = (s) => (s.custom ? "var(--text)" : PROVIDER_SLOT[s.provider] ? `var(--s${PROVIDER_SLOT[s.provider]})` : "var(--s-other)");
  const symbolPath = (s, size = 64) => d3.symbol(s.shape || d3.symbolCircle, size)();

  // ---------- data ----------
  async function load() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.data = await res.json();
    } catch (err) {
      setStatus("Couldn't load leaderboard data (" + err.message + "). Try reloading.", true);
      return;
    }
    prepare();
    readHash();
    buildDatasetSelect();
    selectDataset(state.datasetId, { keepSelection: state.selected.size > 0 });
    bindUI();
    new ResizeObserver(() => render()).observe(chartEl);
  }

  function prepare() {
    const { series, points } = state.data;
    seriesByKey = new Map(series.map((s) => [s.key, { ...s }]));
    // Stable shape per provider, by release order across the whole dataset.
    const byProvider = d3.group([...seriesByKey.values()], (s) => s.provider);
    for (const list of byProvider.values()) {
      list.sort((a, b) => (a.released || "").localeCompare(b.released || "") || a.key.localeCompare(b.key));
      list.forEach((s, i) => (s.shape = SHAPES[i % SHAPES.length]));
    }
    for (const p of points) p.series = seriesByKey.get(p.s);
    const src = $("#source");
    src.innerHTML = `Data: <a href="${esc(state.data.sourceUrl)}" target="_blank" rel="noopener">ARC Prize leaderboard</a>, refreshed automatically every 3 hours`;
  }

  function deriveDataset() {
    const pts = state.data.points.filter((p) => p.d === state.datasetId);
    const groups = d3.group(pts, (p) => p.s);
    const list = [];
    for (const [key, ps] of groups) {
      const s = seriesByKey.get(key);
      ps.sort((a, b) => a.cost - b.cost);
      const best = ps.reduce((m, p) => (p.score > m.score || (p.score === m.score && p.cost < m.cost) ? p : m), ps[0]);
      const view = { ...s, ref: REFERENCE_PROVIDERS.has(s.provider), points: ps, best, minCost: ps[0].cost };
      for (const p of ps) p.series = view;
      list.push(view);
    }
    const meta = state.data.datasets.find((d) => d.id === state.datasetId) || { name: state.datasetId, costLabel: "Cost" };
    const all = list.filter((s) => !s.ref).flatMap((s) => s.points);
    const globalFrontier = paretoFrontier(all);
    const frontierKeys = new Set(globalFrontier.map((p) => p.s));
    ds = { meta, series: list, byKey: new Map(list.map((s) => [s.key, s])), globalFrontier, frontierKeys };
  }

  // Points sorted by cost; keep each one that beats every cheaper point.
  function paretoFrontier(points) {
    const sorted = [...points].sort((a, b) => a.cost - b.cost || b.score - a.score);
    const out = [];
    let best = -Infinity;
    for (const p of sorted) {
      if (p.score > best) {
        out.push(p);
        best = p.score;
      }
    }
    return out;
  }

  // ---------- presets ----------
  function preset(name) {
    const eligible = ds.series.filter((s) => !s.ref);
    const recent = [...eligible].sort((a, b) => (b.released || "").localeCompare(a.released || ""));
    let keys = [];
    if (name === "all") keys = ds.series.map((s) => s.key);
    else if (name === "none") keys = [];
    else if (name === "frontier") keys = [...ds.frontierKeys];
    else if (name === "recent") keys = recent.slice(0, 12).map((s) => s.key);
    else {
      // Recommended: frontier models plus the newest releases, capped for legibility.
      const set = new Set(recent.slice(0, 8).map((s) => s.key));
      const frontierByRecency = recent.filter((s) => ds.frontierKeys.has(s.key));
      for (const s of frontierByRecency) {
        if (set.size >= 12) break;
        set.add(s.key);
      }
      keys = [...set];
    }
    state.selected = new Set(keys);
  }

  function selectDataset(id, { keepSelection = false } = {}) {
    if (!state.data.datasets.some((d) => d.id === id)) id = state.data.datasets.find((d) => d.id === "v2_Semi_Private")?.id || state.data.datasets[0].id;
    state.datasetId = id;
    $("#dataset").value = id;
    deriveDataset();
    const carried = [...state.selected].filter((k) => ds.byKey.has(k));
    if (keepSelection && carried.length) state.selected = new Set(carried);
    else preset("default");
    state.transform = d3.zoomIdentity;
    if (zoomBehavior && svg) svg.call(zoomBehavior.transform, d3.zoomIdentity);
    update();
  }

  // ---------- URL state ----------
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("d")) state.datasetId = h.get("d");
    if (h.get("x") === "linear") state.scale = "linear";
    if (["visible", "all", "off"].includes(h.get("f"))) state.frontierMode = h.get("f");
    if (h.get("m")) state.selected = new Set(h.get("m").split(",").filter(Boolean));
    if (h.get("c")) {
      state.custom = h.get("c").split("|").map((t) => {
        const [name, cost, score] = t.split("~");
        return { name, cost: +cost, score: +score / 100 };
      }).filter((c) => c.name && c.cost > 0 && c.score >= 0).slice(0, 20);
    }
  }
  function writeHash() {
    const h = new URLSearchParams();
    h.set("d", state.datasetId);
    if (state.scale !== "log") h.set("x", state.scale);
    if (state.frontierMode !== "visible") h.set("f", state.frontierMode);
    h.set("m", [...state.selected].join(","));
    if (state.custom.length) h.set("c", state.custom.map((c) => [c.name.replace(/[~|]/g, " "), c.cost, +(c.score * 100).toFixed(3)].join("~")).join("|"));
    history.replaceState(null, "", "#" + h.toString());
  }

  // ---------- UI ----------
  function buildDatasetSelect() {
    const order = ["v2_Semi_Private", "v1_Semi_Private", "v3_Semi_Private"];
    const sorted = [...state.data.datasets].sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });
    $("#dataset").innerHTML = sorted.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("");
  }

  function bindUI() {
    $("#dataset").addEventListener("change", (e) => selectDataset(e.target.value, { keepSelection: true }));
    document.querySelectorAll("[data-scale]").forEach((b) => b.addEventListener("click", () => {
      state.scale = b.dataset.scale;
      state.transform = d3.zoomIdentity;
      svg && svg.call(zoomBehavior.transform, d3.zoomIdentity);
      update();
    }));
    document.querySelectorAll("[data-frontier]").forEach((b) => b.addEventListener("click", () => {
      state.frontierMode = b.dataset.frontier;
      update();
    }));
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      preset(b.dataset.preset);
      update();
    }));
    $("#search").addEventListener("input", (e) => { state.search = e.target.value.trim().toLowerCase(); renderList(); });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    $("#theme").addEventListener("click", () => {
      const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
      const next = dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch {}
    });
    $("#share").addEventListener("click", async () => {
      writeHash();
      try {
        await navigator.clipboard.writeText(location.href);
        flash($("#share"), "Copied");
      } catch {
        flash($("#share"), "Copy failed");
      }
    });
    $("#reset-zoom").addEventListener("click", () => svg.transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity));
    $("#model-list").addEventListener("change", (e) => {
      const key = e.target.dataset.key;
      if (!key) return;
      e.target.checked ? state.selected.add(key) : state.selected.delete(key);
      update({ keepList: true });
    });
    $("#model-list").addEventListener("click", (e) => {
      const prov = e.target.dataset.provAll;
      if (prov == null) return;
      const keys = visibleListSeries().filter((s) => s.provider === prov).map((s) => s.key);
      const allOn = keys.every((k) => state.selected.has(k));
      keys.forEach((k) => (allOn ? state.selected.delete(k) : state.selected.add(k)));
      update();
    });
    $("#model-list").addEventListener("pointerover", (e) => {
      const row = e.target.closest(".model-row");
      setHover(row && state.selected.has(row.dataset.key) ? row.dataset.key : null);
    });
    $("#model-list").addEventListener("pointerleave", () => setHover(null));
    $("#custom-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const c = { name: String(f.get("name")).trim().slice(0, 40), cost: +f.get("cost"), score: +f.get("score") / 100 };
      if (!c.name || !(c.cost > 0) || !(c.score >= 0 && c.score <= 1)) return;
      state.custom.push(c);
      e.target.reset();
      update();
    });
    $("#custom-list").addEventListener("click", (e) => {
      const i = e.target.dataset.rm;
      if (i == null) return;
      state.custom.splice(+i, 1);
      update();
    });
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1400);
  }

  function setStatus(text, isError = false) {
    const el = $("#status");
    el.textContent = text;
    el.classList.toggle("error", isError);
  }

  function update({ keepList = false } = {}) {
    document.querySelectorAll("[data-scale]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.scale === state.scale));
    document.querySelectorAll("[data-frontier]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.frontier === state.frontierMode));
    const n = [...state.selected].filter((k) => ds.byKey.has(k)).length;
    $("#count").textContent = `${n} of ${ds.series.length}`;
    const fetched = state.data.fetchedAt ? `data fetched ${relTime(state.data.fetchedAt)}` : "";
    setStatus(`${ds.meta.name} · ${n} model${n === 1 ? "" : "s"} shown · ${fetched}`);
    if (!keepList) renderList();
    else syncListChecks();
    renderCustomList();
    render();
    renderTable();
    writeHash();
  }

  function visibleListSeries() {
    const q = state.search;
    return ds.series.filter((s) => !q || s.name.toLowerCase().includes(q) || s.provider.toLowerCase().includes(q));
  }

  function renderList() {
    const list = visibleListSeries();
    const cmp = {
      recent: (a, b) => (b.released || "").localeCompare(a.released || "") || a.name.localeCompare(b.name),
      score: (a, b) => b.best.score - a.best.score,
      cost: (a, b) => a.minCost - b.minCost,
      name: (a, b) => a.name.localeCompare(b.name),
    }[state.sort];
    const groups = d3.groups(list, (s) => s.provider)
      .map(([prov, items]) => [prov, items.sort(cmp)])
      .sort((a, b) => cmp(a[1][0], b[1][0]));
    const ul = $("#model-list");
    if (!list.length) {
      ul.innerHTML = `<li class="empty">No models match “${esc(state.search)}”.</li>`;
      return;
    }
    ul.innerHTML = groups.map(([prov, items]) => {
      const allOn = items.every((s) => state.selected.has(s.key));
      return `<li class="prov-head"><span>${esc(state.data.providers[prov]?.name || prov)}</span><button type="button" data-prov-all="${esc(prov)}">${allOn ? "none" : "all"}</button></li>` +
        items.map((s) => `<li class="model-row" data-key="${esc(s.key)}"><label title="${esc(s.name)} · released ${esc(fmtDate(s.released))}">
          <input type="checkbox" data-key="${esc(s.key)}" ${state.selected.has(s.key) ? "checked" : ""} />
          <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><path d="${symbolPath(s, 56)}" style="fill:${colorOf(s)}"/></svg>
          <span class="nm">${esc(s.name)}</span>
          <span class="meta">${fmtPct(s.best.score)}</span>
        </label></li>`).join("");
    }).join("");
  }
  function syncListChecks() {
    document.querySelectorAll("#model-list input[data-key]").forEach((i) => (i.checked = state.selected.has(i.dataset.key)));
    document.querySelectorAll("#model-list [data-prov-all]").forEach((b) => {
      const keys = visibleListSeries().filter((s) => s.provider === b.dataset.provAll).map((s) => s.key);
      b.textContent = keys.every((k) => state.selected.has(k)) ? "none" : "all";
    });
  }
  function renderCustomList() {
    $("#custom-list").innerHTML = state.custom.map((c, i) =>
      `<li><span>${esc(c.name)} — ${fmtPct(c.score)} @ ${fmtCost(c.cost)}</span><button type="button" data-rm="${i}" aria-label="Remove ${esc(c.name)}">✕</button></li>`).join("");
  }

  // ---------- chart ----------
  let svg, zoomBehavior, gRoot, layers;
  let lastScreenPts = [];
  let delaunay = null;

  function ensureSvg() {
    if (svg) return;
    svg = d3.select(chartEl).append("svg").attr("role", "img").attr("aria-label", "Score versus cost scatter with Pareto frontier");
    const defs = svg.append("defs");
    defs.append("clipPath").attr("id", "plot-clip").append("rect");
    gRoot = svg.append("g");
    layers = {
      gridY: gRoot.append("g").attr("class", "grid grid-y"),
      gridX: gRoot.append("g").attr("class", "grid grid-x"),
      axisX: gRoot.append("g").attr("class", "axis axis-x"),
      axisY: gRoot.append("g").attr("class", "axis axis-y"),
      titleX: gRoot.append("text").attr("class", "axis-title").attr("text-anchor", "middle"),
      titleY: gRoot.append("text").attr("class", "axis-title").attr("text-anchor", "middle"),
      leaders: gRoot.append("g").attr("class", "leaders"),
      plot: gRoot.append("g").attr("clip-path", "url(#plot-clip)"),
      labels: gRoot.append("g").attr("class", "labels"),
      hit: gRoot.append("rect").attr("fill", "transparent"),
    };
    layers.frontierArea = layers.plot.append("path").attr("class", "frontier-area");
    layers.frontier = layers.plot.append("path").attr("class", "frontier-line");
    layers.lines = layers.plot.append("g");
    layers.rings = layers.plot.append("g");
    layers.points = layers.plot.append("g");
    layers.custom = layers.plot.append("g");
    layers.hover = layers.plot.append("path").attr("class", "hover-ring").style("display", "none");

    zoomBehavior = d3.zoom()
      .scaleExtent([0.5, 60])
      .on("zoom", (e) => {
        state.transform = e.transform;
        $("#reset-zoom").hidden = e.transform.k === 1 && e.transform.x === 0 && e.transform.y === 0;
        hideTooltip();
        render();
      });
    svg.call(zoomBehavior).on("dblclick.zoom", null);
    svg.on("dblclick", () => svg.transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity));
    svg.on("pointermove", onPointerMove).on("pointerleave", () => { hideTooltip(); setHover(null); });
  }

  function currentSeries() {
    return ds.series.filter((s) => state.selected.has(s.key));
  }
  function customPoints() {
    return state.custom.map((c, i) => ({
      d: state.datasetId, s: "custom:" + i, id: "custom:" + i, effort: "", score: c.score, cost: c.cost,
      series: { key: "custom:" + i, name: c.name, provider: "Your point", custom: true, shape: d3.symbolDiamond },
    }));
  }
  function frontierPool() {
    if (state.frontierMode === "off") return [];
    const base = state.frontierMode === "all"
      ? ds.series.filter((s) => !s.ref).flatMap((s) => s.points)
      : currentSeries().filter((s) => !s.ref).flatMap((s) => s.points);
    return paretoFrontier(base.concat(customPoints()));
  }

  function logTicks(domain) {
    const [lo, hi] = domain;
    const out = [];
    for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)) + 1; e++) {
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, e);
        if (v >= lo * 0.999 && v <= hi * 1.001) out.push(+v.toPrecision(3));
      }
    }
    return out.length > 14 ? out.filter((v) => /^1|^5/.test(v.toExponential())) : out;
  }

  function render() {
    if (!ds) return;
    ensureSvg();
    const W = chartEl.clientWidth, H = chartEl.clientHeight;
    if (!W || !H) return;
    const series = currentSeries();
    const custom = customPoints();
    const showLabels = W >= 640;

    // Measure the label gutter from the longest visible name.
    const longest = d3.max(series, (s) => s.name.length) || 8;
    const gutter = showLabels ? Math.min(230, Math.max(110, longest * 7.4 + 34)) : 12;
    const m = { top: 16, right: gutter, bottom: 46, left: 56 };
    const iw = Math.max(50, W - m.left - m.right), ih = Math.max(50, H - m.top - m.bottom);

    svg.attr("viewBox", `0 0 ${W} ${H}`);
    gRoot.attr("transform", `translate(${m.left},${m.top})`);
    svg.select("#plot-clip rect").attr("x", -8).attr("y", -8).attr("width", iw + 16).attr("height", ih + 16);
    layers.hit.attr("width", iw).attr("height", ih).lower();
    zoomBehavior.extent([[0, 0], [iw, ih]]).translateExtent([[-iw * 2, -ih * 2], [iw * 3, ih * 3]]);

    const allPts = series.flatMap((s) => s.points).concat(custom);
    const costs = allPts.length ? d3.extent(allPts, (p) => p.cost) : [0.01, 10];
    const maxScore = allPts.length ? d3.max(allPts, (p) => p.score) : 1;

    const x0 = state.scale === "log"
      ? d3.scaleLog().domain([costs[0] / 1.6, costs[1] * 1.6]).range([0, iw])
      : d3.scaleLinear().domain([0, costs[1] * 1.08]).range([0, iw]);
    const yMax = Math.min(1, Math.ceil((maxScore * 1.06) * 10) / 10) || 1;
    const y0 = d3.scaleLinear().domain([0, Math.max(yMax, maxScore * 1.04)]).range([ih, 0]);
    const x = state.transform.rescaleX(x0);
    const y = state.transform.rescaleY(y0);

    // Axes + grid
    const xTicks = state.scale === "log" ? logTicks(x.domain()) : x.ticks(Math.max(3, Math.floor(iw / 90)));
    layers.axisX.attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(xTicks).tickFormat(fmtTick).tickSizeOuter(0).tickPadding(8));
    layers.axisY.call(d3.axisLeft(y).ticks(Math.max(3, Math.floor(ih / 70))).tickFormat((v) => d3.format(".0~%")(v)).tickSize(0).tickPadding(10));
    layers.axisY.select(".domain").remove();
    layers.gridY.call(d3.axisLeft(y).ticks(Math.max(3, Math.floor(ih / 70))).tickSize(-iw).tickFormat(""));
    layers.gridX.attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(xTicks).tickSize(-ih).tickFormat("")).style("opacity", 0.6);
    layers.titleX.attr("x", iw / 2).attr("y", ih + 40).text(`${ds.meta.costLabel} (USD, ${state.scale === "log" ? "log scale" : "linear"})`);
    layers.titleY.attr("transform", `translate(${-44},${ih / 2}) rotate(-90)`).text(`${ds.meta.name} score`);

    // Frontier
    const frontier = frontierPool();
    const fSet = new Set(frontier);
    if (frontier.length) {
      const fp = frontier.map((p) => [x(p.cost), y(p.score)]);
      fp.push([iw + 20, fp[fp.length - 1][1]]);
      layers.frontier.attr("d", d3.line().curve(d3.curveStepAfter)(fp)).style("display", null);
      layers.frontierArea.attr("d", d3.area().curve(d3.curveStepAfter).y0(ih + 20)(fp)).style("display", null);
    } else {
      layers.frontier.style("display", "none");
      layers.frontierArea.style("display", "none");
    }

    // Series lines and points
    const line = d3.line().x((p) => x(p.cost)).y((p) => y(p.score));
    layers.lines.selectAll("path").data(series, (s) => s.key).join("path")
      .attr("class", "series-line")
      .attr("d", (s) => line(s.points))
      .style("stroke", colorOf)
      .style("stroke-dasharray", (s) => (s.ref ? "4 4" : null));

    const ptsData = series.flatMap((s) => s.points);
    layers.points.selectAll("path").data(ptsData, (p) => p.s + "|" + p.id).join("path")
      .attr("class", "pt")
      .attr("d", (p) => symbolPath(p.series, 70))
      .attr("transform", (p) => `translate(${x(p.cost)},${y(p.score)})`)
      .style("fill", (p) => colorOf(p.series));

    layers.rings.selectAll("circle").data(frontier.filter((p) => !p.series.custom), (p) => p.s + "|" + p.id).join("circle")
      .attr("class", "frontier-ring").attr("r", 8.5)
      .attr("cx", (p) => x(p.cost)).attr("cy", (p) => y(p.score));

    layers.custom.selectAll("path").data(custom, (p) => p.id).join("path")
      .attr("class", "custom-pt")
      .attr("d", (p) => symbolPath(p.series, 120))
      .attr("transform", (p) => `translate(${x(p.cost)},${y(p.score)})`);

    // Right-gutter labels with leader lines, like a slope chart's end labels.
    renderLabels(showLabels ? series.concat(custom.map((p) => ({ ...p.series, best: p, points: [p] }))) : [], x, y, iw, ih, fSet);

    // Hover index
    lastScreenPts = ptsData.concat(custom).map((p) => ({ p, sx: x(p.cost), sy: y(p.score) }))
      .filter((d) => d.sx >= -4 && d.sx <= iw + 4 && d.sy >= -4 && d.sy <= ih + 4);
    delaunay = d3.Delaunay.from(lastScreenPts, (d) => d.sx, (d) => d.sy);
    render.ctx = { m, iw, ih, frontier, fSet };
    applyHover();

    if (!series.length && !custom.length) setStatus(`${ds.meta.name} · no models selected — pick some from the list`);
  }

  function renderLabels(series, x, y, iw, ih, fSet) {
    const LH = 18;
    let items = series.map((s) => {
      const ax = x(s.best.cost), ay = y(s.best.score);
      const inView = ax >= 0 && ax <= iw && ay >= 0 && ay <= ih;
      return { s, ax, ay, inView, target: Math.max(0, Math.min(ih, ay)), onFrontier: s.points.some((p) => fSet.has(p)) };
    });
    const maxFit = Math.floor(ih / LH) + 1;
    if (items.length > maxFit) {
      // Too many to label legibly: keep frontier models, then the best scorers.
      items.sort((a, b) => (b.onFrontier - a.onFrontier) || b.s.best.score - a.s.best.score);
      items = items.slice(0, maxFit);
    }
    items.sort((a, b) => a.target - b.target);
    let prev = -Infinity;
    for (const it of items) { it.ly = Math.max(it.target, prev + LH); prev = it.ly; }
    let bound = ih + 4;
    for (let i = items.length - 1; i >= 0; i--) {
      items[i].ly = Math.min(items[i].ly, bound);
      bound = items[i].ly - LH;
    }

    const gx = iw + 16;
    layers.leaders.selectAll("path").data(items, (d) => d.s.key).join("path")
      .attr("class", "leader")
      .attr("data-key", (d) => d.s.key)
      .attr("d", (d) => (d.inView ? `M${d.ax + 8},${d.ay}L${iw},${d.ay}L${gx - 4},${d.ly}` : null));

    const g = layers.labels.selectAll("g.lbl").data(items, (d) => d.s.key).join((enter) => {
      const e = enter.append("g").attr("class", "lbl");
      e.append("path").attr("class", "lbl-dot");
      e.append("text").attr("dy", "0.35em").attr("x", 12);
      e.append("title");
      return e;
    });
    g.attr("transform", (d) => `translate(${gx},${d.ly})`)
      .attr("data-key", (d) => d.s.key)
      .style("opacity", (d) => (d.inView ? null : 0.55));
    g.select("path").attr("d", (d) => symbolPath(d.s, 48)).style("fill", (d) => colorOf(d.s));
    g.select("text").text((d) => d.s.name);
    g.select("title").text((d) => (d.s.custom ? "Your point" : `${d.s.name} — click to remove`));
    g.on("pointerenter", (e, d) => setHover(d.s.key))
      .on("pointerleave", () => setHover(null))
      .on("click", (e, d) => {
        if (d.s.custom) return;
        state.selected.delete(d.s.key);
        setHover(null);
        update({ keepList: true });
      });
  }

  // ---------- hover ----------
  function setHover(key) {
    state.hoverSeries = key;
    applyHover();
  }
  function applyHover() {
    const k = state.hoverSeries;
    if (!layers) return;
    layers.lines.selectAll("path").classed("dim", (s) => k && s.key !== k);
    layers.points.selectAll("path").classed("dim", (p) => k && p.s !== k);
    layers.rings.selectAll("circle").classed("dim", (p) => k && p.s !== k);
    layers.labels.selectAll("g.lbl").classed("dim", (d) => k && d.s.key !== k).classed("hl", (d) => d.s.key === k);
    layers.leaders.selectAll("path").classed("dim", (d) => k && d.s.key !== k);
    document.querySelectorAll("#model-list .model-row").forEach((r) => r.classList.toggle("hl", r.dataset.key === k));
  }

  function onPointerMove(e) {
    if (!delaunay || !lastScreenPts.length || e.buttons) return;
    const { m } = render.ctx;
    const [px, py] = d3.pointer(e, gRoot.node());
    const i = delaunay.find(px, py);
    const hit = lastScreenPts[i];
    if (!hit || Math.hypot(hit.sx - px, hit.sy - py) > 28) {
      hideTooltip();
      if (!e.target.closest || !e.target.closest(".lbl")) setHover(null);
      return;
    }
    setHover(hit.p.series.custom ? null : hit.p.s);
    layers.hover.style("display", null).attr("d", d3.symbol(d3.symbolCircle, 260)()).attr("transform", `translate(${hit.sx},${hit.sy})`);
    showTooltip(hit, m);
  }

  function showTooltip(hit, m) {
    const { p } = hit;
    const s = p.series;
    const { frontier, fSet } = render.ctx;
    let flag = "";
    if (state.frontierMode !== "off" && !s.ref) {
      if (fSet.has(p)) flag = "◆ On the Pareto frontier";
      else {
        const dom = frontier.filter((f) => f.cost <= p.cost && f.score >= p.score).sort((a, b) => b.score - a.score)[0];
        if (dom) flag = `Dominated by ${esc(dom.series.name)}${dom.effort ? " (" + esc(dom.effort) + ")" : ""}: ${fmtPct(dom.score)} for ${fmtCost(dom.cost)}`;
      }
    }
    const provName = s.custom ? "Your point" : state.data.providers[s.provider]?.name || s.provider;
    tooltip.innerHTML = `
      <div class="tt-name"><span class="tt-sw" style="background:${colorOf(s)}"></span>${esc(s.name)}</div>
      <div class="tt-sub">${esc(provName)}${p.effort ? " · " + esc(p.effort) + " effort" : ""}</div>
      <dl>
        <dt>Score</dt><dd>${fmtPct(p.score)}</dd>
        <dt>${esc(ds.meta.costLabel)}</dt><dd>${fmtCost(p.cost)}</dd>
        ${s.released ? `<dt>Released</dt><dd>${fmtDate(s.released)}</dd>` : ""}
        ${!s.custom && p.score > 0 ? `<dt>$ per point</dt><dd>${fmtCost(p.cost / (p.score * 100))}</dd>` : ""}
      </dl>
      ${flag ? `<div class="tt-flag">${flag}</div>` : ""}
      ${p.note ? `<div class="tt-note">${esc(p.note.length > 220 ? p.note.slice(0, 217) + "…" : p.note)}</div>` : ""}`;
    tooltip.hidden = false;
    const card = chartEl.parentElement.getBoundingClientRect();
    const chartBox = chartEl.getBoundingClientRect();
    const ax = chartBox.left - card.left + m.left + hit.sx;
    const ay = chartBox.top - card.top + m.top + hit.sy;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let left = ax + 16, top = ay - th / 2;
    if (left + tw > card.width - 8) left = ax - tw - 16;
    top = Math.max(8, Math.min(card.height - th - 8, top));
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }
  function hideTooltip() {
    tooltip.hidden = true;
    layers && layers.hover.style("display", "none");
  }

  // ---------- table ----------
  let tableSort = { key: "cost", dir: 1 };
  function renderTable() {
    const fSet = new Set(frontierPool());
    const rows = currentSeries().flatMap((s) => s.points.map((p) => ({
      model: s.name, provider: state.data.providers[s.provider]?.name || s.provider, effort: p.effort || "—",
      score: p.score, cost: p.cost, frontier: fSet.has(p), url: p.url,
    }))).concat(customPoints().map((p) => ({ model: p.series.name, provider: "Your point", effort: "—", score: p.score, cost: p.cost, frontier: fSet.has(p) })));
    const k = tableSort.key, dir = tableSort.dir;
    rows.sort((a, b) => (typeof a[k] === "number" ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k]))) * dir);
    const cols = [["model", "Model"], ["provider", "Provider"], ["effort", "Effort"], ["score", "Score", "num"], ["cost", ds.meta.costLabel, "num"], ["frontier", "Frontier"]];
    $("#table").innerHTML = `<thead><tr>${cols.map(([key, label, cls]) => `<th class="${cls || ""}" data-sort="${key}" aria-sort="${key === k ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(label)}${key === k ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${r.url ? `<a href="${ARC_ORIGIN}${esc(r.url)}" target="_blank" rel="noopener">${esc(r.model)}</a>` : esc(r.model)}</td><td>${esc(r.provider)}</td><td>${esc(r.effort)}</td><td class="num">${fmtPct(r.score)}</td><td class="num">${fmtCost(r.cost)}</td><td>${r.frontier ? "◆ yes" : ""}</td></tr>`).join("")}</tbody>`;
    $("#table").querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.sort;
      tableSort = { key, dir: tableSort.key === key ? -tableSort.dir : 1 };
      renderTable();
    }));
  }

  load();
})();
