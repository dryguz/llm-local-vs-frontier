// node tests/calibrate.mjs  — compares engine predictions with colibri README measurements.
import { readFileSync } from "node:fs";
import { estimateLocal } from "../assets/engine.js";

const load = p => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url)));
const hw = Object.fromEntries(load("hardware.json").hardware.map(h => [h.id, h]));
const cal = load("calibration.json").points;

const skew = process.argv[2] ? Number(process.argv[2]) : undefined;
for (const p of cal) {
  if (!p.hw_id || p.active_b == null) { console.log(`--  ${p.label}: measured ${p.measured_lo}–${p.measured_hi} (no prediction: ${p.hw_note})`); continue; }
  const e = estimateLocal({ total_b: p.total_b, active_b: p.active_b }, hw[p.hw_id],
    { ramOverrideGb: p.ram_override_gb, cold: p.cold, ...(skew ? { skew } : {}) });
  const mid = (p.measured_lo + p.measured_hi) / 2;
  console.log(`${(e.decodeTps / mid).toFixed(2).padStart(6)}x  ${p.label}: pred ${e.decodeTps.toFixed(2)} vs meas ${p.measured_lo}–${p.measured_hi}  [${e.breakdown.map(b => `${b.tier} ${(b.sec*1000).toFixed(0)}ms`).join(", ")}]`);
}
