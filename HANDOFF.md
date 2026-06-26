# Session handoff — Phase 1d confirmed working, ready for Phase 2

Read `llm-arena-build-plan.md` and `CLAUDE.md` first. This file is the volatile "where we left off" doc — update or delete it as work progresses.

## User context

New to WebGPU and this inference stack; doing this project to deepen AI/systems knowledge. Wants things explained, not just done. Prefers concise answers, no preamble. No em dashes (use hyphens instead).

## Environment (confirmed)

- Windows 11, AMD RX 5700 XT (RDNA1, 8GB VRAM), Dx12 backend.
- Target browser: Edge only. Firefox has WebGPU disabled.
- Dev server: `npm run dev` (port 5173). COOP + COEP headers active locally.
- GitHub repo: https://github.com/viribusegovis/llm-arena (public, MIT)
- Cloudflare Pages deploy: https://llm-arena.viribus.workers.dev (Wrangler-based)

## Repo state

- Branch: `main`
- Clean tree, all committed. Last commit: `f8576ba`

## Phase 1 milestone status

- 1a - 1c: complete (referee, LLM agents, 4 personalities, 10 rounds, all-LLM match)
- 1d: **confirmed working end-to-end on Cloudflare** this session
- 21 unit tests passing (`npm test`)
- README not yet updated with live URL (minor outstanding item)

## File layout (current)

```
index.html                # All CSS inline in <style> block; #app mount point only
src/
  worker.ts               # Cloudflare Worker entry: /model.gguf proxy + static assets
  referee/
    types.ts              # Move, GameState, AgentView, RoundResult
    ipd.ts                # payoffs, runRound (with optional callbacks), createInitialState, isLegalMove
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
  _headers                # Cloudflare Pages: COOP only (COEP removed, see gotchas)
wrangler.toml             # main = src/worker.ts; assets.directory = ./dist; binding = ASSETS
vite.config.ts            # COOP+COEP headers locally; file-logger plugin; /model.gguf dev proxy
```

## Model

- Repo: `unsloth/Qwen3.5-0.8B-GGUF`
- File: `Qwen3.5-0.8B-Q4_1.gguf` (535,171,328 bytes, ~510 MB)
- Served via: `/model.gguf` on the same origin (Worker proxies to HuggingFace server-side)
- MODEL_URL: `${window.location.origin}/model.gguf` (works in both dev and prod)

## Architecture: model proxy (key decision this session)

HuggingFace migrated this repo to XET storage (`us.aws.cdn.hf.co/xet-bridge-us`), which does not send CORS headers on browser GET requests. The old git-LFS CDN did.

Fix: `src/worker.ts` adds a `/model.gguf` route:
- HEAD - returns synthetic 200 with Content-Length (HF's CDN also lacks CORS on HEAD; wllama needs content-length for progress bar)
- GET - proxies to HuggingFace server-side (no browser CORS constraints on server-to-server fetch); adds Content-Length if missing (XET streams chunked, no Content-Length, causing wllama to always show 0% progress)

`vite.config.ts` has an identical `/model.gguf` middleware for local dev (Node fetch is also server-side, no CORS). The `window.fetch` HEAD patch from the previous session was removed — no longer needed.

## Key gotchas (cumulative from all sessions)

1. GPU offload: `n_gpu_layers: -1` required. Already set.
2. Thinking mode: `enable_thinking: false` required. Already set.
3. Concurrent inference: crashes wllama. `runRound` calls agents sequentially. Already fixed.
4. Single-word extraction: 100% valid, ~187ms/run. Already implemented.
5. OPFS cache: per-origin. `localhost:5173` and Cloudflare are separate caches. First load ~5 min, cached ~2-5s. Changing MODEL_URL invalidates the cache (different cache key).
6. Firefox: WebGPU disabled. Only test in Edge.
7. COEP removed from Cloudflare `_headers` — HF's LFS CDN doesn't send `Cross-Origin-Resource-Policy: cross-origin`. wllama falls back to single-thread without COEP (WebGPU still works). Local dev keeps COEP (multithread works there).
8. wllama URL validation: `loadModelFromUrl` requires the URL to end in `.gguf` — hence `/model.gguf` not `/model`.
9. wllama `getHFFileSHA256`: only triggers when URL contains `/resolve/`. Our `/model.gguf` URL doesn't, so this code path is skipped. OPFS cache falls back to etag (passed through from HF response headers by the Worker).
10. HF XET CDN: streams file without Content-Length. Worker adds it explicitly from the known constant so wllama's progress bar works.
11. llama.cpp console noise: `slot update_slots:` and `srv ` prefix messages fire on every inference call. Suppressed in `LOG_SKIP` before `original()` so they don't appear in DevTools at all.
12. `/__log` 404 on Cloudflare: health-checked once at startup. If `__RESET__` POST returns ok, logging is enabled; otherwise silenced for the session.

## UI (Phase 1d final state)

- Agent color palette: tit-for-tat=blue (#5bb8f5), always-defect=red (#f55b5b), always-cooperate=green (#6ee77a), grudger=amber (#f5a623)
- Colors applied consistently: score bar fills, bar score values, streaming-box left border + agent label, heatmap row headers
- Animated shimmer progress bar during model loading (hides on completion)
- Heatmap heat-coded: cell background = row agent's color at opacity proportional to score (0 = transparent, max = 65% opacity)
- Title with blue glow, section border-left accents

## What to do next

1. Update README with the live Cloudflare URL and a short description
2. Begin Phase 2 (Mini-Mafia) per `llm-arena-build-plan.md`
   - Key additions: hidden roles, night/day phases, voting, elimination, per-role AgentView asymmetry
   - The build plan recommends starting from `bastoscostadavi/llm-mafia-game` 4-player Mini-Mafia rules (1 mafioso, 1 detective, 2 villagers)
   - Tool calling may earn its place here for structured vote/action moves
