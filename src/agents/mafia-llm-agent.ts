import type { ChatCompletionTool } from "@wllama/wllama";
import type { WllamaClient } from "../llm/wllama-client";
import type { MafiaAgent, MafiaAgentView, MafiaMove } from "../referee/mafia";

// How many times to re-prompt before giving up on a structured action.
// If tool calling keeps failing, the fallback is a random legal move (never a crash).
const MAX_RETRIES = 3;

// Max recent transcript lines shown in vote prompt. Capped low — tiny models echo long context.
const MAX_VOTE_TRANSCRIPT = 3;

// Builds the user-facing part of the prompt for each game phase.
// Day-discuss is intentionally framed as a plain social situation (no game language) so the
// model responds as a person rather than narrating game mechanics.
function buildUserMessage(view: MafiaAgentView): string {
  if (view.phase === "day-discuss") {
    return buildSpeakMessage(view);
  }

  const lines: string[] = [];

  if (view.eliminated.length > 0) {
    const gone = view.eliminated.map((e) => e.playerId).join(", ");
    lines.push(`Gone: ${gone}`);
  }
  lines.push(`Alive: ${view.alivePlayers.join(", ")}`);

  if (view.phase === "night") {
    const targets = view.legalMoves
      .map((m) => (m as { target: string }).target)
      .join(", ");
    if (view.myRole === "mafioso") {
      lines.push(`Night. Choose who to eliminate: ${targets}`);
    } else if (view.myRole === "detective") {
      if (view.investigationResults && view.investigationResults.length > 0) {
        lines.push("Your findings:");
        for (const r of view.investigationResults) lines.push(`  ${r.target}: ${r.role}`);
      }
      lines.push(`Night. Choose who to investigate: ${targets}`);
    } else if (view.myRole === "medic") {
      if (view.protectionHistory && view.protectionHistory.length > 0) {
        const last = view.protectionHistory[view.protectionHistory.length - 1];
        lines.push(`You protected ${last.target} last round.`);
      }
      lines.push(`Night. Choose who to protect: ${targets}`);
    }
  } else if (view.phase === "day-vote") {
    const recent = view.transcript.slice(-MAX_VOTE_TRANSCRIPT);
    if (recent.length > 0) {
      lines.push("Discussion:");
      for (const e of recent) lines.push(`  ${e.playerId}: ${e.text}`);
    }
    const targets = view.legalMoves
      .map((m) => (m as { target: string }).target)
      .join(", ");
    lines.push(`Vote to eliminate one of: ${targets}`);
  }

  return lines.join("\n");
}

// Day-discuss prompt: framed as a plain social situation, no game terminology.
// The model responds as a person at a table, not a character explaining game rules.
function buildSpeakMessage(view: MafiaAgentView): string {
  const gone = view.eliminated.map((e) => e.playerId);
  const parts: string[] = [];

  if (gone.length > 0) {
    parts.push(`${gone.join(", ")} ${gone.length === 1 ? "has" : "have"} been removed.`);
  }

  // Only the single most recent statement — more causes echoing in small models.
  const last = view.transcript.slice(-1);
  if (last.length > 0) {
    parts.push(`${last[0].playerId} just said: "${last[0].text}"`);
  }

  // Multiple-choice format: harder for tiny models to echo than an open question,
  // and puts the names right where generation starts so one gets picked naturally.
  parts.push(`Who do you distrust most — ${view.alivePlayers.join(", ")}?`);
  return parts.join("\n");
}

// Strips markdown bold/italic that models sometimes emit (e.g. **name** → name).
function stripMarkdown(text: string): string {
  return text.replace(/\*+([^*]+)\*+/g, "$1").replace(/_([^_]+)_/g, "$1");
}

// Truncates to the first complete sentence so agents don't ramble past the one-sentence cap.
function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]+[.!?]/);
  return match ? match[0].trim() : text.trim();
}

// Tool definition for action phases (kill / investigate / vote).
// The "enum" constraint on player_id is the key: it tells the model exactly which
// values are legal and lets the referee validate the result without ambiguity.
function buildActionTool(validTargets: string[]): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "choose_player",
      description: "Select the player to target with your current action.",
      parameters: {
        type: "object",
        properties: {
          player_id: {
            type: "string",
            // enum constrains the model's output to the exact set of valid target IDs.
            enum: validTargets,
            description: "The ID of the player to target.",
          },
        },
        required: ["player_id"],
      },
    },
  };
}

