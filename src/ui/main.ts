import { LLMAgent } from "../agents/llm-agent";
import { HumanMafiaAgent } from "../agents/human-mafia-agent";
import { MafiaLLMAgent } from "../agents/mafia-llm-agent";
import { WllamaClient } from "../llm/wllama-client";
import { createInitialState as ipdCreateInitial, runRound } from "../referee/ipd";
import { createInitialState as mafiaCreateInitial, stepPhase, GameCancelledError } from "../referee/mafia";
import type { MafiaGameState, Role } from "../referee/mafia";
import type { GameState } from "../referee/types";
import { initIPDLayout, initMafiaLayout } from "./render";
import { recordMafiaGame, recordIPDGame, initLeaderboardLayout } from "./leaderboard";

const app = document.querySelector<HTMLDivElement>("#app")!;

// ── Dev logging ───────────────────────────────────────────────────────────────
// Forwards every console line to spike-log.txt via the Vite file-logger plugin.
// Probes /__log once at startup; silences POST-404 spam on Cloudflare.

let loggingEnabled = false;
fetch("/__log", { method: "POST", body: "__RESET__" })
  .then((r) => { loggingEnabled = r.ok; })
  .catch(() => {});

const stringifyArg = (a: unknown) =>
  typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })();

// Internal llama.cpp diagnostic messages — suppress from the console entirely.
const LOG_SKIP = [/^slot\s/, /^srv\s/];

for (const level of ["log", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(stringifyArg).join(" ");
    if (LOG_SKIP.some((re) => re.test(text))) return;
    original(...args);
    if (!loggingEnabled) return;
    fetch("/__log", {
      method: "POST",
      body: `[${new Date().toISOString()}] ${level.toUpperCase()}: ${text}`,
    }).catch(() => {});
  };
}

// ── Mafia: personality catalogue ─────────────────────────────────────────────
// Personalities describe how an agent communicates — tone, style, habits.
// Roles (mafioso / detective / medic / villager) are assigned randomly each game
// and injected separately, so the same personality can play different roles.

// Each personality has a fixed human name. The name is the agent's public id used
// in the game state and LLM prompts — other agents never see the personality label.
// The personality label is viewer-only: shown in the UI as "Alice (paranoid)".
const MAFIA_PERSONALITIES: Array<{ id: string; name: string; personalityPrompt: string }> = [
  {
    id: "paranoid", name: "Alice",
    personalityPrompt:
      "You are a deeply anxious person who sees danger everywhere. You speak urgently, " +
      "jump to accusations quickly, and become defensive the moment anyone looks at you sideways.",
  },
  {
    id: "analytical", name: "Ben",
    personalityPrompt:
      "You are a calm, methodical thinker. You reason from evidence, weigh your words carefully, " +
      "and express yourself in structured, measured sentences. You don't get emotional.",
  },
  {
    id: "naive", name: "Clara",
    personalityPrompt:
      "You are an optimistic, trusting person who wants to see the best in people. " +
      "You give others the benefit of the doubt, try to build consensus, and are easy to sway.",
  },
  {
    id: "deceptive", name: "David",
    personalityPrompt:
      "You are naturally guarded and strategic. You say little, watch carefully, and only speak " +
      "when you have a point worth making. You're hard to read and rarely show your full hand.",
  },
  {
    id: "impulsive", name: "Elena",
    personalityPrompt:
      "You are quick to decide and slow to reconsider. You state your opinion fast and " +
      "push others to commit. You don't like ambiguity and don't sit on the fence.",
  },
  {
    id: "reserved", name: "Finn",
    personalityPrompt:
      "You are quiet and observant. In conversation you say as little as possible — " +
      "usually just one short sentence. You watch more than you talk.",
  },
  {
    id: "dramatic", name: "Grace",
    personalityPrompt:
      "You are theatrical and emotionally expressive. You react strongly to everything, " +
      "use vivid language, and make every situation feel urgent and consequential.",
  },
  {
    id: "skeptical", name: "Hugo",
    personalityPrompt:
      "You challenge everything and trust no one's stated reasoning. You poke holes in " +
      "other people's arguments and demand better evidence before committing to anything.",
  },
];

