import { describe, expect, it } from "vitest";
import { MafiaRandomAgent } from "../agents/mafia-random-agent";
import {
  buildAgentView,
  checkWin,
  createInitialState,
  discussPasses,
  getLegalMoves,
  isValidMove,
  stepPhase,
} from "./mafia";
import type { MafiaAgent, MafiaGameState, MafiaMove } from "./mafia";

// ---- Test helpers ----

// Builds a standard 4-player state (1 mafioso, 1 detective, 2 villagers) at night.
function makeState(overrides?: Partial<MafiaGameState>): MafiaGameState {
  const base = createInitialState([
    { id: "maf", role: "mafioso" },
    { id: "det", role: "detective" },
    { id: "v1",  role: "villager" },
    { id: "v2",  role: "villager" },
  ]);
  return overrides ? { ...base, ...overrides } : base;
}

// Builds a 4-player state with a medic (1 mafioso, 1 detective, 1 medic, 1 villager) at night.
function makeStateWithMedic(overrides?: Partial<MafiaGameState>): MafiaGameState {
  const base = createInitialState([
    { id: "maf", role: "mafioso" },
    { id: "det", role: "detective" },
    { id: "med", role: "medic" },
    { id: "v1",  role: "villager" },
  ]);
  return overrides ? { ...base, ...overrides } : base;
}

function makeAgentsWithMedic(): MafiaAgent[] {
  return [
    new MafiaRandomAgent("maf"),
    new MafiaRandomAgent("det"),
    new MafiaRandomAgent("med"),
    new MafiaRandomAgent("v1"),
  ];
}

// Scripted agent: always returns the given move, ignoring the view.
function scripted(id: string, move: MafiaMove): MafiaAgent {
  return { id, decide: async () => move };
}

// Agents for the standard 4-player game.
function makeAgents() {
  return [
    new MafiaRandomAgent("maf"),
    new MafiaRandomAgent("det"),
    new MafiaRandomAgent("v1"),
    new MafiaRandomAgent("v2"),
  ];
}

// Mark a player dead by id (returns a new state, never mutates).
function killPlayer(state: MafiaGameState, id: string): MafiaGameState {
  return {
    ...state,
    players: state.players.map((p) => (p.id === id ? { ...p, isAlive: false } : p)),
  };
}

// ---- createInitialState ----

describe("createInitialState", () => {
  it("starts in night phase, round 1", () => {
    const s = makeState();
    expect(s.phase).toBe("night");
    expect(s.round).toBe(1);
  });

  it("all four players are alive", () => {
    const s = makeState();
    expect(s.players).toHaveLength(4);
    expect(s.players.every((p) => p.isAlive)).toBe(true);
  });

  it("roles are assigned correctly", () => {
    const s = makeState();
    const roles = Object.fromEntries(s.players.map((p) => [p.id, p.role]));
    expect(roles).toEqual({ maf: "mafioso", det: "detective", v1: "villager", v2: "villager" });
  });

  it("no votes, transcript, eliminated, or pending night actions", () => {
    const s = makeState();
    expect(s.votes).toEqual({});
    expect(s.transcript).toHaveLength(0);
    expect(s.eliminated).toHaveLength(0);
    expect(s.nightActions).toEqual({});
  });
});

// ---- checkWin ----

describe("checkWin", () => {
  it("returns null while mafia is outnumbered (4 alive)", () => {
    expect(checkWin(makeState())).toBeNull();
  });

  it("returns null while mafia is outnumbered (3 alive: 1 maf, 2 non-maf)", () => {
    expect(checkWin(killPlayer(makeState(), "v2"))).toBeNull();
  });

  it("returns 'mafia' when maf count equals non-maf count (2 alive)", () => {
    // Kill det and v1, leaving maf + v2.
    const s = killPlayer(killPlayer(makeState(), "det"), "v1");
    expect(checkWin(s)).toBe("mafia");
  });

  it("returns 'mafia' when maf count exceeds non-maf (only maf alive)", () => {
    const s = ["det", "v1", "v2"].reduce(killPlayer, makeState());
    expect(checkWin(s)).toBe("mafia");
  });

  it("returns 'villagers' when no mafioso alive", () => {
    const s = killPlayer(makeState(), "maf");
    expect(checkWin(s)).toBe("villagers");
  });
});

