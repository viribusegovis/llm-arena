# In-Browser LLM Arena — Build Plan

A single static web page. Several instances of a tiny LLM (Qwen3.5-0.8B-Instruct, Q4) run client-side via wllama on WebGPU, each with a personality, playing a turn-based social game. A deterministic referee owns all rules and state; the models never touch game state — they only emit moves (`play`, `speak`, `vote`) which the referee validates and applies. Agents "communicate" only through a shared transcript the referee feeds back into each one's context. $0 to host: no server, no inference API, no token bill. Phase 1 game = Iterated Prisoner's Dilemma. Stretch = Mini-Mafia.

It looks like a frontend toy; it's actually a systems project (quantized in-browser inference, WebGPU, validated decoding, clean engine/agent split).

---

## Ground rules for the implementing agent (read first)

- **Don't proceed past a phase gate until its exit criteria pass.** Phase 0 is a hard gate. If the spike fails, stop and fix model/quant/backend before writing game code.
- **Verify library APIs against the installed version — do not trust signatures written in this doc.** wllama is bleeding-edge (WebGPU landed in v3, early 2026) and the API moves. Read the actual examples in the installed package (`examples/main/`, `examples/tools/`) and the live docs before calling anything. Do not invent methods, params, or flags.
- **Build the referee with `RandomAgent` and unit-test it completely before wllama exists in the codebase.** The referee must be fully testable with zero model calls.
- **YAGNI.** Two agent implementations, one game first. No strategy-plugin system, no agent factory, no message bus, no speculative config. Add the second game only after the first is solid.
- **Say what you verified vs assumed.** Don't claim something runs unless you ran it.

---

## What's verified vs what the spike must confirm

**Verified (as of mid-2026 — re-check, versions move):**
- wllama v3.x runs heavy compute on **WebGPU** (matmul etc. in WGSL shaders on the GPU); WASM only handles loading/orchestration. This is why both the WASM caveats (Memory64, SharedArrayBuffer/COOP-COEP) **and** the WebGPU caveats apply at once — they're two layers, not a contradiction.
- wllama v3 has **tool calling**, **OPFS model caching**, and an OpenAI-compatible **`createChatCompletion`** that is **stateless per call** (you pass the full `messages` array each time).
- **Qwen3.5-0.8B is real** (released ~March 2026, Apache 2.0). It is **multimodal** (vision encoder), uses a **Gated DeltaNet hybrid** architecture (linear-attention, not a plain transformer), 262K context, and **thinking mode is OFF by default** on the small models.
- **Qwen3.5-2B Q4** is confirmed runnable on the wllama WebGPU demo → it's a validated fallback if 0.8B is too weak.
- Axelrod IPD payoffs are correct: CC = 3/3, CD = 0/5, DC = 5/0, DD = 1/1.