// Role instructions are injected on top of the personality.
// Intentionally positive-only — negative constraints ("NEVER say X") make tiny models
// repeat the forbidden words. Instead, say what to DO and how to sound.
const ROLE_INSTRUCTIONS: Record<Role, string> = {
  mafioso:
    "You are secretly working against the group. " +
    "Act like a worried, innocent member. Point suspicion at other people to protect yourself.",

  detective:
    "You have a strong sense of who can be trusted. " +
    "Share suspicions as gut feelings — sound like a perceptive observer.",

  medic:
    "You quietly look out for the group. " +
    "Voice your suspicions like everyone else.",

  villager:
    "Watch for anyone acting evasive or deflecting blame onto others. Call them out.",
};

// Appended to every agent's system prompt. Kept to one rule — tiny models drift on longer lists.
const SPEAK_RULES = "When speaking, say exactly one sentence naming a specific person and why you find them suspicious.";

// Shuffle personalities and assign roles randomly each game.
// Layout: 1 mafioso, 1 detective, 1 medic, 5 villagers = 8 total.
// When humanPlays is true, the mafioso slot is reserved for "you" and only 7 LLM
// personalities are used (one is left out each game at random).
// Returns: id = human name (what agents call each other); personality = personality key (viewer-only).
function assignRoles(isHuman: boolean): Array<{ id: string; personality: string; role: Role; systemPrompt: string }> {
  const shuffled = [...MAFIA_PERSONALITIES].sort(() => Math.random() - 0.5);
  const roles: Role[] = [
    "mafioso", "detective", "medic",
    "villager", "villager", "villager", "villager", "villager",
  ];

  if (isHuman) {
    // Human takes mafioso; 7 LLM agents take the remaining roles.
    const llmRoles = roles.slice(1); // detective, medic, villager×5
    return [
      { id: "Sam", personality: "you", role: "mafioso", systemPrompt: "" },
      ...shuffled.slice(0, 7).map((p, i) => ({
        id: p.name,           // name is the public id — what agents call each other
        personality: p.id,    // personality key is viewer-only
        role: llmRoles[i],
        systemPrompt: `${p.personalityPrompt} ${ROLE_INSTRUCTIONS[llmRoles[i]]} ${SPEAK_RULES}`,
      })),
    ];
  }

  return shuffled.map((p, i) => ({
    id: p.name,
    personality: p.id,
    role: roles[i],
    systemPrompt: `${p.personalityPrompt} ${ROLE_INSTRUCTIONS[roles[i]]} ${SPEAK_RULES}`,
  }));
}

// ── IPD agent definitions ─────────────────────────────────────────────────────
// id = human name (agents refer to each other by name, never by strategy label).
// personality = strategy key — viewer-only, shown in UI and leaderboard.

const IPD_AGENTS: Array<{ id: string; personality: string; prompt: string }> = [
  {
    id: "Iris", personality: "tit-for-tat",
    prompt:
      "You are playing the Prisoner's Dilemma. Your strategy is tit-for-tat: " +
      "always cooperate on the first round, then copy whatever your opponent did last round. " +
      "If they cooperated last round, cooperate. If they defected last round, defect. " +
      "Follow this rule strictly.",
  },
  {
    id: "Jack", personality: "always-defect",
    prompt:
      "You are playing the Prisoner's Dilemma. You are a ruthless self-interested player. " +
      "Defecting always gives you a better personal outcome regardless of what your opponent does. " +
      "Always defect. Never cooperate under any circumstances.",
  },
  {
    id: "Kira", personality: "always-cooperate",
    prompt:
      "You are playing the Prisoner's Dilemma. You are an idealistic cooperator who believes " +
      "mutual trust is the only path to the best collective outcome. " +
      "Always cooperate, no matter what your opponent has done.",
  },
  {
    id: "Leo", personality: "adaptive",
    prompt:
      "You are playing the Prisoner's Dilemma. Payoffs per round: both cooperate = +3 each; " +
      "you defect, they cooperate = +5 you / +0 them; you cooperate, they defect = +0 you / +5 them; " +
      "both defect = +1 each. You have 10 rounds total against each opponent. " +
      "Study the round history you are given and decide what will earn you the most points " +
      "over the remaining rounds. Use your own judgment — there is no fixed rule to follow.",
  },
  {
    id: "Maya", personality: "counter",
    prompt:
      "You are playing the Prisoner's Dilemma. Payoffs per round: both cooperate = +3 each; " +
      "you defect, they cooperate = +5 you / +0 them; you cooperate, they defect = +0 you / +5 them; " +
      "both defect = +1 each. Your strategy is to read your opponent's pattern from the history and counter it: " +
      "if they always cooperate, defect every round to exploit them; " +
      "if they always defect, defect every round to avoid being exploited; " +
      "if they tend to copy your last move, cooperate to lock in mutual +3 gains. " +
      "When no clear pattern has emerged yet, defect by default.",
  },
];

