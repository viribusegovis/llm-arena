# Session handoff — Phase 1, milestone 1d next

Read `llm-arena-build-plan.md` and `CLAUDE.md` first. This file is the volatile "where we left off" doc — update or delete it as work progresses.

## User context

New to WebGPU and this inference stack; doing this project to deepen AI/systems knowledge. Wants things explained, not just done — briefly explain what's being checked/why when resuming. Prefers concise answers, no preamble.

## Environment (confirmed)

- Windows 11, AMD RX 5700 XT (RDNA1, 8GB VRAM), Dx12 backend.
- **Target browser: Edge only.** Firefox has WebGPU disabled — never test there.
- Dev server: `npm run dev` (port 5173). Must be running for `/__log` file-logger to work. If `/__log` returns 404, the server isn't running or was started without the updated `vite.config.ts`.

## Repo state

- Branch: `feat/phase1-referee`
- No remote yet (not pushed anywhere).
- All work committed — clean tree.

## Phase 1 milestone status

- **1a** ✅ Referee + IPD rules + RandomAgent, 21 unit tests passing (`npm test`).
- **1b** ✅ LLMAgent wired in, one full match end-to-end verified in Edge.
- **1c** ✅ All-LLM match, 4 personalities (tit-for-tat, always-defect, always-cooperate, grudger), 10 rounds. Results look correct — distinct C/D patterns per personality.
- **1d** ← next. Minimal UI: live score bars + payoff heatmap + token streaming.

## File layout (current)

```
src/
  referee/
    types.ts          # Move, GameState, AgentView, RoundResult
    ipd.ts            # payoffs, runRound, createInitialState, isLegalMove
    ipd.test.ts       # 21 Vitest tests
  agents/
    agent.ts          # Agent interface
    random-agent.ts   # RandomAgent (used in tests)
    llm-agent.ts      # LLMAgent — builds prompt, parses move, retries 3×
  llm/
    wllama-client.ts  # WllamaClient — load model, complete()
  ui/
    main.ts           # Entry point — match runner, dev logger
```

`src/ui/render.ts` does not exist yet — that's the first thing to create for 1d.

## Key findings / gotchas (from Phase 0 + Phase 1)

1. **GPU offload**: `n_gpu_layers: -1` required (not -24, not absent). Default is CPU-only despite README. Already set in `wllama-client.ts`.
2. **Thinking mode**: `chat_template_kwargs: { enable_thinking: false }` required on every call. Already set.
3. **Concurrent inference**: wllama crashes (returns null) if two agents call `createChatCompletion` at the same time on the same instance. `runRound` now calls agents sequentially. Already fixed in `ipd.ts`.
4. **Single-word extraction wins**: 100% valid at temp 0.5, ~187ms/run. Tool-call is 6× slower, same validity. Using single-word in `llm-agent.ts`.
5. **OPFS cache**: first load ~5min (download), cached reloads ~2-5s.
6. **Firefox**: WebGPU disabled, 30× slower (CPU-only WASM). Never test there.

## Streaming API (confirmed against installed types)

wllama supports token streaming via `onData` callback:

```typescript
// Fires once per token as the model generates. chunk.choices[0].delta.content
// is the new text fragment (may be one or several characters).
await wllama.createChatCompletion({
  messages,
  stream: true,
  onData: (chunk: ChatCompletionChunk) => {
    const fragment = chunk.choices[0].delta.content ?? "";
    // update DOM here
  },
  max_tokens: 16,
  temperature: 0.5,
  chat_template_kwargs: { enable_thinking: false },
});
// When stream=true + onData is provided, returns Promise<void> (not the response).
// Must collect the full text yourself inside onData.
```

This is the path for 1d's "agent visibly types its move" effect.

## Plan for 1d (agreed, not yet started)

- `src/ui/render.ts` — score bar + payoff heatmap render functions (pure DOM, called after each round)
- Update `WllamaClient.complete()` to accept optional `onToken?: (fragment: string) => void` and pass it as `onData`
- Update `LLMAgent.decide()` to accept and forward `onToken`
- Update `src/ui/main.ts` to pass a DOM callback per agent turn and call render after each round

## Notes

- The file-logger Vite plugin (`vite.config.ts`) is still in place for dev logging. Needs server running to work.
- `npm test` runs all 21 Vitest unit tests — run after any referee/agent changes.
- CLAUDE.md has comment conventions: thorough comments for a learner who doesn't know LLM/ML internals, define jargon at first use, explain WHY not just WHAT.
