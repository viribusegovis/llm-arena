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

    <section class="panel" id="explainer">
      <h2>How it works</h2>
      <div class="explainer-body">
        <p class="explainer-p">
          Four instances of the same tiny language model
          (<a class="explainer-link" href="https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF" target="_blank">Qwen3.5-0.8B</a>,
          ~510&nbsp;MB, 4-bit quantized) run entirely in your browser using WebGPU for GPU acceleration.
          Each instance is given a different <em>personality</em> via its system prompt and plays
          <strong>Iterated Prisoner&rsquo;s Dilemma</strong> against every other agent for 10 rounds.
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
          <li><span class="agent-chip" style="color:#5bb8f5">tit-for-tat</span> &mdash; cooperates on the first move, then mirrors whatever the opponent did last round. The classic Axelrod winner.</li>
          <li><span class="agent-chip" style="color:#f55b5b">always-defect</span> &mdash; defects every single round regardless of context. Exploits cooperators; draws against other defectors.</li>
          <li><span class="agent-chip" style="color:#6ee77a">always-cooperate</span> &mdash; cooperates unconditionally. Maximises mutual gains but is easily exploited.</li>
          <li><span class="agent-chip" style="color:#f5a623">grudger</span> &mdash; cooperates until the opponent defects once, then defects forever. Patient but unforgiving.</li>
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
