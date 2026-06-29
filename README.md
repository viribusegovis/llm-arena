# LLM Arena

A browser-based experiment in multi-agent AI: language model instances with distinct personalities compete against each other in social deduction and game theory scenarios. Everything runs locally in the browser - no server, no API keys.

**Live demo:** https://llm-arena.viribus.workers.dev

---

## Games

### Mini-Mafia

Eight LLM agents are secretly assigned roles and play a full hidden-role deduction game.

**Roles:**
- **Mafioso** - eliminates one player each night; must blend in during the day
- **Detective** - privately investigates one player each night, learning their role
- **Medic** - secretly protects one player each night, blocking any kill on that target
- **Villagers (×5)** - no night action; must identify and vote out the mafioso

Each round: night actions resolve privately, then all surviving agents discuss in free text and vote to eliminate a suspect. The mafioso wins if they outlast the town; villagers win if they vote out the mafioso.

Roles are randomised each game. Personalities stay fixed - the same agent can play any role across games, creating genuinely different behaviour depending on whether they're lying or telling the truth.

**Play as the mafioso** - toggle "Play as Mafioso" to take control of the mafioso slot yourself. You choose who to kill each night and what to say during discussion. The LLM agents don't know you're human.

### Iterated Prisoner's Dilemma

Five agents play a 10-round round-robin tournament (10 pairings per round). Each round every agent decides independently whether to cooperate or defect against each opponent, given the full history of prior rounds between them.

**Agents:**
- **tit-for-tat** - cooperates first, then mirrors whatever the opponent did last round
- **always-defect** - defects unconditionally
- **always-cooperate** - cooperates unconditionally
- **adaptive** - no fixed strategy; reads the payoff matrix and round history to maximise its own score
- **counter** - identifies the opponent's pattern and applies the explicit counter (exploit cooperators, match defectors, lock in mutual gains against mirrors)

A live score bar chart and head-to-head payoff heatmap update after every round.

---

## Features

- **Personality leaderboard** - tracks win rates and scores across all games in localStorage; persists across sessions; resets with one click
- **Streaming output** - each agent's reasoning streams token by token into their row as they decide
- **Game controls** - Restart, Pause (between turns), and Stop at any point
- **Tab state preservation** - switching tabs does not restart games; Mafia and IPD run independently and resume where they left off
- **God mode** - in watch-only Mafia, the viewer sees all hidden roles, detective findings, and medic targets

---

## How it works

The model (Qwen3-0.8B, ~500 MB) downloads once on first visit and is cached in the browser's Origin Private File System (OPFS). Subsequent loads take a few seconds.

Structured decisions (who to kill, who to vote out, cooperate vs. defect) use tool calling with an enum constraint so the model must pick from the exact set of legal targets - no parsing needed. Free-text discussion in Mafia streams token by token.

Since wllama does not support concurrent inference, a serial queue in `WllamaClient` ensures only one inference runs at a time across both games. Switching tabs background-pauses the leaving game at the next inter-turn checkpoint; the arriving game resumes from where it was.

---

## Tech stack

| | |
|---|---|
| **Runtime** | [wllama](https://github.com/ngxson/wllama) - llama.cpp compiled to WebAssembly |
| **Model** | Qwen3-0.8B-Q4_K_M (4-bit quantized, via Unsloth on HuggingFace) |
| **GPU** | WebGPU backend (Chrome/Edge on RDNA1+ AMD, recent NVIDIA/Intel) |
| **Build** | Vite + TypeScript |
| **Deploy** | Cloudflare Workers - serves the static bundle and proxies the model download same-origin to avoid CORS |

---

## Requirements

- Chrome or Edge with WebGPU support (Firefox has WebGPU disabled by default)
- A GPU with WebGPU support
- ~600 MB free browser storage for the model cache

---

## Running locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome or Edge. First load downloads the model (~5 min depending on connection). Cached reloads take a few seconds.

```bash
npm test   # 106 unit tests covering both game engines
```

---

## Project structure

```
src/
  referee/    # Game engines: IPD rules, Mafia state machine, phases, win conditions
  agents/     # Agent interfaces, LLMAgents (IPD + Mafia), HumanMafiaAgent
  llm/        # WllamaClient - model loading, serial inference queue, tool calling
  ui/         # Tab switching, persistent game containers, streaming render, leaderboard
```

---

## Implementation notes

- **Thinking mode** (`enable_thinking`) must be explicitly disabled for Qwen3 or the model spends its entire context budget on internal reasoning and outputs nothing
- **GPU offload** requires `n_gpu_layers: -1` — wllama defaults to CPU-only despite the README implying otherwise
- **Concurrent inference** is not supported by wllama; a serial promise queue in `WllamaClient` enforces one call at a time
- **Negative constraints** ("never say X") in system prompts backfire on small models — the forbidden word appears immediately. Positive-only instructions work reliably
- **Self-accusation** — without mitigation, tiny models tend to output the first name they see in the speak prompt. Fix: exclude self from the candidate list and shuffle the remainder
- **Tool calling** for Mafia votes uses `tool_choice: "required"` with an enum of living player IDs. Falls back to a random pick after 3 failed attempts
