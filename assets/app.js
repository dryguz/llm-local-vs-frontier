import { taskLocal, taskApi, estimateLocal, DEFAULTS } from "./engine.js?v=0.2";

const SCENARIOS = {
  // 5000 words of source text ≈ 6.7k tokens (≈1.33 tokens/word in English; other languages usually more)
  brief: { inputTokens: 7000, outputTokens: 270, reasoningTokens: 1500 },
  chat:  { inputTokens: 500,  outputTokens: 300, reasoningTokens: 500 },
  doc:   { inputTokens: 33000, outputTokens: 800, reasoningTokens: 2000 }
};
const FALLBACK_USDPLN = 3.70;
const KIND = {
  frontier: { label: "Frontier via API", color: "var(--s-frontier)", shape: "circle" },
  openapi:  { label: "Open-weight via API (hosted)", color: "var(--s-openapi)", shape: "square" },
  local:    { label: "Open-weight local (electricity)", color: "var(--s-local)", shape: "triangle" }
};

const $ = id => document.getElementById(id);
const [modelsJ, hwJ, calJ] = await Promise.all(
  ["models", "hardware", "calibration"].map(f => fetch(`data/${f}.json`, { cache: "no-cache" }).then(r => r.json())));
const models = modelsJ.models, hardware = hwJ.hardware;

// ---------- controls ----------
$("asof").textContent = modelsJ._meta.quality_checked;
for (const h of hardware) $("hw").add(new Option(h.name, h.id));
$("hw").value = "ryzen-ai-max-128";
$("kwh").value = 1.04;
$("usd").value = FALLBACK_USDPLN;
$("usdHint").textContent = `Default ${FALLBACK_USDPLN} (fallback); fetching NBP rate…`;
applyScenario("brief");
$("runs").value = 30;
syncPower();

fetch("https://api.nbp.pl/api/exchangerates/rates/a/usd/?format=json")
  .then(r => r.json())
  .then(j => { const r = j.rates[0]; $("usd").value = r.mid.toFixed(4); $("usdHint").textContent = `NBP mid rate as of ${r.effectiveDate}.`; render(); })
  .catch(() => { $("usdHint").textContent = `Could not fetch the NBP rate; using ${FALLBACK_USDPLN}.`; });

function applyScenario(k) {
  const s = SCENARIOS[k];
  $("inTok").value = s.inputTokens; $("outTok").value = s.outputTokens; $("reasonTok").value = s.reasoningTokens;
}
function syncPower() { $("power").value = hardware.find(h => h.id === $("hw").value).power_w; }
$("scenario").onchange = e => { applyScenario(e.target.value); render(); };
$("hw").onchange = () => { syncPower(); render(); };
for (const id of ["mode", "power", "inTok", "outTok", "reasonTok", "runs", "kwh", "usd", "onlyRunnable"]) $(id).oninput = render;

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
    scen: { inputTokens: +$("inTok").value, outputTokens: +$("outTok").value, reasoningTokens: +$("reasonTok").value,
            pricePerKWh: +$("kwh").value, usdPln: +$("usd").value }
  };
}

