import { taskLocal, taskApi, estimateLocal, DEFAULTS } from "./engine.js?v=0.5";

// A use case = token profile (drives time & cost) + the quality metric that matters for it.
// Token profiles are estimates. 5000 words ≈ 6.7k tokens (≈1.33 tokens/word in English).
const USECASES = {
  brief:   { label: "Daily brief: 20 sites → 200 words", metric: "longdoc",
             inputTokens: 7000, outputTokens: 270, reasoningTokens: 1500 },
  doc:     { label: "Analyse a 50-page document", metric: "longdoc",
             inputTokens: 33000, outputTokens: 800, reasoningTokens: 2000 },
  coding:  { label: "Coding task (fix a bug in a repo)", metric: "coding",
             inputTokens: 15000, outputTokens: 1000, reasoningTokens: 2000 },
  agent:   { label: "Agentic workflow with tools", metric: "agentic",
             inputTokens: 20000, outputTokens: 500, reasoningTokens: 3000 },
  qa:      { label: "Quick question from model knowledge", metric: "reliability",
             inputTokens: 500, outputTokens: 300, reasoningTokens: 500 },
  general: { label: "General use (overall index)", metric: "overall",
             inputTokens: 3000, outputTokens: 500, reasoningTokens: 1000 }
};
// Units of 1 USD. Fallback only — replaced by live ECB (Frankfurter) or NBP rates when reachable.
const FALLBACK_FX = { USD: 1, EUR: 0.87, PLN: 3.70 };
// Default electricity price: Poland, G11 tariff, 2026 average incl. distribution (rankomat.pl / interia.pl).
const DEFAULT_KWH = { value: 1.04, cur: "PLN" };

const avg = (...xs) => xs.some(x => x == null) ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const METRICS = {
  overall:     { label: "Overall intelligence", short: "AA index", axis: "AA Intelligence Index v5.0.2", get: m => m.aa_index,
                 note: "Weighted mix of 9 evaluations: knowledge work, coding, science, general knowledge." },
  coding:      { label: "Coding", short: "Coding", axis: "Coding score (%)", get: m => avg(m.bench?.frontiercode, m.bench?.terminalbench),
                 note: "Mean of FrontierCode-AA 2.0 (merge-worthy changes in real repos) and Terminal-Bench 4.1 (agentic terminal work)." },
  agentic:     { label: "Agentic workflows", short: "Agentic", axis: "AutomationBench-AA (%)", get: m => m.bench?.automationbench,
                 note: "AutomationBench-AA: share of objectives completed in simulated SaaS workflows using tools." },
  longdoc:     { label: "Long documents", short: "Long docs", axis: "GDP.pdf all-pass rate (%)", get: m => m.bench?.gdppdf,
                 note: "GDP.pdf: reasoning over long real-world professional documents; a task counts only if every criterion passes. Closest available proxy for summarising sources — no AA benchmark measures faithfulness to provided text directly." },
  reliability: { label: "Knowledge reliability (no sources)", short: "Knowledge", axis: "AA-Omniscience net score", get: m => m.bench?.omniscience,
                 note: "AA-Omniscience net score: closed-book factual questions, correct minus hallucinated answers (−100…100); abstaining beats guessing. Measures what the model knows by itself, not faithfulness to documents you provide." }
};
const KIND = {
  frontier: { label: "Frontier via API", color: "var(--s-frontier)" },
  openapi:  { label: "Open-weight via API (hosted)", color: "var(--s-openapi)" },
  local:    { label: "Open-weight local (electricity)", color: "var(--s-local)" }
};

const $ = id => document.getElementById(id);
const [modelsJ, hwJ, calJ, harnessJ] = await Promise.all(
  ["models", "hardware", "calibration", "harness"].map(f => fetch(`data/${f}.json`, { cache: "no-cache" }).then(r => r.json())));
const models = modelsJ.models, hardware = hwJ.hardware;

// ---------- state ----------
let fx = { ...FALLBACK_FX }, fxNote = "fallback rates";
let kwhUSD = DEFAULT_KWH.value / fx[DEFAULT_KWH.cur];       // electricity price kept internally in USD
const cur = () => $("cur").value;
const metric = () => METRICS[$("metric").value];