const IPD_ROUNDS = 10;

// ── Shared model instance ─────────────────────────────────────────────────────
// The model (~510 MB) loads once into OPFS and is reused across both game types.
// loadedPromise is set on first call; subsequent calls await the same resolved promise.
const client = new WllamaClient();
let loadedPromise: Promise<void> | null = null;

// ── Per-game slot state ───────────────────────────────────────────────────────
// Each game tab (Mafia, IPD) has its own slot so they can run independently.
// Switching between the two game tabs background-pauses the leaving game and
// resumes the arriving one. Switching to/from Leaderboard lets games run freely.
interface Slot {
  // Incremented on cancel — game loops compare this to their captured id to know they were cancelled.
  gameId: number;
  // True when the loop is parked at a waitIfPausedFor checkpoint (user-paused OR bg-paused).
  paused: boolean;
  // True only when the user explicitly pressed Pause — persists across tab switches.
  userPaused: boolean;
  // Resolve function for the pending pause promise; set inside waitIfPausedFor.
  pauseResolve: (() => void) | null;
  // Mafia only — the active HumanMafiaAgent, if any; cancelled when game is interrupted.
  humanAgent: HumanMafiaAgent | null;
  status: "idle" | "running" | "paused" | "stopped" | "finished";
}

function makeSlot(): Slot {
  return { gameId: 0, paused: false, userPaused: false, pauseResolve: null, humanAgent: null, status: "idle" };
}

const mafiaSlot = makeSlot();
const ipdSlot   = makeSlot();

function slotFor(tab: "mafia" | "ipd"): Slot {
  return tab === "mafia" ? mafiaSlot : ipdSlot;
}

// Lift the pause block — wakes up any loop waiting inside waitIfPausedFor.
function releaseSlot(slot: Slot): void {
  const resolve = slot.pauseResolve;
  slot.paused       = false;
  slot.pauseResolve = null;
  resolve?.();
}

// Stop whatever is running: cancel pending human input, lift any pause,
// and bump gameId so the running loop sees isCancelled() and exits cleanly.
function cancelSlot(slot: Slot): void {
  slot.humanAgent?.cancel();
  slot.humanAgent  = null;
  slot.userPaused  = false;
  releaseSlot(slot);
  slot.gameId++;
}

// Called inside game loops between turns. Suspends until the slot is unpaused.
async function waitIfPausedFor(slot: Slot): Promise<void> {
  if (!slot.paused) return;
  await new Promise<void>((r) => { slot.pauseResolve = r; });
}

