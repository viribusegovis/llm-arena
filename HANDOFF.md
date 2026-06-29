# Session handoff — Phase 2 complete

Read `llm-arena-build-plan.md` and `CLAUDE.md` first.

## User context

New to WebGPU and the inference stack; doing this project to deepen AI/systems knowledge. Wants things explained, not just done. Concise answers, no preamble, no em dashes (use hyphens). Using for job applications - keep `main` clean and demo-ready.

## Environment

- Windows 11, AMD RX 5700 XT (RDNA1, 8GB VRAM), Dx12 backend.
- Target browser: Edge only. Firefox has WebGPU disabled.
- Dev server: `npm run dev` (port 5173).
- GitHub: https://github.com/viribusegovis/llm-arena (public, MIT)
- Live prod: https://llm-arena.viribus.workers.dev - auto-deploys on push to `main` via `.github/workflows/deploy.yml`
- Staging: `npm run build && npx wrangler deploy --env staging`

## Repo state

- `main` is clean and up-to-date (all Phase 2 features merged).
- 106 tests passing (`npx vitest run`), TypeScript clean (`npx tsc --noEmit`).

## What is built (Phase 2 — all on main)

### Personality Leaderboard (`src/ui/leaderboard.ts`)
- Third tab "Leaderboard" in the tab bar
- Tracks wins/games per personality for both Mafia and IPD
- Stored in `localStorage` — persists across refreshes
- Reset button clears storage and re-renders
- Mafia: win = your faction won. IPD: win = top scorer that match; also tracks avg pts/game
- Tables sorted by win rate desc, personality names colored with existing accent colors

### IPD: adaptive + counter agents (replaced grudger)
- `adaptive`: no fixed rule — given payoff matrix and round history, uses its own judgment
- `counter`: reads opponent's pattern and applies counter-strategy
- Both LLM-driven. IPD now has 5 agents; games take ~67% longer (10 pairings vs 6)
- adaptive correctly identified and fully exploited always-cooperate (50 pts, all defects)

### Game controls (Restart / Pause / Stop)
- `[Restart] [Pause] [Stop]` group, right-aligned in tab bar
- Pause/Stop hidden while stopped/finished; Restart always visible on game tabs
- All three hidden on Leaderboard tab
- State badge: `⏸ Paused` (amber), `■ Stopped` (red), `✓ Finished` (green)

### Tab state preservation (`src/ui/main.ts` — full rewrite)
- Three persistent containers (`#mafia-container`, `#ipd-container`, `#leaderboard-container`)
  hidden/shown on tab switch instead of destroyed/recreated
- Per-slot state (`Slot` interface: gameId, paused, userPaused, pauseResolve, humanAgent, status)
  replaces global gameId/gamePaused/pauseResolve/currentHumanAgent
- Switching between game tabs: background-pauses the leaving game, auto-resumes arriving game
- Switching to/from Leaderboard: games keep running freely (no model conflict)
- IPD doesn't start until first visited (`slot.gameId === 0` check)
- User-pause state persists across tab switches; background-pause does not

## File layout

```
src/
  agents/
    llm-agent.ts          — base LLM agent (IPD)
    mafia-llm-agent.ts    — Mafia agent with tool-call voting
    human-mafia-agent.ts  — human input agent (mafioso play mode)
  llm/
    wllama-client.ts      — model loader + serial inference queue
  referee/
    ipd.ts                — IPD round logic
    mafia.ts              — Mafia phase/state machine
    types.ts              — shared GameState type
  ui/
    main.ts               — bootstrap, slot state, tab switching, game runners
    render.ts             — layout helpers, agent colors (agentColor exported)
    leaderboard.ts        — localStorage tracking + rendering
index.html                — all CSS inline
```

## Key gotchas (cumulative)

1. GPU offload: `n_gpu_layers: -1` required.
2. Thinking mode: `enable_thinking: false` required AND strip leaked `<think>` tags.
3. Concurrent inference: wllama returns null. Serial via `WllamaClient.inferenceQueue`.
4. Single-word extraction: 100% valid for IPD. Mafia uses tool calling (`tool_choice: "required"`).
5. OPFS cache: per-origin. localhost:5173 and Cloudflare are separate caches. First load ~5 min.
6. Firefox: WebGPU disabled. Edge only.
7. COEP removed from `_headers` - HF CDN doesn't send `Cross-Origin-Resource-Policy`.
8. wllama URL validation: `loadModelFromUrl` requires URL ending in `.gguf`.
9. HF XET CDN strips Content-Length. Fallback: hardcoded `535_171_328` bytes.
10. llama.cpp console noise: `slot ` and `srv ` prefixes suppressed in LOG_SKIP.
11. `/__log` 404 on Cloudflare: health-checked once at startup; logging silenced if not ok.
12. Mafia tool calling: `tool_choice: "required"` forces tool response. 3x retry then random fallback.
13. Negative constraints in prompts backfire on 0.8B models. Use positive-only instructions.
14. Tab/toggle cancellation: `GameCancelledError` thrown after each `agent.decide()` if `shouldStop()` returns true.
15. Self-accusation: tiny models output the first name in the speak prompt. Fix: exclude self, shuffle remainder.
16. Pause only works between turns (phases for Mafia, rounds for IPD) — cannot halt mid-inference.
17. adaptive agent correctly identified and fully exploited always-cooperate (unexpected capability for 0.8B).
18. Tab state: `slot.gameId === 0` = never started. `cancelSlot` increments gameId; `releaseSlot` lifts pause without cancelling.
