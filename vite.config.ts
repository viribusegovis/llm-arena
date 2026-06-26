import { defineConfig, type Plugin } from "vite";
import { appendFileSync, renameSync, existsSync } from "node:fs";
import { Readable } from "node:stream";

// Dev-only: page POSTs each log line here so spike output survives reloads/closed tabs.
// On each page load the page sends a __RESET__ sentinel first, which rotates
// spike-log.txt → spike-log.prev.txt so each session starts clean.
const fileLogger: Plugin = {
  name: "file-logger",
  configureServer(server) {
    server.middlewares.use("/__log", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (body.trimEnd() === "__RESET__") {
          // Rotate: move the current log to .prev before the new session writes anything.
          if (existsSync("spike-log.txt")) renameSync("spike-log.txt", "spike-log.prev.txt");
        } else {
          appendFileSync("spike-log.txt", body + "\n");
        }
        res.statusCode = 204;
        res.end();
      });
    });

    // Dev mirror of the Cloudflare Worker's /model route.
    // Same problem as prod: HF's XET CDN has no CORS headers for browser fetches.
    // Node's fetch runs server-side, so no CORS applies — identical fix, different runtime.
    server.middlewares.use("/model.gguf", (req, res) => {
      const MODEL_HF_URL =
        "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_1.gguf";
      const MODEL_SIZE_BYTES = 535_171_328;

      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Length": String(MODEL_SIZE_BYTES),
          "Accept-Ranges": "bytes",
        });
        res.end();
        return;
      }

      const fetchHeaders: Record<string, string> = {};
      if (typeof req.headers.range === "string") fetchHeaders["Range"] = req.headers.range;

      // Kick off the async proxy. Unhandled rejection surfaces in Vite's console.
      void fetch(MODEL_HF_URL, { headers: fetchHeaders }).then((hfRes) => {
        // node fetch decompresses gzip automatically but keeps Content-Encoding in headers;
        // drop it so the browser doesn't try to decompress an already-plain body.
        const headers = Object.fromEntries(hfRes.headers.entries());
        delete headers["content-encoding"];
        res.writeHead(hfRes.status, headers);
        if (hfRes.body) {
          // Convert Web ReadableStream (fetch API) to Node Readable so we can .pipe().
          Readable.fromWeb(hfRes.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
        } else {
          res.end();
        }
      });
    });
  },
};

// COOP/COEP required for SharedArrayBuffer (wllama multithread WASM)
export default defineConfig({
  plugins: [fileLogger],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
