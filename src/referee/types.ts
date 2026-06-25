// The two moves an agent can make in the Prisoner's Dilemma.
// "Cooperate" = trust your opponent; "defect" = betray them for personal gain.
export type Move = "cooperate" | "defect";

// The result of one pairing between two agents in a single round.
// Stored from each agent's perspective so history lookups are a simple filter.
export interface RoundResult {
  agentId: string;
  opponentId: string;
  move: Move;
  opponentMove: Move;
  // Points earned this round by agentId (from the IPD payoff matrix).
  score: number;
}

// Everything the referee knows about the game at any point in time.
// The referee owns this; agents never write to it directly.
export interface GameState {
  // Which round just completed (0 = not started).
  round: number;
  // Cumulative points per agent ID across all rounds and pairings so far.
  scores: Record<string, number>;
  // Every individual pairing result, in order. Both sides of each pairing
  // are stored as separate entries so each agent can filter to its own view.
  results: RoundResult[];
}

// A filtered snapshot the referee passes to one agent before it decides.
// The agent sees only what its own perspective allows — not other agents' moves
// against third parties, and not the other agent's raw "inner state".
export interface AgentView {
  agentId: string;
  opponentId: string;
  // History of THIS agent vs THIS specific opponent only, oldest first.
  // Each entry is: what I played, what they played.
  history: Array<{ myMove: Move; opponentMove: Move }>;
}
