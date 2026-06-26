import { LLMAgent } from "../agents/llm-agent";
import { MafiaLLMAgent } from "../agents/mafia-llm-agent";
import { WllamaClient } from "../llm/wllama-client";
import { createInitialState as ipdCreateInitial, runRound } from "../referee/ipd";
import { createInitialState as mafiaCreateInitial, stepPhase } from "../referee/mafia";
import type { MafiaGameState, Role } from "../referee/mafia";
import type { GameState } from "../referee/types";
import { initIPDLayout, initMafiaLayout } from "./render";

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

const MAFIA_PERSONALITIES: Array<{ id: string; personalityPrompt: string }> = [
  {
    id: "paranoid",
    personalityPrompt:
      "You are a deeply anxious person who sees danger everywhere. You speak urgently, " +
      "jump to accusations quickly, and become defensive the moment anyone looks at you sideways.",
  },
  {
    id: "analytical",
    personalityPrompt:
      "You are a calm, methodical thinker. You reason from evidence, weigh your words carefully, " +
      "and express yourself in structured, measured sentences. You don't get emotional.",
  },
  {
    id: "naive",
    personalityPrompt:
      "You are an optimistic, trusting person who wants to see the best in people. " +
      "You give others the benefit of the doubt, try to build consensus, and are easy to sway.",
  },
  {
    id: "deceptive",
    personalityPrompt:
      "You are naturally guarded and strategic. You say little, watch carefully, and only speak " +
      "when you have a point worth making. You're hard to read and rarely show your full hand.",
  },
  {
    id: "impulsive",
    personalityPrompt:
      "You are quick to decide and slow to reconsider. You state your opinion fast and " +
      "push others to commit. You don't like ambiguity and don't sit on the fence.",
  },
  {
    id: "reserved",
    personalityPrompt:
      "You are quiet and observant. In conversation you say as little as possible — " +
      "usually just one short sentence. You watch more than you talk.",
  },
  {
    id: "dramatic",
    personalityPrompt:
      "You are theatrical and emotionally expressive. You react strongly to everything, " +
      "use vivid language, and make every situation feel urgent and consequential.",
  },
  {
    id: "skeptical",
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
function assignRoles(): Array<{ id: string; role: Role; systemPrompt: string }> {
  const shuffled = [...MAFIA_PERSONALITIES].sort(() => Math.random() - 0.5);
  const roles: Role[] = [
    "mafioso", "detective", "medic",
    "villager", "villager", "villager", "villager", "villager",
  ];
  return shuffled.map((p, i) => ({
    id: p.id,
    role: roles[i],
    systemPrompt: `${p.personalityPrompt} ${ROLE_INSTRUCTIONS[roles[i]]} ${SPEAK_RULES}`,
  }));
}

// ── IPD personality definitions ───────────────────────────────────────────────

const IPD_PERSONALITIES: Record<string, string> = {
  "tit-for-tat":
    "You are playing the Prisoner's Dilemma. Your strategy is tit-for-tat: " +
    "always cooperate on the first round, then copy whatever your opponent did last round. " +
    "If they cooperated last round, cooperate. If they defected last round, defect. " +
    "Follow this rule strictly.",
  "always-defect":
    "You are playing the Prisoner's Dilemma. You are a ruthless self-interested player. " +
    "Defecting always gives you a better personal outcome regardless of what your opponent does. " +
    "Always defect. Never cooperate under any circumstances.",
  "always-cooperate":
    "You are playing the Prisoner's Dilemma. You are an idealistic cooperator who believes " +
    "mutual trust is the only path to the best collective outcome. " +
    "Always cooperate, no matter what your opponent has done.",
  "grudger":
    "You are playing the Prisoner's Dilemma. You start by cooperating and will keep " +
    "cooperating as long as your opponent has never defected against you. " +
    "But if they defect even once, you defect against them for every remaining round — no forgiveness.",
};

const IPD_ROUNDS = 10;

// ── Shared model instance ─────────────────────────────────────────────────────
// The model (~510 MB) loads once into OPFS and is reused across both game types.
// loadedPromise is set on first call; subsequent calls await the same resolved promise.
const client = new WllamaClient();
let loadedPromise: Promise<void> | null = null;

// ── Tab state ─────────────────────────────────────────────────────────────────
// gameId increments on every tab switch. Each runner captures its id at launch
// and returns early at loop checkpoints if the id has moved on (tab switched).
let gameId = 0;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  app.innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="mafia">Mini-Mafia</button>
      <button class="tab-btn" data-tab="ipd">Prisoner&rsquo;s Dilemma</button>
    </div>
    <div id="game-container"></div>
  `;

  const gameContainer = app.querySelector<HTMLElement>("#game-container")!;
  const tabBtns = Array.from(app.querySelectorAll<HTMLButtonElement>(".tab-btn"));

  for (const btn of tabBtns) {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      gameId++;
      const tab = btn.dataset.tab as "mafia" | "ipd";
      void launchGame(gameContainer, tab, gameId);
    });
  }

  await launchGame(gameContainer, "mafia", gameId);
}

async function launchGame(
  container: HTMLElement,
  tab: "mafia" | "ipd",
  myGameId: number,
): Promise<void> {
  if (tab === "mafia") {
    await runMafiaGame(container, myGameId);
  } else {
    await runIPDGame(container, myGameId);
  }
}

// ── Mafia runner ──────────────────────────────────────────────────────────────
async function runMafiaGame(container: HTMLElement, myGameId: number): Promise<void> {
  const isCancelled = () => gameId !== myGameId;

  // Assign roles randomly each game so the same personality can play any role.
  const assignments = assignRoles();
  const mafiaIds   = assignments.map((a) => a.id);
  const detectiveId = assignments.find((a) => a.role === "detective")!.id;
  const medicId     = assignments.find((a) => a.role === "medic")!.id;

  const ui = initMafiaLayout(container, mafiaIds);
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

  const agents = assignments.map(
    ({ id, systemPrompt }) => new MafiaLLMAgent(id, systemPrompt, client),
  );

  ui.appendLog(`Agents: ${mafiaIds.join(", ")}`);
  // God-mode: viewer can see all roles; agents only know their own.
  const roleLog = assignments.map((a) => `${a.id}=${a.role}`).join(", ");
  ui.appendLog(`Roles (hidden from agents): ${roleLog}\n`);

  let state: MafiaGameState = mafiaCreateInitial(
    assignments.map(({ id, role }) => ({ id, role })),
  );

  while (state.phase !== "game-over") {
    if (isCancelled()) return;

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

    state = await stepPhase(agents, state, {
      beforeDecide(agentId) {
        const label =
          phase === "night"       ? "Night"    :
          phase === "day-discuss" ? "Speaking" : "Voting";
        ui.setStatus(`Round ${round} · ${label} · ${agentId} is deciding…`);
        if (phase === "day-discuss") ui.setStreamingAgent(agentId);
      },
      onToken(_agentId, fragment) {
        ui.appendStreamToken(fragment);
      },
    });

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
      for (const inv of newInvestigations) {
        ui.appendLog(`  [private — ${detectiveId}] investigated ${inv.target} → ${inv.role}`);
      }
      for (const prot of newProtections) {
        const note = prot.blocked ? " — kill blocked!" : "";
        ui.appendLog(`  [private — ${medicId}] protected ${prot.target}${note}`);
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

  const winner   = state.winner!;
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
async function runIPDGame(container: HTMLElement, myGameId: number): Promise<void> {
  const isCancelled = () => gameId !== myGameId;
  const agentIds = Object.keys(IPD_PERSONALITIES);

  const ui = initIPDLayout(container, agentIds);
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

  const agents = Object.entries(IPD_PERSONALITIES).map(
    ([id, prompt]) => new LLMAgent(id, prompt, client),
  );

  ui.appendLog(`Agents: ${agentIds.join(", ")}`);
  ui.appendLog(`${IPD_ROUNDS} rounds, round-robin\n`);

  let state: GameState = ipdCreateInitial(agentIds);

  for (let round = 1; round <= IPD_ROUNDS; round++) {
    if (isCancelled()) return;

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
