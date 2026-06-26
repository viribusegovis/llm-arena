import type { GameState } from "../referee/types";

// ── Agent palette ─────────────────────────────────────────────────────────────
// One accent color per personality. Used consistently: score bar fill, streaming-box
// left border, heatmap row label, and agent name while it is deciding.
// hex: CSS color string. rgb: same values as "r,g,b" for building rgba() strings
// without a runtime hex parser.
const AGENT_COLORS: Record<string, { hex: string; rgb: string }> = {
  "tit-for-tat":      { hex: "#5bb8f5", rgb: "91,184,245"  }, // blue  — reciprocal, reliable
  "always-defect":    { hex: "#f55b5b", rgb: "245,91,91"   }, // red   — purely self-interested
  "always-cooperate": { hex: "#6ee77a", rgb: "110,231,122" }, // green — unconditional altruist
  "grudger":          { hex: "#f5a623", rgb: "245,166,35"  }, // amber — patient but unforgiving
};
const FALLBACK_COLOR = { hex: "#8892a4", rgb: "136,146,164" };

function agentColor(id: string) {
  return AGENT_COLORS[id] ?? FALLBACK_COLOR;
}

// ── ArenaUI interface ─────────────────────────────────────────────────────────
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

// ── Layout ────────────────────────────────────────────────────────────────────
export function initLayout(root: HTMLElement, agentIds: string[]): ArenaUI {
  root.innerHTML = `
    <h1>LLM Arena</h1>
    <p class="tagline">Iterated Prisoner&rsquo;s Dilemma &middot; 4 agents &middot; 10 rounds</p>

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

  // Pre-seed the score bars and heatmap with zeroes so the layout is visible
  // before any rounds play.
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

    setProgress(pct) {
      if (pct >= 100) {
        // Loading done — hide the bar entirely.
        progressWrapEl.hidden = true;
      } else {
        progressWrapEl.hidden = false;
        progressFillEl.style.width = `${pct}%`;
      }
    },

    setStreamingAgent(agentId) {
      // Update the CSS custom property so the left border and agent label both
      // switch to this agent's color via the CSS rules in index.html.
      const color = agentColor(agentId);
      streamBoxEl.style.setProperty("--agent-color", color.hex);
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
      // Keep the latest entry visible.
      logEl.scrollTop = logEl.scrollHeight;
    },
  };
}

// ── Score bars ────────────────────────────────────────────────────────────────
// Each bar is sized relative to the current leader so a small early lead still
// shows up visually. Sorted highest-to-lowest.
function renderScoreBars(state: GameState, container: HTMLElement): void {
  const entries = Object.entries(state.scores).sort(([, a], [, b]) => b - a);
  const maxScore = Math.max(1, ...entries.map(([, s]) => s));

  container.innerHTML = entries
    .map(([id, score]) => {
      const pct = Math.round((score / maxScore) * 100);
      const color = agentColor(id);
      // --agent-color is picked up by .bar-fill's background gradient in the CSS.
      return `
        <div class="bar-row">
          <span class="bar-label">${id}</span>
          <div class="bar-track">
            <div class="bar-fill" style="--agent-color:${color.hex};width:${pct}%"></div>
          </div>
          <span class="bar-score" style="color:${color.hex}">${score}</span>
        </div>
      `;
    })
    .join("");
}

// ── Heatmap ───────────────────────────────────────────────────────────────────
// Rows = agent A, columns = agent B. Each cell shows A's cumulative score from
// all rounds vs B. Cell backgrounds are heat-coded: the row agent's color at
// varying opacity (transparent at 0, 65% opacity at the global max score).
function renderHeatmap(state: GameState, agentIds: string[], container: HTMLElement): void {
  if (state.results.length === 0) {
    container.innerHTML = "<p class='dim'>No rounds played yet.</p>";
    return;
  }

  // Sum scores per pairing.
  const lookup: Record<string, Record<string, number>> = {};
  for (const id of agentIds) {
    lookup[id] = Object.fromEntries(agentIds.map((other) => [other, 0]));
  }
  for (const r of state.results) {
    lookup[r.agentId][r.opponentId] += r.score;
  }

  // Find the global max across all non-diagonal cells for heat-scaling.
  const allScores = agentIds.flatMap((a) =>
    agentIds.filter((b) => b !== a).map((b) => lookup[a][b]),
  );
  const maxScore = Math.max(1, ...allScores);

  const colHeaders = agentIds.map((id) => `<th>${id}</th>`).join("");

  const rows = agentIds
    .map((a) => {
      const color = agentColor(a);
      const cells = agentIds
        .map((b) => {
          if (a === b) return `<td class="heatmap-self">—</td>`;
          const score = lookup[a][b];
          // Alpha 0 → 0.65: low scorer is transparent, top scorer is clearly tinted.
          const alpha = ((score / maxScore) * 0.65).toFixed(2);
          const bg = `rgba(${color.rgb},${alpha})`;
          return `<td class="heatmap-cell" style="background:${bg}">${score}</td>`;
        })
        .join("");
      // Row header takes the row agent's color so you can scan by personality.
      return `<tr><th class="heatmap-row-header" style="color:${color.hex}">${a}</th>${cells}</tr>`;
    })
    .join("");

  container.innerHTML = `
    <table class="heatmap-table">
      <thead><tr><th></th>${colHeaders}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
