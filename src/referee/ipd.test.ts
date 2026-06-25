import { describe, expect, it } from "vitest";
import { RandomAgent } from "../agents/random-agent";
import { applyPayoffs, createInitialState, isLegalMove, runRound } from "./ipd";

describe("applyPayoffs", () => {
  it("CC → 3/3", () => expect(applyPayoffs("cooperate", "cooperate")).toEqual([3, 3]));
  it("CD → 0/5", () => expect(applyPayoffs("cooperate", "defect")).toEqual([0, 5]));
  it("DC → 5/0", () => expect(applyPayoffs("defect", "cooperate")).toEqual([5, 0]));
  it("DD → 1/1", () => expect(applyPayoffs("defect", "defect")).toEqual([1, 1]));
});

describe("isLegalMove", () => {
  it("accepts 'cooperate'", () => expect(isLegalMove("cooperate")).toBe(true));
  it("accepts 'defect'", () => expect(isLegalMove("defect")).toBe(true));
  it("rejects arbitrary string", () => expect(isLegalMove("attack")).toBe(false));
  it("rejects empty string", () => expect(isLegalMove("")).toBe(false));
  it("rejects number", () => expect(isLegalMove(1)).toBe(false));
  it("rejects null", () => expect(isLegalMove(null)).toBe(false));
});

describe("createInitialState", () => {
  it("sets round to 0", () => {
    expect(createInitialState(["a", "b"]).round).toBe(0);
  });
  it("initialises scores to 0 for each agent", () => {
    expect(createInitialState(["a", "b"]).scores).toEqual({ a: 0, b: 0 });
  });
  it("starts with an empty results list", () => {
    expect(createInitialState(["a", "b"]).results).toHaveLength(0);
  });
});

describe("runRound — 2 agents", () => {
  it("increments round counter", async () => {
    const [a, b] = [new RandomAgent("a"), new RandomAgent("b")];
    const state = await runRound([a, b], createInitialState(["a", "b"]));
    expect(state.round).toBe(1);
  });

  it("produces 2 result entries (one per side of the pairing)", async () => {
    const [a, b] = [new RandomAgent("a"), new RandomAgent("b")];
    const state = await runRound([a, b], createInitialState(["a", "b"]));
    expect(state.results).toHaveLength(2);
  });

  it("each result entry has the correct perspective (agentId sees their own move)", async () => {
    const [a, b] = [new RandomAgent("a"), new RandomAgent("b")];
    const state = await runRound([a, b], createInitialState(["a", "b"]));
    const aResult = state.results.find((r) => r.agentId === "a")!;
    const bResult = state.results.find((r) => r.agentId === "b")!;
    // The two entries must be mirror images: A's move is B's opponentMove and vice versa.
    expect(aResult.move).toBe(bResult.opponentMove);
    expect(bResult.move).toBe(aResult.opponentMove);
  });

  it("scores sum to the correct total for the moves played", async () => {
    // Known-move agents let us assert exact scores.
    const alwaysCooperate = { id: "c", decide: async () => "cooperate" as const };
    const alwaysDefect    = { id: "d", decide: async () => "defect"    as const };
    const state = await runRound([alwaysCooperate, alwaysDefect], createInitialState(["c", "d"]));
    // CD → cooperator gets 0, defector gets 5
    expect(state.scores["c"]).toBe(0);
    expect(state.scores["d"]).toBe(5);
  });

  it("does not mutate the input state", async () => {
    const [a, b] = [new RandomAgent("a"), new RandomAgent("b")];
    const initial = createInitialState(["a", "b"]);
    await runRound([a, b], initial);
    expect(initial.round).toBe(0);
    expect(initial.results).toHaveLength(0);
  });
});

describe("runRound — 3 agents (round-robin)", () => {
  it("produces 6 result entries (3 pairings × 2 sides each)", async () => {
    const agents = ["a", "b", "c"].map((id) => new RandomAgent(id));
    const state = await runRound(agents, createInitialState(["a", "b", "c"]));
    expect(state.results).toHaveLength(6);
  });

  it("every agent appears in the results", async () => {
    const agents = ["a", "b", "c"].map((id) => new RandomAgent(id));
    const state = await runRound(agents, createInitialState(["a", "b", "c"]));
    for (const id of ["a", "b", "c"]) {
      expect(state.results.some((r) => r.agentId === id)).toBe(true);
    }
  });
});

describe("runRound — history accumulates across rounds", () => {
  it("history passed to agent grows each round", async () => {
    const seenHistoryLengths: number[] = [];
    // Spy agent records the history length it receives each time it decides.
    const spy = {
      id: "spy",
      decide: async (view: { history: unknown[] }) => {
        seenHistoryLengths.push(view.history.length);
        return "cooperate" as const;
      },
    };
    const other = new RandomAgent("other");
    let state = createInitialState(["spy", "other"]);
    for (let i = 0; i < 3; i++) state = await runRound([spy, other], state);
    // After rounds 1, 2, 3 the spy should have seen history lengths 0, 1, 2
    expect(seenHistoryLengths).toEqual([0, 1, 2]);
  });
});
