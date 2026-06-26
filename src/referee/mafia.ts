// Mini-Mafia game engine — Phase 2 of the LLM Arena.
//
// Rules summary:
//   8 players (configurable): 1 mafioso, 1 detective, 1 medic, 5 villagers.
//   Each "round" has two phases:
//     Night — mafioso secretly kills; detective secretly investigates; medic secretly protects.
//     Day   — all alive players discuss, then vote to eliminate one player.
//   Mafia wins when their count equals or exceeds the remaining non-mafia (can never be outvoted).
//   Villagers win when the mafioso is eliminated.
//
// The referee owns all state. Agents receive a filtered AgentView that hides info they
// shouldn't see (other roles, detective's investigation log, medic's protection log).

// The roles in a Mini-Mafia game.
// Mafioso, detective, and medic all act at night; villagers rely entirely on the day vote.
export type Role = "mafioso" | "detective" | "medic" | "villager";

// Phases the game advances through in order: night → day-discuss → day-vote → (repeat or end).
export type Phase = "night" | "day-discuss" | "day-vote" | "game-over";

// Every action an agent can submit, as a "discriminated union" — a TypeScript pattern where
// each variant has a unique `kind` string so the type-checker knows which fields are present.
export type MafiaMove =
  // Night only. Mafioso picks one alive non-mafia player to eliminate overnight.
  | { kind: "kill"; target: string }
  // Night only. Detective learns the true role of one alive player (private result).
  | { kind: "investigate"; target: string }
  // Night only. Medic shields one alive player from the mafioso's kill this round.
  | { kind: "protect"; target: string }
  // Day-discuss only. Player says something added to the shared transcript.
  | { kind: "speak"; text: string }
  // Day-vote only. Player nominates one other alive player for elimination.
  | { kind: "vote"; target: string };

// Per-player record the referee keeps throughout the game.
export interface Player {
  id: string;
  role: Role;
  // Becomes false when eliminated; dead players cannot act or be targeted.
  isAlive: boolean;
}

// One entry written to the public transcript during the day-discuss phase.
// All alive players can read all transcript entries in their AgentView.
export interface TranscriptEntry {
  round: number;
  playerId: string;
  text: string;
}

// Permanent record of a player being removed from the game.
// Role is publicly revealed on elimination — gives villagers useful signal from day votes.
export interface EliminationRecord {
  playerId: string;
  role: Role;
  round: number;
  // "night-kill" = mafioso eliminated overnight; "day-vote" = voted out by the group.
  cause: "night-kill" | "day-vote";
}

// The full, authoritative game state. Only the referee reads/writes this.
// Agents receive a filtered MafiaAgentView — never the raw state.
export interface MafiaGameState {
  phase: Phase;
  // Starts at 1, increments each time the game transitions from day-vote back to night.
  round: number;
  players: Player[];
  // Detective's private investigation log. Only surfaced to the detective in their AgentView.
  investigations: Array<{ target: string; role: Role }>;
  // Medic's private protection log. Only surfaced to the medic in their AgentView.
  // "blocked" is true when the medic's target matched the mafioso's kill target that same night.
  protections: Array<{ round: number; target: string; blocked: boolean }>;
  // Shared public discussion log accumulated across all day-discuss phases.
  transcript: TranscriptEntry[];
  // Votes cast during the current day-vote phase. Cleared when the round ends.
  votes: Record<string, string>; // voterId → targetId
  // Night actions the referee has collected but not yet applied. Cleared after each night.
  nightActions: {
    killTarget?: string;
    investigateTarget?: string;
    protectTarget?: string;
  };
  // All eliminations so far, in chronological order. Roles are revealed here.
  eliminated: EliminationRecord[];
  // Set once the game ends. Undefined while still in progress.
  winner?: "mafia" | "villagers";
}

// The filtered snapshot the referee hands to one agent before each decision.
// Different roles see different information — that asymmetry lives here.
export interface MafiaAgentView {
  myId: string;
  myRole: Role;
  phase: Phase;
  round: number;
  // Everyone's IDs, but NOT their roles (roles are hidden until revealed by elimination).
  allPlayerIds: string[];
  // IDs of players still alive and able to act or be targeted.
  alivePlayers: string[];
  // Public discussion log — all alive players can read this.
  transcript: TranscriptEntry[];
  // Publicly announced eliminations (role revealed on elimination).
  eliminated: EliminationRecord[];
  // Detective's private investigation results. Present only when myRole === "detective".
  investigationResults?: Array<{ target: string; role: Role }>;
  // Medic's private protection history. Present only when myRole === "medic".
  // Tells the medic who they've protected before so they can vary their choices.
  protectionHistory?: Array<{ round: number; target: string; blocked: boolean }>;
  // The legal moves available right now. RandomAgent picks one; LLMAgent uses this to
  // constrain output to actions that are actually allowed in the current phase.
  legalMoves: MafiaMove[];
}