**Must confirm in the Phase 0 spike (docs can't answer these):**
1. Does Qwen3.5-0.8B run **fully on the WebGPU backend** on this machine (AMD RX 5700 XT, RDNA1) with **no per-op fallback to CPU/WASM**? The WebGPU backend is new and operators are still being added; ggml can silently run unsupported ops on CPU and tank throughput.
2. What is the **valid-output rate** at this size/quant, and is **single-word output** or **tool calling** more reliable for the move choice?
3. Does wllama expose **GBNF grammar enforcement**? Treat the answer as **no** and validate regardless; if it turns out yes, add it as belt-and-suspenders only.

---

## Locked decisions

| Choice | Decision | Why |
|---|---|---|
| Runtime | wllama v3.1+ (WASM orchestration + WebGPU compute, OPFS cache, tool calling) | Heavy compute on GPU by default; OpenAI-compatible typed API |
| Model | **Qwen3.5-0.8B-Instruct** at **Q4** (Q4_K_M, or an Unsloth dynamic `UD-Q4_K_XL` — similar size, better quality) | NOT the **Base** model (Base is for fine-tuning, not direct chat). NOT IQ/imatrix quants. Non-thinking mode (default) avoids loop bugs. |
| Language | TypeScript | — |
| Build tool | Vite | Dev server sets the COOP/COEP headers multithread needs |
| State ownership | Referee owns everything: rules, payoffs, transcript, per-agent memory, win checks. Models own only the choice of which legal action to take. | — |

---

## Phase 0 — De-risk spike (HARD GATE — do this before any game code)

Throwaway branch. The project hinges on one empirical question: can this model at this quant reliably emit a valid, parseable move in the browser on this GPU? Answer it in isolation.

**Step 0 — Hardware/WebGPU check (5 minutes, do this literally first).**
This kills the two cheapest-to-check risks (AMD WebGPU support + the multimodal model packaging) before any code:
- ✅ **CONFIRMED (`chrome://gpu`):** default adapter selects the discrete GPU — `AMD Radeon RX 5700 XT`, `DiscreteGpu`, `isFallbackAdapter: false`, **Dx12** backend, **8 GB** VRAM, `shader-f16` present, driver dated 2026-06-19. WebGPU adapter init is not a risk; skip re-running this check. (Still unconfirmed: that wllama's backend runs Qwen3.5's Gated DeltaNet ops with no per-op CPU fallback — that's Step 1.)
- Load any existing in-browser WebGPU LLM demo (the wllama demo, or a web-llm chat demo) and confirm it **actually generates tokens** on the GPU. If this runs, the hardware risk is gone.
- ⚠️ A native desktop chatbot (LM Studio / Ollama / koboldcpp) running "on GPU" does **not** prove this — those use Vulkan/ROCm/D3D natively, which is a different path from the browser's WebGPU API.

**Step 1 — Load + one completion.**
- Vite + TS skeleton, COOP/COEP headers on.
- Load wllama. Load **Qwen3.5-0.8B-Instruct Q4** as a **text GGUF** from the HF hub (an Unsloth or equivalent GGUF repo — confirm the exact repo id; do not assume the path). **Do not load the `mmproj` vision file** — this is a text-only game.
- Confirm a plain `createChatCompletion` returns coherent text from a text-only prompt (this also confirms the chat template works without vision).
- Confirm it's on the **WebGPU backend with no per-op CPU fallback** (check wllama/ggml backend logs — "GPU is being used" is not enough; an op silently on CPU will wreck throughput).
- Confirm the **second load is instant** (OPFS cache working).

**Step 2 — Throughput sanity.** Measure tokens/sec on the RX 5700 XT. Decide if it's tolerable for sequential multi-agent turns.

**Step 3 — Get a move out, BOTH ways.** Define the move as a 2-value choice (`cooperate | defect`) and implement two extraction paths:
- **(a) Single-word output:** prompt for exactly one word, parse the first in-enum token.
- **(b) Tool call:** define a `pick(move)` tool with the enum, parse `tool_calls` off the response. Read the exact API from `examples/tools/` — don't guess the signature.

**Step 4 — Stress test, pick the winner.** Crank temperature, run each path ~50×, measure **valid in-enum rate** and parse failures for (a) vs (b). Keep whichever wins. (Expectation: single-word wins for a 2-value choice on a 0.8B model — less structure to get wrong — but **measure, don't assume**. Either way it's an internal detail of `LLMAgent`, so switching later is free.) This number sets your retry/fallback logic. If both are bad even at Q4, that's the signal to bump to **Qwen3.5-2B Q4**.

**Step 5 — Two personalities, sequential.** wllama won't do concurrent contexts on WASM and `createChatCompletion` is stateless, so: **one loaded instance, agents run sequentially, referee builds a fresh `messages` array per agent per turn.** This is also the natural fit — turn-based games have one agent thinking at a time, and hidden-info games need different context per agent anyway. Confirm a second "agent" (different system prompt, same instance) gives a sensibly different answer.

**Exit criteria:** you can reliably get a valid, parsed move from the model, twice in a row with two different personalities, **on the WebGPU backend with no CPU-fallback ops**, with a known invalid-rate you can handle. If you can't hit this, stop and fix model/quant/validation before building the game.

---

## Architecture — the one seam that matters

```ts
interface Agent {
  decide(view: AgentView): Promise<Move>;
}
```

- **`AgentView`** — exactly what this agent may see this turn: its personality, its private memory, the public transcript (trimmed), current phase, and the list of legal moves. The referee builds it. For hidden-info games, information asymmetry lives here and nowhere else.
- **`Move`** — a validated discriminated union: `{kind:"play", move}`, `{kind:"speak", text}`, `{kind:"vote", target}`.

Two implementations, and only two:
- **`RandomAgent`** — picks a random legal move. Lets you build and test the entire referee with zero model.
- **`LLMAgent`** — wraps wllama: builds `messages` from `AgentView`, gets a move (via whichever extraction path won the spike), validates, retries once on garbage, returns the `Move`.

No strategy-plugin system, agent factory, or message bus. Two implementations is the real second use case that justifies the interface — nothing beyond that.

### Validation: split the two responsibilities cleanly

Don't duplicate "validation" across the agent and the referee — they validate different things:
- **`LLMAgent` does *syntactic* validation.** Is the output parseable and in the offered legal set? Retry once on garbage, then fall back to a default legal move. It always hands the referee a **well-formed `Move` drawn from the legal set in the `AgentView`**.
- **The referee does *legal* validation and is the final authority.** Given current state/phase, is this `Move` actually allowed? It should already be (the agent picked from the legal set), but the referee re-checks as a safety net and applies a default legal move if not. The referee owns all state; the agent never touches it.

For IPD both moves are always legal, so referee-side legality is trivial — but build the seam now so Mafia (where legality depends on state, e.g. can't vote a dead player) drops in without rework.

---

## Referee — pure, testable, no model

Holds game state, applies moves, computes outcomes, manages transcript + per-agent memory, decides legal moves per phase, checks win condition, performs legal validation. **Zero model calls** — fully unit-testable by feeding it scripted/random moves. Build and test it completely with `RandomAgent` before wllama is in the codebase.

---

## Phase 1 — Iterated Prisoner's Dilemma (the weekend build)

Simplest game that exercises the full pipeline.

Loop:
- Agents play pairwise, round-robin. Each round an agent sees: its personality, the history of (my move / opp move) vs the current opponent, optionally recent trash-talk.
- Each agent emits `play(cooperate|defect)`, optionally `speak(text)`.
- Referee applies the payoff matrix (CC 3/3, CD 0/5, DC 5/0, DD 1/1) and updates cumulative scores.
- Repeat N rounds; aggregate across all pairings.

This re-stages Axelrod 1980 but with LLM-personality strategies instead of fixed algorithms. The entertainment is watching a "paranoid" or "naive" personality make characteristically bad *legal* choices.

**Sampling config:** the spike cranks temperature to stress-test; **actual play wants low temperature** (start ~0.3–0.7, tune) for sensible behavior, **plus a fixed seed or full transcript logging** so you can debug "why did paranoid-agent defect here." These are two different configs — set both up front. (Temp values are starting points, not gospel.)

Visual: payoff heatmap (who exploited whom) + live cumulative score bars.

Milestones:
- **1a** — Referee + IPD rules + `RandomAgent`, unit-tested, runs headless in console.
- **1b** — Swap `LLMAgent` in for one player, rest random. One full match end-to-end.
- **1c** — All-LLM match, 3–4 distinct personalities.
- **1d** — Minimal UI: scores + heatmap; each agent's move and speak-line animates in as it decides (the wait reads as drama, not lag — and stream tokens so it never looks hung; sequential 0.8B turns over a full round-robin can run into minutes).

---

## Phase 2 (stretch) — Mini-Mafia

Only after Phase 1 is solid. Adds hidden roles, night/day phases, voting, elimination, and information asymmetry (mafioso knows who they are; villagers don't). The `AgentView` abstraction already handles asymmetry — the referee just hands each role a different view. This is also where **tool calling earns its place** (structured actions: vote target, night action), if single-word won Phase 1.

Crib rules/flow from `bastoscostadavi/llm-mafia-game` (verify it still exists / matches your needs before relying on it). Their 4-player Mini-Mafia (1 mafioso, 1 detective, 2 villagers, fixed night actions, single day phase) is the smallest meaningful version — target that before full Werewolf. Memory stays referee-owned per agent; do not let the 0.8B model manage its own memory.

---

## File layout (right-sized — don't over-split)

```
index.html
src/
  referee/
    types.ts          # GameState, AgentView, Move
    ipd.ts            # IPD rules + payoffs + win check + legal validation
  agents/
    agent.ts          # Agent interface
    random-agent.ts   # for testing the referee with no model
    llm-agent.ts      # wllama-backed: build messages, extract move, syntactic validate + retry
  llm/
    wllama-client.ts  # load model, completion/tool-call, OPFS cache, progress
  ui/
    main.ts
    render.ts         # heatmap + score bars
```

---

## Known gotchas (verified against wllama v3 docs)

- **Use the Instruct model, not Base.** The Base model card explicitly says it's not for direct interaction.
- **The model is multimodal** — its GGUF splits the vision part into a separate `mmproj` file. For a text-only game, don't download or load it; just the main text GGUF.
- **Gated DeltaNet on a new backend is the real risk.** Qwen3.5 isn't a plain transformer; the llama.cpp WebGPU backend is weeks/months old with incomplete operator coverage. Confirm in the spike that nothing falls back to CPU.
- **Safari is out** — wllama's build requires Memory64, unsupported in Safari.
- **Firefox** — works only via `setCompat('default', 'firefox_safari')`, with significantly degraded performance. Chrome/Edge are the real targets.
- **Multithread needs cross-origin isolation** — COOP (`same-origin`) + COEP (`require-corp`) headers, or SharedArrayBuffer is unavailable. Vite dev server sets them. For $0 deploy use **Cloudflare Pages or Netlify** (both allow a `_headers` file on free tier) — **not** vanilla GitHub Pages (can't set headers; or use the `coi-serviceworker` hack). Single-thread works without the headers but slower.
- **First load is a multi-hundred-MB download** → multi-second cold start. OPFS cache makes repeat visits instant; show a real progress bar (`progressCallback` gives `{loaded, total}`).
- **Keep contexts SMALL** — a 0.8B model drowns in long history (even though it *supports* 262K). Feed each agent a trimmed transcript, not the full log.
- **Don't enable thinking mode** — off by default on the small models; leave it off.
- **Full GPU offload is fine** — a 0.8B Q4 model (~0.5 GB) + KV cache fits easily in the 5700 XT's 8 GB VRAM. `n_gpu_layers` in `LoadModelParams` only matters if a model is too big for VRAM, which this isn't.
- **Split the GGUF into ≤512 MB chunks** only if you self-host weights (parallel download, avoids OOM). Loading direct from HF hub: not your problem.
- **`createChatCompletion` is stateless** — pass the full `messages` each call. No persistent sequence to manage, which is exactly what referee-owns-state wants.

---

## First commit target

The Phase 0 spike, on a throwaway branch, starting with Step 0 (the `chrome://gpu` + WebGPU-demo check). Do not start the game until the spike's exit criteria pass — everything downstream depends on reliable, GPU-resident tool/move output, and that's the one thing no amount of planning can confirm.

---

## References (re-check — fast-moving)

- wllama: https://github.com/ngxson/wllama — docs: https://github.ngxson.com/wllama/docs/
- wllama WebGPU writeup: https://reeselevine.github.io/llamas-on-the-web/
- Qwen3.5-0.8B (Base card, links to family/blog): https://huggingface.co/Qwen/Qwen3.5-0.8B-Base — find the **Instruct** + GGUF repos from the Qwen3.5 collection
- Qwen3.5 local-run notes (thinking off by default, mmproj/GGUF caveats): https://unsloth.ai/docs/models/qwen3.5