// ---- getLegalMoves ----

describe("getLegalMoves — night phase", () => {
  it("mafioso can kill detective and both villagers", () => {
    const s = makeState();
    const moves = getLegalMoves(s, "maf");
    const targets = moves.map((m) => (m as { kind: "kill"; target: string }).target).sort();
    expect(targets).toEqual(["det", "v1", "v2"].sort());
    expect(moves.every((m) => m.kind === "kill")).toBe(true);
  });

  it("detective can investigate mafioso and both villagers", () => {
    const s = makeState();
    const moves = getLegalMoves(s, "det");
    const targets = moves.map((m) => (m as { kind: "investigate"; target: string }).target).sort();
    expect(targets).toEqual(["maf", "v1", "v2"].sort());
    expect(moves.every((m) => m.kind === "investigate")).toBe(true);
  });

  it("villager has no night moves", () => {
    expect(getLegalMoves(makeState(), "v1")).toHaveLength(0);
  });

  it("excludes dead players from kill targets", () => {
    const s = killPlayer(makeState(), "v1");
    const moves = getLegalMoves(s, "maf");
    const targets = moves.map((m) => (m as { kind: "kill"; target: string }).target);
    expect(targets).not.toContain("v1");
    expect(targets).toContain("det");
    expect(targets).toContain("v2");
  });

  it("excludes dead players from investigate targets", () => {
    const s = killPlayer(makeState(), "v1");
    const moves = getLegalMoves(s, "det");
    const targets = moves.map((m) => (m as { kind: "investigate"; target: string }).target);
    expect(targets).not.toContain("v1");
    expect(targets).toContain("maf");
  });

  it("dead player has no moves", () => {
    const s = killPlayer(makeState(), "maf");
    expect(getLegalMoves(s, "maf")).toHaveLength(0);
  });
});

describe("getLegalMoves — day-discuss phase", () => {
  const s = makeState({ phase: "day-discuss" });

  it("all alive players can speak", () => {
    for (const id of ["maf", "det", "v1", "v2"]) {
      const moves = getLegalMoves(s, id);
      expect(moves).toHaveLength(1);
      expect(moves[0].kind).toBe("speak");
    }
  });

  it("dead player has no moves", () => {
    const dead = killPlayer(s, "v1");
    expect(getLegalMoves(dead, "v1")).toHaveLength(0);
  });
});

describe("getLegalMoves — day-vote phase", () => {
  const s = makeState({ phase: "day-vote" });

  it("each player can vote for every other alive player", () => {
    const moves = getLegalMoves(s, "maf");
    const targets = moves.map((m) => (m as { kind: "vote"; target: string }).target).sort();
    expect(targets).toEqual(["det", "v1", "v2"].sort());
    expect(moves.every((m) => m.kind === "vote")).toBe(true);
  });

  it("player cannot vote for themselves", () => {
    const moves = getLegalMoves(s, "v1");
    const targets = moves.map((m) => (m as { kind: "vote"; target: string }).target);
    expect(targets).not.toContain("v1");
  });

  it("dead player cannot be voted for", () => {
    const dead = killPlayer(s, "v1");
    const moves = getLegalMoves(dead, "maf");
    const targets = moves.map((m) => (m as { kind: "vote"; target: string }).target);
    expect(targets).not.toContain("v1");
  });
});

// ---- isValidMove ----