// ---------- formatting ----------
const pln = v => v == null ? "—" : v < 0.01 ? `PLN ${v.toFixed(4)}` : v < 10 ? `PLN ${v.toFixed(2)}` : `PLN ${v.toFixed(0)}`;
const dur = s => s == null ? "—" : s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`;
const tps = v => v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);

// ---------- compute rows ----------
function rows(st) {
  const out = [];
  for (const m of models) {
    const api = taskApi(m, st.scen);
    const loc = m.open ? taskLocal(m, st.hw, st.scen, { mode: st.mode }) : null;
    out.push({ m, api, loc });
  }
  return out;
}

// ---------- tiles ----------
function tiles(st, R) {
  const bestF = Math.max(...models.filter(m => !m.open).map(m => m.aa_index));
  const bestO = Math.max(...models.filter(m => m.open && m.aa_index != null).map(m => m.aa_index));
  const halfHour = st.hw.power_w * 0.5 / 1000 * st.scen.pricePerKWh;
  const runnable = R.filter(r => r.loc?.ok && r.m.aa_index != null).sort((a, b) => b.m.aa_index - a.m.aa_index);
  const bestLocal = runnable[0];
  const sonnet = R.find(r => r.m.id === "claude-sonnet-5.5");
  const t = [
    ["Quality gap (AA v5.0.2)", `${bestF} vs ${bestO}`, "best frontier vs best open-weight"],
    ["Open-weight lag", "≈ 4 months", "Epoch AI, average since Jan 2026"],
    ["30 min local, electricity", pln(halfHour), `${st.hw.power_w} W × 0.5 h × ${st.scen.pricePerKWh} PLN/kWh`],
    bestLocal
      ? [`Local: ${bestLocal.m.name}`, `${dur(bestLocal.loc.totalS)} · ${pln(bestLocal.loc.costPLN)}`,
         `best model that runs on this hardware · ${pln(bestLocal.loc.costPLN * st.runs)}/month`]
      : ["Local", "—", "no scored model runs on this hardware"],
    ["API: Claude Sonnet 5.5", pln(sonnet.api.costPLN), `per run · ${pln(sonnet.api.costPLN * st.runs)}/month`]
  ];
  $("tiles").innerHTML = t.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
}

// ---------- table ----------
let sortKey = "q", sortDir = -1;
function table(st, R) {
  const cols = [
    ["Model", "name"], ["AA", "q"], ["Weights", "type"], ["Params (active)", "params"],
    ["Q4 size", "size"], ["Local tok/s", "tps"], ["Local time", "time"], ["Power/run", "cl"],
    ["API/run", "ca"], ["API/month", "cam"], ["Power/month", "clm"]
  ];
  const data = R.map(({ m, api, loc }) => ({
    m, api, loc,
    name: m.name, q: m.aa_index ?? -1, type: m.open ? "open" : "frontier",
    params: m.total_b ?? 0, size: loc?.totalBytes ?? 0,
    tps: loc?.ok ? loc.decodeTps : -1, time: loc?.ok ? loc.totalS : Infinity,
    cl: loc?.ok ? loc.costPLN : Infinity, ca: api.ok ? api.costPLN : Infinity,
    cam: api.ok ? api.costPLN * st.runs : Infinity, clm: loc?.ok ? loc.costPLN * st.runs : Infinity
  }));
  if ($("onlyRunnable").checked) data.splice(0, data.length, ...data.filter(d => d.loc?.ok));
  data.sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : a[sortKey] < b[sortKey] ? -1 : 0) * sortDir);
  const head = `<thead><tr>${cols.map(([l, k]) => `<th data-k="${k}">${l}${k === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>`;
  const body = data.map(d => {
    const k = d.m.open ? "openapi" : "frontier";
    const locCells = !d.m.open ? `<td class="na" colspan="4">closed weights</td>`
      : d.loc.ok ? `<td>${tps(d.loc.decodeTps)}${d.loc.streaming ? " ⇅" : ""}</td><td>${dur(d.loc.totalS)}</td><td>${pln(d.loc.costPLN)}</td>`
      : `<td class="bad" colspan="3">${d.loc.reason}</td>`;
    const sizeCell = d.m.open ? `<td>${d.loc?.totalBytes ? (d.loc.totalBytes / 1e9).toFixed(0) + " GB" : "—"}</td>` : "";
    return `<tr>
      <td><span class="dot" style="background:${KIND[k].color}"></span>${d.m.name}</td>
      <td>${d.m.aa_index ?? "—"}</td><td>${d.m.open ? "open" : "closed"}</td>
      <td>${d.m.total_b ? `${d.m.total_b}B (${d.m.active_b}B)` : "—"}</td>
      ${sizeCell}${locCells}
      <td>${d.api.ok ? pln(d.api.costPLN) : "—"}</td>
      <td>${d.api.ok ? pln(d.api.costPLN * st.runs) : "—"}</td>
      <td>${d.loc?.ok ? pln(d.loc.costPLN * st.runs) : "—"}</td></tr>`;
  }).join("");
  $("tbl").innerHTML = head + `<tbody>${body}</tbody>`;
  $("tbl").querySelectorAll("th").forEach(th => th.onclick = () => {
    const k = th.dataset.k; sortDir = k === sortKey ? -sortDir : (k === "name" ? 1 : -1); sortKey = k; render();
  });
}

// ---------- chart ----------
function chart(st, R) {
  const pts = [];
  for (const { m, api, loc } of R) {
    if (m.aa_index == null) continue;
    if (api.ok) pts.push({ kind: m.open ? "openapi" : "frontier", x: api.costPLN, y: m.aa_index, m, api });
    if (loc?.ok) pts.push({ kind: "local", x: loc.costPLN, y: m.aa_index, m, loc });
  }
  const W = 1000, H = 420, ml = 48, mr = 170, mt = 16, mb = 44;
  const xs = pts.map(p => p.x);
  const lx0 = Math.floor(Math.log10(Math.min(...xs))), lx1 = Math.ceil(Math.log10(Math.max(...xs)));
  const X = v => ml + (Math.log10(v) - lx0) / (lx1 - lx0) * (W - ml - mr);
  const Y = v => mt + (1 - v / 70) * (H - mt - mb);
  let g = "";
  for (let q = 0; q <= 70; q += 10) g += `<line class="gridline" x1="${ml}" x2="${W - mr}" y1="${Y(q)}" y2="${Y(q)}"/><text x="${ml - 8}" y="${Y(q) + 4}" text-anchor="end">${q}</text>`;
  for (let e = lx0; e <= lx1; e++) {
    const v = 10 ** e;
    g += `<line class="gridline" x1="${X(v)}" x2="${X(v)}" y1="${mt}" y2="${H - mb}"/><text x="${X(v)}" y="${H - mb + 16}" text-anchor="middle">${pln(v)}</text>`;
  }
  g += `<text x="${(ml + W - mr) / 2}" y="${H - 6}" text-anchor="middle">cost of one run (log)</text>`;
  g += `<text x="12" y="${(mt + H - mb) / 2}" transform="rotate(-90 12 ${(mt + H - mb) / 2})" text-anchor="middle">AA Intelligence Index v5.0.2</text>`;

  // labels on the right edge with collision nudging, leader lines to points
  const labeled = [...pts].sort((a, b) => Y(a.y) - Y(b.y));
  let lastY = -Infinity; const lab = [];
  for (const p of labeled) { const ly = Math.max(Y(p.y), lastY + 13); lastY = ly; lab.push({ p, ly }); }
  const overflow = lastY - (H - mb); if (overflow > 0) lab.forEach(l => l.ly -= overflow);

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
  $("chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart of quality versus cost">${g}<line class="axis" x1="${ml}" x2="${W - mr}" y1="${H - mb}" y2="${H - mb}"/>${labels}${marks}</svg>`;

  const tip = $("tip");
  $("chart").querySelectorAll("g[data-i]").forEach(el => {
    el.onmousemove = ev => {
      const p = pts[+el.dataset.i];
      const extra = p.kind === "local"
        ? `${tps(p.loc.decodeTps)} tok/s · time ${dur(p.loc.totalS)} (prompt ${dur(p.loc.prefillS)})<br>${p.loc.kWh.toFixed(3)} kWh${p.loc.streaming ? " · streaming from SSD" : ""}`
        : `${Math.round(p.api.inTok)} input tok, ${Math.round(p.api.outTok)} output tok · $${p.api.usd.toFixed(4)}`;
      tip.innerHTML = `<b>${p.m.name}</b><br>${KIND[p.kind].label}<br>AA ${p.y} · ${pln(p.x)} / run · ${pln(p.x * st.runs)} / month<br>${extra}`;
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

function sources() {
  const s = [
    ["Artificial Analysis — leaderboard (Intelligence Index v5.0.2)", "https://artificialanalysis.ai/leaderboards/models"],
    ["Artificial Analysis — open weights models", "https://artificialanalysis.ai/models/open-source"],
    ["Epoch AI — open-weight models lag", "https://epoch.ai/topics/open-models"],
    ["How far behind is open-source AI? (gap in months)", "https://yaroslavvb.github.io/artificial-analysis-oss-lag/"],
    ["colibri — README and measurements", "https://github.com/JustVugg/colibri"],
    ["llmhardware.io — tok/s ceiling formula, bandwidths", "https://llmhardware.io/guides/llm-tokens-per-second"],
    ["Anthropic — API pricing", "https://platform.claude.com/en/docs/about-claude/pricing"],
    ["OpenAI — API pricing", "https://developers.openai.com/api/docs/pricing"],
    ["OpenRouter — open-weight model prices", "https://openrouter.ai/"],
    ["Polish electricity prices 2026 (G11 tariff, avg ~1.04 PLN/kWh gross)", "https://rankomat.pl/nieruchomosci/ceny-pradu"],
    ["LocalScore — measured results on hardware", "https://localscore.ai"],
    ["NBP API — USD exchange rate", "https://api.nbp.pl/"]
  ];
  $("sources").innerHTML = s.map(([t, u]) => `<li><a href="${u}">${t}</a></li>`).join("");
}

function render() {
  const st = state(); const R = rows(st);
  tiles(st, R); table(st, R); chart(st, R);
}
calibration(); sources(); render();
