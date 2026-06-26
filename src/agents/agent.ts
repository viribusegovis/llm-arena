import type { AgentView, Move } from "../referee/types";

// The contract every agent must satisfy. The referee calls decide() each turn;
// the agent returns its move. Async because LLM agents need to await model inference.
// onToken is an optional streaming callback: if provided, the agent should fire it
// once per generated text fragment so the UI can display tokens as they arrive.
export interface Agent {
  readonly id: string;
  decide(view: AgentView, onToken?: (fragment: string) => void): Promise<Move>;
}