describe("isValidMove — kill", () => {
  it("valid kill in night phase", () => {
    expect(isValidMove(makeState(), "maf", { kind: "kill", target: "v1" })).toBe(true);
  });

  it("kill rejected outside night phase", () => {
    const s = makeState({ phase: "day-vote" });
    expect(isValidMove(s, "maf", { kind: "kill", target: "v1" })).toBe(false);
  });

  it("detective cannot kill", () => {
    expect(isValidMove(makeState(), "det", { kind: "kill", target: "v1" })).toBe(false);
  });

  it("cannot kill a dead player", () => {
    const s = killPlayer(makeState(), "v1");
    expect(isValidMove(s, "maf", { kind: "kill", target: "v1" })).toBe(false);
  });

  it("mafioso cannot kill themselves", () => {
    // maf is role "mafioso", so killing "maf" is blocked by the non-mafioso guard.
    expect(isValidMove(makeState(), "maf", { kind: "kill", target: "maf" })).toBe(false);
  });
});

describe("isValidMove — investigate", () => {
  it("valid investigate in night phase", () => {
    expect(isValidMove(makeState(), "det", { kind: "investigate", target: "maf" })).toBe(true);
  });

  it("detective cannot investigate themselves", () => {
    expect(isValidMove(makeState(), "det", { kind: "investigate", target: "det" })).toBe(false);
  });

  it("investigate rejected outside night phase", () => {
    const s = makeState({ phase: "day-discuss" });
    expect(isValidMove(s, "det", { kind: "investigate", target: "maf" })).toBe(false);
  });

  it("mafioso cannot investigate", () => {
    expect(isValidMove(makeState(), "maf", { kind: "investigate", target: "v1" })).toBe(false);
  });
});

describe("isValidMove — speak", () => {
  it("valid speak in day-discuss phase", () => {
    const s = makeState({ phase: "day-discuss" });
    expect(isValidMove(s, "v1", { kind: "speak", text: "suspicious" })).toBe(true);
  });

  it("speak rejected with empty text", () => {
    const s = makeState({ phase: "day-discuss" });
    expect(isValidMove(s, "v1", { kind: "speak", text: "   " })).toBe(false);
  });

  it("speak rejected outside day-discuss phase", () => {
    expect(isValidMove(makeState(), "v1", { kind: "speak", text: "hi" })).toBe(false);
  });
});

describe("isValidMove — vote", () => {
  it("valid vote in day-vote phase", () => {
    const s = makeState({ phase: "day-vote" });
    expect(isValidMove(s, "v1", { kind: "vote", target: "maf" })).toBe(true);
  });

  it("cannot vote for yourself", () => {
    const s = makeState({ phase: "day-vote" });
    expect(isValidMove(s, "v1", { kind: "vote", target: "v1" })).toBe(false);
  });

  it("cannot vote for a dead player", () => {
    const s = killPlayer(makeState({ phase: "day-vote" }), "v2");
    expect(isValidMove(s, "v1", { kind: "vote", target: "v2" })).toBe(false);
  });

  it("vote rejected outside day-vote phase", () => {
    expect(isValidMove(makeState(), "v1", { kind: "vote", target: "maf" })).toBe(false);
  });
});

// ---- buildAgentView ----

describe("buildAgentView", () => {
  it("detective receives investigationResults; others do not", () => {
    const s = makeState();
    expect(buildAgentView(s, "det").investigationResults).toBeDefined();
    expect(buildAgentView(s, "maf").investigationResults).toBeUndefined();
    expect(buildAgentView(s, "v1").investigationResults).toBeUndefined();
  });

  it("detective's investigationResults reflects the referee's list", () => {
    const s = makeState({
      investigations: [{ target: "maf", role: "mafioso" }],
    });
    expect(buildAgentView(s, "det").investigationResults).toEqual([
      { target: "maf", role: "mafioso" },
    ]);
  });

  it("alivePlayers excludes dead players", () => {
    const s = killPlayer(makeState(), "v1");
    const view = buildAgentView(s, "maf");
    expect(view.alivePlayers).not.toContain("v1");
    expect(view.alivePlayers).toContain("v2");
  });

  it("legalMoves matches getLegalMoves", () => {
    const s = makeState();
    expect(buildAgentView(s, "maf").legalMoves).toEqual(getLegalMoves(s, "maf"));
    expect(buildAgentView(s, "v1").legalMoves).toEqual(getLegalMoves(s, "v1"));
  });

  it("myId and myRole are correct", () => {
    const s = makeState();
    const view = buildAgentView(s, "det");
    expect(view.myId).toBe("det");
    expect(view.myRole).toBe("detective");
  });
});

