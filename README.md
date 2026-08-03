# Freebuff2 API Worker

OpenAI-compatible proxy untuk Freebuff / Codebuff API, dijalankan di Cloudflare Workers.

## Endpoints

| Method | Path              | Description                |
|--------|-------------------|----------------------------|
| GET    | `/healthz`        | Health check               |
| GET    | `/v1/models`      | List available models      |
| POST   | `/v1/chat/completions` | Chat completions (OpenAI-compatible) |

### Models tersedia

**Freebuff Models** (source: https://freebuff.com/live, verified 2026-07-12):
- `deepseek/deepseek-v4-flash`
- `deepseek/deepseek-v4-pro`
- `moonshotai/kimi-k2.7-code` (replaced deprecated `kimi-k2.6`)
- `minimax/minimax-m3`
- `mimo/mimo-v2.5`
- `mimo/mimo-v2.5-pro`
- `kwaipilot/kat-coder-pro-v2` (new)
- `z-ai/glm-5.2`

Removed: `moonshotai/kimi-k2.6`, `minimax/minimax-m2.7`, and mistaken Codebuff paid-mode aliases (`codebuff/*`).

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

Dapetin token Freebuff di **https://freebuff.071129.xyz/** — login trus generate token disana.

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
| `FREEBUFF_AD_PROVIDERS` | *(kosong — ads disabled)*                                  | Ad providers (⚠️ jangan diisi, lihat Security) |
| `FREEBUFF_TIMEOUT`    | `30` (produksi) / `60` (default kode)                        | Session queue timeout  |
| `FREEBUFF_DEBUG`      | `false`                                                      | Debug logging          |
| `FREEBUFF_TIMEZONE`   | `Asia/Shanghai`                                              | Fake device timezone (hanya dipakai kalau ads aktif) |
| `FREEBUFF_LOCALE`     | `zh-CN`                                                      | Fake device locale (hanya dipakai kalau ads aktif) |
| `FREEBUFF_OS`         | `windows`                                                    | Fake device OS (hanya dipakai kalau ads aktif) |
| `FREEBUFF_BROWSER_UA` | Mozilla/5.0 ... Chrome/120                                   | Browser user-agent untuk upstream |
| `CODEBUFF_API_URL`    | `https://www.codebuff.com`                                   | Upstream API URL       |
| `CLIENT_ID`           | `freebuff-cli-worker`                                        | Client identifier      |

## ⚠️ Security

### 1. Ad chain WAJIB mati (default sudah mati)

Freebuff adalah layanan gratis yang didanai iklan. Memanggil `/api/v1/ads` secara otomatis dari server (IP datacenter) dengan fingerprint device palsu adalah **pola ad fraud / click farming** dan **menyebabkan akun di-ban permanen** (`403 {"status":"banned"}`).

Sejak versi ini, ad chain **default OFF** di kode dan semua env:

```
FREEBUFF_AD_PROVIDERS=   # kosong = mati (JANGAN diisi)
```

Kalau var ini di-set ke provider apapun (`gravity`, `zeroclick`, dll), kode akan memanggil endpoint ads — **jangan lakukan itu** kecuali kamu benar-benar paham risikonya.

### 2. Token jangan pernah masuk git

- `.dev.vars` dan `.dev.vars.bak` sudah di-`.gitignore` dan di-untrack dari git.
- Repo punya **secret guard** (pre-commit hook) yang otomatis memblokir commit kalau ada file `.dev.vars`/`.env` atau nilai token asli yang ke-stage:

```bash
# install sekali (sudah dilakukan di repo ini)
git config core.hooksPath .githooks
```

Kalau commit kamu keblokir padahal bukan secret, hapus file/value itu dari staging (`git restore --staged <file>`).

### 3. Rotasi token

Kalau token pernah bocor (misal ke-commit di history git) atau kena banned, **rotasi di https://freebuff.071129.xyz/** — token lama harus dianggap bocor permanen. Untuk beberapa akun, generate ulang dengan cara yang berbeda per akun supaya tidak di-flag sebagai satu cluster. Token baru cukup di-set lewat `wrangler secret put FREEBUFF_TOKEN` dan `.dev.vars` (local), **jangan di-commit**.

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