// ---------- controls ----------
$("asof").textContent = modelsJ._meta.quality_checked;
for (const h of hardware) $("hw").add(new Option(h.name, h.id));
for (const [k, m] of Object.entries(METRICS)) $("metric").add(new Option(m.label, k));
for (const [k, u] of Object.entries(USECASES)) $("usecase").add(new Option(u.label, k));
$("usecase").add(new Option("Custom (set under More settings)", "custom"));
$("hw").value = "ryzen-ai-max-128";
applyUseCase("brief");
$("runs").value = 30;
syncPower(); syncKwh();

loadFx().then(render);

async function loadFx() {
  const tries = [
    async () => { const j = await (await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,PLN")).json();
                  return { r: { USD: 1, ...j.rates }, note: `ECB reference rates, ${j.date}` }; },
    async () => { const j = await (await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR,PLN")).json();
                  return { r: { USD: 1, ...j.rates }, note: `ECB reference rates, ${j.date}` }; },
    async () => { const g = c => fetch(`https://api.nbp.pl/api/exchangerates/rates/a/${c}/?format=json`).then(r => r.json());
                  const [u, e] = await Promise.all([g("usd"), g("eur")]);
                  return { r: { USD: 1, PLN: u.rates[0].mid, EUR: u.rates[0].mid / e.rates[0].mid }, note: `NBP mid rates, ${u.rates[0].effectiveDate}` }; }
  ];
  for (const t of tries) {
    try { const { r, note } = await t(); if (r.EUR && r.PLN) { fx = r; fxNote = note; kwhUSD = DEFAULT_KWH.value / fx[DEFAULT_KWH.cur]; syncKwh(); return; } }
    catch { /* try next source */ }
  }
}

function applyUseCase(k) {
  const u = USECASES[k]; if (!u) return;
  $("inTok").value = u.inputTokens; $("outTok").value = u.outputTokens; $("reasonTok").value = u.reasoningTokens;
  $("metric").value = u.metric;
}
// editing tokens or metric by hand turns the use case into "Custom"
const toCustom = () => { $("usecase").value = "custom"; render(); };
function syncPower() { $("power").value = hardware.find(h => h.id === $("hw").value).power_w; }
function syncKwh() {
  const v = kwhUSD * fx[cur()];
  $("kwh").value = v.toFixed(v < 1 ? 3 : 2);
  $("kwhLabel").textContent = `Electricity [${cur()}/kWh]`;
}
$("usecase").onchange = e => { applyUseCase(e.target.value); render(); };
for (const id of ["inTok", "outTok", "reasonTok", "metric"]) $(id).oninput = toCustom;
$("hw").onchange = () => { syncPower(); render(); };
$("cur").onchange = () => { syncKwh(); render(); };
$("kwh").oninput = () => { kwhUSD = +$("kwh").value / fx[cur()]; render(); };
for (const id of ["mode", "power", "runs", "onlyRunnable"]) $(id).oninput = render;

// tabs (hash-routed so links and the back button work)
function showTab() {
  const t = location.hash === "#method" ? "method" : "dashboard";
  document.querySelectorAll(".tabs a").forEach(a => a.setAttribute("aria-selected", a.dataset.tab === t));
  $("tab-dashboard").hidden = t !== "dashboard"; $("tab-method").hidden = t !== "method";
}
window.addEventListener("hashchange", showTab); showTab();

$("moreBtn").onclick = () => {
  const open = $("more").hidden; $("more").hidden = !open; $("moreBtn").setAttribute("aria-expanded", open);
};

function state() {
  const hw = { ...hardware.find(h => h.id === $("hw").value), power_w: +$("power").value };
  return {
    hw, mode: $("mode").value, runs: +$("runs").value,
    // all costs computed in USD, converted only for display
    scen: { inputTokens: +$("inTok").value, outputTokens: +$("outTok").value, reasoningTokens: +$("reasonTok").value,
            pricePerKWh: kwhUSD, fx: 1 }
  };
}

// ---------- formatting ----------
function money(usd) {
  if (usd == null || !isFinite(usd)) return "—";
  const x = usd * fx[cur()];
  const d = x === 0 ? 0 : x < 0.01 ? 4 : x < 10 ? 2 : 0;
  return new Intl.NumberFormat("en", { style: "currency", currency: cur(), minimumFractionDigits: d, maximumFractionDigits: d }).format(x);
}
const dur = s => s == null ? "—" : s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`;
const tps = v => v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
const q = v => v == null ? "—" : Number.isInteger(v) ? `${v}` : v.toFixed(1);

// ---------- compute rows ----------
function rows(st) {
  return models.map(m => ({
    m,
    api: taskApi(m, st.scen),
    loc: m.open ? taskLocal(m, st.hw, st.scen, { mode: st.mode }) : null
  }));
}

// ---------- tiles ----------
function tiles(st, R) {
  const M = metric();
  const score = m => M.get(m);
  const best = list => list.filter(m => score(m) != null).sort((a, b) => score(b) - score(a))[0];
  const bF = best(models.filter(m => !m.open)), bO = best(models.filter(m => m.open));
  const halfHourUSD = st.hw.power_w * 0.5 / 1000 * kwhUSD;
  const bestLocal = R.filter(r => r.loc?.ok && score(r.m) != null).sort((a, b) => score(b.m) - score(a.m))[0];
  const sonnet = R.find(r => r.m.id === "claude-sonnet-5.5");
  const t = [
    [`${M.short} gap`, `${q(score(bF))} vs ${q(score(bO))}`, `${bF.name.replace(/ \(.*\)/, "")} vs ${bO.name.replace(/ \(.*\)/, "")}`],
    ["Open-weight lag", "≈ 4 months", "Epoch AI, overall capability, avg since Jan 2026"],
    ["30 min local, electricity", money(halfHourUSD), `${st.hw.power_w} W × 0.5 h`],
    bestLocal
      ? [`Local: ${bestLocal.m.name.replace(/ \(.*\)/, "")}`, `${dur(bestLocal.loc.totalS)} · ${money(bestLocal.loc.cost)}`,
         `best ${M.short.toLowerCase()} score that runs here · ${money(bestLocal.loc.cost * st.runs)}/month`]
      : ["Local", "—", "no scored model runs on this hardware"],
    ["API: Claude Sonnet 5.5", money(sonnet.api.cost), `per run · ${money(sonnet.api.cost * st.runs)}/month`]
  ];
  $("tiles").innerHTML = t.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
}

// ---------- table ----------
let sortKey = "q", sortDir = -1;
function table(st, R) {
  const M = metric(), overall = $("metric").value === "overall";
  const cols = [["Model", "name"], ["AA index", "aa"]];
  if (!overall) cols.push([M.short, "q"]);
  cols.push(["Weights", "type"], ["Params (active)", "params"], ["Q4 size", "size"], ["Local tok/s", "tps"],
    ["Local time", "time"], ["Power/run", "cl"], ["API/run", "ca"], ["API/month", "cam"], ["Power/month", "clm"]);
  if (overall && sortKey === "q") sortKey = "aa";
  let data = R.map(({ m, api, loc }) => ({
    m, api, loc,
    name: m.name, aa: m.aa_index ?? -999, q: M.get(m) ?? -999, type: m.open ? "open" : "frontier",
    params: m.total_b ?? 0, size: loc?.totalBytes ?? 0,
    tps: loc?.ok ? loc.decodeTps : -1, time: loc?.ok ? loc.totalS : Infinity,
    cl: loc?.ok ? loc.cost : Infinity, ca: api.ok ? api.cost : Infinity,
    cam: api.ok ? api.cost * st.runs : Infinity, clm: loc?.ok ? loc.cost * st.runs : Infinity
  }));
  if ($("onlyRunnable").checked) data = data.filter(d => d.loc?.ok);
  data.sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : a[sortKey] < b[sortKey] ? -1 : 0) * sortDir);
  const head = `<thead><tr>${cols.map(([l, k]) => `<th data-k="${k}">${l}${k === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>`;
  const body = data.map(d => {
    const k = d.m.open ? "openapi" : "frontier";
    const locCells = !d.m.open ? `<td class="na" colspan="4">closed weights</td>`
      : d.loc.ok ? `<td>${tps(d.loc.decodeTps)}${d.loc.streaming ? " ⇅" : ""}</td><td>${dur(d.loc.totalS)}</td><td>${money(d.loc.cost)}</td>`
      : `<td class="bad" colspan="3">${d.loc.reason}</td>`;
    const sizeCell = d.m.open ? `<td>${d.loc?.totalBytes ? (d.loc.totalBytes / 1e9).toFixed(0) + " GB" : "—"}</td>` : "";
    return `<tr>
      <td><span class="dot" style="background:${KIND[k].color}"></span>${d.m.name}</td>
      <td>${q(d.m.aa_index)}</td>${overall ? "" : `<td><b>${q(M.get(d.m))}</b></td>`}<td>${d.m.open ? "open" : "closed"}</td>
      <td>${d.m.total_b ? `${d.m.total_b}B (${d.m.active_b}B)` : "—"}</td>
      ${sizeCell}${locCells}
      <td>${d.api.ok ? money(d.api.cost) : "—"}</td>
      <td>${d.api.ok ? money(d.api.cost * st.runs) : "—"}</td>
      <td>${d.loc?.ok ? money(d.loc.cost * st.runs) : "—"}</td></tr>`;
  }).join("");
  $("tbl").innerHTML = head + `<tbody>${body}</tbody>`;
  $("tbl").querySelectorAll("th").forEach(th => th.onclick = () => {
    const k = th.dataset.k; sortDir = k === sortKey ? -sortDir : (k === "name" ? 1 : -1); sortKey = k; render();
  });
}

// ---------- chart ----------
function chart(st, R) {
  const M = metric();
  $("metricNote").textContent = M.note;
  $("metricName").textContent = `Quality: ${M.label}`;
  const pts = [];
  for (const { m, api, loc } of R) {
    const y = M.get(m);
    if (y == null) continue;
    if (api.ok) pts.push({ kind: m.open ? "openapi" : "frontier", x: api.cost * fx[cur()], usd: api.cost, y, m, api });
    if (loc?.ok) pts.push({ kind: "local", x: loc.cost * fx[cur()], usd: loc.cost, y, m, loc });
  }
  const W = 1000, H = 420, ml = 52, mr = 170, mt = 16, mb = 44;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const lx0 = Math.floor(Math.log10(Math.min(...xs))), lx1 = Math.ceil(Math.log10(Math.max(...xs)));
  const y0 = Math.min(0, Math.floor(Math.min(...ys) / 10) * 10), y1 = Math.ceil(Math.max(...ys) / 10) * 10;
  const X = v => ml + (Math.log10(v) - lx0) / (lx1 - lx0) * (W - ml - mr);
  const Y = v => mt + (1 - (v - y0) / (y1 - y0)) * (H - mt - mb);
  const fmtAxis = v => new Intl.NumberFormat("en", { style: "currency", currency: cur(), maximumFractionDigits: 4 }).format(v);
  let g = "";
  for (let v = y0; v <= y1; v += 10) g += `<line class="gridline" x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${ml - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let e = lx0; e <= lx1; e++) {
    const v = 10 ** e;
    g += `<line class="gridline" x1="${X(v)}" x2="${X(v)}" y1="${mt}" y2="${H - mb}"/><text x="${X(v)}" y="${H - mb + 16}" text-anchor="middle">${fmtAxis(v)}</text>`;
  }
  g += `<text x="${(ml + W - mr) / 2}" y="${H - 6}" text-anchor="middle">cost of one run (log)</text>`;
  g += `<text x="12" y="${(mt + H - mb) / 2}" transform="rotate(-90 12 ${(mt + H - mb) / 2})" text-anchor="middle">${M.axis}</text>`;

  // labels on the right edge with collision nudging, leader lines to points
  const labeled = [...pts].sort((a, b) => Y(a.y) - Y(b.y));
  const top = mt + 4, bottom = H - mb - 2;
  const gap = Math.min(13, (bottom - top) / Math.max(1, labeled.length - 1));
  const lab = labeled.map(p => ({ p, ly: Math.min(bottom, Math.max(top, Y(p.y))) }));
  for (let i = 1; i < lab.length; i++) lab[i].ly = Math.max(lab[i].ly, lab[i - 1].ly + gap);          // push down
  if (lab.length) lab[lab.length - 1].ly = Math.min(lab[lab.length - 1].ly, bottom);
  for (let i = lab.length - 2; i >= 0; i--) lab[i].ly = Math.min(lab[i].ly, lab[i + 1].ly - gap);      // pull back up

  let marks = "";
  pts.forEach((p, i) => {
    const cx = X(p.x), cy = Y(p.y), c = KIND[p.kind].color;
    const shape = p.kind === "frontier" ? `<circle class="mark" cx="${cx}" cy="${cy}" r="6" fill="${c}"/>`
      : p.kind === "openapi" ? `<rect class="mark" x="${cx - 5.5}" y="${cy - 5.5}" width="11" height="11" rx="2" fill="${c}"/>`
      : `<path class="mark" d="M${cx},${cy - 7} L${cx + 7},${cy + 5} L${cx - 7},${cy + 5} Z" fill="${c}"/>`;
    marks += `<g data-i="${i}">${shape}<circle cx="${cx}" cy="${cy}" r="14" fill="transparent"/></g>`;
  });
  let labels = "";
  for (const { p, ly } of lab) {
    const short = p.m.name.replace(/ \((Max|High|Xhigh)\)/, "");
    labels += `<line x1="${X(p.x) + 8}" y1="${Y(p.y)}" x2="${W - mr + 6}" y2="${ly}" stroke="var(--grid)"/>` +
      `<text class="lbl" x="${W - mr + 10}" y="${ly + 4}">${short}${p.kind === "local" ? " ▲" : p.kind === "openapi" ? " ■" : ""}</text>`;
  }
  $("chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart of ${M.label} versus cost">${g}<line class="axis" x1="${ml}" x2="${W - mr}" y1="${Y(0)}" y2="${Y(0)}"/>${labels}${marks}</svg>`;

  const tip = $("tip");
  $("chart").querySelectorAll("g[data-i]").forEach(el => {
    el.onmousemove = ev => {
      const p = pts[+el.dataset.i];
      const extra = p.kind === "local"
        ? `${tps(p.loc.decodeTps)} tok/s · time ${dur(p.loc.totalS)} (prompt ${dur(p.loc.prefillS)})<br>${p.loc.kWh.toFixed(3)} kWh${p.loc.streaming ? " · streaming from SSD" : ""}`
        : `${Math.round(p.api.inTok)} input tok, ${Math.round(p.api.outTok)} output tok`;
      tip.innerHTML = `<b>${p.m.name}</b><br>${KIND[p.kind].label}<br>${M.short} ${q(p.y)} · ${money(p.usd)} / run · ${money(p.usd * st.runs)} / month<br>${extra}`;
      tip.hidden = false; tip.style.left = ev.clientX + 14 + "px"; tip.style.top = ev.clientY + 14 + "px";
    };
    el.onmouseleave = () => { tip.hidden = true; };
  });
  const sw = k => k === "frontier" ? `<span class="dot" style="background:${KIND[k].color}"></span>`
    : k === "openapi" ? `<span class="dot" style="background:${KIND[k].color};border-radius:2px"></span>`
    : `<svg width="12" height="12"><path d="M6,0 L12,11 L0,11 Z" fill="${KIND[k].color}"/></svg>`;
  $("legend").innerHTML = Object.keys(KIND).map(k => `<span>${sw(k)}${KIND[k].label}</span>`).join("");
}

// ---------- calibration ----------
function calibration() {
  const hwById = Object.fromEntries(hardware.map(h => [h.id, h]));
  const rowsH = calJ.points.map(p => {
    const meas = p.measured_lo === p.measured_hi ? `${p.measured_lo}` : `${p.measured_lo}–${p.measured_hi}`;
    if (!p.hw_id || p.active_b == null) return `<tr><td class="l">${p.label}</td><td>${meas}</td><td class="na">—</td><td class="na">—</td><td class="l na">${p.hw_note}</td></tr>`;
    const e = estimateLocal({ total_b: p.total_b, active_b: p.active_b }, hwById[p.hw_id], { ramOverrideGb: p.ram_override_gb, cold: p.cold });
    const ratio = e.decodeTps / ((p.measured_lo + p.measured_hi) / 2);
    const cls = ratio > 2 || ratio < 0.5 ? "bad" : "";
    const note = p.hw_id === "ryzen-ai-max-128" ? "calibration point (fitted)" : (p.hw_note ?? "");
    return `<tr><td class="l">${p.label}</td><td>${meas}</td><td>${tps(e.decodeTps)}</td><td class="${cls}">${ratio.toFixed(2)}×</td><td class="l">${note}</td></tr>`;
  }).join("");
  $("cal").innerHTML = `<caption style="caption-side:bottom;text-align:left;color:var(--ink2);padding-top:8px">Known weakness: for small MoE models on CPU the model overestimates speed by about 4–5×. In that regime compute and engine overhead matter, not only memory bandwidth. Parameters: Q4 ≈ ${DEFAULTS.bytesPerParam} B/param, memory efficiency ${DEFAULTS.memEff}, SSD ${DEFAULTS.ssdEff}, skew ${DEFAULTS.skew}.</caption><thead><tr><th class="l">Configuration</th><th>Measured tok/s</th><th>Model tok/s</th><th>Model / measured</th><th class="l">Notes</th></tr></thead><tbody>${rowsH}</tbody>`;
}

// ---------- harness comparison (one horizontal bar chart per model, single series → no legend) ----------
function harness() {
  $("harness").innerHTML = harnessJ.models.map(m => {
    const rows = Object.entries(m.scores).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...harnessJ.models.flatMap(x => Object.values(x.scores)));
    const W = 460, rowH = 22, ml = 130, mr = 36, H = rows.length * rowH + 8;
    const X = v => ml + v / max * (W - ml - mr);
    const lo = rows[rows.length - 1][1], hi = rows[0][1];
    const bars = rows.map(([h, v], i) => {
      const y = 4 + i * rowH;
      return `<g><text x="${ml - 8}" y="${y + 14}" text-anchor="end">${h}</text>
        <rect x="${ml}" y="${y + 3}" width="${X(v) - ml}" height="${rowH - 8}" rx="3" fill="${m.open ? "var(--s-openapi)" : "var(--s-frontier)"}"><title>${h}: ${v}</title></rect>
        <text class="lbl" x="${X(v) + 6}" y="${y + 14}">${v}</text></g>`;
    }).join("");
    return `<figure><figcaption><b>${m.name}</b> · ${m.open ? "open weights" : "closed"} · best ${hi}, worst ${lo} (−${Math.round((1 - lo / hi) * 100)}%)</figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Coding Agent Index of ${m.name} by harness">${bars}</svg></figure>`;
  }).join("");
}

function sources() {
  const s = [
    ["Artificial Analysis — leaderboard (Intelligence Index v5.0.2)", "https://artificialanalysis.ai/leaderboards/models"],
    ["Artificial Analysis — open weights models", "https://artificialanalysis.ai/models/open-source"],
    ["AA — FrontierCode-AA 2.0", "https://artificialanalysis.ai/evaluations/frontiercode-2-0"],
    ["AA — Terminal-Bench 4.1", "https://artificialanalysis.ai/evaluations/terminalbench-4-1"],
    ["AA — AutomationBench-AA", "https://artificialanalysis.ai/evaluations/automationbench-aa"],
    ["AA — GDP.pdf", "https://artificialanalysis.ai/evaluations/gdp-pdf"],
    ["AA — AA-Omniscience v1.1", "https://artificialanalysis.ai/evaluations/omniscience"],
    ["AA — Coding Agent Index, harness comparisons", "https://artificialanalysis.ai/agents/coding-agents"],
    ["AA — Intelligence benchmarking methodology (sampling, harnesses)", "https://artificialanalysis.ai/methodology/intelligence-benchmarking"],
    ["Epoch AI — open-weight models lag", "https://epoch.ai/topics/open-models"],
    ["How far behind is open-source AI? (gap in months)", "https://yaroslavvb.github.io/artificial-analysis-oss-lag/"],
    ["colibri — README and measurements", "https://github.com/JustVugg/colibri"],
    ["llmhardware.io — tok/s ceiling formula, bandwidths", "https://llmhardware.io/guides/llm-tokens-per-second"],
    ["Anthropic — API pricing", "https://platform.claude.com/en/docs/about-claude/pricing"],
    ["OpenAI — API pricing", "https://developers.openai.com/api/docs/pricing"],
    ["OpenRouter — open-weight model prices", "https://openrouter.ai/"],
    ["Default electricity price: Poland 2026, G11 tariff, avg ~1.04 PLN/kWh gross", "https://rankomat.pl/nieruchomosci/ceny-pradu"],
    ["Exchange rates: Frankfurter (ECB reference rates), NBP fallback", "https://frankfurter.dev/"],
    ["LocalScore — measured results on hardware", "https://localscore.ai"]
  ];
  $("sources").innerHTML = s.map(([t, u]) => `<li><a href="${u}">${t}</a></li>`).join("");
}

function render() {
  $("fxHint").textContent = `1 USD = ${fx.EUR.toFixed(3)} EUR = ${fx.PLN.toFixed(3)} PLN (${fxNote}). Default electricity: Poland avg.`;
  const st = state(); const R = rows(st);
  tiles(st, R); table(st, R); chart(st, R);
}
calibration(); harness(); sources(); render();