// The contract every Mafia agent must satisfy. Parallel structure to the IPD Agent interface.
// Async because LLM agents need to await model inference.
// onToken fires once per streamed text fragment — optional, for live UI updates.
export interface MafiaAgent {
  readonly id: string;
  decide(view: MafiaAgentView, onToken?: (fragment: string) => void): Promise<MafiaMove>;
}

// ---- Game setup ----

// Returns a fresh game state: all players alive, first night not yet started.
export function createInitialState(
  players: Array<{ id: string; role: Role }>,
): MafiaGameState {
  return {
    phase: "night",
    round: 1,
    players: players.map(({ id, role }) => ({ id, role, isAlive: true })),
    investigations: [],
    protections: [],
    transcript: [],
    votes: {},
    nightActions: {},
    eliminated: [],
  };
}

// ---- Win condition ----

// Returns the winner if the game is over, or null if it's still ongoing.
//
// Mafia wins when their alive count equals or exceeds alive non-mafia:
//   at that point, the mafioso can never be outvoted in a day vote.
// Villagers win when the mafioso is dead.
export function checkWin(state: MafiaGameState): "mafia" | "villagers" | null {
  const alive = state.players.filter((p) => p.isAlive);
  const aliveMafia = alive.filter((p) => p.role === "mafioso").length;
  const aliveNonMafia = alive.filter((p) => p.role !== "mafioso").length;

  if (aliveMafia === 0) return "villagers";
  if (aliveMafia >= aliveNonMafia) return "mafia";
  return null;
}

// ---- Legal move enumeration ----

// Returns every move this player is allowed to make right now.
// The referee passes this list inside AgentView; agents pick from it rather than guessing.
export function getLegalMoves(state: MafiaGameState, playerId: string): MafiaMove[] {
  const player = state.players.find((p) => p.id === playerId);
  // Dead players and unknown IDs have no moves.
  if (!player || !player.isAlive) return [];

  const alivePlayers = state.players.filter((p) => p.isAlive);

  switch (state.phase) {
    case "night": {
      if (player.role === "mafioso") {
        // Kill any alive player who is not also a mafioso.
        const targets = alivePlayers
          .filter((p) => p.role !== "mafioso")
          .map((p) => p.id);
        return targets.map((target) => ({ kind: "kill", target }));
      }
      if (player.role === "detective") {
        // Investigate any alive player except themselves.
        const targets = alivePlayers.filter((p) => p.id !== playerId).map((p) => p.id);
        return targets.map((target) => ({ kind: "investigate", target }));
      }
      if (player.role === "medic") {
        // Protect any alive player, including themselves.
        // The medic can self-protect if they suspect they are being targeted.
        const targets = alivePlayers.map((p) => p.id);
        return targets.map((target) => ({ kind: "protect", target }));
      }
      // Villagers have no night action.
      return [];
    }

    case "day-discuss":
      // Any alive player may speak. The `text: ""` signals that speaking is legal now;
      // the actual text content is chosen by the agent (not enumerable here).
      return [{ kind: "speak", text: "" }];

    case "day-vote": {
      // Vote for any alive player except yourself.
      const targets = alivePlayers.filter((p) => p.id !== playerId).map((p) => p.id);
      return targets.map((target) => ({ kind: "vote", target }));
    }

    default:
      return [];
  }
}

// ---- Move validation ----

// Returns true if the move is legal for this player in the current game state.
// Used by the referee to sanity-check agent output before applying it.
export function isValidMove(
  state: MafiaGameState,
  playerId: string,
  move: MafiaMove,
): boolean {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !player.isAlive) return false;

  const aliveIds = state.players.filter((p) => p.isAlive).map((p) => p.id);

  switch (move.kind) {
    case "kill":
      return (
        state.phase === "night" &&
        player.role === "mafioso" &&
        aliveIds.includes(move.target) &&
        state.players.find((p) => p.id === move.target)?.role !== "mafioso"
      );

    case "investigate":
      return (
        state.phase === "night" &&
        player.role === "detective" &&
        aliveIds.includes(move.target) &&
        move.target !== playerId
      );

    case "protect":
      return (
        state.phase === "night" &&
        player.role === "medic" &&
        aliveIds.includes(move.target)
      );

    case "speak":
      return state.phase === "day-discuss" && move.text.trim().length > 0;

    case "vote":
      return (
        state.phase === "day-vote" &&
        aliveIds.includes(move.target) &&
        move.target !== playerId
      );

    default:
      return false;
  }
}

