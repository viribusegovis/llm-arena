import type { WllamaClient } from "../llm/wllama-client";
import type { AgentView, Move } from "../referee/types";
import type { Agent } from "./agent";

// How many times to re-prompt the model if it returns unparseable output before
// giving up and defaulting. 3 is enough — if it can't cooperate/defect in 3 tries,
// something is structurally wrong with the prompt, not just bad luck.
const MAX_RETRIES = 3;

// Scan the model's raw text for the first occurrence of "cooperate" or "defect".
// Returns null if neither appears, which tells the caller to retry.
// Using indexOf rather than regex keeps it simple: whichever word appears first wins.
function parseMoveFromText(text: string): Move | null {
  const lower = text.toLowerCase();
  const ci = lower.indexOf("cooperate");
  const di = lower.indexOf("defect");
  if (ci === -1 && di === -1) return null;
  if (ci === -1) return "defect";
  if (di === -1) return "cooperate";
  return ci < di ? "cooperate" : "defect";
}

// Builds the user-facing part of the prompt for one decision turn.
// Includes this agent's round-by-round history against this specific opponent so
// the model can reason about patterns (e.g. tit-for-tat needs to know the last move).
function buildUserMessage(view: AgentView): string {
  const lines: string[] = [];

  if (view.history.length === 0) {
    lines.push(`This is your first round against opponent "${view.opponentId}".`);
  } else {
    lines.push(`Your history against opponent "${view.opponentId}" (oldest first):`);
    view.history.forEach((h, i) => {
      lines.push(`  Round ${i + 1}: you chose ${h.myMove}, they chose ${h.opponentMove}`);
    });
  }

  lines.push(`Respond with exactly one word: cooperate or defect. No explanation, no punctuation.`);
  return lines.join("\n");
}

// An agent backed by the language model. Its "personality" is a system prompt —
// a hidden instruction that shapes its values and strategy before the conversation starts.
export class LLMAgent implements Agent {
  constructor(
    public readonly id: string,
    // The system prompt that defines this agent's personality and strategy.
    private readonly systemPrompt: string,
    private readonly client: WllamaClient,
  ) {}

  async decide(view: AgentView): Promise<Move> {
    const messages = [
      { role: "system" as const, content: this.systemPrompt },
      { role: "user" as const, content: buildUserMessage(view) },
    ];

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const text = await this.client.complete(messages);
      const move = parseMoveFromText(text);
      if (move !== null) return move;
      // Model returned something unparseable — loop back and try again.
    }

    // All retries exhausted. "Defect" is the safe/pessimistic fallback: it avoids
    // being exploited by a broken prompt at the cost of mutual punishment.
    console.warn(`${this.id}: all ${MAX_RETRIES} retries exhausted, defaulting to defect`);
    return "defect";
  }
}
