import type { GameState } from "../referee/types";
import type { MafiaAgentView, MafiaGameState, MafiaMove } from "../referee/mafia";

// One accent color per personality, shared across both game types.
// hex: CSS color string. rgb: same values as "r,g,b" for rgba() strings.
// Keyed by personality name — always look up by personality, never by agent name.
const AGENT_COLORS: Record<string, { hex: string; rgb: string }> = {
  // ── Mafia personalities ───────────────────────────────────────────────────
  "paranoid":   { hex: "#f55b5b", rgb: "245,91,91"   }, // red    — accusatory, volatile
  "analytical": { hex: "#5bb8f5", rgb: "91,184,245"  }, // blue   — calm, methodical
  "naive":      { hex: "#6ee77a", rgb: "110,231,122" }, // green  — trusting, honest
  "deceptive":  { hex: "#f5a623", rgb: "245,166,35"  }, // amber  — hard to read
  "impulsive":  { hex: "#c47ef5", rgb: "196,126,245" }, // purple — jumps to conclusions
  "reserved":   { hex: "#5fd0c0", rgb: "95,208,192"  }, // teal   — quiet, watchful
  "dramatic":   { hex: "#e84393", rgb: "232,67,147"  }, // pink   — theatrical, expressive
  "skeptical":  { hex: "#ff9d4f", rgb: "255,157,79"  }, // orange — challenges everything
  // ── Human player ─────────────────────────────────────────────────────────
  "you":        { hex: "#ffffff", rgb: "255,255,255"  }, // white  — stands out from LLMs
  // ── IPD strategies ───────────────────────────────────────────────────────
  "tit-for-tat":      { hex: "#5bb8f5", rgb: "91,184,245"  }, // blue
  "always-defect":    { hex: "#f55b5b", rgb: "245,91,91"   }, // red
  "always-cooperate": { hex: "#6ee77a", rgb: "110,231,122" }, // green
  "adaptive":         { hex: "#f5a623", rgb: "245,166,35"  }, // amber
  "counter":          { hex: "#c47ef5", rgb: "196,126,245" }, // purple
};
const FALLBACK_COLOR = { hex: "#8892a4", rgb: "136,146,164" };

// Look up color by personality key (not by agent name).
export function agentColor(personality: string) {
  return AGENT_COLORS[personality] ?? FALLBACK_COLOR;
}

// ── IPD (Prisoner's Dilemma) ─────────────────────────────────────────────────

export interface ArenaUI {
  setStatus(text: string): void;
  // 0–99: show the loading bar at that fill percentage. 100: hide the bar.
  setProgress(pct: number): void;
  setStreamingAgent(agentId: string): void;
  appendStreamToken(fragment: string): void;
  updateScores(state: GameState): void;
  updateHeatmap(state: GameState): void;
  appendLog(line: string): void;
}

