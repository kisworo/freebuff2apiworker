# Freebuff2 API Worker

OpenAI-compatible proxy untuk Freebuff / Codebuff API, dijalankan di Cloudflare Workers.

## Endpoints

| Method | Path              | Description                |
|--------|-------------------|----------------------------|
| GET    | `/healthz`        | Health check               |
| GET    | `/v1/models`      | List available models      |
| POST   | `/v1/chat/completions` | Chat completions (OpenAI-compatible) |

### Models tersedia

**Freebuff Models:**
- `deepseek/deepseek-v4-flash`
- `deepseek/deepseek-v4-pro`
- `moonshotai/kimi-k2.6`
- `minimax/minimax-m2.7`

**Gemini Models (via Freebuff session):**
- `google/gemini-2.5-flash-lite`
- `google/gemini-3.1-flash-lite-preview`
- `google/gemini-3.1-pro-preview`

## Auth

Set `FREEBUFF_API_KEY` sebagai secret. Client mengirim `Authorization: Bearer <api_key>` di setiap request. Jika tidak diset, auth tidak diaktifkan.

## Deploy

```bash
# Install dependencies
npm install

# Deploy ke Cloudflare
npx wrangler deploy
```

## Setting Secrets (wajib!)

Dapetin token Freebuff di **https://freebuff.llm.pm/** — login trus generate token disana.

Token bisa berisi satu akun atau multi akun (dipisah koma) untuk concurrent request.

Ada 2 secrets yang harus diset sebelum worker bisa dipakai:

```bash
# Token API Freebuff (satu atau multi akun, pisah dengan koma)
echo "token1,token2,token3" | npx wrangler secret put FREEBUFF_TOKEN

# API Key buat akses proxy ini (optional, untuk auth client)
echo "sk-xxx" | npx wrangler secret put FREEBUFF_API_KEY
```

### Local development

Buat file `.dev.vars` (sudah di-gitignore):

```
FREEBUFF_TOKEN=token1,token2,token3
FREEBUFF_API_KEY=***
```

Jalankan dev server:

```bash
npx wrangler dev
```

### Vars (non-sensitive — di wrangler.json)

| Var                   | Default                                                      | Description            |
|-----------------------|--------------------------------------------------------------|------------------------|
| `FREEBUFF_AD_PROVIDERS` | `gravity,zeroclick`                                        | Ad providers           |
| `FREEBUFF_TIMEOUT`    | `60`                                                         | Session queue timeout  |
| `FREEBUFF_DEBUG`      | `true`                                                       | Debug logging          |
| `FREEBUFF_TIMEZONE`   | `Asia/Shanghai`                                              | Fake device timezone   |
| `FREEBUFF_LOCALE`     | `zh-CN`                                                      | Fake device locale     |
| `FREEBUFF_OS`         | `windows`                                                    | Fake device OS         |
| `FREEBUFF_BROWSER_UA` | Mozilla/5.0 ... Chrome/120                                   | Fake browser user-agent|
| `CODEBUFF_API_URL`    | `https://www.codebuff.com`                                   | Upstream API URL       |
| `CLIENT_ID`           | `freebuff-cli-worker`                                        | Client identifier      |

## Multi-Account / Round-Robin Pool

Worker ini mendukung **banyak akun Freebuff** dalam satu token. Caranya pisah token dengan koma:

```
FREEBUFF_TOKEN=token_akun1,token_akun2,token_akun3
```

**Cara kerjanya di kode (`CodebuffAccountPool`):**

1. Token di-split berdasarkan koma → setiap token jadi satu `CodebuffClient` + `SessionManager`.
2. Setiap request masuk, pool meminjam salah satu akun secara **round-robin** (`nextIndex`).
3. Jika semua akun sedang sibuk, request masuk ke antrian (`waitingQueue`) dan akan dilayani pas ada akun yang selesai.
4. Akun dilepas kembali ke pool setelah request selesai (stream atau non-stream).

**Kenapa multi-akun berguna?**
- **Rate limit handling** — beban request didistribusi ke beberapa akun.
- **Concurrent sessions** — setiap akun bisa handle satu request aktif, jadi N akun = N request paralel maksimal.
- **Queue fallback** — kalau semua sibuk, request antri tanpa error.

### Alur request (streaming)

```
Client → POST /v1/chat/completions
          ↓
  Auth middleware (cek FREEBUFF_API_KEY)
          ↓
  Resolve model (mapping nama model → agent_id Freebuff)
          ↓
  acquireSession (pinjam akun dari pool, round-robin)
          ↓
  startRunChain (start run + context-pruner child run)
          ↓
  buildUpstreamPayload (map ke format Codebuff API)
          ↓
  chatEventsStream → pipe response → Client
          ↓
  finalizeRun + release akun (background via waitUntil)
```
