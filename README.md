# LLM Arena

A browser-based Iterated Prisoner's Dilemma tournament where language model agents compete against each other using distinct personality strategies. Everything runs locally in the browser - no server, no API keys.

**Live demo:** https://llm-arena.viribus.workers.dev

## What it does

Four LLM agents (tit-for-tat, always-defect, always-cooperate, grudger) play 10 rounds of round-robin IPD. A live UI shows token streaming as each agent decides, a score bar chart that updates after every round, and a head-to-head payoff grid.

The model (Qwen3.5-0.8B, ~500 MB) downloads once and is cached in the browser's OPFS storage. Subsequent loads take a few seconds.

## Tech stack

- **Runtime**: [wllama](https://github.com/ngxson/wllama) - runs llama.cpp compiled to WebAssembly
- **Model**: Qwen3.5-0.8B-Q4_K_M (4-bit quantized, via Unsloth on HuggingFace)
- **GPU**: WebGPU backend (RDNA1+ on AMD, recent NVIDIA/Intel)
- **Build**: Vite + TypeScript

## Requirements

- Edge or Chrome with WebGPU enabled (Firefox has WebGPU disabled)
- A GPU with WebGPU support
- ~600 MB free browser storage for the model cache

## Running locally

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` in Edge or Chrome. First load downloads the model (~5 min depending on connection). Cached reloads take a few seconds.

```bash
npm test   # run the 21 unit tests for the referee/IPD logic
```

## Project structure

```
src/
  referee/    # IPD rules, payoff matrix, game state
  agents/     # Agent interface, RandomAgent, LLMAgent
  llm/        # WllamaClient - model loading and inference
  ui/         # Entry point, DOM layout, render functions
```

## Phases

- **Phase 0** - de-risk spike: confirmed WebGPU inference, GPU offload, streaming API, OPFS cache
- **Phase 1** - referee + LLM agents + minimal UI (current)
- **Phase 2** - planned: Mini-Mafia (hidden roles, night/day phases, voting, elimination)

## Notes

- Thinking mode (`enable_thinking`) must be explicitly disabled for Qwen3.5 or the model spends its entire token budget on an internal chain-of-thought and returns nothing
- GPU offload requires `n_gpu_layers: -1` - wllama defaults to CPU-only
- wllama crashes on concurrent inference calls; agents decide sequentially
