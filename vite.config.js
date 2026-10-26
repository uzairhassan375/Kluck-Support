import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Vite does not run Vercel /api serverless functions.
 * Mount posthog-market-stats locally so Market Flow Stats works on localhost.
 */
function supportApiPlugin() {
  return {
    name: "kluck-support-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
        if (!url.startsWith("/api/posthog-market-stats")) {
          next();
          return;
        }

        const env = loadEnv(server.config.mode, server.config.root, "");
        for (const [key, value] of Object.entries(env)) {
          if (process.env[key] === undefined) process.env[key] = value;
        }

        try {
          const modPath = path.resolve(
            server.config.root,
            "api/posthog-market-stats.js",
          );
          // Cache-bust so handler edits reload without restarting Vite.
          const href = `${pathToFileURL(modPath).href}?t=${Date.now()}`;
          const mod = await import(href);
          const handler = mod.default;
          if (typeof handler !== "function") {
            throw new Error("posthog-market-stats default export is missing");
          }
          await handler(req, res);
        } catch (err) {
          console.error("[kluck-support-api]", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                success: false,
                error: err?.message || "Local stats API failed",
              }),
            );
          }
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), supportApiPlugin()],
});
