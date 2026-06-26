import { Wllama } from "@wllama/wllama";
import type { ChatCompletionChunk, ChatCompletionTool } from "@wllama/wllama";
// Vite's `?url` import gives us the path to the compiled WASM binary at build time.
// The WASM file contains the actual inference engine — the compiled C++ code that
// runs the neural network math.
import wllamaWasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";

// The model is proxied through /model on the same origin (Cloudflare Worker in prod,
// Vite dev middleware in dev). Same-origin URLs bypass browser CORS rules entirely,
// which is necessary because HuggingFace's new XET CDN doesn't send CORS headers
// on browser fetch requests. The model file itself still lives on HuggingFace.
const MODEL_URL = `${window.location.origin}/model.gguf`;

// Removes Qwen3.5 chain-of-thought tags from model output.
// Even with enable_thinking: false, the model sometimes leaks a </think> tag or a full
// <think>…</think> block as the first tokens of its response. Strip them as a safety net.
function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "") // full thinking blocks
    .replace(/<\/think>/g, "")                // orphaned closing tag at start
    .trim();
}

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
    // MODEL_URL is /model on the same origin, proxied to HuggingFace server-side.
    // No CORS patching needed — same-origin requests are always allowed by the browser.
    await this.wllama.loadModelFromUrl(
      MODEL_URL,
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
          // Cloudflare Workers strips Content-Length from streamed responses, so
          // `total` arrives as 0. Fall back to the known file size so the progress
          // bar shows a real percentage instead of being stuck at 0%.
          const knownSize = 535_171_328;
          const t = total || knownSize;
          onProgress(Math.round((loaded / t) * 100));
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
      // Tracks whether we're currently inside a <think>…</think> block.
      // Qwen3.5 sometimes leaks thinking-mode tokens into streaming output even with
      // enable_thinking: false — we filter them so they never reach the UI.
      let inThinkBlock = false;

      await this.wllama.createChatCompletion({
        messages,
        max_tokens: maxTokens,
        temperature,
        chat_template_kwargs: { enable_thinking: false },
        stream: true,
        onData: (chunk: ChatCompletionChunk) => {
          const fragment = chunk.choices[0].delta.content ?? "";
          if (!fragment) return;
          collected += fragment;
          // Suppress thinking-mode tags and any content inside them.
          if (fragment.includes("<think>")) inThinkBlock = true;
          if (fragment.includes("</think>")) { inThinkBlock = false; return; }
          if (!inThinkBlock && !fragment.startsWith("<think>")) onToken(fragment);
        },
      });
      if (!collected) throw new Error("wllama streaming returned no content");
      // Post-process to strip any thinking blocks that weren't fully filtered above.
      return stripThinkTags(collected);
    }

    // Non-streaming mode: returns the full response in one shot.
    const response = await this.wllama.createChatCompletion({
      messages,
      max_tokens: maxTokens,
      temperature,
      // enable_thinking: false — Qwen3.5 has a built-in chain-of-thought mode that spends
      // the entire token budget on internal reasoning and returns an empty final answer.
      // Always disable it; strip leaked tags as a safety net.
      chat_template_kwargs: { enable_thinking: false },
    });
    if (!response) throw new Error("wllama returned null — likely a concurrent inference call");
    return stripThinkTags(response.choices[0].message.content ?? "");
  }

  // Runs one inference with a single tool definition and returns the parsed JSON arguments
  // the model placed in the tool call, or null if the model skipped or botched the call.
  //
  // tool_choice "required" instructs the model to always respond via the tool rather than
  // plain text. This is the right setting when you need a structured answer (like "pick one
  // of these player IDs") and cannot afford a free-text response.
  //
  // Returns null (rather than throwing) when the model calls the wrong tool or produces
  // malformed JSON — the caller handles that as a retry or fallback.
  async completeWithTool(
    messages: ChatMessage[],
    tool: ChatCompletionTool,
    maxTokens = 50,
    temperature = 0.3,
  ): Promise<Record<string, unknown> | null> {
    const response = await this.wllama.createChatCompletion({
      messages,
      tools: [tool],
      // "required" means the model must invoke one of the provided tools — it cannot
      // respond with free text. Without this, Qwen3.5-0.8B may ignore the tool entirely.
      tool_choice: "required",
      max_tokens: maxTokens,
      temperature,
      chat_template_kwargs: { enable_thinking: false },
    });
    if (!response) throw new Error("wllama returned null on tool call — concurrent inference?");

    const toolCalls = response.choices[0].message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) return null;

    const call = toolCalls.find((tc) => tc.function.name === tool.function.name);
    if (!call) return null;

    try {
      return JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      // Model called the tool but produced invalid JSON in the arguments field.
      return null;
    }
  }
}