// ---- Agent view construction ----

// Builds the filtered snapshot the referee hands to one player before they decide.
// The information asymmetry between roles is enforced here and nowhere else.
export function buildAgentView(state: MafiaGameState, playerId: string): MafiaAgentView {
  const player = state.players.find((p) => p.id === playerId)!;
  const view: MafiaAgentView = {
    myId: playerId,
    myRole: player.role,
    phase: state.phase,
    round: state.round,
    allPlayerIds: state.players.map((p) => p.id),
    alivePlayers: state.players.filter((p) => p.isAlive).map((p) => p.id),
    transcript: state.transcript,
    eliminated: state.eliminated,
    legalMoves: getLegalMoves(state, playerId),
  };

  // Only the detective receives their private investigation log.
  if (player.role === "detective") {
    view.investigationResults = state.investigations;
  }

  // Only the medic receives their private protection history.
  if (player.role === "medic") {
    view.protectionHistory = state.protections;
  }

  return view;
}

// ---- Phase drivers (internal) ----

// Collects night actions from the mafioso, detective, and medic, then resolves them.
// Sequential iteration satisfies the wllama constraint: one inference at a time.
async function stepNight(
  agents: MafiaAgent[],
  state: MafiaGameState,
  callbacks?: MafiaCallbacks,
): Promise<MafiaGameState> {
  const nightActions: {
    killTarget?: string;
    investigateTarget?: string;
    protectTarget?: string;
  } = {};

  for (const agent of agents) {
    const legalMoves = getLegalMoves(state, agent.id);
    if (legalMoves.length === 0) continue; // villager: no night move

    callbacks?.beforeDecide?.(agent.id);
    const view = buildAgentView(state, agent.id);
    const move = await agent.decide(view);

    if (move.kind === "kill" && isValidMove(state, agent.id, move)) {
      nightActions.killTarget = move.target;
    } else if (move.kind === "investigate" && isValidMove(state, agent.id, move)) {
      nightActions.investigateTarget = move.target;
    } else if (move.kind === "protect" && isValidMove(state, agent.id, move)) {
      nightActions.protectTarget = move.target;
    }
    // Illegal move: silently ignore.
  }

  return resolveNight(state, nightActions);
}

// Pure function: applies collected night actions, checks win, advances phase.
function resolveNight(
  state: MafiaGameState,
  nightActions: { killTarget?: string; investigateTarget?: string; protectTarget?: string },
): MafiaGameState {
  let players = [...state.players];
  let eliminated = [...state.eliminated];
  const investigations = [...state.investigations];
  const protections = [...state.protections];

  // Determine if the medic's protection blocks the kill.
  // "blocked" is true when both the kill and protect target the same player.
  const killBlocked =
    nightActions.killTarget !== undefined &&
    nightActions.killTarget === nightActions.protectTarget;

  // Record the medic's protection (private — only surfaced to the medic in their AgentView).
  if (nightActions.protectTarget !== undefined) {
    protections.push({
      round: state.round,
      target: nightActions.protectTarget,
      blocked: killBlocked,
    });
  }

  // Apply the mafioso's kill, unless the medic protected the same target.
  if (nightActions.killTarget && !killBlocked) {
    const idx = players.findIndex((p) => p.id === nightActions.killTarget);
    if (idx !== -1 && players[idx].isAlive) {
      const target = players[idx];
      players = players.map((p, i) => (i === idx ? { ...p, isAlive: false } : p));
      eliminated = [
        ...eliminated,
        { playerId: target.id, role: target.role, round: state.round, cause: "night-kill" },
      ];
    }
  }

  // Record the detective's investigation result (private).
  if (nightActions.investigateTarget) {
    const target = players.find((p) => p.id === nightActions.investigateTarget);
    if (target) {
      investigations.push({ target: target.id, role: target.role });
    }
  }

  const next: MafiaGameState = {
    ...state,
    players,
    eliminated,
    investigations,
    protections,
    nightActions: {},
    phase: "day-discuss",
  };

  const winner = checkWin(next);
  if (winner) return { ...next, phase: "game-over", winner };
  return next;
}

