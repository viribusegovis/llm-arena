import type { AgentView, Move } from "../referee/types";
import type { Agent } from "./agent";

const MOVES: Move[] = ["cooperate", "defect"];

// Picks a move uniformly at random. Used to test the referee in isolation —
// no model loaded, no inference, deterministic enough to unit-test game logic.
export class RandomAgent implements Agent {
  constructor(public readonly id: string) {}

  async decide(_view: AgentView): Promise<Move> {
    return MOVES[Math.floor(Math.random() * MOVES.length)];
  }
}
