import type { MafiaAgent, MafiaAgentView, MafiaMove } from "../referee/mafia";

// Picks a uniformly random legal move from view.legalMoves.
// Used to test the Mafia referee in isolation — no model loaded, no inference.
// For "speak" moves the legalMoves list only signals that speaking is allowed
// (the placeholder text is empty); this agent fills in a fixed phrase so the move
// passes the non-empty-text validation.
export class MafiaRandomAgent implements MafiaAgent {
  constructor(public readonly id: string) {}

  async decide(view: MafiaAgentView): Promise<MafiaMove> {
    const { legalMoves } = view;
    if (legalMoves.length === 0) {
      throw new Error(`MafiaRandomAgent "${this.id}" has no legal moves`);
    }
    const move = legalMoves[Math.floor(Math.random() * legalMoves.length)];
    if (move.kind === "speak") {
      return { kind: "speak", text: "I have nothing to add." };
    }
    return move;
  }
}
