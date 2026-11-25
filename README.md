# Local or cloud?

**🔗 Live page: https://dryguz.github.io/llm-local-vs-frontier/**

A static dashboard (GitHub Pages) comparing open-weight and frontier LLMs along four dimensions:

1. **Quality**: Artificial Analysis Intelligence Index v5.0.2, plus task-specific views built from its component evaluations: Coding (FrontierCode-AA 2.0 + Terminal-Bench 4.1), Agentic workflows (AutomationBench-AA), Long documents (GDP.pdf) and Knowledge reliability without sources (AA-Omniscience net score).
2. **Hardware**: whether a model fits in RAM/VRAM, or can run with experts streamed from SSD (colibri-style).
3. **Time**: estimated generation and prompt-processing speed, turned into the time one task takes.
4. **Cost**: local electricity vs API tokens (Anthropic, OpenAI, hosted open-weight models), in USD, EUR or PLN.

A **use case** selector (daily brief, long document, coding, agentic workflow, quick question, general use) sets both the token profile and the most relevant quality metric.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
node tests/calibrate.mjs      # compare the engine with colibri measurements
node tests/calibrate.mjs 8    # same, with a different skew parameter
```

GitHub Pages: Settings → Pages → Deploy from a branch → `main` / root.

## Layout

| File | Contents |
|---|---|
| `data/models.json` | models: AA index, per-benchmark scores, total/active params, API prices, colibri support |
| `data/hardware.json` | machines: memory tiers (capacity, bandwidth), SSD, FLOPS, power draw |
| `data/calibration.json` | decode tok/s measurements from the colibri README |
| `data/harness.json` | AA Coding Agent Index for the same model across coding-agent harnesses |
| `assets/engine.js` | estimation engine (pure functions, also runs in Node) |
| `assets/app.js` | UI |

All data files can be edited without touching JavaScript. Each one carries its sources and the date it was read in `_meta`.

## How the estimates work

- **Generation** (established mechanism): time/token ≈ Σ bytes of active weights read from each memory tier / (bandwidth × 0.6) + overhead.
- **MoE + SSD streaming** (speculative): the dense part goes to the fastest memory, experts form a pool. A hot-expert cache holding fraction c of the pool serves `1-(1-c)^skew` of the accesses; skew = 6.5 is fitted to a single measurement (GLM-5.2 on Ryzen AI Max+ 395).
- **Prompt processing** (speculative): 2 × active params × tokens / effective FLOPS; in SSD mode the SSD-resident pool is also read once per 2048-token prompt chunk.
- **Electricity**: power × time × price per kWh. Hardware amortization is not included.
- **Currency**: everything is computed in USD (API list prices) and converted with ECB reference rates (Frankfurter), with NBP as fallback. Default electricity price: Poland 2026 G11 average, 1.04 PLN/kWh.

## Known limitations (v0.x)

- For small MoE models on CPU the engine overestimates speed by about 4–5× (compute and engine overhead are not modelled).
- FLOPS and power draw in `hardware.json` are estimates; replace them with measurements (`llama-bench`, a wall meter).
- Quality scores are published scores for AA's setup. Local quantization, sampling settings, chat templates and harness choice can lower them; none of this is modelled. On coding, AA measured a 28–35% drop between the best and worst harness for the same model.
- No AA benchmark measures faithfulness to provided sources directly; GDP.pdf is used as the closest proxy for summarising tasks.
- Per-benchmark values were read from AA's rendered charts and must be updated by hand.
- No hardware amortization, multi-GPU, prompt caching or batch pricing.

## To do

- [ ] Hardware amortization (price / years of use) as an optional cost component.
- [ ] Import your own measurements (`llama-bench` JSON).
- [ ] A separate CPU calibration (compute term in decode).
- [ ] Automated data refresh (GitHub Action) where a source offers an API.
- [ ] Harness comparison for more open-weight models once AA publishes them.
