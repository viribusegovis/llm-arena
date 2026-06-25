import { LLMAgent } from "../agents/llm-agent";
import { RandomAgent } from "../agents/random-agent";
import { WllamaClient } from "../llm/wllama-client";
import { createInitialState, runRound } from "../referee/ipd";
import type { GameState } from "../referee/types";

const app = document.querySelector<HTMLDivElement>("#app")!;

// --- Dev logging infrastructure --------------------------------------------------
// Rotates spike-log.txt on each page load, then forwards every console line to it.
// The Vite file-logger plugin (vite.config.ts) handles the server side.

fetch("/__log", { method: "POST", body: "__RESET__" }).catch(() => {});

const stringifyArg = (a: unknown) =>
  typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })();

// Noisy-but-benign internal llama.cpp scheduler messages — suppress from the log file,
// still visible in browser DevTools.
const LOG_SKIP = [/slot update_slots:.*restored context checkpoint/];

for (const level of ["log", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${args.map(stringifyArg).join(" ")}`;
    if (LOG_SKIP.some((re) => re.test(line))) return;
    fetch("/__log", { method: "POST", body: line }).catch(() => {});
  };
}

// --- UI helpers ------------------------------------------------------------------

function log(line: string): void {
  app.append(line, document.createElement("br"));
  console.log(line);
}

// --- Match config ----------------------------------------------------------------

const ROUNDS = 5;

// The LLM agent's personality. A system prompt is a hidden instruction given to the
// model before any conversation — it sets its "character" for the whole match.
const LLM_PERSONALITY =
  "You are a cautious strategist in the Prisoner's Dilemma. " +
  "You prefer cooperation when trust seems warranted, but you defect swiftly " +
  "if your opponent has betrayed you. Protect yourself, but don't be needlessly hostile.";

// --- Entry point -----------------------------------------------------------------

async function main(): Promise<void> {
  log("=== LLM Arena — Phase 1b match ===");

  // Load the model. First visit downloads ~500 MB; after that it loads from the
  // browser's built-in file cache (OPFS) and takes only a few seconds.
  const client = new WllamaClient();
  log("Loading model…");
  await client.load((pct) => {
    if (pct % 10 === 0) log(`  ${pct}%`);
  });
  log("Model ready.");

  // One LLM-backed agent, two purely random agents (no model needed).
  // Round-robin means every pair plays each other every round.
  const agents = [
    new LLMAgent("llm-cautious", LLM_PERSONALITY, client),
    new RandomAgent("random-1"),
    new RandomAgent("random-2"),
  ];

  log(`\nAgents: ${agents.map((a) => a.id).join(", ")}`);
  log(`Running ${ROUNDS} rounds of round-robin IPD…\n`);

  // createInitialState sets up zeroed scores for every agent ID.
  let state: GameState = createInitialState(agents.map((a) => a.id));

  for (let round = 1; round <= ROUNDS; round++) {
    state = await runRound(agents, state);
    log(`After round ${round}: ${formatScores(state)}`);
  }

  log("\n=== Final scores ===");
  for (const [id, score] of Object.entries(state.scores).sort((a, b) => b[1] - a[1])) {
    log(`  ${id}: ${score} pts`);
  }

  log("\n=== Move history (LLM agent) ===");
  const llmResults = state.results.filter((r) => r.agentId === "llm-cautious");
  for (const r of llmResults) {
    log(`  vs ${r.opponentId}: ${r.move} / they played ${r.opponentMove} → +${r.score} pts`);
  }
}

function formatScores(state: GameState): string {
  return Object.entries(state.scores)
    .map(([id, score]) => `${id}=${score}`)
    .join(", ");
}

main().catch((err) => {
  console.error(err);
  log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
});
