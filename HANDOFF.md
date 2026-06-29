# Session handoff — Phase 2 (Mini-Mafia)

Read `llm-arena-build-plan.md` and `CLAUDE.md` first. This file is the volatile "where we left off" doc — delete it once the branch is merged.

## User context

New to WebGPU and this inference stack; doing this project to deepen AI/systems knowledge. Wants things explained, not just done. Prefers concise answers, no preamble. No em dashes (use hyphens instead). Using this project for job applications — keep `main` clean and demo-ready at all times.

## Environment (confirmed)

- Windows 11, AMD RX 5700 XT (RDNA1, 8GB VRAM), Dx12 backend.
- Target browser: Edge only. Firefox has WebGPU disabled.
- Dev server: `npm run dev` (port 5173).
- GitHub repo: https://github.com/viribusegovis/llm-arena (public, MIT)
- Live prod: https://llm-arena.viribus.workers.dev — auto-deploys on push to `main` via `.github/workflows/deploy.yml`
- Staging: `llm-arena-staging.<account>.workers.dev` — deploy with `npm run build && npx wrangler deploy --env staging` from this branch, no `main` required

## Repo state

- Active branch: `feat/phase-2-mafia`
- Main is clean and running Phase 1 (IPD only). DO NOT push there until staging is confirmed good.
- Recent commits on this branch:
  - `29b6ed7` feat(infra): serial inference queue, per-agent cancellation, staging env
  - `ef027f5` feat(mafia): add mini-mafia game with LLM agents
- 102 tests passing (`npx vitest run`), TypeScript clean (`npx tsc --noEmit`)

## Phase 2 status — code complete, browser testing in progress

Everything is implemented and committed. The staging Cloudflare env was just set up. The user was in the process of deploying to staging when the session ended.

### What's built

**Game engine (`src/referee/mafia.ts`):**
- Roles: mafioso, detective, medic, villager
- 8 players: 1 mafioso, 1 detective, 1 medic, 5 villagers
- Phases: night → day-discuss → day-vote, repeating until win condition
- Medic protection: if protect target === kill target, kill is blocked
- `GameCancelledError` thrown mid-phase if `callbacks.shouldStop()` returns true
- 102 unit tests total (85 IPD + 17 new Mafia)

**Agents:**
- `MafiaLLMAgent`: tool calling for night/vote, streaming free-text for day-discuss
  - Strips `<think>` tags and markdown from output
  - Truncates speak output to first sentence
  - Multiple-choice question format: `"Who do you distrust most — A, B, C, D?"`
  - 3 retries then random fallback on tool failures
- `MafiaRandomAgent`: picks uniformly from legal moves (used in tests)

**UI (`src/ui/main.ts`, `src/ui/render.ts`, `index.html`):**
- Tab switcher: Mini-Mafia / Prisoner's Dilemma on one page; model loads once
- `gameId` cancellation: switching tabs increments gameId; runners exit at `shouldStop` check
- `GameCancelledError` caught in runner loop, exits silently
- Serial inference queue in `WllamaClient`: only one `complete()` runs at a time — prevents wllama's null return on concurrent calls
- Random role assignment each game via `assignRoles()` (8 shuffled personalities → roles)
- Inline streaming quotes: each player row has a `.player-quote` div that streams their day-discuss speech; quotes persist across re-renders via `quotes: Record<string, string>` map
- Short status line at top only (no separate stream box for Mafia)
- God-mode private log: detective findings and medic protections shown to viewer
- Win banner on game end

**Deployment (`wrangler.toml`):**
```
[env.staging]
name = "llm-arena-staging"
```
Deploy: `npm run build && npx wrangler deploy --env staging`

## Known speech quality issues (not a blocker, but worth noting)

The 0.8B model's day-discuss output is imperfect. Observed issues across iterations:
- Agents sometimes say "I don't trust the person who..." instead of naming someone
- Occasional markdown leakage (`**name**`) — stripped per-fragment now, mostly fixed
- Agents sometimes echo the previous speaker's exact words
- Very rarely: `</think>` tag leaks through despite filtering

