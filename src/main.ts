import { Wllama, type LoadedContextInfo } from "@wllama/wllama";
import wllamaWasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";

const app = document.querySelector<HTMLDivElement>("#app")!;

// Rotate the log file on each page load (server moves the old one to spike-log.prev.txt).
// Fires before the console patch so every line of this session lands in the fresh file.
fetch("/__log", { method: "POST", body: "__RESET__" }).catch(() => {});

const stringifyArg = (a: unknown) => {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
};

// These llama.cpp messages are normal internal scheduler chatter — not errors.
// "restored context checkpoint" = the KV cache (saved computation table) was reloaded
// for a new inference that shares a prompt prefix with a previous one. Expected and benign.
// Filtering here keeps the log readable; they still appear in the browser console if needed.
const LOG_SKIP = [/slot update_slots:.*restored context checkpoint/];

// Forward everything that hits the console (ours, wllama's internal logger, browser warnings)
// to the dev-only /__log endpoint so the spike output survives in spike-log.txt.
for (const level of ["log", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${args.map(stringifyArg).join(" ")}`;
    if (LOG_SKIP.some((re) => re.test(line))) return;
    fetch("/__log", { method: "POST", body: line }).catch(() => {});
  };
}

const log = (line: string) => {
  app.append(line, document.createElement("br"));
  console.log(line);
};

const MOVES = ["cooperate", "defect"] as const;
type Move = (typeof MOVES)[number];

function parseMoveFromText(text: string): Move | null {
  const lower = text.toLowerCase();
  const cooperateIdx = lower.indexOf("cooperate");
  const defectIdx = lower.indexOf("defect");
  if (cooperateIdx === -1 && defectIdx === -1) return null;
  if (cooperateIdx === -1) return "defect";
  if (defectIdx === -1) return "cooperate";
  return cooperateIdx < defectIdx ? "cooperate" : "defect";
}

async function getMoveSingleWord(wllama: Wllama, temperature: number): Promise<Move | null> {
  const response = await wllama.createChatCompletion({
    messages: [
      {
        role: "user",
        content:
          "You are playing one round of the Prisoner's Dilemma. Respond with exactly one word: either cooperate or defect. No explanation, no punctuation.",
      },
    ],
    max_tokens: 8,
    temperature,
    chat_template_kwargs: { enable_thinking: false },
  });
  return parseMoveFromText(response.choices[0].message.content ?? "");
}

const PICK_TOOL = {
  type: "function" as const,
  function: {
    name: "pick",
    description: "Choose your move in the Prisoner's Dilemma.",
    parameters: {
      type: "object" as const,
      properties: {
        move: { type: "string", enum: [...MOVES] },
      },
      required: ["move"],
    },
  },
};

async function getMoveToolCall(wllama: Wllama, temperature: number): Promise<Move | null> {
  const response = await wllama.createChatCompletion({
    messages: [
      {
        role: "user",
        content: "You are playing one round of the Prisoner's Dilemma. Call the `pick` tool with your move.",
      },
    ],
    tools: [PICK_TOOL],
    tool_choice: "required",
    max_tokens: 64,
    temperature,
    chat_template_kwargs: { enable_thinking: false },
  });
  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall) return null;
  try {
    const args = JSON.parse(toolCall.function.arguments);
    return (MOVES as readonly string[]).includes(args.move) ? (args.move as Move) : null;
  } catch {
    return null;
  }
}

async function stressTest(
  label: string,
  n: number,
  runOnce: () => Promise<Move | null>
): Promise<void> {
  let valid = 0;
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    try {
      const move = await runOnce();
      if (move) valid++;
    } catch (err) {
      console.error(`${label} run ${i} threw`, err);
    }
    if ((i + 1) % 10 === 0) log(`${label}: ${i + 1}/${n} runs done...`);
  }
  const ms = performance.now() - start;
  log(
    `${label}: ${valid}/${n} valid (${((valid / n) * 100).toFixed(0)}%), ${ms.toFixed(0)}ms total, ${(ms / n).toFixed(0)}ms/run avg`
  );
}

// A "personality" is a system prompt paired with a label. A system prompt is a hidden
// instruction injected before the conversation starts — it steers the model's values,
// tone, and strategy without the user (or opponent) seeing it.
const PERSONALITIES = [
  {
    name: "cooperative (tit-for-tat)",
    // Tit-for-tat: open with cooperation, then mirror whatever the opponent did last round.
    // Historically one of the strongest strategies in repeated Prisoner's Dilemma tournaments.
    systemPrompt:
      "You are a fair-minded player in the Prisoner's Dilemma. You believe in mutual cooperation. On the first round, always cooperate. After that, mirror your opponent's last move.",
  },
  {
    name: "defective (always-defect)",
    systemPrompt:
      "You are a ruthlessly self-interested player in the Prisoner's Dilemma. You always prioritize your own payoff. Defecting is almost always correct — it exploits cooperators and protects you from being exploited.",
  },
];

// Verify that two distinct personalities produce sensibly different outputs from the same
// loaded model instance. This is the final Phase 0 gate: confirms the system-prompt
// mechanism actually shapes behavior rather than being ignored.
async function testPersonalities(wllama: Wllama): Promise<void> {
  log(`--- Personality test: 2 personalities × 3 rounds, temperature=0.3 ---`);

  for (const personality of PERSONALITIES) {
    const moves: (Move | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await wllama.createChatCompletion({
        messages: [
          // The system role sets the personality context before the conversation begins.
          { role: "system", content: personality.systemPrompt },
          {
            role: "user",
            content:
              "You are playing one round of the Prisoner's Dilemma. Respond with exactly one word: either cooperate or defect. No explanation, no punctuation.",
          },
        ],
        max_tokens: 8,
        // Low temperature (0–1 scale) makes the model more deterministic — it picks the
        // highest-probability token more reliably. High temperature adds randomness.
        // 0.3 here because we want to see each personality's "true" preference, not noise.
        temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false },
      });
      moves.push(parseMoveFromText(response.choices[0].message.content ?? ""));
    }
    log(`  ${personality.name}: ${moves.join(", ")}`);
  }
}

async function main() {
  log(`isSupportWebGPU(): checking...`);
  const wllama = new Wllama({ default: wllamaWasmUrl });
  log(`WebGPU supported: ${wllama.isSupportWebGPU()}`);

  const loadStart = performance.now();
  await wllama.loadModelFromHF(
    { repo: "unsloth/Qwen3.5-0.8B-GGUF", file: "Qwen3.5-0.8B-Q4_K_M.gguf" },
    {
      n_ctx: 2048,
      n_gpu_layers: -1, // -1 = offload all layers; n_layer(24) undercounts by 1 (doesn't include output layer)
      jinja: true,
      progressCallback: ({ loaded, total }) => {
        const pct = total ? Math.round((loaded / total) * 100) : 0;
        log(`Loading model... ${pct}%`);
      },
    }
  );
  const loadMs = performance.now() - loadStart;
  log(`Model loaded in ${loadMs.toFixed(0)}ms (check console for backend/CPU-fallback logs)`);

  const ctx: LoadedContextInfo = wllama.getLoadedContextInfo();
  log(`n_ctx=${ctx.n_ctx} n_layer=${ctx.n_layer} n_embd=${ctx.n_embd}`);

  const RUNS = 50;
  const TEMP = 0.5; // production-range temperature (plan: ~0.3-0.7); was 1.2 during adversarial stress test

  log(`--- Single-word extraction, temperature=${TEMP}, n=${RUNS} ---`);
  await stressTest("single-word", RUNS, () => getMoveSingleWord(wllama, TEMP));

  log(`--- Tool-call extraction, temperature=${TEMP}, n=${RUNS} ---`);
  await stressTest("tool-call", RUNS, () => getMoveToolCall(wllama, TEMP));

  await testPersonalities(wllama);
}

main().catch((err) => {
  console.error(err);
  log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
});
