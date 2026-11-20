/* Pareto Frontier Explorer - vanilla JS + d3 v7. */
(() => {
  "use strict";

  const DATA_URL = "data/arc.json";
  const LOGO_URL = "assets/logos.svg";
  const ARC_ORIGIN = "https://arcprize.org";
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Fixed provider -> categorical slot. Color follows the provider, never rank.
  // Models from one provider get tints of that hue, and the logo carries identity.
  const PROVIDER_SLOT = {
    OpenAI: 1, Anthropic: 2, Google: 3, xAI: 4, "Moonshot AI": 5,
    Meta: 6, "Meta AI": 6, DeepSeek: 7, Alibaba: 8,
  };
  const PROVIDER_LOGO = {
    OpenAI: "openai", Anthropic: "anthropic", Google: "google-color", xAI: "xai",
    DeepSeek: "deepseek-color", "Moonshot AI": "kimi-color", Alibaba: "qwen-color",
    Meta: "meta-color", "Meta AI": "meta-color", Mistral: "mistral-color",
    Minimax: "minimax-color", "Z.ai": "zai", NVIDIA: "nvidia-color",
    Reflection: "reflection", Inception: "inception", "Dots Studio": "dotsstudio",
    Human: "human",
  };
  const TINTS = [0, 15, -14, 27, -24, 8, -7, 21];
  const REFERENCE_PROVIDERS = new Set(["Human"]); // shown if picked, never in frontier or defaults
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    data: null,
    datasetId: "v2_Semi_Private",
    scale: "log",
    frontierMode: "visible",
    releasedDays: 0,
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

  // ---------- theme + color ----------
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s-other", "text", "text-2", "text-3", "surface", "surface-3"]) {
      theme[k] = cs.getPropertyValue("--" + k).trim();
    }
    theme.dark = cs.colorScheme.includes("dark");
    colorCache.clear();
    const btn = $("#theme");
    btn.innerHTML = theme.dark
      ? `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" fill="currentColor"/></svg>`;
    btn.setAttribute("aria-label", theme.dark ? "Switch to light theme" : "Switch to dark theme");
  }

  function seriesColor(s) {
    if (s.custom) return theme.text;
    let c = colorCache.get(s.key);
    if (c) return c;
    const slot = PROVIDER_SLOT[s.provider];
    const hcl = d3.hcl(slot ? theme["s" + slot] : theme["s-other"]);
    hcl.l = Math.max(30, Math.min(86, hcl.l + TINTS[(s.tint || 0) % TINTS.length]));
    c = hcl.formatHex();
    colorCache.set(s.key, c);
    return c;
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
      g.append("circle").attr("r", size / 2).style("fill", theme["surface-3"]);
      g.append("text").attr("text-anchor", "middle").attr("dy", "0.35em")
        .style("font-size", (provider === "__custom" ? size * 0.7 : size * 0.42) + "px").style("font-weight", 700).style("fill", theme["text-2"])
        .text(provider === "__custom" ? "+" : initials(provider));
    }
  }

  // ---------- data ----------
  async function load() {
    readTheme();
    try {
      const [data, logos] = await Promise.all([
        fetch(DATA_URL, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
        fetch(LOGO_URL).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
        Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]),
      ]);
      state.data = data;
      const sprite = $("#logo-sprite");
      sprite.innerHTML = logos;
      sprite.hidden = false;
      const svgEl = sprite.querySelector("svg");
      if (svgEl) svgEl.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    } catch (err) {
      setStatus("Couldn't load leaderboard data (" + err.message + "). Try reloading.", true);
      return;
    }
    prepare();
    readHash();
    buildDatasetSelect();
    bindUI();
    selectDataset(state.datasetId, { keepSelection: state.selected.size > 0 });
    let first = true;
    new ResizeObserver(() => { if (first) { first = false; return; } render(); }).observe(chartEl);
    const onTheme = () => {
      readTheme();
      layers?.labels.selectAll(".lbl-logo").attr("data-prov", null);
      renderList();
      render();
      renderTable();
    };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
    new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  function prepare() {
    const { series, points } = state.data;
    seriesByKey = new Map(series.map((s) => [s.key, { ...s }]));
    // Newest model in each provider gets the base hue; older ones get tints.
    for (const list of d3.group([...seriesByKey.values()], (s) => s.provider).values()) {
      list.sort((a, b) => (b.released || "").localeCompare(a.released || "") || a.key.localeCompare(b.key));
      list.forEach((s, i) => (s.tint = i));
    }
    for (const p of points) p.series = seriesByKey.get(p.s);
    $("#source").innerHTML = `Data: <a href="${esc(state.data.sourceUrl)}" target="_blank" rel="noopener">ARC Prize leaderboard</a>, refreshed automatically every 3 hours`;
    const live = $("#live");
    const ageH = (Date.now() - new Date(state.data.fetchedAt).getTime()) / 3.6e6;
    live.hidden = false;
    $("#live-text").textContent = `Live · updated ${relTime(state.data.fetchedAt)}`;
    live.title = `Fetched from arcprize.org ${new Date(state.data.fetchedAt).toLocaleString()}` +
      (state.data.sourceLastModified ? `\nLeaderboard last changed ${new Date(state.data.sourceLastModified).toLocaleString()}` : "");
    if (ageH > 12) live.querySelector(".pulse").style.animation = "none";
  }

  function deriveDataset() {
    const pts = state.data.points.filter((p) => p.d === state.datasetId);
    const cutoff = state.releasedDays ? new Date(Date.now() - state.releasedDays * 864e5).toISOString().slice(0, 10) : null;
    const list = [];
    for (const [key, ps] of d3.group(pts, (p) => p.s)) {
      const s = seriesByKey.get(key);
      if (cutoff && (!s.released || s.released < cutoff)) continue;
      ps.sort((a, b) => a.cost - b.cost);
      const best = ps.reduce((m, p) => (p.score > m.score || (p.score === m.score && p.cost < m.cost) ? p : m), ps[0]);
      const view = { ...s, ref: REFERENCE_PROVIDERS.has(s.provider), points: ps, best, minCost: ps[0].cost };
      for (const p of ps) p.series = view;
      list.push(view);
    }
    const meta = state.data.datasets.find((d) => d.id === state.datasetId) || { name: state.datasetId, costLabel: "Cost" };
    const globalFrontier = paretoFrontier(list.filter((s) => !s.ref).flatMap((s) => s.points));
    ds = { meta, series: list, byKey: new Map(list.map((s) => [s.key, s])), globalFrontier, frontierKeys: new Set(globalFrontier.map((p) => p.s)) };
  }

  // Points sorted by cost; keep each one that beats every cheaper point.
  function paretoFrontier(points) {
    const sorted = [...points].sort((a, b) => a.cost - b.cost || b.score - a.score);
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
    state.datasetId = id;
    $("#dataset").value = id;
    deriveDataset();
    const carried = [...state.selected].filter((k) => ds.byKey.has(k));
    if (keepSelection && carried.length) state.selected = new Set([...state.selected]);
    else preset("default");
    resetZoom(false);
    update({ animate: true });
  }

  // ---------- URL state ----------
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("d")) state.datasetId = h.get("d");
    if (h.get("x") === "linear") state.scale = "linear";
    if (["visible", "all", "off"].includes(h.get("f"))) state.frontierMode = h.get("f");
    if (["365", "182", "91"].includes(h.get("r"))) state.releasedDays = +h.get("r");
    $("#released").value = String(state.releasedDays);
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
    if (state.scale !== "log") h.set("x", state.scale);
    if (state.frontierMode !== "visible") h.set("f", state.frontierMode);
    if (state.releasedDays) h.set("r", state.releasedDays);
    h.set("m", [...state.selected].filter((k) => ds.byKey.has(k)).join(","));
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
    $("#released").addEventListener("change", (e) => {
      state.releasedDays = +e.target.value;
      deriveDataset();
      update({ animate: true });
    });
    document.querySelectorAll("[data-scale]").forEach((b) => b.addEventListener("click", () => {
      if (state.scale === b.dataset.scale) return;
      state.scale = b.dataset.scale;
      resetZoom(false);
      update({ animate: true });
    }));
    document.querySelectorAll("[data-frontier]").forEach((b) => b.addEventListener("click", () => {
      state.frontierMode = b.dataset.frontier;
      update({ animate: true });
    }));
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      preset(b.dataset.preset);
      state.groupOpen.clear();
      update({ animate: true });
    }));
    $("#search").addEventListener("input", (e) => { state.search = e.target.value.trim().toLowerCase(); renderList(); });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    $("#theme").addEventListener("click", () => {
      const next = theme.dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch {}
    });
    $("#share").addEventListener("click", async () => {
      writeHash();
      try { await navigator.clipboard.writeText(location.href); flash($("#share"), "Copied ✓"); }
      catch { flash($("#share"), "Copy failed"); }
    });
    $("#export-png").addEventListener("click", () => exportPNG().catch((err) => { console.error(err); flash($("#export-png"), "Failed"); }));
    $("#export-csv").addEventListener("click", exportCSV);
    $("#reset-zoom").addEventListener("click", () => resetZoom(true));

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

    $("#custom-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const c = { name: String(f.get("name")).trim().slice(0, 40), cost: +f.get("cost"), score: +f.get("score") / 100 };
      if (!c.name || !(c.cost > 0) || !(c.score >= 0 && c.score <= 1)) return;
      state.custom.push(c);
      e.target.reset();
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
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") unpin(); });
    document.addEventListener("pointerdown", (e) => {
      if (state.pinned && !tooltip.contains(e.target) && !chartEl.contains(e.target)) unpin();
    });
  }

  function flash(btn, text) {
    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => (btn.textContent = old), 1400);
  }

  function setStatus(html, isError = false) {
    const el = $("#status");
    el.innerHTML = html;
    el.classList.toggle("error", isError);
  }

  function update({ animate = false } = {}) {
    unpin(false);
    document.querySelectorAll("[data-scale]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.scale === state.scale));
    document.querySelectorAll("[data-frontier]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.frontier === state.frontierMode));
    const shown = currentSeries();
    $("#count").textContent = `${shown.length} of ${ds.series.length} shown`;
    const nPts = shown.reduce((n, s) => n + s.points.length, 0);
    const nFront = frontierPool().length;
    setStatus(`<strong>${esc(ds.meta.name)}</strong> · ${shown.length} model${shown.length === 1 ? "" : "s"} · ${nPts} points` +
      (state.frontierMode !== "off" && nFront ? ` · ${nFront} on the frontier` : ""));
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
    const scroll = ul.scrollTop;
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
      ul.innerHTML = `<li class="empty">${state.search ? `No models match “${esc(state.search)}”.` : "No models released in this period."}</li>`;
      return;
    }
    ul.innerHTML = groups.map(([prov, items]) => {
      const sel = items.filter((s) => state.selected.has(s.key)).length;
      const open = state.search ? true : state.groupOpen.has(prov) ? state.groupOpen.get(prov) : sel > 0;
      return `<li class="prov" data-prov="${esc(prov)}" data-open="${open}">
        <div class="prov-head">
          <button type="button" class="prov-toggle" aria-expanded="${open}">
            <svg class="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${logoHTML(prov, 18)}
            <span class="prov-name">${esc(providerName(prov))}</span>
            <span class="prov-count">${sel}/${items.length}</span>
          </button>
          <button type="button" class="prov-all" data-prov-all="${esc(prov)}">${sel === items.length ? "None" : "All"}</button>
        </div>
        <ul class="prov-models">${items.map(rowHTML).join("")}</ul>
      </li>`;
    }).join("");
    ul.scrollTop = scroll;
    applyHover();
  }
  function rowHTML(s) {
    const on = state.selected.has(s.key);
    return `<li class="model-row${on ? "" : " off"}" data-key="${esc(s.key)}">
      <label title="${esc(s.name)} · ${esc(providerName(s.provider))} · released ${esc(fmtDate(s.released))}">
        <input type="checkbox" data-key="${esc(s.key)}" ${on ? "checked" : ""} />
        <span class="sw" style="background:${seriesColor(s)}"></span>
        <span class="nm"><b>${esc(s.name)}</b><small>${esc(fmtShortDate(s.released))} · from ${fmtCost(s.minCost)}</small></span>
        <span class="meta">${fmtPct(s.best.score)}</span>
      </label>
      <button type="button" class="only" data-only="${esc(s.key)}" title="Show only this model">only</button>
    </li>`;
  }
  function renderCustomList() {
    $("#custom-list").innerHTML = state.custom.map((c, i) =>
      `<li><span>${esc(c.name)} — ${fmtPct(c.score)} @ ${fmtCost(c.cost)}</span><button type="button" data-rm="${i}" aria-label="Remove ${esc(c.name)}">✕</button></li>`).join("");
  }

  // ---------- chart ----------
  let svg, zoomBehavior, gRoot, layers, ctx = null;
  let screenPts = [];
  let delaunay = null;
  const measureCtx = document.createElement("canvas").getContext("2d");
  const textWidth = (t) => { measureCtx.font = '600 13px "DM Sans", system-ui, sans-serif'; return measureCtx.measureText(t).width; };

  function ensureSvg() {
    if (svg) return;
    svg = d3.select(chartEl).append("svg").attr("role", "img").attr("aria-label", "Score versus cost chart with Pareto frontier");
    svg.append("defs").append("clipPath").attr("id", "plot-clip").append("rect");
    gRoot = svg.append("g");
    layers = {
      gridY: gRoot.append("g").attr("class", "grid grid-y"),
      gridX: gRoot.append("g").attr("class", "grid grid-x"),
      axisX: gRoot.append("g").attr("class", "axis axis-x"),
      axisY: gRoot.append("g").attr("class", "axis axis-y"),
      titleX: gRoot.append("text").attr("class", "axis-title").attr("text-anchor", "middle"),
      titleY: gRoot.append("text").attr("class", "axis-title").attr("text-anchor", "middle"),
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

    zoomBehavior = d3.zoom()
      .scaleExtent([0.5, 80])
      .on("start", (e) => { if (e.sourceEvent) unpin(); })
      .on("zoom", (e) => {
        state.transform = e.transform;
        $("#reset-zoom").hidden = e.transform.k === 1 && e.transform.x === 0 && e.transform.y === 0;
        state.hoverPoint = null;
        hideTooltip();
        render();
      });
    svg.call(zoomBehavior).on("dblclick.zoom", null);
    svg.on("dblclick", () => resetZoom(true));
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

  function render({ animate = false } = {}) {
    if (!ds) return;
    ensureSvg();
    const W = chartEl.clientWidth, H = chartEl.clientHeight;
    if (!W || !H) return;
    const T = animate && !reducedMotion ? svg.transition().duration(420).ease(d3.easeCubicOut) : null;
    const tr = (sel) => (T ? sel.transition(T) : sel.interrupt());

    const series = currentSeries();
    const custom = customPoints();
    const labelMode = W >= 720 ? "full" : "logo";

    // Gutter for end labels, sized to the longest visible name.
    const longest = d3.max(series.concat(custom.map((p) => p.series)), (s) => textWidth(s.name)) || 60;
    const gutter = labelMode === "full" ? Math.min(250, Math.max(130, 18 + 30 + longest + 10)) : 46;
    const m = { top: 22, right: gutter, bottom: 50, left: 60 };
    const iw = Math.max(50, W - m.left - m.right), ih = Math.max(50, H - m.top - m.bottom);

    svg.attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
    gRoot.attr("transform", `translate(${m.left},${m.top})`);
    svg.select("#plot-clip rect").attr("x", -10).attr("y", -10).attr("width", iw + 20).attr("height", ih + 20);
    zoomBehavior.extent([[0, 0], [iw, ih]]).translateExtent([[-iw * 3, -ih * 3], [iw * 4, ih * 4]]);

    const allPts = series.flatMap((s) => s.points).concat(custom);
    const costs = allPts.length ? d3.extent(allPts, (p) => p.cost) : [0.01, 10];
    const maxScore = allPts.length ? d3.max(allPts, (p) => p.score) : 1;

    const x0 = state.scale === "log"
      ? d3.scaleLog().domain([costs[0] / 1.5, costs[1] * 1.5]).range([0, iw])
      : d3.scaleLinear().domain([0, costs[1] * 1.06]).range([0, iw]);
    const top = Math.max(Math.min(1, Math.ceil(maxScore * 1.05 * 10) / 10), maxScore * 1.04) || 1;
    const y0 = d3.scaleLinear().domain([0, top]).range([ih, 0]);
    const x = state.transform.rescaleX(x0);
    const y = state.transform.rescaleY(y0);

    // Axes + grid
    const xTicks = state.scale === "log" ? logTicks(x.domain()) : x.ticks(Math.max(3, Math.floor(iw / 100)));
    const yTicks = y.ticks(Math.max(3, Math.floor(ih / 70)));
    tr(layers.axisX.attr("transform", `translate(0,${ih})`)).call(d3.axisBottom(x).tickValues(xTicks).tickFormat(fmtTick).tickSizeOuter(0).tickSize(5).tickPadding(8));
    tr(layers.axisY).call(d3.axisLeft(y).tickValues(yTicks).tickFormat((v) => d3.format(".0~%")(v)).tickSize(0).tickPadding(12));
    layers.axisY.select(".domain").remove();
    tr(layers.gridY).call(d3.axisLeft(y).tickValues(yTicks).tickSize(-iw).tickFormat(""));
    tr(layers.gridX.attr("transform", `translate(0,${ih})`)).call(d3.axisBottom(x).tickValues(xTicks).tickSize(-ih).tickFormat(""));
    layers.titleX.attr("x", iw / 2).attr("y", ih + 42).text(`${ds.meta.costLabel} (USD, ${state.scale === "log" ? "log scale" : "linear"})`);
    layers.titleY.attr("transform", `translate(${-46},${ih / 2}) rotate(-90)`).text(`${ds.meta.name} score`);

    // Frontier staircase
    const frontier = frontierPool();
    const fSet = new Set(frontier);
    if (frontier.length) {
      const fp = frontier.map((p) => [x(p.cost), y(p.score)]);
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
    const lineGen = d3.line().x((p) => x(p.cost)).y((p) => y(p.score));
    const lines = layers.lines.selectAll("path").data(series, (s) => s.key).join(
      (enter) => enter.append("path").attr("class", "series-line").attr("opacity", 0).attr("d", (s) => lineGen(s.points)),
    );
    lines.style("stroke", seriesColor).style("stroke-dasharray", (s) => (s.ref ? "4 4" : null));
    tr(lines).attr("d", (s) => lineGen(s.points)).attr("opacity", 1);

    // Points: frontier points are larger and haloed.
    const ptsData = series.flatMap((s) => s.points);
    const keyOf = (p) => p.s + "|" + p.id;
    const halos = layers.halos.selectAll("circle").data(ptsData.filter((p) => fSet.has(p)), keyOf).join(
      (enter) => enter.append("circle").attr("class", "halo").attr("r", 0).attr("cx", (p) => x(p.cost)).attr("cy", (p) => y(p.score)),
    );
    tr(halos).attr("r", 10).attr("cx", (p) => x(p.cost)).attr("cy", (p) => y(p.score));

    const pts = layers.points.selectAll("circle").data(ptsData, keyOf).join(
      (enter) => enter.append("circle").attr("class", "pt").attr("r", 0).attr("cx", (p) => x(p.cost)).attr("cy", (p) => y(p.score)),
    );
    pts.classed("front", (p) => fSet.has(p)).style("fill", (p) => seriesColor(p.series));
    tr(pts).attr("cx", (p) => x(p.cost)).attr("cy", (p) => y(p.score)).attr("r", (p) => (fSet.has(p) ? 5.5 : 4.5));

    const cps = layers.custom.selectAll("path").data(custom, (p) => p.id).join("path").attr("class", "custom-pt")
      .attr("d", d3.symbol(d3.symbolDiamond, 130)());
    tr(cps).attr("transform", (p) => `translate(${x(p.cost)},${y(p.score)})`);

    layers.empty.attr("x", iw / 2).attr("y", ih / 2)
      .text(series.length || custom.length ? "" : "No models selected. Pick some from the list, or try Recommended.");

    ctx = { m, iw, ih, x, y, frontier, fSet, labelMode };
    renderLabels(series.concat(custom.map((p) => ({ ...p.series, best: p, points: [p] }))), T);

    screenPts = ptsData.concat(custom).map((p) => ({ p, sx: x(p.cost), sy: y(p.score) }))
      .filter((d) => d.sx >= -6 && d.sx <= iw + 6 && d.sy >= -6 && d.sy <= ih + 6);
    delaunay = d3.Delaunay.from(screenPts, (d) => d.sx, (d) => d.sy);
    applyHover();
  }

  function renderLabels(series, T) {
    const { x, y, iw, ih, fSet, labelMode } = ctx;
    const LH = 21;
    let items = series.map((s) => {
      // Anchor at the line's end: its most expensive point that is in view.
      const inView = s.points.filter((p) => { const px = x(p.cost), py = y(p.score); return px >= 0 && px <= iw && py >= 0 && py <= ih; });
      const a = inView.length ? inView[inView.length - 1] : s.points[s.points.length - 1];
      const ax = x(a.cost), ay = y(a.score);
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

    const gx = iw + 22;
    const leaders = layers.leaders.selectAll("path").data(items.filter((d) => d.inView), (d) => d.s.key).join("path").attr("class", "leader");
    (T ? leaders.transition(T) : leaders.interrupt()).attr("d", (d) => `M${d.ax + 8},${d.ay}H${Math.max(d.ax + 8, iw + 4)}L${gx - 7},${d.ly}`);

    const labelW = labelMode === "full" ? ctx.m.right - 26 : 34;
    const g = layers.labels.selectAll("g.lbl").data(items, (d) => d.s.key).join((enter) => {
      const e = enter.append("g").attr("class", "lbl").attr("transform", (d) => `translate(${gx},${d.ly})`);
      e.append("rect").attr("class", "lbl-bg").attr("x", -12).attr("y", -10.5).attr("height", 21).attr("rx", 6);
      e.append("circle").attr("class", "lbl-dot").attr("r", 3.5);
      e.append("g").attr("class", "lbl-logo").attr("transform", "translate(16,0)");
      e.append("text").attr("class", "lbl-name").attr("x", 30).attr("dy", "0.35em");
      e.append("title");
      return e;
    });
    g.attr("data-key", (d) => d.s.key).style("opacity", (d) => (d.inView ? null : 0.5));
    (T ? g.transition(T) : g.interrupt()).attr("transform", (d) => `translate(${gx},${d.ly})`);
    g.select("rect").attr("width", labelW + 12);
    g.select(".lbl-dot").style("fill", (d) => seriesColor(d.s));
    g.select(".lbl-logo").each(function (d) {
      const sel = d3.select(this);
      const prov = d.s.custom ? "__custom" : d.s.provider;
      if (sel.attr("data-prov") !== prov || !this.firstChild) { sel.attr("data-prov", prov); drawLogo(sel, prov, 16); }
    });
    g.select(".lbl-name").text((d) => (labelMode === "full" ? d.s.name : ""));
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

  // ---------- hover, crosshair, pin ----------
  function setHover(key) {
    if (state.pinned) return;
    if (state.hoverSeries === key) return;
    state.hoverSeries = key;
    applyHover();
  }

  function applyHover() {
    const k = state.pinned ? state.pinned.s : state.hoverSeries;
    if (layers && ctx) {
      const off = (key) => k && key !== k;
      layers.lines.selectAll("path").classed("dim", (s) => off(s.key));
      layers.points.selectAll("circle").classed("dim", (p) => off(p.s));
      layers.halos.selectAll("circle").classed("dim", (p) => off(p.s));
      layers.labels.selectAll("g.lbl").classed("dim", (d) => off(d.s.key)).classed("hl", (d) => d.s.key === k);
      layers.leaders.selectAll("path").classed("dim", (d) => off(d.s.key)).classed("hl", (d) => d.s.key === k);

      // Effort-level labels for the focused model.
      const { x, y, iw, ih } = ctx;
      const s = k && ds.byKey.get(k);
      const eff = s && state.selected.has(k) ? s.points.filter((p) => p.effort) : [];
      layers.effort.selectAll("text").data(eff, (p) => p.id).join("text")
        .attr("class", "effort-lbl")
        .attr("text-anchor", (p, i) => (i % 2 ? "start" : "end"))
        .attr("x", (p, i) => x(p.cost) + (i % 2 ? 9 : -9))
        .attr("y", (p, i) => y(p.score) + (i % 2 ? 15 : -9))
        .text((p) => p.effort);

      // Crosshair to the axes with value readouts.
      const hp = state.pinned || state.hoverPoint;
      if (hp) {
        const sx = x(hp.cost), sy = y(hp.score);
        layers.guides.selectAll("line").data([0, 1]).join("line").attr("class", "guide")
          .attr("x1", (i) => (i ? 0 : sx)).attr("x2", (i) => (i ? sx : sx))
          .attr("y1", (i) => (i ? sy : sy)).attr("y2", (i) => (i ? sy : ih));
        layers.ring.style("display", null).attr("cx", sx).attr("cy", sy);
        layers.readout.style("display", null);
        const cx = fmtCost(hp.cost), cy = fmtPct(hp.score);
        const wx = textWidth(cx) * 0.9 + 14, wy = textWidth(cy) * 0.9 + 12;
        layers.readX.attr("transform", `translate(${Math.max(wx / 2, Math.min(iw - wx / 2, sx))},${ih + 4})`);
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
  }

  function nearestPoint(e) {
    if (!delaunay || !screenPts.length || !ctx) return null;
    const [px, py] = d3.pointer(e, gRoot.node());
    const hit = screenPts[delaunay.find(px, py)];
    return hit && Math.hypot(hit.sx - px, hit.sy - py) <= 24 ? hit : null;
  }

  function onPointerMove(e) {
    if (state.pinned || e.buttons) return;
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
    const { frontier, fSet, m } = ctx;
    let flag = "";
    if (state.frontierMode !== "off" && !s.ref) {
      if (fSet.has(p)) {
        flag = `<span>◆</span><span><b>On the Pareto frontier.</b> Nothing scores higher for less.</span>`;
      } else {
        const atBudget = frontier.filter((f) => f.cost <= p.cost).sort((a, b) => b.score - a.score)[0];
        const cheaper = frontier.filter((f) => f.score >= p.score).sort((a, b) => a.cost - b.cost)[0];
        const parts = [];
        if (atBudget) parts.push(`<b>${esc(atBudget.series.name)}${atBudget.effort ? " (" + esc(atBudget.effort) + ")" : ""}</b> scores ${fmtPct(atBudget.score)} for ${fmtCost(atBudget.cost)}`);
        if (cheaper && cheaper !== atBudget && cheaper.cost < p.cost) parts.push(`matches this score for ${fmtCost(cheaper.cost)} with <b>${esc(cheaper.series.name)}</b>`);
        if (parts.length) flag = `<span>↘</span><span>Dominated. ${parts.join("; ")}.</span>`;
      }
    }
    const prov = s.custom ? "Your point" : providerName(s.provider);
    const url = p.url ? ARC_ORIGIN + p.url : null;
    tooltip.innerHTML = `
      <div class="tt-head"><span class="tt-sw" style="background:${seriesColor(s)}"></span>${logoHTML(s.custom ? "__custom" : s.provider, 20)}<div class="tt-name">${esc(s.name)}</div></div>
      <div class="tt-sub">${esc(prov)}${p.effort ? " · " + esc(p.effort) + " effort" : ""}${s.released ? " · " + esc(fmtDate(s.released)) : ""}</div>
      <dl>
        <dt>Score</dt><dd>${fmtPct(p.score)}</dd>
        <dt>${esc(ds.meta.costLabel)}</dt><dd>${fmtCost(p.cost)}</dd>
        ${p.score > 0 ? `<dt>Cost per point</dt><dd>${fmtCost(p.cost / (p.score * 100))}</dd>` : ""}
      </dl>
      ${flag ? `<div class="tt-flag">${flag}</div>` : ""}
      ${p.note ? `<div class="tt-note">${esc(p.note.length > 220 ? p.note.slice(0, 217) + "…" : p.note)}</div>` : ""}
      ${s.custom ? "" : `<div class="tt-hint">Click to pin</div>
      <div class="tt-actions">
        <button type="button" data-act="only">Only this</button>
        <button type="button" data-act="remove">Remove</button>
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">ARC results ↗</a>` : ""}
      </div>`}`;
    tooltip.classList.toggle("pinned", pinned);
    tooltip.hidden = false;
    const card = chartEl.parentElement.getBoundingClientRect();
    const box = chartEl.getBoundingClientRect();
    const ax = box.left - card.left + m.left + hit.sx;
    const ay = box.top - card.top + m.top + hit.sy;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let left = ax + 18;
    if (left + tw > card.width - 8) left = ax - tw - 18;
    left = Math.max(8, left);
    const top = Math.max(8, Math.min(card.height - th - 8, ay - th / 2));
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
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
    const fSet = new Set(frontierPool());
    return currentSeries().flatMap((s) => s.points.map((p) => ({
      model: s.name, provider: providerName(s.provider), effort: p.effort || "", score: p.score, cost: p.cost,
      released: s.released || "", frontier: fSet.has(p), url: p.url, s,
    }))).concat(customPoints().map((p) => ({ model: p.series.name, provider: "Your point", effort: "", score: p.score, cost: p.cost, released: "", frontier: fSet.has(p), s: p.series })));
  }

  function exportCSV() {
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const rows = visibleRows();
    const lines = [["benchmark", "model", "provider", "effort", "score_pct", "cost_usd", "released", "on_frontier"].join(",")]
      .concat(rows.map((r) => [ds.meta.name, r.model, r.provider, r.effort, +(r.score * 100).toFixed(3), +r.cost.toPrecision(6), r.released, r.frontier].map(q).join(",")));
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
    bg.setAttribute("fill", theme.surface);
    clone.insertBefore(bg, clone.firstChild);
    const caption = document.createElementNS(SVG_NS, "text");
    caption.setAttribute("x", W - 12);
    caption.setAttribute("y", H - 8);
    caption.setAttribute("text-anchor", "end");
    caption.setAttribute("style", `fill:${theme["text-3"]};font-size:11px;font-family:system-ui,sans-serif`);
    caption.textContent = `${ds.meta.name} · data: ARC Prize, ${new Date(state.data.fetchedAt).toISOString().slice(0, 10)}`;
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
    download(blob, `pareto-${state.datasetId}.png`);
    flash($("#export-png"), "Saved ✓");
  }

  // ---------- table ----------
  let tableSort = { key: "cost", dir: 1 };
  function renderTable() {
    const rows = visibleRows();
    const k = tableSort.key, dir = tableSort.dir;
    rows.sort((a, b) => (typeof a[k] === "number" ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k]))) * dir);
    const cols = [["model", "Model"], ["provider", "Provider"], ["effort", "Effort"], ["score", "Score", "num"], ["cost", ds.meta.costLabel, "num"], ["frontier", "Frontier"]];
    const table = $("#table");
    table.innerHTML = `<thead><tr>${cols.map(([key, label, cls]) => `<th class="${cls || ""}" data-sort="${key}" aria-sort="${key === k ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(label)}${key === k ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => {
        const name = r.url ? `<a href="${ARC_ORIGIN}${esc(r.url)}" target="_blank" rel="noopener">${esc(r.model)}</a>` : esc(r.model);
        return `<tr><td><span class="cell-model">${logoHTML(r.s.custom ? "__custom" : r.s.provider, 16)}${name}</span></td><td>${esc(r.provider)}</td><td>${esc(r.effort || "—")}</td><td class="num">${fmtPct(r.score)}</td><td class="num">${fmtCost(r.cost)}</td><td>${r.frontier ? "◆ yes" : ""}</td></tr>`;
      }).join("")}</tbody>`;
    table.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.sort;
      tableSort = { key, dir: tableSort.key === key ? -tableSort.dir : 1 };
      renderTable();
    }));
  }

  load();
})();