// ── humanPlays flag ───────────────────────────────────────────────────────────
// Whether the human is playing as the mafioso. Persists across game restarts.
let humanPlays = false;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  app.innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="mafia">Mini-Mafia</button>
      <button class="tab-btn" data-tab="ipd">Prisoner&rsquo;s Dilemma</button>
      <button class="tab-btn" data-tab="leaderboard">Leaderboard</button>
      <div class="game-controls">
        <span id="game-state" class="game-state" hidden></span>
        <button id="restart-btn" class="ctrl-btn">Restart</button>
        <button id="pause-btn" class="ctrl-btn" hidden>Pause</button>
        <button id="stop-btn" class="ctrl-btn ctrl-btn-stop" hidden>Stop</button>
      </div>
    </div>
    <div id="mafia-container"></div>
    <div id="ipd-container" hidden></div>
    <div id="leaderboard-container" hidden></div>
  `;

  const mafiaContainer       = app.querySelector<HTMLElement>("#mafia-container")!;
  const ipdContainer         = app.querySelector<HTMLElement>("#ipd-container")!;
  const leaderboardContainer = app.querySelector<HTMLElement>("#leaderboard-container")!;
  const tabBtns    = Array.from(app.querySelectorAll<HTMLButtonElement>(".tab-btn"));
  const restartBtn = app.querySelector<HTMLButtonElement>("#restart-btn")!;
  const pauseBtn   = app.querySelector<HTMLButtonElement>("#pause-btn")!;
  const stopBtn    = app.querySelector<HTMLButtonElement>("#stop-btn")!;
  const stateEl    = app.querySelector<HTMLElement>("#game-state")!;

  // currentTab: which tab is visible right now.
  let currentTab: "mafia" | "ipd" | "leaderboard" = "mafia";
  // activeGameTab: which game's controls to show; stays on the last game tab even
  // while leaderboard is visible.
  let activeGameTab: "mafia" | "ipd" = "mafia";

  function containerFor(tab: "mafia" | "ipd"): HTMLElement {
    return tab === "mafia" ? mafiaContainer : ipdContainer;
  }

  // Show exactly one container; hide the other two.
  function showOnly(tab: "mafia" | "ipd" | "leaderboard"): void {
    mafiaContainer.hidden       = tab !== "mafia";
    ipdContainer.hidden         = tab !== "ipd";
    leaderboardContainer.hidden = tab !== "leaderboard";
  }

  // Sync buttons and state badge to the foreground slot's current status.
  // Called whenever slot.status or tab visibility changes.
  function syncControls(): void {
    if (currentTab === "leaderboard") {
      restartBtn.hidden = true;
      pauseBtn.hidden   = true;
      stopBtn.hidden    = true;
      stateEl.hidden    = true;
      return;
    }
    const slot = slotFor(activeGameTab);
    restartBtn.hidden = false;
    const isActive = slot.status === "running" || slot.status === "paused";
    pauseBtn.hidden = !isActive;
    stopBtn.hidden  = !isActive;
    const stateConfigs: Record<Slot["status"], { label: string; cls: string }> = {
      idle:     { label: "",            cls: ""                    },
      running:  { label: "",            cls: ""                    },
      paused:   { label: "⏸  Paused",   cls: "game-state-paused"   },
      stopped:  { label: "■  Stopped",  cls: "game-state-stopped"  },
      finished: { label: "✓  Finished", cls: "game-state-finished" },
    };
    const cfg = stateConfigs[slot.status];
    stateEl.hidden      = slot.status === "running" || slot.status === "idle";
    stateEl.textContent = cfg.label;
    stateEl.className   = `game-state ${cfg.cls}`;
    pauseBtn.textContent = slot.userPaused ? "Resume" : "Pause";
  }

  // Cancel whatever is running in this slot's tab and launch a fresh game.
  function startGame(tab: "mafia" | "ipd"): void {
    const slot      = slotFor(tab);
    const container = containerFor(tab);
    cancelSlot(slot);
    slot.status = "running";
    const myId = slot.gameId;
    const onComplete = () => {
      slot.status = "finished";
      // Only update controls if this game's tab is the one currently shown.
      if (activeGameTab === tab && currentTab !== "leaderboard") syncControls();
    };
    void (tab === "mafia"
      ? runMafiaGame(container, slot, myId, onComplete)
      : runIPDGame(container, slot, myId, onComplete));
  }

  for (const btn of tabBtns) {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const nextTab = btn.dataset.tab as "mafia" | "ipd" | "leaderboard";
      currentTab = nextTab;

      if (nextTab === "leaderboard") {
        // Leaderboard has no model — games can keep running freely in the background.
        showOnly("leaderboard");
        initLeaderboardLayout(leaderboardContainer);
        syncControls();
        return;
      }

      // Switching to a game tab: if it's different from the currently active game,
      // background-pause that game so only one game runs inference at a time.
      if (activeGameTab !== nextTab) {
        const prev = slotFor(activeGameTab);
        // Only mark as paused if running and not already paused.
        // Status intentionally stays "running" — bg pause is transparent to the user.
        if (prev.status === "running" && !prev.paused) {
          prev.paused = true;
        }
      }

      activeGameTab = nextTab;
      showOnly(nextTab);
      const incoming = slotFor(nextTab);

      if (incoming.gameId === 0) {
        // First visit to this tab — start the game for the first time.
        startGame(nextTab);
      } else if (incoming.paused && !incoming.userPaused) {
        // Auto-resume a background-paused game (the user didn't manually pause it).
        releaseSlot(incoming);
      }
      // If incoming.userPaused: leave it — syncControls shows "Resume" for the user.

      syncControls();
    });
  }

  restartBtn.addEventListener("click", () => {
    startGame(activeGameTab);
    syncControls();
  });

  pauseBtn.addEventListener("click", () => {
    const slot = slotFor(activeGameTab);
    if (!slot.userPaused) {
      slot.userPaused = true;
      slot.paused     = true;
      slot.status     = "paused";
    } else {
      slot.userPaused = false;
      slot.status     = "running";
      releaseSlot(slot);
    }
    syncControls();
  });

  stopBtn.addEventListener("click", () => {
    const slot = slotFor(activeGameTab);
    cancelSlot(slot);
    slot.status = "stopped";
    syncControls();
  });

  // Auto-start Mafia on page load.
  startGame("mafia");
  syncControls();
}

// ── Mafia runner ──────────────────────────────────────────────────────────────
async function runMafiaGame(
  container: HTMLElement,
  slot: Slot,
  myGameId: number,
  onComplete: () => void,
): Promise<void> {
  // isCancelled: returns true if this game instance was replaced (tab switch / restart).
  const isCancelled = () => slot.gameId !== myGameId;

  // Assign roles randomly each game so the same personality can play any role.
  const assignments  = assignRoles(humanPlays);
  const agentDisplay = assignments.map((a) => ({ id: a.id, personality: a.personality }));
  const detectiveId  = assignments.find((a) => a.role === "detective")!.id;
  const medicId      = assignments.find((a) => a.role === "medic")!.id;

  const ui = initMafiaLayout(container, agentDisplay, humanPlays, (on) => {
    // Human/AI toggle fired — restart this game with the new play mode.
    humanPlays = on;
    cancelSlot(slot);
    slot.status = "running";
    const newId = slot.gameId;
    void runMafiaGame(container, slot, newId, onComplete);
  });
  ui.appendLog("=== LLM Arena — Mini-Mafia ===\n");

  if (!loadedPromise) {
    ui.setStatus("Loading model…");
    ui.appendLog("Loading model (first visit: ~510 MB download)…");
    loadedPromise = client.load((pct) => {
      ui.setStatus(`Loading model… ${pct}%`);
      ui.setProgress(pct);
      if (pct > 0 && pct % 25 === 0) ui.appendLog(`  ${pct}%`);
    });
  } else {
    ui.setStatus("Starting game…");
  }

  await loadedPromise;
  if (isCancelled()) return;

  ui.setProgress(100);
  ui.setStatus("Model ready. Starting game…");
  ui.appendLog("Model ready.\n");

  // Build agents — human takes the mafioso slot when play mode is on.
  let humanAgent: HumanMafiaAgent | null = null;
  const agents = assignments.map(({ id, role, systemPrompt }) => {
    if (humanPlays && role === "mafioso") {
      humanAgent = new HumanMafiaAgent(id);
      humanAgent.onNeedInput = (view, onMove) => ui.showHumanInput(view, onMove);
      humanAgent.onHide = () => ui.hideHumanInput();
      return humanAgent;
    }
    return new MafiaLLMAgent(id, systemPrompt, client);
  });
  // Store on the slot so cancelSlot() can cancel pending human input if needed.
  slot.humanAgent = humanAgent;

  ui.appendLog(`Agents: ${agentDisplay.map((a) => a.id).join(", ")}`);
  if (humanPlays) {
    // Don't reveal LLM roles to the human — they have to figure it out.
    ui.appendLog("You are the mafioso. Good luck.\n");
  } else {
    // God-mode: viewer can see all roles and private logs since they're just watching.
    // Show "Alice (paranoid)=mafioso" format so the personality is clear alongside the name.
    const roleLog = assignments.map((a) => `${a.id} (${a.personality})=${a.role}`).join(", ");
    ui.appendLog(`Roles (hidden from agents): ${roleLog}\n`);
  }

  let state: MafiaGameState = mafiaCreateInitial(
    assignments.map(({ id, role }) => ({ id, role })),
  );

  while (state.phase !== "game-over") {
    if (isCancelled()) return;
    await waitIfPausedFor(slot);
    if (isCancelled()) return; // re-check: Stop may have been pressed during pause

    const phase = state.phase;
    const round = state.round;

    const prevEliminatedLen     = state.eliminated.length;
    const prevTranscriptLen     = state.transcript.length;
    const prevInvestigationsLen = state.investigations.length;
    const prevProtectionsLen    = state.protections.length;

    if (phase === "night") {
      ui.appendLog(`── Round ${round}: Night ───────────────────────`);
    } else if (phase === "day-discuss") {
      ui.appendLog(`── Round ${round}: Day — Discussion ─────────────`);
    } else if (phase === "day-vote") {
      ui.appendLog(`── Round ${round}: Day — Vote ───────────────────`);
    }

    // Tracks discussion pass state so beforeDecide can include it in the status bar.
    let currentDiscussPass = 1;
    let totalDiscussPasses = 1;

    try {
      state = await stepPhase(agents, state, {
        shouldStop: isCancelled,
        beforeDecide(agentId) {
          const label =
            phase === "night"       ? "Night"    :
            phase === "day-discuss" ? `Discussion ${currentDiscussPass}/${totalDiscussPasses}` : "Voting";
          ui.setStatus(`Round ${round} · ${label} · ${agentId} is deciding…`);
          if (phase === "day-discuss") ui.setStreamingAgent(agentId);
        },
        onDiscussPass(pass, total) {
          currentDiscussPass = pass;
          totalDiscussPasses = total;
          ui.appendLog(`  — discussion pass ${pass}/${total} —`);
        },
        onToken(_agentId, fragment) {
          ui.appendStreamToken(fragment);
        },
      });
    } catch (e) {
      if (e instanceof GameCancelledError) return;
      throw e;
    }

    const newElim           = state.eliminated.slice(prevEliminatedLen);
    const newTranscript     = state.transcript.slice(prevTranscriptLen);
    const newInvestigations = state.investigations.slice(prevInvestigationsLen);
    const newProtections    = state.protections.slice(prevProtectionsLen);

    if (phase === "night") {
      if (newElim.length > 0) {
        for (const e of newElim) ui.appendLog(`  ✗ ${e.playerId} was found dead (${e.role})`);
      } else {
        ui.appendLog(`  (nobody was killed tonight)`);
      }
      // Only show private logs in god-mode (watch mode). When human is playing,
      // revealing detective findings or medic targets would be a free win condition.
      if (!humanPlays) {
        for (const inv of newInvestigations) {
          ui.appendLog(`  [private — ${detectiveId}] investigated ${inv.target} → ${inv.role}`);
        }
        for (const prot of newProtections) {
          const note = prot.blocked ? " — kill blocked!" : "";
          ui.appendLog(`  [private — ${medicId}] protected ${prot.target}${note}`);
        }
      }
    } else if (phase === "day-discuss") {
      for (const e of newTranscript) ui.appendLog(`  [${e.playerId}]: "${e.text}"`);
    } else if (phase === "day-vote") {
      if (newElim.length > 0) {
        for (const e of newElim) ui.appendLog(`  ✗ ${e.playerId} was voted out (${e.role})`);
      } else {
        ui.appendLog(`  (tie vote — no elimination this round)`);
      }
    }

    ui.updatePlayers(state);
    ui.appendLog("");
  }

  const winner = state.winner!;
  recordMafiaGame(assignments, winner);
  onComplete();
  const winLabel = winner === "mafia" ? "MAFIA WINS" : "VILLAGERS WIN";

  ui.setStatus(`Game over — ${winLabel}`);
  ui.appendLog(`══════════════════════════════════════`);
  ui.appendLog(winLabel);

  const survivors = state.players
    .filter((p) => p.isAlive)
    .map((p) => `${p.id} (${p.role})`)
    .join(", ");
  ui.appendLog(`Survivors: ${survivors}`);

  const elimOrder = state.eliminated
    .map((e) => `${e.playerId} (${e.role}, r${e.round} ${e.cause})`)
    .join(" → ");
  ui.appendLog(`Elimination order: ${elimOrder}`);

  ui.showWinner(winner);
  ui.updatePlayers(state);
}

// ── IPD runner ────────────────────────────────────────────────────────────────
async function runIPDGame(
  container: HTMLElement,
  slot: Slot,
  myGameId: number,
  onComplete: () => void,
): Promise<void> {
  const isCancelled = () => slot.gameId !== myGameId;
  const agentDisplay   = IPD_AGENTS.map((a) => ({ id: a.id, personality: a.personality }));
  const agentIds       = IPD_AGENTS.map((a) => a.id);
  // Maps name → personality key so the leaderboard can record by personality, not by name.
  const personalityOf  = Object.fromEntries(IPD_AGENTS.map((a) => [a.id, a.personality]));

  const ui = initIPDLayout(container, agentDisplay);
  ui.appendLog("=== LLM Arena — Prisoner's Dilemma ===\n");

  if (!loadedPromise) {
    ui.setStatus("Loading model…");
    ui.appendLog("Loading model (first visit: ~510 MB download)…");
    loadedPromise = client.load((pct) => {
      ui.setStatus(`Loading model… ${pct}%`);
      ui.setProgress(pct);
      if (pct > 0 && pct % 20 === 0) ui.appendLog(`  ${pct}%`);
    });
  } else {
    ui.setStatus("Starting match…");
  }

  await loadedPromise;
  if (isCancelled()) return;

  ui.setProgress(100);
  ui.setStatus("Model ready. Starting match…");
  ui.appendLog("Model ready.\n");

  const agents = IPD_AGENTS.map(({ id, prompt }) => new LLMAgent(id, prompt, client));

  ui.appendLog(`Agents: ${agentIds.join(", ")}`);
  ui.appendLog(`${IPD_ROUNDS} rounds, round-robin\n`);

  let state: GameState = ipdCreateInitial(agentIds);

  for (let round = 1; round <= IPD_ROUNDS; round++) {
    if (isCancelled()) return;
    await waitIfPausedFor(slot);
    if (isCancelled()) return; // re-check: Stop may have been pressed during pause

    ui.setStatus(`Round ${round} / ${IPD_ROUNDS}`);
    ui.appendLog(`--- Round ${round} ---`);

    state = await runRound(agents, state, {
      beforeDecide(agentId, opponentId) {
        ui.setStatus(`Round ${round} / ${IPD_ROUNDS} — ${agentId} deciding vs ${opponentId}`);
        ui.setStreamingAgent(agentId);
      },
      onToken(_agentId, _opponentId, fragment) {
        ui.appendStreamToken(fragment);
      },
    });

    ui.updateScores(state);
    ui.updateHeatmap(state);
    ui.appendLog(
      `  Scores: ${Object.entries(state.scores).map(([id, s]) => `${id}=${s}`).join(", ")}`,
    );
  }

  if (isCancelled()) return;

  recordIPDGame(state.scores, personalityOf);
  onComplete();
  ui.setStatus("Match complete!");
  ui.appendLog("\n=== Final scores ===");
  for (const [id, score] of Object.entries(state.scores).sort(([, a], [, b]) => b - a)) {
    ui.appendLog(`  ${id}: ${score} pts`);
  }

  ui.appendLog("\n=== Cooperation rates ===");
  for (const agent of agents) {
    const own  = state.results.filter((r) => r.agentId === agent.id);
    const coop = own.filter((r) => r.move === "cooperate").length;
    const pct  = own.length === 0 ? "0" : Math.round((coop / own.length) * 100).toString();
    ui.appendLog(`  ${agent.id}: ${coop}/${own.length} cooperated (${pct}%)`);
  }

  ui.appendLog("\n=== Head-to-head move sequences ===");
  for (let i = 0; i < agentIds.length; i++) {
    for (let j = i + 1; j < agentIds.length; j++) {
      const a = agentIds[i], b = agentIds[j];
      const aMoves = state.results
        .filter((r) => r.agentId === a && r.opponentId === b)
        .map((r) => (r.move === "cooperate" ? "C" : "D"));
      const bMoves = state.results
        .filter((r) => r.agentId === b && r.opponentId === a)
        .map((r) => (r.move === "cooperate" ? "C" : "D"));
      const aScore = state.results
        .filter((r) => r.agentId === a && r.opponentId === b)
        .reduce((s, r) => s + r.score, 0);
      const bScore = state.results
        .filter((r) => r.agentId === b && r.opponentId === a)
        .reduce((s, r) => s + r.score, 0);
      ui.appendLog(`  ${a} vs ${b}`);
      ui.appendLog(`    ${a}: ${aMoves.join(" ")} → ${aScore} pts`);
      ui.appendLog(`    ${b}: ${bMoves.join(" ")} → ${bScore} pts`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  app.innerHTML += `<p style="color:#f55b5b;margin-top:1rem">ERROR: ${err instanceof Error ? err.message : String(err)}</p>`;
});
