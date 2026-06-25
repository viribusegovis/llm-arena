import type { AgentView, Move } from "../referee/types";

// The contract every agent must satisfy. The referee calls decide() each turn;
// the agent returns its move. Async because LLM agents need to await model inference.
export interface Agent {
  readonly id: string;
  decide(view: AgentView): Promise<Move>;
}
