import type { Role } from "../referee/mafia";
import { agentColor } from "./render";

const STORAGE_KEY = "llm-arena-leaderboard";

// Stats for one personality across all games of a given type.
interface PersonalityStats {
  games: number;  // total games played
  wins: number;   // games where this personality's faction/outcome won
  totalPts: number; // IPD only: cumulative points across all games
}

interface LeaderboardData {
  mafia: Record<string, PersonalityStats>;
  ipd: Record<string, PersonalityStats>;
}

function load(): LeaderboardData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mafia: {}, ipd: {} };
    return JSON.parse(raw) as LeaderboardData;
  } catch {
    return { mafia: {}, ipd: {} };
  }
}

function save(data: LeaderboardData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function entry(map: Record<string, PersonalityStats>, id: string): PersonalityStats {
  if (!map[id]) map[id] = { games: 0, wins: 0, totalPts: 0 };
  return map[id];
}

// Record one completed Mafia game. Win = your faction won
// (mafioso wins if mafia wins; everyone else wins if villagers win).
// Skips "you" — the human player is not a tracked personality.
// Uses personality key (not agent name) so stats accumulate correctly across games.
export function recordMafiaGame(
  assignments: Array<{ personality: string; role: Role }>,
  winner: "mafia" | "villagers",
): void {
  const data = load();
  for (const { personality, role } of assignments) {
    if (personality === "you") continue;
    const s = entry(data.mafia, personality);
    s.games++;
    const factionWon = (winner === "mafia") === (role === "mafioso");
    if (factionWon) s.wins++;
  }
  save(data);
}

// Record one completed IPD match. Win = top scorer in that match.
// personalityOf maps agent name → personality key so stats accumulate by strategy.
export function recordIPDGame(
  scores: Record<string, number>,
  personalityOf: Record<string, string>,
): void {
  const data = load();
  const best = Math.max(...Object.values(scores));
  for (const [id, pts] of Object.entries(scores)) {
    const personality = personalityOf[id] ?? id;
    const s = entry(data.ipd, personality);
    s.games++;
    s.totalPts += pts;
    if (pts === best) s.wins++;
  }
  save(data);
}

function fmtPct(wins: number, games: number): string {
  if (games === 0) return "—";
  return `${Math.round((wins / games) * 100)}%`;
}

function renderTable(stats: Record<string, PersonalityStats>, showPts: boolean): string {
  const entries = Object.entries(stats).sort(([, a], [, b]) => {
    // Sort by win rate desc, then by games played desc.
    const ra = a.games === 0 ? -1 : a.wins / a.games;
    const rb = b.games === 0 ? -1 : b.wins / b.games;
    return rb - ra || b.games - a.games;
  });

  if (entries.length === 0) {
    return `<p class="dim">No games recorded yet.</p>`;
  }

  const ptsHeader = showPts ? `<th class="lb-th">Avg pts</th>` : "";

  const rows = entries
    .map(([id, s]) => {
      const hex = agentColor(id).hex;
      const ptsCell = showPts
        ? `<td class="lb-td">${s.games > 0 ? (s.totalPts / s.games).toFixed(1) : "—"}</td>`
        : "";
      return `
        <tr>
          <td class="lb-td lb-td-name" style="color:${hex}">${id}</td>
          <td class="lb-td">${s.games}</td>
          <td class="lb-td">${s.wins}</td>
          <td class="lb-td">${fmtPct(s.wins, s.games)}</td>
          ${ptsCell}
        </tr>`;
    })
    .join("");

  return `
    <table class="lb-table">
      <thead>
        <tr>
          <th class="lb-th lb-th-name">Personality</th>
          <th class="lb-th">Games</th>
          <th class="lb-th">Wins</th>
          <th class="lb-th">Win %</th>
          ${ptsHeader}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function initLeaderboardLayout(root: HTMLElement): void {
  const data = load();

  root.innerHTML = `
    <h1>LLM Arena</h1>
    <p class="tagline">Personality Leaderboard &middot; stored in your browser</p>

    <div class="lb-toolbar">
      <button id="lb-reset" class="lb-reset-btn">Reset stats</button>
    </div>

    <section class="panel">
      <h2>Mini-Mafia</h2>
      <p class="lb-hint">Win = your faction won. Mafioso wins if mafia wins; all others win if villagers win.</p>
      <div id="lb-mafia">${renderTable(data.mafia, false)}</div>
    </section>

    <section class="panel">
      <h2>Prisoner&rsquo;s Dilemma</h2>
      <p class="lb-hint">Win = top scorer in that match. Avg pts = cumulative points &divide; games.</p>
      <div id="lb-ipd">${renderTable(data.ipd, true)}</div>
    </section>
  `;

  root.querySelector("#lb-reset")!.addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    initLeaderboardLayout(root);
  });
}
