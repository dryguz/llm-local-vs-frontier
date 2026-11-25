// Estimation engine. Pure functions, no DOM — runs in the browser and in Node (tests/calibrate.mjs).
//
// Mechanism (decode): generating one token reads every *active* weight once, so
//   time/token ≈ Σ_tiers bytes_read_from_tier / (bandwidth_tier × efficiency) + fixed overhead.
// Tiers: VRAM → RAM → SSD (SSD only in "streaming" mode, colibri-style).
// MoE: dense part (attention, shared experts, embeddings) is read every token and is placed first
// in the fastest tier. Routed experts form a pool; a learned hot-set cache means the fraction c of the
// pool held in fast tiers serves more than c of the accesses: hit(c) = 1 − (1 − c)^skew.
// skew = 1 → uniform access (plain mmap); skew > 1 → hot experts (calibrated on colibri GLM-5.2 data).
//
// Prefill: compute-bound: 2 × active params × prompt tokens / effective FLOPS; in streaming mode each
// prompt chunk touches (nearly) every expert, so the SSD-resident part of the pool is read once per chunk.

export const DEFAULTS = {
  bytesPerParam: 0.56,      // ~Q4_K_M / int4 group-scaled (≈4.5 bit)
  memEff: 0.6,              // achieved / peak memory bandwidth during decode
  ssdEff: 0.8,              // achieved / peak sequential SSD read (large preads)
  denseFracOfActive: 0.3,   // MoE: share of active params that are dense/shared (read every token)
  skew: 6.5,                // expert hot-set skew (calibrated, see tests/calibrate.mjs)
  overheadMs: { cpu: 5, unified: 5, gpu: 4 },
  prefillChunk: 2048,       // tokens per prefill chunk in streaming mode
  mode: "streaming"         // "fit" = must fit in RAM/VRAM, "streaming" = colibri-style SSD tier
};

export function estimateLocal(model, hw, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (model.total_b == null || model.active_b == null) return { ok: false, reason: "no parameter data" };

  const GB = 1e9;
  const bpp = o.bytesPerParam;
  const totalBytes = model.total_b * GB * bpp;
  const activeBytes = model.active_b * GB * bpp;
  const isDense = model.dense || model.total_b === model.active_b;
  const denseActive = isDense ? activeBytes : activeBytes * o.denseFracOfActive;
  const expertPerToken = activeBytes - denseActive;
  const pool = totalBytes - denseActive;               // routed-expert pool (0 for dense)

  const tiers = hw.tiers.map(t => ({ ...t, capB: (t.cap_gb ?? 0) * GB }));
  if (opts.ramOverrideGb != null) tiers[tiers.length - 1].capB = opts.ramOverrideGb * GB;
  const memCap = tiers.reduce((s, t) => s + t.capB, 0);

  if (o.mode === "fit" && totalBytes > memCap)
    return { ok: false, reason: `does not fit (${fmtGB(totalBytes)} > ${fmtGB(memCap)})`, totalBytes };
  if (denseActive > memCap)
    return { ok: false, reason: "dense part does not fit in memory", totalBytes };

  // place dense part, then expert pool, fastest tier first
  let remainingDense = denseActive, remainingPool = pool;
  const place = tiers.map(t => {
    let free = t.capB;
    const d = Math.min(remainingDense, free); remainingDense -= d; free -= d;
    const p = Math.min(remainingPool, free); remainingPool -= p;
    return { tier: t, dense: d, pool: p };
  });
  const ssdPool = remainingPool;                       // what is left lives on SSD
  const streaming = ssdPool > 1;

  // access fraction of expert reads served by each tier (cumulative hot-set model)
  const skew = isDense ? 1 : (o.cold ? 1 : o.skew);
  const hit = c => (pool <= 0 ? 1 : 1 - Math.pow(1 - Math.min(1, c), skew));
  let cum = 0, prevHit = 0, t = 0;
  const breakdown = [];
  for (const p of place) {
    cum += p.pool;
    const h = hit(pool > 0 ? cum / pool : 1);
    const expertBytes = expertPerToken * (h - prevHit);
    prevHit = h;
    const denseBytes = denseActive * (p.dense / denseActive || 0);
    const bytes = expertBytes + denseBytes;
    const sec = bytes / (p.tier.bw_gbs * GB * o.memEff);
    t += sec;
    breakdown.push({ tier: p.tier.name, bytes, sec });
  }
  if (streaming) {
    const bytes = expertPerToken * (1 - prevHit);
    const sec = bytes / (hw.ssd_gbs * GB * o.ssdEff);
    t += sec;
    breakdown.push({ tier: "SSD", bytes, sec });
  }
  t += (o.overheadMs[hw.class] ?? 5) / 1000;
  const decodeTps = 1 / t;

  return {
    ok: true, streaming, decodeTps, secPerToken: t, breakdown, totalBytes,
    ssdBytes: ssdPool, memCap,
    prefill: (promptTokens) => prefillSeconds(model, hw, o, promptTokens, ssdPool)
  };
}

function prefillSeconds(model, hw, o, promptTokens, ssdPool) {
  const compute = (2 * model.active_b * 1e9 * promptTokens) / (hw.tflops * 1e12);
  const chunks = Math.ceil(promptTokens / o.prefillChunk);
  const stream = ssdPool > 1 ? (chunks * ssdPool) / (hw.ssd_gbs * 1e9 * o.ssdEff) : 0;
  return compute + stream;
}

export function taskLocal(model, hw, scen, opts = {}) {
  const e = estimateLocal(model, hw, opts);
  if (!e.ok) return e;
  const genTokens = scen.outputTokens + scen.reasoningTokens;
  const prefillS = e.prefill(scen.inputTokens);
  const decodeS = genTokens / e.decodeTps;
  const totalS = prefillS + decodeS;
  const kWh = (hw.power_w * totalS) / 3600 / 1000;
  const costPLN = kWh * scen.pricePerKWh;
  return { ...e, prefillS, decodeS, totalS, kWh, costPLN };
}

export function taskApi(model, scen) {
  if (model.price_in == null || model.price_out == null) return { ok: false, reason: "no API price" };
  const m = model.token_multiplier ?? 1;
  const inTok = scen.inputTokens * m;
  const outTok = (scen.outputTokens + scen.reasoningTokens) * m;
  const usd = (inTok * model.price_in + outTok * model.price_out) / 1e6;
  return { ok: true, usd, costPLN: usd * scen.usdPln, inTok, outTok };
}

export function fmtGB(b) { return `${(b / 1e9).toFixed(b < 10e9 ? 1 : 0)} GB`; }