// Collects one speak move from each alive player and appends to the transcript.
// Each player sees the transcript entries added before them in the same discussion.
async function stepDayDiscuss(
  agents: MafiaAgent[],
  state: MafiaGameState,
  callbacks?: MafiaCallbacks,
): Promise<MafiaGameState> {
  let transcript = [...state.transcript];

  for (const agent of agents) {
    const isAlive = state.players.find((p) => p.id === agent.id)?.isAlive;
    if (!isAlive) continue;

    callbacks?.beforeDecide?.(agent.id);
    // Pass the growing transcript so speakers can react to prior messages this round.
    const view = buildAgentView({ ...state, transcript }, agent.id);
    const move = await agent.decide(
      view,
      callbacks?.onToken ? (f) => callbacks.onToken!(agent.id, f) : undefined,
    );

    if (move.kind === "speak" && move.text.trim().length > 0) {
      transcript = [...transcript, { round: state.round, playerId: agent.id, text: move.text }];
    }
  }

  return { ...state, transcript, phase: "day-vote" };
}

// Collects one vote from each alive player, resolves via plurality, and applies elimination.
async function stepDayVote(
  agents: MafiaAgent[],
  state: MafiaGameState,
  callbacks?: MafiaCallbacks,
): Promise<MafiaGameState> {
  const votes: Record<string, string> = {};

  for (const agent of agents) {
    const isAlive = state.players.find((p) => p.id === agent.id)?.isAlive;
    if (!isAlive) continue;

    callbacks?.beforeDecide?.(agent.id);
    const view = buildAgentView(state, agent.id);
    const move = await agent.decide(view);

    if (move.kind === "vote" && isValidMove(state, agent.id, move)) {
      votes[agent.id] = move.target;
    }
    // Invalid vote: player abstains this round.
  }

  return resolveDayVote(state, votes);
}

// Pure function: tallies votes, eliminates the plurality winner (or nobody on a tie),
// checks win, and advances the phase.
function resolveDayVote(
  state: MafiaGameState,
  votes: Record<string, string>,
): MafiaGameState {
  // Count votes per candidate.
  const tally: Record<string, number> = {};
  for (const target of Object.values(votes)) {
    tally[target] = (tally[target] ?? 0) + 1;
  }

  const maxVotes = Object.values(tally).reduce((a, b) => Math.max(a, b), 0);

  // Find all players tied at the top.
  const topTargets =
    maxVotes > 0
      ? Object.entries(tally)
          .filter(([, count]) => count === maxVotes)
          .map(([id]) => id)
      : [];

  // Tie (or no votes): no elimination this round. Advance to next night.
  if (topTargets.length !== 1) {
    return { ...state, votes: {}, phase: "night", round: state.round + 1 };
  }

  const eliminatedId = topTargets[0];
  const eliminatedPlayer = state.players.find((p) => p.id === eliminatedId)!;

  const players = state.players.map((p) =>
    p.id === eliminatedId ? { ...p, isAlive: false } : p,
  );
  const eliminated = [
    ...state.eliminated,
    {
      playerId: eliminatedId,
      role: eliminatedPlayer.role,
      round: state.round,
      cause: "day-vote" as const,
    },
  ];

  const next: MafiaGameState = {
    ...state,
    players,
    eliminated,
    votes: {},
    phase: "night",
    round: state.round + 1,
  };

  const winner = checkWin(next);
  if (winner) return { ...next, phase: "game-over", winner };
  return next;
}

// ---- Main game driver ----

// Optional callbacks the match runner (UI) can attach to observe decisions in real time.
// All fields are optional — omit entirely for non-UI contexts (tests, scripts).
export interface MafiaCallbacks {
  // Fires just before each agent's decide() call so the UI can label the active agent.
  beforeDecide?: (agentId: string) => void;
  // Fires once per streamed text fragment during day-discuss speak moves.
  onToken?: (agentId: string, fragment: string) => void;
}

// Advances the game by one full phase and returns the new state.
// Call repeatedly until state.phase === "game-over".
//
// Phase cycle:
//   "night"       → collects kill + investigate + protect → resolves → "day-discuss"
//   "day-discuss" → each alive player speaks once                    → "day-vote"
//   "day-vote"    → players vote, plurality eliminated               → "night" | "game-over"
export async function stepPhase(
  agents: MafiaAgent[],
  state: MafiaGameState,
  callbacks?: MafiaCallbacks,
): Promise<MafiaGameState> {
  switch (state.phase) {
    case "night":
      return stepNight(agents, state, callbacks);
    case "day-discuss":
      return stepDayDiscuss(agents, state, callbacks);
    case "day-vote":
      return stepDayVote(agents, state, callbacks);
    case "game-over":
      throw new Error("stepPhase called on a finished game");
  }
}
