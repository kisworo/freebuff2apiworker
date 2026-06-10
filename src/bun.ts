import fs from "fs";
import path from "path";
import app from "./index";

const devVarsPath = path.join(import.meta.dir, "../.dev.vars");
if (fs.existsSync(devVarsPath)) {
  const content = fs.readFileSync(devVarsPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx !== -1) {
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      process.env[key] = val;
    }
  }
  console.log("[Bun Server] Loaded variables from .dev.vars");
}

const port = 7300; // Use port 7300
console.log(`[Bun Server] Starting Hono app on port ${port}...`);

Bun.serve({
  fetch: (request, server) => {
    return app.fetch(request, process.env);
  },
  port: port,
});