// agents: { id = human name, personality = strategy key }
export function initIPDLayout(
  root: HTMLElement,
  agents: Array<{ id: string; personality: string }>,
): ArenaUI {
  const agentIds = agents.map((a) => a.id);
  // Maps name → personality so render helpers can look up colors.
  const personalityOf: Record<string, string> = Object.fromEntries(
    agents.map((a) => [a.id, a.personality]),
  );
  const colorFor = (id: string) => agentColor(personalityOf[id] ?? id);

  root.innerHTML = `
    <h1>LLM Arena</h1>
    <p class="tagline">Prisoner&rsquo;s Dilemma &middot; 5 agents &middot; 10 rounds</p>

    <p id="status" class="status">Starting&hellip;</p>
    <div id="progress-wrap" class="progress-wrap">
      <div id="progress-fill" class="progress-fill" style="width:0%"></div>
    </div>

    <div id="stream-box" class="stream-box">
      <span id="stream-agent" class="stream-agent"></span>
      <span class="stream-arrow"> &rarr; </span>
      <span id="stream-output" class="stream-output"></span>
    </div>

    <section class="panel">
      <h2>Scores</h2>
      <div id="score-bars"></div>
    </section>

    <section class="panel">
      <h2>Head-to-head</h2>
      <div id="heatmap"></div>
    </section>

    <section class="panel">
      <h2>Log</h2>
      <pre id="log" class="log"></pre>
    </section>

    <section class="panel" id="explainer">
      <h2>How it works</h2>
      <div class="explainer-body">
        <p class="explainer-p">
          Five instances of the same tiny language model
          (<a class="explainer-link" href="https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF" target="_blank">Qwen3.5-0.8B</a>,
          ~510&nbsp;MB, 4-bit quantized) run entirely in your browser using WebGPU for GPU acceleration.
          Each instance is given a different <em>strategy</em> via its system prompt and plays
          <strong>Iterated Prisoner&rsquo;s Dilemma</strong> against every other agent for 10 rounds.
          Agents refer to each other by name only &mdash; they cannot see each other&rsquo;s strategies.
          No server, no API, no token bill.
        </p>

        <p class="explainer-subhead">The Prisoner&rsquo;s Dilemma</p>
        <p class="explainer-p">
          Each round, two agents independently choose to <strong>cooperate</strong> or <strong>defect</strong>
          &mdash; without knowing what the other will pick. Payoffs:
        </p>
        <pre class="explainer-matrix">
               Opponent cooperates   Opponent defects
  You cooperate      +3 / +3              +0 / +5
  You defect         +5 / +0              +1 / +1</pre>
        <p class="explainer-p">
          Mutual cooperation pays well for everyone. Defecting against a cooperator is the greedy
          play &mdash; you get 5 but they get nothing. Mutual defection is the worst collective
          outcome: both get only 1. The tension is that defecting is <em>individually</em> rational
          in a single game, but cooperation beats it over repeated rounds against the right partner.
        </p>

        <p class="explainer-subhead">The agents</p>
        <ul class="explainer-agents">
          ${agents.map(({ id, personality }) => {
            const color = agentColor(personality).hex;
            const desc: Record<string, string> = {
              "tit-for-tat":      "cooperates on the first move, then mirrors whatever the opponent did last round. The classic Axelrod winner.",
              "always-defect":    "defects every single round regardless of context. Exploits cooperators; draws against other defectors.",
              "always-cooperate": "cooperates unconditionally. Maximises mutual gains but is easily exploited.",
              "adaptive":         "no fixed rule. Given the payoff matrix and round history, it decides each move by its own judgment. Behaviour emerges from the model.",
              "counter":          "explicitly reads the opponent&rsquo;s pattern and applies the counter-strategy: exploit cooperators, match defectors, cooperate against mirrors.",
            };
            return `<li><span class="agent-chip" style="color:${color}">${id}</span> <span class="agent-personality-tag">(${personality})</span> &mdash; ${desc[personality] ?? ""}`;
          }).join("\n          ")}
        </ul>

        <p class="explainer-subhead">What you&rsquo;re watching</p>
        <p class="explainer-p">
          On first load the model downloads and is cached in your browser&rsquo;s storage (OPFS);
          subsequent visits skip the download. Once loaded, the match runs automatically.
          The streaming box shows each agent&rsquo;s raw token output as the model generates it &mdash;
          the referee extracts the move word and discards the rest.
          Agents run one at a time because the model is a single shared instance; turns appear
          sequentially as each agent &ldquo;thinks.&rdquo;
        </p>
        <p class="explainer-p">
          The <strong>head-to-head grid</strong> shows cumulative points agent A (row) earned
          against agent B (column). Brighter cells = more points extracted from that matchup.
        </p>
      </div>
    </section>
  `;

  const statusEl       = root.querySelector<HTMLElement>("#status")!;
  const progressWrapEl = root.querySelector<HTMLElement>("#progress-wrap")!;
  const progressFillEl = root.querySelector<HTMLElement>("#progress-fill")!;
  const streamBoxEl    = root.querySelector<HTMLElement>("#stream-box")!;
  const streamAgentEl  = root.querySelector<HTMLElement>("#stream-agent")!;
  const streamOutputEl = root.querySelector<HTMLElement>("#stream-output")!;
  const scoreBarsEl    = root.querySelector<HTMLElement>("#score-bars")!;
  const heatmapEl      = root.querySelector<HTMLElement>("#heatmap")!;
  const logEl          = root.querySelector<HTMLElement>("#log")!;

  const zeroState: GameState = {
    round: 0,
    scores: Object.fromEntries(agentIds.map((id) => [id, 0])),
    results: [],
  };
  renderScoreBars(zeroState, scoreBarsEl, colorFor, personalityOf);
  renderHeatmap(zeroState, agentIds, heatmapEl, colorFor, personalityOf);

  return {
    setStatus(text) { statusEl.textContent = text; },

    setProgress(pct) {
      if (pct >= 100) {
        progressWrapEl.hidden = true;
      } else {
        progressWrapEl.hidden = false;
        progressFillEl.style.width = `${pct}%`;
      }
    },

    setStreamingAgent(agentId) {
      const color = colorFor(agentId);
      streamBoxEl.style.setProperty("--agent-color", color.hex);
      // Show "Iris (tit-for-tat)" in the stream label so the viewer knows who is speaking.
      const personality = personalityOf[agentId];
      streamAgentEl.textContent = personality ? `${agentId} (${personality})` : agentId;
      streamOutputEl.textContent = "";
    },

    appendStreamToken(fragment) {
      streamOutputEl.textContent += fragment;
    },

    updateScores(state) { renderScoreBars(state, scoreBarsEl, colorFor, personalityOf); },

    updateHeatmap(state) { renderHeatmap(state, agentIds, heatmapEl, colorFor, personalityOf); },

    appendLog(line) {
      logEl.textContent += line + "\n";
      logEl.scrollTop = logEl.scrollHeight;
    },
  };
}