What's been tried (all in the current code):
- Multiple-choice question format forces picking from the name list
- Only last 1 transcript entry shown (was 3 — caused echoing)
- `firstSentence()` truncates rambling at first `.!?`
- `stripMarkdown()` on final text; `*` stripped per streaming fragment
- Positive-only role instructions (removed "NEVER say..." — it backfired)
- Short single-rule `SPEAK_RULES` (longer = worse for tiny models)

The game is still fun and functional even with imperfect speech. Further improvement would require either a larger model or more aggressive post-processing (e.g. extract player name, reconstruct sentence).

## What to do next

1. **Verify staging looks correct in Edge** — run `npm run build && npx wrangler deploy --env staging`, open staging URL, check:
   - Model loads, both tabs work
   - Mafia game runs multiple rounds
   - Inline quotes stream under player names
   - Tab switch mid-game exits cleanly (no console errors)
   - IPD tab still works

2. **Merge to main and deploy production** once staging is confirmed:
   ```
   git checkout main
   git merge feat/phase-2-mafia
   git push   # triggers GitHub Actions auto-deploy
   ```
   OR manually: `npm run build && npx wrangler deploy`

3. **Delete this file** after merging.

## File layout (current)

```
index.html                # CSS for both IPD and Mafia; tab bar; #app mount
src/
  worker.ts               # Cloudflare Worker: /model.gguf proxy + static assets
  referee/
    types.ts              # IPD types
    ipd.ts                # IPD engine
    ipd.test.ts           # 85 IPD tests
    mafia.ts              # Mafia engine + GameCancelledError
    mafia.test.ts         # 17 Mafia tests (102 total)
  agents/
    agent.ts              # IPD Agent interface
    random-agent.ts       # IPD RandomAgent
    llm-agent.ts          # IPD LLMAgent
    mafia-random-agent.ts # MafiaRandomAgent
    mafia-llm-agent.ts    # MafiaLLMAgent (tool calling + streaming speak + cleanup)
  llm/
    wllama-client.ts      # WllamaClient: load, complete (queued), completeWithTool (queued)
  ui/
    main.ts               # Tab switcher + both game runners (Mafia + IPD)
    render.ts             # initMafiaLayout + initIPDLayout + shared AGENT_COLORS
public/
  _headers                # Cloudflare: COOP only (no COEP — needed for HF CDN)
wrangler.toml             # prod (llm-arena) + staging (llm-arena-staging) envs
vite.config.ts
.github/workflows/deploy.yml   # auto-deploys main to prod
```

## Key gotchas (cumulative)

1. GPU offload: `n_gpu_layers: -1` required. Default is CPU-only.
2. Thinking mode: `enable_thinking: false` required AND strip leaked `<think>` tags in output.
3. Concurrent inference: wllama returns null. Enforced serial via `WllamaClient.inferenceQueue`.
4. Single-word extraction: 100% valid for IPD. Mafia uses tool calling (`tool_choice: "required"`).
5. OPFS cache: per-origin. localhost:5173 and Cloudflare are separate caches. First load ~5 min.
6. Firefox: WebGPU disabled. Edge only.
7. COEP removed from `_headers` — HF's CDN doesn't send `Cross-Origin-Resource-Policy`. wllama falls back to single-thread without COEP. Local dev keeps COEP.
8. wllama URL validation: `loadModelFromUrl` requires URL ending in `.gguf`.
9. HF XET CDN strips Content-Length. Fallback: hardcoded `535_171_328` bytes.
10. llama.cpp console noise: `slot ` and `srv ` prefixes suppressed in LOG_SKIP.
11. `/__log` 404 on Cloudflare: health-checked once at startup; logging silenced if not ok.
12. Mafia tool calling: `tool_choice: "required"` forces tool response. 3x retry then random fallback.
13. Negative constraints in prompts backfire on 0.8B models — "NEVER say kill" makes it say kill. Use positive-only instructions.
14. Tab cancellation: `GameCancelledError` is thrown after each `agent.decide()` if `shouldStop()` returns true. Caller catches it and returns early. Old runner exits within one inference call of the tab switch.
