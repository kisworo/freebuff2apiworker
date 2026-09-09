# buff.eyasin.com — Bun local / VPS

Production Cloudflare Worker: `src/index.ts` (wrangler).

Local Bun entry: `src/bun.ts` — same Hono app, port 7300, `idleTimeout=255s` so long SSE tool gaps are not killed.

```bash
bun src/bun.ts
```

Loads `.dev.vars` into `process.env`.

`GET /healthz` — no auth.
