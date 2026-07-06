# buff.eyasin.com — Bun proxy mode (VPS)

Production entry: `src/bun.ts` → forwards `/v1/*` to cmdproxy (default `127.0.0.1:8787`).

## Environment (`.dev.vars` or systemd)

| Variable | Default | Description |
|----------|---------|-------------|
| `FREEBUFF_API_KEY` | *(required)* | Bearer token for clients (9router buff node) |
| `FREEBUFF_UPSTREAM_HOST` | `127.0.0.1` | cmdproxy host |
| `FREEBUFF_UPSTREAM_PORT` | `8787` | cmdproxy port |
| `FREEBUFF_UPSTREAM_TIMEOUT_MS` | `600000` | Max upstream duration |
| `FREEBUFF_SSE_KEEPALIVE_MS` | `15000` | SSE comment ping interval |

## Health

`GET /healthz` — no auth.

## Legacy

`codebuff.ts` / worker pool — not used when `index.ts` is proxy-only. See git history before `a924ec4` for Codebuff worker mode.