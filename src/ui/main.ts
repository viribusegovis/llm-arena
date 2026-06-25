import { LLMAgent } from "../agents/llm-agent";
import { WllamaClient } from "../llm/wllama-client";
import { createInitialState, runRound } from "../referee/ipd";
import type { GameState, Move } from "../referee/types";

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

// --- Personalities ---------------------------------------------------------------
// Each personality is a system prompt — a hidden instruction that shapes how the
// model approaches every decision. Same model, different "character".

const PERSONALITIES: Record<string, string> = {
  // Tit-for-tat: one of the strongest strategies in Axelrod's tournaments.
  // Open with trust, then mirror whatever the opponent did last round.
  "tit-for-tat":
    "You are playing the Prisoner's Dilemma. Your strategy is tit-for-tat: " +
    "always cooperate on the first round, then copy whatever your opponent did last round. " +
    "If they cooperated last round, cooperate. If they defected last round, defect. " +
    "Follow this rule strictly.",

  // Always defects — the individually rational but collectively destructive choice.
  "always-defect":
    "You are playing the Prisoner's Dilemma. You are a ruthless self-interested player. " +
    "Defecting always gives you a better personal outcome regardless of what your opponent does. " +
    "Always defect. Never cooperate under any circumstances.",

  // Always cooperates — naive altruism; gets exploited but never starts conflict.
  "always-cooperate":
    "You are playing the Prisoner's Dilemma. You are an idealistic cooperator who believes " +
    "mutual trust is the only path to the best collective outcome. " +
    "Always cooperate, no matter what your opponent has done.",

  // Grudger: cooperates until betrayed once, then defects forever.
  "grudger":
    "You are playing the Prisoner's Dilemma. You start by cooperating and will keep " +
    "cooperating as long as your opponent has never defected against you. " +
    "But if they defect even once, you defect against them for every remaining round — no forgiveness.",
};

// --- Match config ----------------------------------------------------------------

const ROUNDS = 10;

// --- Entry point -----------------------------------------------------------------

async function main(): Promise<void> {
  log("=== LLM Arena — Phase 1c: all-LLM match ===");

  // All four agents share one loaded model instance. Loading once and reusing is
  // essential — each load would re-download/re-initialize ~500 MB.
  const client = new WllamaClient();
  log("Loading model…");
  await client.load((pct) => {
    if (pct % 20 === 0) log(`  ${pct}%`);
  });
  log("Model ready.\n");

  const agents = Object.entries(PERSONALITIES).map(
    ([id, prompt]) => new LLMAgent(id, prompt, client)
  );

  log(`Agents: ${agents.map((a) => a.id).join(", ")}`);
  log(`${ROUNDS} rounds, round-robin (each pair plays every round)\n`);

  let state: GameState = createInitialState(agents.map((a) => a.id));

  for (let round = 1; round <= ROUNDS; round++) {
    state = await runRound(agents, state);
    log(`Round ${round}: ${formatScores(state)}`);
  }

  log("\n=== Final scores ===");
  for (const [id, score] of Object.entries(state.scores).sort((a, b) => b[1] - a[1])) {
    log(`  ${id}: ${score} pts`);
  }

  // Per-agent cooperation rate: what fraction of moves were "cooperate"?
  // This reveals whether the personality actually shaped behavior.
  log("\n=== Cooperation rates ===");
  for (const agent of agents) {
    const ownResults = state.results.filter((r) => r.agentId === agent.id);
    const cooperated = ownResults.filter((r) => r.move === "cooperate").length;
    log(`  ${agent.id}: ${cooperated}/${ownResults.length} cooperated (${pct(cooperated, ownResults.length)}%)`);
  }

  // Head-to-head breakdown: for each pairing, show both sides' move sequences.
  // This is where personality differences become visible.
  log("\n=== Head-to-head move sequences ===");
  const ids = agents.map((a) => a.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const aMoves = movesFor(state, a, b);
      const bMoves = movesFor(state, b, a);
      const aScore = state.results.filter((r) => r.agentId === a && r.opponentId === b).reduce((s, r) => s + r.score, 0);
      const bScore = state.results.filter((r) => r.agentId === b && r.opponentId === a).reduce((s, r) => s + r.score, 0);
      log(`  ${a} vs ${b}`);
      log(`    ${a}: ${aMoves.join(" ")} → ${aScore} pts`);
      log(`    ${b}: ${bMoves.join(" ")} → ${bScore} pts`);
    }
  }
}

// Returns this agent's move sequence against a specific opponent, abbreviated to C/D.
function movesFor(state: GameState, agentId: string, opponentId: string): string[] {
  return state.results
    .filter((r) => r.agentId === agentId && r.opponentId === opponentId)
    .map((r): string => (r.move as Move) === "cooperate" ? "C" : "D");
}

function formatScores(state: GameState): string {
  return Object.entries(state.scores)
    .map(([id, score]) => `${id}=${score}`)
    .join(", ");
}

function pct(n: number, total: number): string {
  return total === 0 ? "0" : Math.round((n / total) * 100).toString();
}

main().catch((err) => {
  console.error(err);
  log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
});
