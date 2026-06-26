import { Wllama } from "@wllama/wllama";
import type { ChatCompletionChunk } from "@wllama/wllama";
// Vite's `?url` import gives us the path to the compiled WASM binary at build time.
// The WASM file contains the actual inference engine — the compiled C++ code that
// runs the neural network math.
import wllamaWasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";

// The quantized model we're loading. "Quantized" means the model's weights (numbers
// that encode what the model has learned) have been compressed from 32-bit floats to
// ~4 bits each, shrinking the file from ~3 GB to ~500 MB at the cost of slight quality loss.
const MODEL_REPO = "unsloth/Qwen3.5-0.8B-GGUF";
// Q4_K_M does not exist in this repo; Q4_1 is the closest 4-bit equivalent (~500 MB).
const MODEL_FILE = "Qwen3.5-0.8B-Q4_1.gguf";

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
  //
  // onToken: if provided, the model streams its output. The callback fires once per
  // text fragment (typically one or a few characters). When streaming, wllama's API
  // returns Promise<void> instead of the response, so we collect text inside the callback.
  async complete(
    messages: ChatMessage[],
    maxTokens = 16,
    temperature = 0.5,
    onToken?: (fragment: string) => void,
  ): Promise<string> {
    if (onToken) {
      // Streaming mode: wllama fires onData once per generated token fragment.
      // We accumulate the fragments ourselves and return the full text at the end.
      let collected = "";
      await this.wllama.createChatCompletion({
        messages,
        max_tokens: maxTokens,
        temperature,
        chat_template_kwargs: { enable_thinking: false },
        // stream: true switches wllama from returning a single response to calling onData
        // repeatedly as tokens are generated, then resolving the promise when done.
        stream: true,
        onData: (chunk: ChatCompletionChunk) => {
          // delta.content is the new text fragment for this token; null at stream end.
          const fragment = chunk.choices[0].delta.content ?? "";
          if (fragment) {
            collected += fragment;
            onToken(fragment);
          }
        },
      });
      // If nothing was collected, the model returned empty content — same failure mode as
      // a null response in non-streaming mode. Throw so the retry logic can handle it.
      if (!collected) throw new Error("wllama streaming returned no content");
      return collected;
    }

    // Non-streaming mode: returns the full response in one shot.
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