// Each bar is sized relative to the current leader. Sorted highest-to-lowest.
function renderScoreBars(
  state: GameState,
  container: HTMLElement,
  colorFor: (id: string) => { hex: string; rgb: string },
  personalityOf: Record<string, string> = {},
): void {
  const entries = Object.entries(state.scores).sort(([, a], [, b]) => b - a);
  const maxScore = Math.max(1, ...entries.map(([, s]) => s));

  container.innerHTML = entries
    .map(([id, score]) => {
      const pct = Math.round((score / maxScore) * 100);
      const color = colorFor(id);
      const personality = personalityOf[id];
      const label = personality ? `${id} <span class="bar-label-tactic">(${personality})</span>` : id;
      return `
        <div class="bar-row">
          <span class="bar-label">${label}</span>
          <div class="bar-track">
            <div class="bar-fill" style="--agent-color:${color.hex};width:${pct}%"></div>
          </div>
          <span class="bar-score" style="color:${color.hex}">${score}</span>
        </div>
      `;
    })
    .join("");
}

// Rows = agent A, columns = agent B. Each cell shows A's cumulative score vs B.
// Cell backgrounds are heat-coded with the row agent's color at varying opacity.
function renderHeatmap(
  state: GameState,
  agentIds: string[],
  container: HTMLElement,
  colorFor: (id: string) => { hex: string; rgb: string },
  personalityOf: Record<string, string>,
): void {
  if (state.results.length === 0) {
    container.innerHTML = "<p class='dim'>No rounds played yet.</p>";
    return;
  }

  const lookup: Record<string, Record<string, number>> = {};
  for (const id of agentIds) {
    lookup[id] = Object.fromEntries(agentIds.map((other) => [other, 0]));
  }
  for (const r of state.results) {
    lookup[r.agentId][r.opponentId] += r.score;
  }

  const allScores = agentIds.flatMap((a) =>
    agentIds.filter((b) => b !== a).map((b) => lookup[a][b]),
  );
  const maxScore = Math.max(1, ...allScores);

  // Column headers show name + personality abbreviation to keep the table compact.
  const colHeaders = agentIds.map((id) => {
    const p = personalityOf[id];
    return `<th title="${p ?? id}">${id}</th>`;
  }).join("");

  const rows = agentIds
    .map((a) => {
      const color = colorFor(a);
      const p = personalityOf[a];
      const cells = agentIds
        .map((b) => {
          if (a === b) return `<td class="heatmap-self">—</td>`;
          const score = lookup[a][b];
          const alpha = ((score / maxScore) * 0.65).toFixed(2);
          return `<td class="heatmap-cell" style="background:rgba(${color.rgb},${alpha})">${score}</td>`;
        })
        .join("");
      const header = p
        ? `${a}<br><span class="heatmap-tactic">(${p})</span>`
        : a;
      return `<tr><th class="heatmap-row-header" style="color:${color.hex}">${header}</th>${cells}</tr>`;
    })
    .join("");

  container.innerHTML = `
    <table class="heatmap-table">
      <thead><tr><th></th>${colHeaders}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ── Mafia ────────────────────────────────────────────────────────────────────

export interface MafiaUI {
  setStatus(text: string): void;
  // 0–99: show the loading bar at that fill percentage. 100: hide the bar.
  setProgress(pct: number): void;
  // Switch the streaming box to a new active speaker (clears previous output).
  setStreamingAgent(agentId: string): void;
  appendStreamToken(fragment: string): void;
  // Re-render the player grid from the current game state.
  updatePlayers(state: MafiaGameState): void;
  // Display the game-over banner.
  showWinner(winner: "mafia" | "villagers"): void;
  appendLog(line: string): void;
  // Show phase-appropriate controls for the human player's turn.
  // onMove is called with the chosen move when the player acts.
  showHumanInput(view: MafiaAgentView, onMove: (move: MafiaMove) => void): void;
  // Hide the human input panel (called on cancellation or after submission).
  hideHumanInput(): void;
}

// agents: { id = human name, personality = personality key }
// humanOn: initial state of the "Play as Mafioso" toggle.
// onToggle: fired when the toggle changes — caller should restart the game with the new mode.
export function initMafiaLayout(
  root: HTMLElement,
  agents: Array<{ id: string; personality: string }>,
  humanOn: boolean,
  onToggle: (on: boolean) => void,
): MafiaUI {
  const agentIds = agents.map((a) => a.id);
  // Maps name → personality so render helpers can look up colors.
  const personalityOf: Record<string, string> = Object.fromEntries(
    agents.map((a) => [a.id, a.personality]),
  );
  const colorFor = (id: string) => agentColor(personalityOf[id] ?? id);

  root.innerHTML = `
    <h1>LLM Arena</h1>
    <p class="tagline">Mini-Mafia &middot; 8 agents &middot; in-browser WebGPU inference</p>

    <div class="play-toggle">
      <input type="checkbox" id="human-toggle" class="play-toggle-input" ${humanOn ? "checked" : ""}>
      <label for="human-toggle" class="play-toggle-label">Play as Mafioso</label>
    </div>

    <p id="status" class="status">Starting&hellip;</p>
    <div id="progress-wrap" class="progress-wrap">
      <div id="progress-fill" class="progress-fill" style="width:0%"></div>
    </div>

    <div id="stream-box" class="stream-box">
      <span id="stream-agent" class="stream-agent"></span>
      <span class="stream-arrow"> &rarr; </span>
      <span id="stream-output" class="stream-output"></span>
    </div>

    <section class="panel">
      <h2>Players</h2>
      <div id="player-grid" class="player-grid"></div>
      <div id="human-panel" class="human-panel" hidden>
        <div class="human-panel-label">Your turn</div>
        <div id="human-panel-body"></div>
      </div>
      <div id="win-banner"></div>
    </section>

    <section class="panel">
      <h2>Log</h2>
      <pre id="log" class="log"></pre>
    </section>

    <section class="panel" id="explainer">
      <h2>How it works</h2>
      <div class="explainer-body">
        <p class="explainer-p">
          Eight instances of the same tiny language model
          (<a class="explainer-link" href="https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF" target="_blank">Qwen3.5-0.8B</a>,
          ~510&nbsp;MB, 4-bit quantized) run entirely in your browser using WebGPU.
          Each instance is given a different <em>personality</em> via its system prompt and
          assigned a secret role. They play <strong>Mini-Mafia</strong> autonomously &mdash; no server,
          no API, no token bill. Agents refer to each other by name only; they cannot see
          each other&rsquo;s personality descriptions.
        </p>

        <p class="explainer-subhead">The roles</p>
        <ul class="explainer-agents">
          <li><span class="agent-chip" style="color:#f55b5b">Mafioso</span> &mdash; knows their identity. Each night they secretly choose one player to eliminate. During the day they must blend in and deflect suspicion.</li>
          <li><span class="agent-chip" style="color:#5bb8f5">Detective</span> &mdash; each night secretly investigates one player and learns their true role. Must use that knowledge without giving themselves away.</li>
          <li><span class="agent-chip" style="color:#f5c842">Medic</span> &mdash; each night secretly protects one player from the mafioso&rsquo;s kill. If the medic protects the right person, nobody dies that night.</li>
          <li><span class="agent-chip" style="color:#6ee77a">Villager &times; 5</span> &mdash; no night action. Must read the room during discussions and vote wisely.</li>
        </ul>

        <p class="explainer-subhead">Win conditions</p>
        <p class="explainer-p">
          <strong>Mafia wins</strong> when their count equals or exceeds the villagers &mdash; they can no longer be outvoted.
          <strong>Villagers win</strong> when the mafioso is eliminated by a day vote.
        </p>

        <p class="explainer-subhead">Each round</p>
        <p class="explainer-p">
          Night: the mafioso picks a kill target; the detective picks someone to investigate.
          Day discussion: all alive players say what they think (streamed live in the box above).
          Day vote: all alive players vote to eliminate someone &mdash; plurality wins; ties skip elimination.
          Roles are revealed publicly when a player is eliminated.
        </p>

        <p class="explainer-subhead">Why the wait</p>
        <p class="explainer-p">
          On first load, the model downloads (~510&nbsp;MB) and is cached in your browser&rsquo;s
          private storage (OPFS); subsequent visits skip the download. Agents run one at a time
          because the model is a single shared GPU-resident instance &mdash; turns appear sequentially
          as each agent &ldquo;thinks.&rdquo;
        </p>
      </div>
    </section>
  `;

  const statusEl         = root.querySelector<HTMLElement>("#status")!;
  const progressWrapEl   = root.querySelector<HTMLElement>("#progress-wrap")!;
  const progressFillEl   = root.querySelector<HTMLElement>("#progress-fill")!;
  const streamBoxEl      = root.querySelector<HTMLElement>("#stream-box")!;
  const streamAgentEl    = root.querySelector<HTMLElement>("#stream-agent")!;
  const streamOutputEl   = root.querySelector<HTMLElement>("#stream-output")!;
  const playerGridEl     = root.querySelector<HTMLElement>("#player-grid")!;
  const humanPanelEl     = root.querySelector<HTMLElement>("#human-panel")!;
  const humanPanelBodyEl = root.querySelector<HTMLElement>("#human-panel-body")!;
  const winBannerEl      = root.querySelector<HTMLElement>("#win-banner")!;
  const logEl            = root.querySelector<HTMLElement>("#log")!;
  const toggleEl         = root.querySelector<HTMLInputElement>("#human-toggle")!;

  // The human player's id if human mode is active — detected by personality "you" so the
  // name can be changed freely without touching this logic.
  const humanId = humanOn ? agents.find((a) => a.personality === "you")?.id : undefined;

  toggleEl.addEventListener("change", () => onToggle(toggleEl.checked));

  // Persists each player's latest quote across re-renders so it stays visible
  // in their row even after updatePlayers() rebuilds the grid DOM.
  const quotes: Record<string, string> = {};
  // The player currently streaming tokens into their inline quote (null = nobody).
  let activeQuoteId: string | null = null;

  // Pre-render the player grid with all players alive (roles hidden until eliminated).
  const emptyState: MafiaGameState = {
    phase: "night", round: 1,
    players: agentIds.map((id) => ({ id, role: "villager", isAlive: true })),
    investigations: [], protections: [], transcript: [], votes: {}, nightActions: {}, eliminated: [], voteHistory: [],
  };
  renderPlayerGrid(emptyState, agents, playerGridEl, quotes, humanId);

  return {
    setStatus(text) { statusEl.textContent = text; },

    setProgress(pct) {
      if (pct >= 100) {
        progressWrapEl.hidden = true;
      } else {
        progressWrapEl.hidden = false;
        progressFillEl.style.width = `${pct}%`;
      }
    },

    setStreamingAgent(agentId) {
      // Remove cursor from whoever was speaking before.
      if (activeQuoteId !== null) {
        const prev = playerGridEl.querySelector<HTMLElement>(`[data-quote-for="${activeQuoteId}"]`);
        if (prev) prev.classList.remove("streaming");
      }
      activeQuoteId = agentId;
      quotes[agentId] = "";
      // Set the stream box color and label using the agent's personality.
      const color = colorFor(agentId);
      streamBoxEl.style.setProperty("--agent-color", color.hex);
      const personality = personalityOf[agentId];
      streamAgentEl.textContent = personality && personality !== "you"
        ? `${agentId} (${personality})`
        : agentId;
      streamOutputEl.textContent = "";
      const el = playerGridEl.querySelector<HTMLElement>(`[data-quote-for="${agentId}"]`);
      if (el) {
        el.textContent = "";
        el.classList.add("streaming");
      }
    },

    appendStreamToken(fragment) {
      if (activeQuoteId === null) return;
      quotes[activeQuoteId] = (quotes[activeQuoteId] ?? "") + fragment;
      const el = playerGridEl.querySelector<HTMLElement>(`[data-quote-for="${activeQuoteId}"]`);
      if (el) el.textContent += fragment;
      streamOutputEl.textContent += fragment;
    },

    updatePlayers(state) {
      // Phase is over — no active speaker, re-render with persisted quotes.
      activeQuoteId = null;
      renderPlayerGrid(state, agents, playerGridEl, quotes, humanId);
    },

    showHumanInput(view, onMove) {
      humanPanelEl.hidden = false;

      if (view.phase === "day-discuss") {
        humanPanelBodyEl.innerHTML = `
          <p class="human-prompt">What do you say?</p>
          <textarea id="human-text" class="human-speak-input" rows="2" maxlength="200" placeholder="Say one sentence…"></textarea>
          <button id="human-send" class="human-send-btn">Send</button>
        `;
        const textarea = humanPanelBodyEl.querySelector<HTMLTextAreaElement>("#human-text")!;
        const sendBtn  = humanPanelBodyEl.querySelector<HTMLButtonElement>("#human-send")!;
        textarea.focus();

        const submit = () => {
          const text = textarea.value.trim();
          if (!text) return;
          humanPanelEl.hidden = true;
          onMove({ kind: "speak", text });
        };
        sendBtn.addEventListener("click", submit, { once: true });
        // Enter (without Shift) submits; Shift+Enter inserts a newline.
        textarea.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
        });
      } else {
        // Night (kill) or day-vote: pick from a list of valid targets.
        const targets = view.legalMoves.map((m) => (m as { target: string }).target);
        const kind    = view.legalMoves[0].kind as "kill" | "vote";
        const prompt  = kind === "kill" ? "Choose who to eliminate tonight:" : "Vote to eliminate:";

        humanPanelBodyEl.innerHTML = `
          <p class="human-prompt">${prompt}</p>
          <div class="human-buttons">
            ${targets.map((t) => `<button class="human-target-btn" data-target="${t}">${t}</button>`).join("")}
          </div>
        `;
        for (const btn of humanPanelBodyEl.querySelectorAll<HTMLButtonElement>(".human-target-btn")) {
          btn.addEventListener("click", () => {
            humanPanelEl.hidden = true;
            onMove({ kind, target: btn.dataset.target! } as MafiaMove);
          }, { once: true });
        }
      }
    },

    hideHumanInput() {
      humanPanelEl.hidden = true;
    },

    showWinner(winner) {
      const cls   = winner === "mafia" ? "win-mafia" : "win-villagers";
      const label = winner === "mafia" ? "Mafia wins" : "Villagers win";
      winBannerEl.className = `win-banner ${cls}`;
      winBannerEl.textContent = label;
    },

    appendLog(line) {
      logEl.textContent += line + "\n";
      logEl.scrollTop = logEl.scrollHeight;
    },
  };
}

// Each row shows: name, personality tag, role badge, elimination note, and latest inline quote.
// Quotes persist via the `quotes` map passed in from the layout closure.
// humanId: if set, that player's role badge is shown immediately (they know their own role).
function renderPlayerGrid(
  state: MafiaGameState,
  agents: Array<{ id: string; personality: string }>,
  container: HTMLElement,
  quotes: Record<string, string>,
  humanId?: string,
): void {
  container.innerHTML = agents
    .map(({ id, personality }) => {
      const player  = state.players.find((p) => p.id === id)!;
      const color   = agentColor(personality);
      const elim    = state.eliminated.find((e) => e.playerId === id);
      const isAlive = player.isAlive;
      const isHuman = id === humanId;

      const dotClass = isAlive ? "alive" : "dead";
      const dot      = isAlive ? "●" : "✕";
      const rowClass = isAlive ? "" : " eliminated";

      // Human player always sees their own role badge; others see "?" until eliminated.
      const visibleRole = elim?.role ?? (isHuman ? player.role : null);
      const badge = visibleRole
        ? `<span class="player-badge role-${visibleRole}">${visibleRole}${isHuman && !elim ? " (you)" : ""}</span>`
        : `<span class="player-badge role-hidden">?</span>`;

      // Elimination note: round + cause, visible only once eliminated.
      const elimNote = elim
        ? `<span class="elim-cause">r${elim.round} · ${elim.cause === "night-kill" ? "night kill" : "voted out"}</span>`
        : "";

      // Personality tag — hidden for the human player ("you" has no personality label).
      const personalityTag = !isHuman
        ? `<span class="player-personality">(${personality})</span>`
        : "";

      return `
        <div class="player-row${rowClass}" style="--agent-color:${color.hex}">
          <div class="player-row-main">
            <span class="player-dot ${dotClass}">${dot}</span>
            <span class="player-name">${id}</span>
            ${personalityTag}
            ${badge}
            ${elimNote}
          </div>
          <div class="player-quote" data-quote-for="${id}"></div>
        </div>
      `;
    })
    .join("");

  // Set quote text via textContent (not innerHTML) to avoid XSS from model output.
  for (const { id } of agents) {
    if (quotes[id]) {
      const el = container.querySelector<HTMLElement>(`[data-quote-for="${id}"]`);
      if (el) el.textContent = quotes[id];
    }
  }
}
