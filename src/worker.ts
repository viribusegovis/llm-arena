// Cloudflare Worker entry point.
//
// HuggingFace recently migrated GGUF repos to their new XET storage CDN
// (us.aws.cdn.hf.co/xet-bridge-us), which does not send CORS headers on browser
// fetch requests. The old git-LFS CDN did have CORS; the new one does not.
//
// Fix: the browser fetches /model from its own origin (same-origin, no CORS rules).
// This Worker proxies that request to HuggingFace server-side, where there are no
// browser CORS constraints. The model file stays on HuggingFace — nothing is uploaded.

const MODEL_HF_URL =
  "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_1.gguf";

// Exact byte size of the model file. Used to answer wllama's HEAD request for
// progress-bar reporting without going through HF's redirect chain (which also
// doesn't expose the headers wllama needs from a browser context).
const MODEL_SIZE_BYTES = 535_171_328;

// Minimal binding type. Full version is in @cloudflare/workers-types, but we
// avoid that dependency — this structural definition is sufficient.
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/model.gguf") {
      // HEAD: wllama calls this before every download to read Content-Length for the
      // progress bar. Return a synthetic response rather than proxying HF, because
      // HF's CDN also doesn't cooperate with browser HEAD requests.
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Length": String(MODEL_SIZE_BYTES),
            // Advertise range-request support so wllama knows it can resume downloads.
            "Accept-Ranges": "bytes",
          },
        });
      }

      // GET: proxy to HuggingFace server-side. Server-to-server fetch has no
      // browser CORS rules, so the missing CDN headers are not a problem here.
      const proxyHeaders: Record<string, string> = {};
      // Forward Range so wllama can do chunked / resumable downloads.
      const range = request.headers.get("Range");
      if (range) proxyHeaders["Range"] = range;

      const hfResponse = await fetch(MODEL_HF_URL, { headers: proxyHeaders });

      // Pass HF's response through including etag, which wllama uses as the
      // freshness key for its OPFS (browser storage) cache.
      return new Response(hfResponse.body, {
        status: hfResponse.status,
        statusText: hfResponse.statusText,
        headers: hfResponse.headers,
      });
    }

    // Everything else: serve the compiled static assets from ./dist.
    return env.ASSETS.fetch(request);
  },
};
