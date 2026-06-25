import { Wllama } from "@wllama/wllama";
// Vite's `?url` import gives us the path to the compiled WASM binary at build time.
// The WASM file contains the actual inference engine — the compiled C++ code that
// runs the neural network math.
import wllamaWasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";

// The quantized model we're loading. "Quantized" means the model's weights (numbers
// that encode what the model has learned) have been compressed from 32-bit floats to
// ~4 bits each, shrinking the file from ~3 GB to ~500 MB at the cost of slight quality loss.
const MODEL_REPO = "unsloth/Qwen3.5-0.8B-GGUF";
const MODEL_FILE = "Qwen3.5-0.8B-Q4_K_M.gguf";

// A message in a conversation, matching the OpenAI chat format wllama expects.
// "system" = hidden setup instructions (personality), "user" = the human turn,
// "assistant" = the model's previous replies (used to give the model its own history).
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Thin wrapper around wllama. Owns model loading and all inference calls.
// Keeping wllama isolated here means the agents and referee never import from it
// directly — if we ever swap the runtime, only this file changes.
export class WllamaClient {
  private readonly wllama: Wllama;

  constructor() {
    // Single WASM build covers both single-thread and multi-thread since wllama v3.1.
    this.wllama = new Wllama({ default: wllamaWasmUrl });
  }

  // Downloads the model on first call, then loads it from the browser's OPFS cache
  // on subsequent calls (~1–5s instead of ~5min). OPFS (Origin Private File System)
  // is a browser storage API that wllama uses automatically — no setup needed.
  // onProgress receives 0–100 so the UI can show a progress bar.
  async load(onProgress: (pct: number) => void): Promise<void> {
    await this.wllama.loadModelFromHF(
      { repo: MODEL_REPO, file: MODEL_FILE },
      {
        // n_ctx: how many tokens (word-pieces) of conversation history the model keeps
        // in memory at once. 2048 is plenty for this game's short prompts.
        n_ctx: 2048,
        // n_gpu_layers: how many of the model's 25 internal layers to run on the GPU.
        // -1 means "all of them". GPU inference is ~6× faster than CPU for this model.
        // Must be explicit — wllama's default is CPU-only despite the README's claim.
        n_gpu_layers: -1,
        // jinja: use the model's built-in chat template (its preferred prompt format).
        // Without this, messages are concatenated raw and quality degrades significantly.
        jinja: true,
        progressCallback: ({ loaded, total }) => {
          onProgress(total ? Math.round((loaded / total) * 100) : 0);
        },
      }
    );
  }

  // Runs one inference: sends the message history to the model and returns its reply.
  // Each call is stateless — the full conversation history must be passed every time.
  // maxTokens caps how long the reply can be (1 token ≈ 1 word or punctuation mark).
  // temperature controls randomness: 0 = deterministic, 1 = very random. 0.5 is balanced.
  async complete(messages: ChatMessage[], maxTokens = 16, temperature = 0.5): Promise<string> {
    const response = await this.wllama.createChatCompletion({
      messages,
      max_tokens: maxTokens,
      temperature,
      // enable_thinking: false — Qwen3.5 has a built-in reasoning mode that spends the
      // entire token budget on an internal chain-of-thought and returns an empty final
      // answer. Always disable it for move extraction.
      chat_template_kwargs: { enable_thinking: false },
    });
    // wllama returns null on concurrent calls or internal failure rather than throwing.
    if (!response) throw new Error("wllama returned null — likely a concurrent inference call");
    return response.choices[0].message.content ?? "";
  }
}
