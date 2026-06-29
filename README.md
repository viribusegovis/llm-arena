# LLM Arena

A browser-based experiment in multi-agent AI: language model instances with distinct personalities compete against each other in social deduction and game theory scenarios. Everything runs locally in the browser - no server, no API keys.

**Live demo:** https://llm-arena.viribus.workers.dev

## Games

### Mini-Mafia
Eight LLM agents are secretly assigned roles (mafioso, detective, medic, villagers) and play a full hidden-role deduction game. Each night the mafioso eliminates a player, the detective investigates one, and the medic protects one. Each day agents discuss in free text and vote to eliminate a suspect. Roles are randomised each game; personalities stay fixed.

### Iterated Prisoner's Dilemma
Four agents (tit-for-tat, always-defect, always-cooperate, grudger) play a 10-round round-robin tournament. A live score bar chart and head-to-head payoff grid update after every round.

Both games share the same model instance. Switch between them with the tab bar at the top.

## How it works

The model (Qwen3.5-0.8B, ~500 MB) downloads once and is cached in the browser's OPFS storage. Subsequent loads take a few seconds. Structured decisions (who to kill, who to vote out) use tool calling with an enum constraint so the model must pick from the exact set of legal targets. Free-text discussion streams token by token into each player's row.

## Tech stack

- **Runtime**: [wllama](https://github.com/ngxson/wllama) - llama.cpp compiled to WebAssembly
- **Model**: Qwen3.5-0.8B-Q4_1 (4-bit quantized, via Unsloth on HuggingFace)
- **GPU**: WebGPU backend (RDNA1+ AMD, recent NVIDIA/Intel)
- **Build**: Vite + TypeScript
- **Deploy**: Cloudflare Workers (model proxied same-origin to avoid CORS)

## Requirements

- Edge or Chrome with WebGPU enabled (Firefox has WebGPU disabled)
- A GPU with WebGPU support
- ~600 MB free browser storage for the model cache

## Running locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Edge or Chrome. First load downloads the model (~5 min depending on connection). Cached reloads take a few seconds.

```bash
npm test   # 102 unit tests covering both game engines
```

## Project structure

```
src/
  referee/    # Game engines: IPD rules + Mafia state machine, phases, win conditions
  agents/     # Agent interfaces, RandomAgents, LLMAgents (IPD + Mafia)
  llm/        # WllamaClient - model loading, serial inference queue, tool calling
  ui/         # Tab switcher, game runners, streaming render functions
```

## Phases

- **Phase 0** - de-risk spike: confirmed WebGPU inference, GPU offload, streaming API, OPFS cache
- **Phase 1** - IPD referee + LLM agents + live UI (complete)
- **Phase 2** - Mini-Mafia with hidden roles, night/day phases, tool-call decisions, streaming speech (complete)

## Notes

- Thinking mode (`enable_thinking`) must be explicitly disabled for Qwen3.5 or the model spends its entire token budget on internal reasoning and returns nothing
- GPU offload requires `n_gpu_layers: -1` - wllama defaults to CPU-only
- wllama does not support concurrent inference; a serial queue in WllamaClient enforces one call at a time
- Negative constraints ("never say X") in system prompts backfire on small models; positive-only instructions work better
