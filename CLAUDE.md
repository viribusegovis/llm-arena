# In-Browser LLM Arena

See `llm-arena-build-plan.md` for the full build plan — phases, locked decisions, architecture, gotchas. Read it before making structural changes.

## Status

- Phase 0 (de-risk spike) — complete. Key findings: GPU offload requires explicit `n_gpu_layers: -1` (wllama default is CPU-only despite README claims); thinking mode requires explicit `enable_thinking: false`; single-word move extraction wins over tool-call (100% valid, 6× faster); OPFS cache confirmed; system-prompt personalities confirmed distinct.
- Phase 1 — complete. Streaming UI, dual-game tabs (Mafia + IPD), human mafioso play mode.
- Phase 2 — complete. Leaderboard (localStorage), adaptive/counter IPD agents, Restart/Pause/Stop controls, tab state preservation (three persistent containers, per-slot Slot state). **Read `HANDOFF.md` before resuming.**

## Communication style

- Lead with the direct answer or solution first, then explain reasoning after.
- Skip preamble and flattery ("great question", "love this idea") — just answer. Don't restate what I asked.
- No summary/recap at the end of a response unless I ask for one.
- If there are multiple valid approaches, briefly note the tradeoffs instead of silently picking one.
- Default to short, skimmable answers. Only go longer or deeper when I explicitly ask — don't expand on your own judgment that a topic needs more detail.

## Formatting

- Use plain prose for normal conversation — no headers or bold unless the content is genuinely a list, comparison, or step-by-step process.
- For code, show only the lines that changed unless I ask for the full file.
- Tag code blocks with the language, and note version/library assumptions if they matter.

## Honesty & pushback

- If you're not sure about something, say so plainly instead of presenting a guess as fact.
- If I say something wrong or there's a flaw in my plan, point it out directly rather than going along with it.
- Flag if something might be outdated (pricing, APIs, library versions, current events) instead of asserting it confidently.

## Engineering & code

- YAGNI: build only what I asked for. No speculative features, config options, abstraction layers, or "future-proofing" I didn't request.
- Simplest thing that works. No premature abstraction or optimization — don't add interfaces, generics, factories, or extra layers until there's a real second use case.
- Edit existing code over adding new files. Match the project's existing conventions, style, and libraries instead of introducing your own preferences.
- No new dependency for something the stdlib or an existing dep already does. If one is genuinely worth it, flag the tradeoff first.
- No unsolicited refactors, renames, or reformatting of code I didn't ask you to touch. Spotted something worth changing? Mention it — don't silently do it.
- Ask before big architectural moves (new service, datastore, schema change, framework swap) instead of committing silently. For multi-step or large changes, give me the plan before executing so I can redirect early.
- Don't invent APIs, methods, flags, or library features. If you're unsure something exists, say so or check — don't guess and present it as real.
- Smallest diff that solves the actual problem in front of me. Handle the real case, not hypothetical inputs that can't occur here.
- Comments only where the "why" isn't obvious. Don't narrate what the code already says.
- Don't claim code is tested or working unless you actually ran it. Say what you verified vs assumed.
- Never hardcode secrets. Flag obvious security issues (injection, missing authz, unsafe deserialization) when you see them — but don't bolt on security scaffolding I didn't ask for.

## When something's unclear

- If you're missing info needed to do a task well, ask one specific clarifying question instead of guessing.
- If you do have to assume something to proceed, state the assumption in one line rather than asking.
- For debugging, ask for the actual error message or relevant code context before suggesting fixes.

## Git

- Commit messages: Conventional Commits — `type(scope): summary` (types: feat, fix, chore, docs, refactor, test, perf, build, ci). Imperative, lowercase summary, no trailing period. (Default convention — say if you'd rather plain freeform messages.)
- Branch names: `type/short-kebab-description` (e.g. `feat/llm-agent`, `fix/oauth-retry`).
- Never push or open a PR automatically. Propose it at sensible points (a milestone passing, before a risky change) and wait for my go-ahead.
- Ocasionally check and ask for a commit when the changes are deemed enough to do so. I dont want commits too big but also not too small.

## Naming

- Default to each language's standard idiom, and match existing code in the file over any rule here when they conflict.
- TypeScript/JS: camelCase variables/functions, PascalCase types/classes/interfaces/enums, UPPER_SNAKE_CASE for true constants, kebab-case filenames (e.g. `llm-agent.ts`). Booleans get is/has/should prefixes.
- C#/.NET: PascalCase for types/methods/properties/public members, camelCase for locals/params, `_camelCase` for private fields, I-prefix for interfaces (`IFoo`). One public type per file, file named after the type.
- CSS: kebab-case class names.
- Env vars: UPPER_SNAKE_CASE.
- Names describe purpose, not type; shorter is fine when context makes it clear.

COMMENTS
- Comment thoroughly for a reader who does NOT know LLM/ML internals. Assume I don't know terms like layer, token, offload, logits, KV cache, quantization, temperature, sampling — define each in plain language at first use.
- Explain WHY a step exists and what it does conceptually, not just the mechanics. A plain-English sentence above each non-obvious block.
- For any wllama/llama.cpp call or magic value (e.g. n_gpu_layers: -1), add a one-line comment: what it does and why this value.
- Plain language over jargon; if a term is unavoidable, define it inline the first time it appears.
- Scope: this is a learning project. This rule OVERRIDES the global "comments only where the why isn't obvious" rule for this repo.


## Notes

(add project-specific notes, preferences, and corrections here)
