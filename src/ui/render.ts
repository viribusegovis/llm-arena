import type { GameState } from "../referee/types";

// The set of DOM update methods exposed to main.ts.
// These are closures over the DOM nodes built by initLayout() — callers never touch
// the raw elements, which keeps the layout logic fully contained in this file.
export interface ArenaUI {
  // Updates the status line (e.g. "Round 3/10 — tit-for-tat deciding…")
  setStatus(text: string): void;
  // Clears the streaming output box and labels it with the given agent name.
  // Call this just before an agent starts deciding.
  setStreamingAgent(agentId: string): void;
  // Appends a text fragment to the streaming output box.
  // Call this from the onToken callback while the model is generating.
  appendStreamToken(fragment: string): void;
  // Redraws the score bars to reflect the current GameState.
  updateScores(state: GameState): void;
  // Redraws the head-to-head payoff grid to reflect the current GameState.
  updateHeatmap(state: GameState): void;
  // Appends a line to the scrolling text log at the bottom of the page.
  appendLog(line: string): void;
}

// Builds the full page layout inside the given root element and returns the ArenaUI
// control object. Call once before the match starts, passing the list of agent IDs
// so the score bars and heatmap can be pre-seeded with zeroes.
export function initLayout(root: HTMLElement, agentIds: string[]): ArenaUI {
  root.innerHTML = `
    <h1>LLM Arena</h1>
    <p id="status" class="status">Starting…</p>

    <!-- Streaming box: shows the model "typing" its move token by token -->
    <div id="stream-box" class="stream-box">
      <span id="stream-agent" class="stream-agent"></span>
      <span class="stream-arrow"> → </span>
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
  `;

  const statusEl       = root.querySelector<HTMLElement>("#status")!;
  const streamAgentEl  = root.querySelector<HTMLElement>("#stream-agent")!;
  const streamOutputEl = root.querySelector<HTMLElement>("#stream-output")!;
  const scoreBarsEl    = root.querySelector<HTMLElement>("#score-bars")!;
  const heatmapEl      = root.querySelector<HTMLElement>("#heatmap")!;
  const logEl          = root.querySelector<HTMLElement>("#log")!;

  // Pre-render zero-score bars so the layout is visible before any rounds play.
  const zeroState: GameState = {
    round: 0,
    scores: Object.fromEntries(agentIds.map((id) => [id, 0])),
    results: [],
  };
  renderScoreBars(zeroState, scoreBarsEl);
  renderHeatmap(zeroState, agentIds, heatmapEl);

  return {
    setStatus(text) {
      statusEl.textContent = text;
    },

    setStreamingAgent(agentId) {
      // Clear leftover output from the previous decision and label the new agent.
      streamAgentEl.textContent = agentId;
      streamOutputEl.textContent = "";
    },

    appendStreamToken(fragment) {
      streamOutputEl.textContent += fragment;
    },

    updateScores(state) {
      renderScoreBars(state, scoreBarsEl);
    },

    updateHeatmap(state) {
      renderHeatmap(state, agentIds, heatmapEl);
    },

    appendLog(line) {
      logEl.textContent += line + "\n";
      // Auto-scroll to the bottom so the latest entry is always visible.
      logEl.scrollTop = logEl.scrollHeight;
    },
  };
}

// Redraws the score bar section. Bars are sized relative to the current leader's score,
// so even a small early lead shows up visually. Sorted highest-to-lowest.
function renderScoreBars(state: GameState, container: HTMLElement): void {
  const entries = Object.entries(state.scores).sort(([, a], [, b]) => b - a);
  // Use max 1 to avoid division-by-zero when all scores are 0 at the start.
  const maxScore = Math.max(1, ...entries.map(([, s]) => s));

  container.innerHTML = entries
    .map(([id, score]) => {
      const pct = Math.round((score / maxScore) * 100);
      return `
        <div class="bar-row">
          <span class="bar-label">${id}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width: ${pct}%"></div>
          </div>
          <span class="bar-score">${score}</span>
        </div>
      `;
    })
    .join("");
}

// Redraws the head-to-head payoff grid. Rows = agent A, columns = agent B.
// Each cell shows A's cumulative score from all rounds played against B.
// The diagonal (A vs A) is blank — agents don't play themselves.
function renderHeatmap(state: GameState, agentIds: string[], container: HTMLElement): void {
  if (state.results.length === 0) {
    container.innerHTML = "<p class='dim'>No rounds played yet.</p>";
    return;
  }

  // Build a score lookup: lookup[a][b] = total points A earned in all pairings vs B.
  const lookup: Record<string, Record<string, number>> = {};
  for (const id of agentIds) {
    lookup[id] = Object.fromEntries(agentIds.map((other) => [other, 0]));
  }
  for (const r of state.results) {
    lookup[r.agentId][r.opponentId] += r.score;
  }

  const colHeaders = agentIds.map((id) => `<th>${id}</th>`).join("");
  const rows = agentIds
    .map((a) => {
      const cells = agentIds
        .map((b) =>
          a === b
            ? `<td class="heatmap-self">—</td>`
            : `<td class="heatmap-cell">${lookup[a][b]}</td>`,
        )
        .join("");
      return `<tr><th class="heatmap-row-header">${a}</th>${cells}</tr>`;
    })
    .join("");

  container.innerHTML = `
    <table class="heatmap-table">
      <thead><tr><th></th>${colHeaders}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
