import { defineConfig, type Plugin } from "vite";
import { appendFileSync, renameSync, existsSync } from "node:fs";

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