// An agent backed by the language model. Handles all Mafia game phases:
//   - Night (kill / investigate): uses tool calling to pick from an enum of valid targets.
//   - Day-discuss (speak): uses plain streaming completion for free-text response.
//   - Day-vote: uses tool calling to pick from the alive-player enum.
//
// "Personality" is encoded in the system prompt — the referee never sees it;
// each LLMAgent can have a different persona (paranoid, naive, analytical, etc.)
export class MafiaLLMAgent implements MafiaAgent {
  constructor(
    public readonly id: string,
    // The system prompt that defines this agent's personality and strategy.
    // Keep it short — 0.8B models lose track of long system instructions.
    private readonly systemPrompt: string,
    private readonly client: WllamaClient,
  ) {}

  // onToken: optional streaming callback forwarded to the model on the first speak attempt.
  // Action phases (kill/investigate/vote) don't stream — the model fires the tool call
  // as a single non-streaming response, so there's no token-by-token drama to show.
  async decide(view: MafiaAgentView, onToken?: (fragment: string) => void): Promise<MafiaMove> {
    if (view.legalMoves.length === 0) {
      // Should not happen: stepPhase skips agents with no legal moves.
      throw new Error(`MafiaLLMAgent "${this.id}" has no legal moves in phase "${view.phase}"`);
    }
    if (view.phase === "day-discuss") {
      return this.decideSpeakMove(view, onToken);
    }
    return this.decideTargetMove(view);
  }

  // Free-text speak: prompt the model to say something and return whatever it generates.
  // Streamed on the first attempt so the UI can show tokens arriving in real time.
  private async decideSpeakMove(
    view: MafiaAgentView,
    onToken?: (fragment: string) => void,
  ): Promise<MafiaMove> {
    const messages = [
      { role: "system" as const, content: this.systemPrompt },
      { role: "user" as const, content: buildUserMessage(view) },
    ];

    // Strip asterisks from each fragment before the UI sees them.
    // Full stripMarkdown needs the whole string (regex spans multiple tokens), but
    // removing bare `*` characters per-fragment is safe and catches bold/italic markers.
    const liveClean = onToken
      ? (fragment: string) => { const c = fragment.replace(/\*/g, ""); if (c) onToken(c); }
      : undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const raw = await this.client.complete(
        messages,
        60,    // one sentence is ~15–40 tokens; 60 cuts off rambling early
        0.7,   // temperature: higher than action moves — creative speech benefits from variety
        attempt === 0 ? liveClean : undefined, // only stream on the first try
      );
      // Full cleanup on the collected text: strip remaining markdown, then take first sentence.
      const cleaned = firstSentence(stripMarkdown(raw));
      if (cleaned.length > 0) return { kind: "speak", text: cleaned };
    }

    console.warn(`${this.id}: speak retries exhausted, using placeholder`);
    return { kind: "speak", text: "I have nothing to say right now." };
  }

  // Structured action (kill / investigate / vote): use tool calling with an enum constraint
  // so the model must pick from exactly the set of valid target player IDs.
  // Falls back to a random legal move if all retries fail.
  private async decideTargetMove(view: MafiaAgentView): Promise<MafiaMove> {
    // All legal moves in a non-discuss phase share the same `kind` and differ only in `target`.
    const kind = view.legalMoves[0].kind as "kill" | "investigate" | "protect" | "vote";
    const validTargets = view.legalMoves.map(
      (m) => (m as { kind: string; target: string }).target,
    );

    const messages = [
      { role: "system" as const, content: this.systemPrompt },
      { role: "user" as const, content: buildUserMessage(view) },
    ];
    const tool = buildActionTool(validTargets);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const args = await this.client.completeWithTool(
        messages,
        tool,
        50,   // tool calls are short — the model only needs to name a player ID
        0.3,  // low temperature: we want a consistent, deliberate choice, not random variation
      );
      if (
        args !== null &&
        typeof args.player_id === "string" &&
        validTargets.includes(args.player_id)
      ) {
        return { kind, target: args.player_id } as MafiaMove;
      }
      // Tool call returned null or an invalid/unlisted player ID — retry.
    }

    // All retries exhausted. Pick a random legal move so the game never hangs.
    console.warn(`${this.id}: tool call failed after ${MAX_RETRIES} retries, choosing randomly`);
    const fallback = view.legalMoves[Math.floor(Math.random() * view.legalMoves.length)];
    // Speak placeholder text is irrelevant here (this branch is only for action moves),
    // but TypeScript needs the cast to match the MafiaMove union.
    return fallback.kind === "speak"
      ? { kind: "speak", text: "..." }
      : (fallback as MafiaMove);
  }
}
