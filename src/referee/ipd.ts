import type { Agent } from "../agents/agent";
import type { AgentView, GameState, Move, RoundResult } from "./types";

// The IPD payoff matrix. Each cell is [scoreForA, scoreForB] given (A's move, B's move).
//
// Classic Axelrod values:
//   Both cooperate (CC) → 3 each  (mutual reward)
//   A cooperates, B defects (CD) → 0 for A, 5 for B  (A gets exploited)
//   A defects, B cooperates (DC) → 5 for A, 0 for B  (A exploits B)
//   Both defect (DD) → 1 each  (mutual punishment — worse than CC, but safe)
//
// The dilemma: defecting always beats cooperating against any fixed opponent choice,
// yet if both reason this way, they both end up at 1/1 instead of 3/3.
export const PAYOFFS: Record<Move, Record<Move, [number, number]>> = {
  cooperate: { cooperate: [3, 3], defect: [0, 5] },
  defect:    { cooperate: [5, 0], defect:  [1, 1] },
};

// Returns [scoreA, scoreB] for a given pair of moves.
export function applyPayoffs(moveA: Move, moveB: Move): [number, number] {
  return PAYOFFS[moveA][moveB];
}

// Type guard: checks whether a value is a legal move string.
// The referee uses this to catch invalid output from LLM agents before applying it.
export function isLegalMove(s: unknown): s is Move {
  return s === "cooperate" || s === "defect";
}

// Builds the limited view the referee passes to one agent before it decides.
// The agent only sees its own history vs this specific opponent.
function buildAgentView(results: RoundResult[], agentId: string, opponentId: string): AgentView {
  return {
    agentId,
    opponentId,
    history: results
      .filter((r) => r.agentId === agentId && r.opponentId === opponentId)
      .map((r) => ({ myMove: r.move, opponentMove: r.opponentMove })),
  };
}

// Returns a zeroed-out GameState for a fresh match.
export function createInitialState(agentIds: string[]): GameState {
  return {
    round: 0,
    scores: Object.fromEntries(agentIds.map((id) => [id, 0])),
    results: [],
  };
}

// Runs one full round of round-robin play: every agent pair plays exactly once.
// With N agents there are N*(N-1)/2 pairings per round.
// Returns the updated GameState (immutable — the input state is never mutated).
export async function runRound(agents: Agent[], state: GameState): Promise<GameState> {
  // Work on copies so the input state is untouched.
  const results = [...state.results];
  const scores = { ...state.scores };

  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i];
      const b = agents[j];

      // Sequential, not concurrent. wllama holds one loaded model and can only run one
      // inference at a time — concurrent calls on the same client return null and crash.
      // RandomAgent resolves instantly so the sequencing cost is negligible.
      const moveA = await a.decide(buildAgentView(results, a.id, b.id));
      const moveB = await b.decide(buildAgentView(results, b.id, a.id));

      // Validate — an LLM agent could return garbage. Default to defect (safe, penalises
      // the broken agent without crashing the game).
      const safeA = isLegalMove(moveA) ? moveA : "defect";
      const safeB = isLegalMove(moveB) ? moveB : "defect";

      const [scoreA, scoreB] = applyPayoffs(safeA, safeB);

      scores[a.id] += scoreA;
      scores[b.id] += scoreB;

      // Store both sides of the pairing so each agent can filter to its own view later.
      results.push(
        { agentId: a.id, opponentId: b.id, move: safeA, opponentMove: safeB, score: scoreA },
        { agentId: b.id, opponentId: a.id, move: safeB, opponentMove: safeA, score: scoreB },
      );
    }
  }

  return { round: state.round + 1, scores, results };
}