// ---- stepPhase — night ----

describe("stepPhase — night", () => {
  it("kill target is marked dead after night", async () => {
    const agents = [
      scripted("maf", { kind: "kill", target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("v1",  { kind: "speak", text: "irrelevant" }), // villager: no night move
      scripted("v2",  { kind: "speak", text: "irrelevant" }),
    ];
    const next = await stepPhase(agents, makeState());
    expect(next.players.find((p) => p.id === "v1")!.isAlive).toBe(false);
  });

  it("kill target appears in eliminated list with cause 'night-kill'", async () => {
    const agents = [
      scripted("maf", { kind: "kill", target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("v1",  { kind: "speak", text: "n/a" }),
      scripted("v2",  { kind: "speak", text: "n/a" }),
    ];
    const next = await stepPhase(agents, makeState());
    const record = next.eliminated.find((e) => e.playerId === "v1");
    expect(record).toBeDefined();
    expect(record!.cause).toBe("night-kill");
    expect(record!.role).toBe("villager");
    expect(record!.round).toBe(1);
  });

  it("investigation result is added to the private list", async () => {
    const agents = [
      scripted("maf", { kind: "kill", target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("v1",  { kind: "speak", text: "n/a" }),
      scripted("v2",  { kind: "speak", text: "n/a" }),
    ];
    const next = await stepPhase(agents, makeState());
    expect(next.investigations).toEqual([{ target: "maf", role: "mafioso" }]);
  });

  it("phase advances to day-discuss after night", async () => {
    const next = await stepPhase(makeAgents(), makeState());
    expect(next.phase).toBe("day-discuss");
  });

  it("night actions cleared after resolution", async () => {
    const next = await stepPhase(makeAgents(), makeState());
    expect(next.nightActions).toEqual({});
  });

  it("villager's move is ignored at night", async () => {
    // v1 returns an invalid "speak" move — should not crash or affect outcome.
    const agents = [
      scripted("maf", { kind: "kill", target: "v2" }),
      scripted("det", { kind: "investigate", target: "v2" }),
      scripted("v1",  { kind: "speak", text: "sneaking a chat" }),
      scripted("v2",  { kind: "vote", target: "maf" }),
    ];
    const next = await stepPhase(agents, makeState());
    expect(next.eliminated.find((e) => e.playerId === "v2")).toBeDefined();
    expect(next.transcript).toHaveLength(0); // speak at night does not go to transcript
  });

  it("game ends as mafia win when kill reaches parity (2 alive: 1 maf, 1 non-maf)", async () => {
    // Start with 2 players: maf + v1. Maf kills v1 → parity reached before day starts.
    const twoPlayer = createInitialState([
      { id: "maf", role: "mafioso" },
      { id: "v1",  role: "villager" },
    ]);
    const agents = [
      scripted("maf", { kind: "kill", target: "v1" }),
      scripted("v1",  { kind: "speak", text: "help" }),
    ];
    const next = await stepPhase(agents, twoPlayer);
    expect(next.phase).toBe("game-over");
    expect(next.winner).toBe("mafia");
  });

  it("input state is not mutated", async () => {
    const original = makeState();
    await stepPhase(makeAgents(), original);
    expect(original.players.every((p) => p.isAlive)).toBe(true);
    expect(original.eliminated).toHaveLength(0);
  });
});

// ---- discussPasses ----

describe("discussPasses", () => {
  it("returns 1 for 3-4 players", () => {
    expect(discussPasses(3)).toBe(1);
    expect(discussPasses(4)).toBe(1);
  });

  it("returns 2 for 5-8 players", () => {
    expect(discussPasses(5)).toBe(2);
    expect(discussPasses(8)).toBe(2);
  });

  it("never returns less than 1", () => {
    expect(discussPasses(1)).toBe(1);
  });
});

// ---- stepPhase — day-discuss ----

describe("stepPhase — day-discuss", () => {
  it("all alive players add entries to the transcript", async () => {
    const s = makeState({ phase: "day-discuss" });
    const next = await stepPhase(makeAgents(), s);
    // 4 alive players → ceil(4/4) = 1 pass → 4 entries total.
    expect(next.transcript).toHaveLength(4);
    for (const id of ["maf", "det", "v1", "v2"]) {
      expect(next.transcript.some((e) => e.playerId === id)).toBe(true);
    }
  });

  it("dead players do not add transcript entries", async () => {
    const s = killPlayer(makeState({ phase: "day-discuss" }), "v1");
    const next = await stepPhase(makeAgents(), s);
    // 3 alive players → ceil(3/4) = 1 pass → 3 entries.
    expect(next.transcript).toHaveLength(3);
    expect(next.transcript.some((e) => e.playerId === "v1")).toBe(false);
  });

  it("transcript entries carry the correct round number", async () => {
    const s = makeState({ phase: "day-discuss", round: 2 });
    const next = await stepPhase(makeAgents(), s);
    expect(next.transcript.every((e) => e.round === 2)).toBe(true);
  });

  it("phase advances to day-vote after discussion", async () => {
    const s = makeState({ phase: "day-discuss" });
    const next = await stepPhase(makeAgents(), s);
    expect(next.phase).toBe("day-vote");
  });

  it("prior transcript entries are preserved", async () => {
    const prior = [{ round: 1, playerId: "maf", text: "trust me" }];
    const s = makeState({ phase: "day-discuss", transcript: prior });
    const next = await stepPhase(makeAgents(), s);
    expect(next.transcript[0]).toEqual(prior[0]);
    expect(next.transcript.length).toBeGreaterThan(1);
  });

  it("8 alive players get 2 passes = 16 transcript entries", async () => {
    const players = [
      { id: "maf", role: "mafioso" as const },
      { id: "det", role: "detective" as const },
      { id: "med", role: "medic" as const },
      { id: "v1",  role: "villager" as const },
      { id: "v2",  role: "villager" as const },
      { id: "v3",  role: "villager" as const },
      { id: "v4",  role: "villager" as const },
      { id: "v5",  role: "villager" as const },
    ];
    const agents = players.map((p) => new MafiaRandomAgent(p.id));
    const s = { ...createInitialState(players), phase: "day-discuss" as const };
    const next = await stepPhase(agents, s);
    // ceil(8/4) = 2 passes × 8 players = 16 entries
    expect(next.transcript).toHaveLength(16);
  });
});

// ---- stepPhase — day-vote ----

describe("stepPhase — day-vote", () => {
  it("plurality vote eliminates the target", async () => {
    // Three agents vote for "maf"; one abstains (scripted to vote for an invalid target).
    const s = makeState({ phase: "day-vote" });
    const agents = [
      scripted("maf", { kind: "vote", target: "v1" }),   // maf can only vote for non-self
      scripted("det", { kind: "vote", target: "maf" }),
      scripted("v1",  { kind: "vote", target: "maf" }),
      scripted("v2",  { kind: "vote", target: "maf" }),
    ];
    const next = await stepPhase(agents, s);
    expect(next.players.find((p) => p.id === "maf")!.isAlive).toBe(false);
    expect(next.eliminated.find((e) => e.playerId === "maf")?.cause).toBe("day-vote");
  });

  it("villagers win when mafioso is voted out", async () => {
    const s = makeState({ phase: "day-vote" });
    const agents = [
      scripted("maf", { kind: "vote", target: "v1" }),
      scripted("det", { kind: "vote", target: "maf" }),
      scripted("v1",  { kind: "vote", target: "maf" }),
      scripted("v2",  { kind: "vote", target: "maf" }),
    ];
    const next = await stepPhase(agents, s);
    expect(next.phase).toBe("game-over");
    expect(next.winner).toBe("villagers");
  });

  it("no elimination on a tie; round advances", async () => {
    // 2-2 split: maf+det vote for v1, v1+v2 vote for maf.
    const s = makeState({ phase: "day-vote" });
    const agents = [
      scripted("maf", { kind: "vote", target: "v1" }),
      scripted("det", { kind: "vote", target: "v1" }),
      scripted("v1",  { kind: "vote", target: "maf" }),
      scripted("v2",  { kind: "vote", target: "maf" }),
    ];
    const next = await stepPhase(agents, s);
    // No player should be eliminated.
    expect(next.players.every((p) => p.isAlive)).toBe(true);
    expect(next.eliminated).toHaveLength(0);
    expect(next.phase).toBe("night");
    expect(next.round).toBe(2);
  });

  it("phase advances to night after successful vote", async () => {
    const s = makeState({ phase: "day-vote" });
    const agents = [
      scripted("maf", { kind: "vote", target: "v1" }),
      scripted("det", { kind: "vote", target: "v1" }),
      scripted("v1",  { kind: "vote", target: "maf" }),
      scripted("v2",  { kind: "vote", target: "v1" }),
    ];
    const next = await stepPhase(agents, s);
    expect(next.phase).toBe("night"); // not game-over — v1 is villager, not maf
    expect(next.round).toBe(2);
  });

  it("mafia wins when vote eliminates a villager and tips the balance", async () => {
    // Start with 3 alive: 1 maf, 1 det, 1 vil. Vote out the detective — leaves 1 maf vs 1 vil.
    // maf >= non-maf (1 >= 1) → mafia wins.
    const threeAlive = createInitialState([
      { id: "maf", role: "mafioso" },
      { id: "det", role: "detective" },
      { id: "v1",  role: "villager" },
    ]);
    const s = { ...threeAlive, phase: "day-vote" as const };
    const agents = [
      scripted("maf", { kind: "vote", target: "det" }),
      scripted("det", { kind: "vote", target: "v1" }),
      scripted("v1",  { kind: "vote", target: "det" }),
    ];
    const next = await stepPhase(agents, s);
    expect(next.phase).toBe("game-over");
    expect(next.winner).toBe("mafia");
  });

  it("invalid vote (wrong kind) counts as abstain", async () => {
    // v2 tries to speak during day-vote — not counted; the other 3 votes proceed normally.
    const s = makeState({ phase: "day-vote" });
    const agents = [
      scripted("maf", { kind: "vote", target: "v1" }),
      scripted("det", { kind: "vote", target: "maf" }),
      scripted("v1",  { kind: "vote", target: "maf" }),
      scripted("v2",  { kind: "speak", text: "oops" }),  // invalid for day-vote: abstain
    ];
    const next = await stepPhase(agents, s);
    // maf got 2 votes, v1 got 1 vote → maf is eliminated.
    expect(next.eliminated.find((e) => e.playerId === "maf")).toBeDefined();
  });

  it("eliminated entry carries correct role and round", async () => {
    const s = makeState({ phase: "day-vote", round: 3 });
    const agents = [
      scripted("maf", { kind: "vote", target: "v1" }),
      scripted("det", { kind: "vote", target: "maf" }),
      scripted("v1",  { kind: "vote", target: "maf" }),
      scripted("v2",  { kind: "vote", target: "maf" }),
    ];
    const next = await stepPhase(agents, s);
    const record = next.eliminated.find((e) => e.playerId === "maf")!;
    expect(record.role).toBe("mafioso");
    expect(record.round).toBe(3);
    expect(record.cause).toBe("day-vote");
  });
});

// ---- stepPhase — game-over guard ----

describe("stepPhase — game-over", () => {
  it("throws when called on a finished game", async () => {
    const s = makeState({ phase: "game-over", winner: "villagers" });
    await expect(stepPhase(makeAgents(), s)).rejects.toThrow();
  });
});

// ---- Medic: getLegalMoves ----

describe("getLegalMoves — medic at night", () => {
  it("medic can protect any alive player including themselves", () => {
    const s = makeStateWithMedic();
    const moves = getLegalMoves(s, "med");
    const targets = moves.map((m) => (m as { kind: "protect"; target: string }).target).sort();
    expect(targets).toEqual(["det", "maf", "med", "v1"].sort());
    expect(moves.every((m) => m.kind === "protect")).toBe(true);
  });

  it("medic cannot protect dead players", () => {
    const s = killPlayer(makeStateWithMedic(), "v1");
    const moves = getLegalMoves(s, "med");
    const targets = moves.map((m) => (m as { kind: "protect"; target: string }).target);
    expect(targets).not.toContain("v1");
  });

  it("dead medic has no moves", () => {
    const s = killPlayer(makeStateWithMedic(), "med");
    expect(getLegalMoves(s, "med")).toHaveLength(0);
  });
});

// ---- Medic: isValidMove ----

describe("isValidMove — protect", () => {
  it("valid protect in night phase", () => {
    expect(isValidMove(makeStateWithMedic(), "med", { kind: "protect", target: "v1" })).toBe(true);
  });

  it("medic can protect themselves", () => {
    expect(isValidMove(makeStateWithMedic(), "med", { kind: "protect", target: "med" })).toBe(true);
  });

  it("protect rejected outside night phase", () => {
    const s = makeStateWithMedic({ phase: "day-discuss" });
    expect(isValidMove(s, "med", { kind: "protect", target: "v1" })).toBe(false);
  });

  it("non-medic cannot protect", () => {
    expect(isValidMove(makeStateWithMedic(), "v1", { kind: "protect", target: "det" })).toBe(false);
    expect(isValidMove(makeStateWithMedic(), "det", { kind: "protect", target: "v1" })).toBe(false);
    expect(isValidMove(makeStateWithMedic(), "maf", { kind: "protect", target: "v1" })).toBe(false);
  });

  it("cannot protect a dead player", () => {
    const s = killPlayer(makeStateWithMedic(), "v1");
    expect(isValidMove(s, "med", { kind: "protect", target: "v1" })).toBe(false);
  });
});

// ---- Medic: buildAgentView ----

describe("buildAgentView — medic", () => {
  it("medic receives protectionHistory; others do not", () => {
    const s = makeStateWithMedic();
    expect(buildAgentView(s, "med").protectionHistory).toBeDefined();
    expect(buildAgentView(s, "maf").protectionHistory).toBeUndefined();
    expect(buildAgentView(s, "det").protectionHistory).toBeUndefined();
    expect(buildAgentView(s, "v1").protectionHistory).toBeUndefined();
  });

  it("medic's protectionHistory reflects the referee's list", () => {
    const s = makeStateWithMedic({
      protections: [{ round: 1, target: "v1", blocked: false }],
    });
    expect(buildAgentView(s, "med").protectionHistory).toEqual([
      { round: 1, target: "v1", blocked: false },
    ]);
  });
});

// ---- Medic: stepPhase — night ----

describe("stepPhase — night — medic protection", () => {
  it("protection blocks the kill when medic and mafioso target the same player", async () => {
    const agents = [
      scripted("maf", { kind: "kill",      target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("med", { kind: "protect",    target: "v1" }),  // saves v1
      scripted("v1",  { kind: "speak",      text: "n/a" }),
    ];
    const next = await stepPhase(agents, makeStateWithMedic());
    // v1 should be alive (kill was blocked)
    expect(next.players.find((p) => p.id === "v1")!.isAlive).toBe(true);
    expect(next.eliminated).toHaveLength(0);
  });

  it("kill goes through when medic protects a different player", async () => {
    const agents = [
      scripted("maf", { kind: "kill",      target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("med", { kind: "protect",    target: "det" }), // protects wrong player
      scripted("v1",  { kind: "speak",      text: "n/a" }),
    ];
    const next = await stepPhase(agents, makeStateWithMedic());
    expect(next.players.find((p) => p.id === "v1")!.isAlive).toBe(false);
    expect(next.eliminated).toHaveLength(1);
  });

  it("blocked protection is recorded with blocked: true", async () => {
    const agents = [
      scripted("maf", { kind: "kill",      target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("med", { kind: "protect",    target: "v1" }),
      scripted("v1",  { kind: "speak",      text: "n/a" }),
    ];
    const next = await stepPhase(agents, makeStateWithMedic());
    expect(next.protections).toHaveLength(1);
    expect(next.protections[0]).toEqual({ round: 1, target: "v1", blocked: true });
  });

  it("unblocked protection is recorded with blocked: false", async () => {
    const agents = [
      scripted("maf", { kind: "kill",      target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("med", { kind: "protect",    target: "det" }),
      scripted("v1",  { kind: "speak",      text: "n/a" }),
    ];
    const next = await stepPhase(agents, makeStateWithMedic());
    expect(next.protections[0]).toEqual({ round: 1, target: "det", blocked: false });
  });

  it("phase still advances to day-discuss when protection blocks the kill", async () => {
    const agents = [
      scripted("maf", { kind: "kill",       target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("med", { kind: "protect",     target: "v1" }),
      scripted("v1",  { kind: "speak",       text: "n/a" }),
    ];
    const next = await stepPhase(agents, makeStateWithMedic());
    expect(next.phase).toBe("day-discuss");
  });

  it("protections accumulate across rounds", async () => {
    const s = makeStateWithMedic({
      protections: [{ round: 1, target: "det", blocked: false }],
    });
    const agents = [
      scripted("maf", { kind: "kill",       target: "v1" }),
      scripted("det", { kind: "investigate", target: "maf" }),
      scripted("med", { kind: "protect",     target: "v1" }),
      scripted("v1",  { kind: "speak",       text: "n/a" }),
    ];
    const next = await stepPhase(agents, s);
    expect(next.protections).toHaveLength(2);
  });
});

// ---- Full game integration ----

describe("full game — RandomAgent with medic", () => {
  it("always produces a winner and terminates", async () => {
    let state = makeStateWithMedic();
    const agents = makeAgentsWithMedic();
    for (let step = 0; step < 30; step++) {
      if (state.phase === "game-over") break;
      state = await stepPhase(agents, state);
    }
    expect(state.phase).toBe("game-over");
    expect(state.winner).toMatch(/^(mafia|villagers)$/);
  });
});

describe("full game — RandomAgent", () => {
  it("always produces a winner and terminates", async () => {
    let state = makeState();
    const agents = makeAgents();
    // Safety valve: the game can't last more than ~6 phase steps in a 4-player game
    // (see reasoning in HANDOFF.md — mafia reaches parity in at most 2 round cycles).
    // 20 steps is extremely conservative.
    for (let step = 0; step < 20; step++) {
      if (state.phase === "game-over") break;
      state = await stepPhase(agents, state);
    }
    expect(state.phase).toBe("game-over");
    expect(state.winner).toMatch(/^(mafia|villagers)$/);
  });

  it("eliminated list reflects every player removed from the game", async () => {
    let state = makeState();
    const agents = makeAgents();
    for (let step = 0; step < 20; step++) {
      if (state.phase === "game-over") break;
      state = await stepPhase(agents, state);
    }
    // Every player marked dead must have an entry in eliminated.
    const deadIds = state.players.filter((p) => !p.isAlive).map((p) => p.id).sort();
    const eliminatedIds = state.eliminated.map((e) => e.playerId).sort();
    expect(eliminatedIds).toEqual(deadIds);
  });
});
