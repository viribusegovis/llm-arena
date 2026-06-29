import { GameCancelledError } from "../referee/mafia";
import type { MafiaAgent, MafiaAgentView, MafiaMove } from "../referee/mafia";

// Called by the UI to show phase-appropriate controls and receive the player's chosen move.
type InputCallback = (view: MafiaAgentView, onMove: (move: MafiaMove) => void) => void;

// A Mafia agent backed by the human sitting at the browser rather than the language model.
// decide() returns a Promise that only resolves when the player clicks/submits their action.
// The game loop pauses at their turn exactly like it does while waiting for LLM inference.
export class HumanMafiaAgent implements MafiaAgent {
  readonly id: string;

  // Wired up by the UI after both the agent and layout are created.
  onNeedInput: InputCallback | null = null;
  // Called by cancel() to hide the input panel when the game is cancelled mid-turn.
  onHide: (() => void) | null = null;

  private pendingReject: ((err: Error) => void) | null = null;

  constructor(id: string) {
    this.id = id;
  }

  async decide(view: MafiaAgentView, onToken?: (fragment: string) => void): Promise<MafiaMove> {
    return new Promise<MafiaMove>((resolve, reject) => {
      this.pendingReject = reject;

      this.onNeedInput!(view, (move) => {
        this.pendingReject = null;
        // Emit speak text as a token so it streams into the player's quote box.
        if (move.kind === "speak" && onToken) onToken(move.text);
        resolve(move);
      });
    });
  }

  // Called when the game is cancelled (tab switch or mode toggle) while waiting for input.
  // Hides the panel and rejects the pending Promise so the game loop exits via GameCancelledError.
  cancel(): void {
    this.onHide?.();
    if (this.pendingReject) {
      this.pendingReject(new GameCancelledError());
      this.pendingReject = null;
    }
  }
}
