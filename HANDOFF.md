# Session handoff — Phase 1 complete, Phase 2 ready to start

Read `llm-arena-build-plan.md` and `CLAUDE.md` first. This file is the volatile "where we left off" doc — update or delete it as work progresses.

## User context

New to WebGPU and this inference stack; doing this project to deepen AI/systems knowledge. Wants things explained, not just done. Prefers concise answers, no preamble. No em dashes (use hyphens instead). Using this project for job applications — keep `main` clean and demo-ready at all times.

## Environment (confirmed)

- Windows 11, AMD RX 5700 XT (RDNA1, 8GB VRAM), Dx12 backend.
- Target browser: Edge only. Firefox has WebGPU disabled.
- Dev server: `npm run dev` (port 5173). COOP + COEP headers active locally.
- GitHub repo: https://github.com/viribusegovis/llm-arena (public, MIT)
- Cloudflare Workers deploy: https://llm-arena.viribus.workers.dev (auto-deploys on push to `main` via GitHub Actions)

## Repo state

- Active branch: `feat/phase-2-mafia` (created, no commits yet)
- `main` is clean and deployed. Last commit on main: `dc635ce`
- CI/CD: `.github/workflows/deploy.yml` — triggers on push to `main` only. Feature branches do not deploy.

## What was done this session

- README updated with live URL and correct Phase 2 description (Mini-Mafia)
- GitHub Actions workflow added (`npm ci` + `npm run build` + `wrangler-action@v3`)
- `package-lock.json` added and committed (was previously gitignored; required for `npm ci`)
- Node bumped to 24 in the workflow (20 was deprecated)
- "How it works" explainer section added to the page (below the log): IPD payoff matrix, agent descriptions, what the streaming box and heatmap show
- Cloudflare workers.dev subdomain changed from `bmsffreitas1` to `viribus`
- Progress bar fix: Cloudflare Workers strips Content-Length from streamed responses, so `total` arrives as 0 in wllama's progressCallback. Fixed by using the known model size (535_171_328) as fallback so the bar shows a real percentage

## Phase 1 milestone status

- 1a - 1d: all complete and deployed
- 21 unit tests passing (`npm test`)

## File layout (current)

```
index.html                # All CSS inline in <style> block; #app mount point only
src/
  worker.ts               # Cloudflare Worker: /model.gguf proxy + static assets
  referee/
    types.ts              # Move, GameState, AgentView, RoundResult
    ipd.ts                # payoffs, runRound, createInitialState, isLegalMove
    ipd.test.ts           # 21 Vitest tests
  agents/
    agent.ts              # Agent interface
    random-agent.ts       # RandomAgent
    llm-agent.ts          # LLMAgent — streams on first attempt only
  llm/
    wllama-client.ts      # WllamaClient — load, complete (streaming + non-streaming)
  ui/
    main.ts               # Entry point — match runner, dev logger, ArenaUI wiring
    render.ts             # initLayout, renderScoreBars, renderHeatmap -> ArenaUI object
public/
  _headers                # Cloudflare: COOP only (COEP removed, see gotchas)
wrangler.toml             # main = src/worker.ts; assets.directory = ./dist; binding = ASSETS
vite.config.ts            # COOP+COEP headers locally; file-logger plugin; /model.gguf dev proxy
.github/workflows/deploy.yml  # CI/CD: build + wrangler deploy on push to main
```

## Model

- Repo: `unsloth/Qwen3.5-0.8B-GGUF`
- File: `Qwen3.5-0.8B-Q4_1.gguf` (535,171,328 bytes, ~510 MB)
- Served via: `/model.gguf` on the same origin (Worker proxies to HuggingFace server-side)
- MODEL_URL: `${window.location.origin}/model.gguf` (works in both dev and prod)

## Key gotchas (cumulative from all sessions)

1. GPU offload: `n_gpu_layers: -1` required. Already set.
2. Thinking mode: `enable_thinking: false` required. Already set.
3. Concurrent inference: crashes wllama. `runRound` calls agents sequentially. Already fixed.
4. Single-word extraction: 100% valid, ~187ms/run. Already implemented.
5. OPFS cache: per-origin. `localhost:5173` and Cloudflare are separate caches. First load ~5 min, cached ~2-5s.
6. Firefox: WebGPU disabled. Only test in Edge.
7. COEP removed from Cloudflare `_headers` — HF's LFS CDN doesn't send `Cross-Origin-Resource-Policy: cross-origin`. wllama falls back to single-thread without COEP (WebGPU still works). Local dev keeps COEP.
8. wllama URL validation: `loadModelFromUrl` requires the URL to end in `.gguf`.
9. HF XET CDN: streams file without Content-Length. Worker adds it explicitly, but Cloudflare strips it when proxying a streaming body. Client-side fallback uses the known constant (535_171_328).
10. llama.cpp console noise: `slot update_slots:` and `srv ` prefix messages suppressed in LOG_SKIP.
11. `/__log` 404 on Cloudflare: health-checked once at startup; logging silenced for the session if not ok.
12. Do not use IQ/imatrix quants — excluded in the build plan. 1-bit GGUF quants would likely produce incoherent output at 0.8B.

## What to do next — Phase 2 (Mini-Mafia)

Branch: `feat/phase-2-mafia` (already checked out, no commits yet)

**Read `llm-arena-build-plan.md` Phase 2 section before starting.** Key points:
- 4 players: 1 mafioso, 1 detective, 2 villagers
- Hidden roles — each agent gets a different AgentView (referee owns all asymmetry)
- Night phase: mafioso picks a kill target; detective investigates one player
- Day phase: all players discuss (speak moves), then vote to eliminate one
- Repeat until mafia wins (equal or outnumber villagers) or villagers win (mafia eliminated)
- `Move` discriminated union needs `{kind:"vote", target}` and `{kind:"speak", text}` in addition to existing structure
- Tool calling may earn its place here for structured vote/action moves (vs single-word for IPD)
- Crib rules from `bastoscostadavi/llm-mafia-game` (verify it still exists)
- Memory stays referee-owned per agent — do not let the 0.8B model manage its own memory
- Build the referee with RandomAgent and unit-test completely before touching LLMAgent

**Start with:** new `src/referee/mafia.ts` + `src/referee/mafia.test.ts` — types, state machine, legal moves, win condition. No model, no UI yet.
