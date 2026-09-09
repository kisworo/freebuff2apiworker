# Freebuff2 API Worker

OpenAI-compatible proxy untuk Freebuff / Codebuff API, dijalankan di Cloudflare Workers.

Wire-nya diselaraskan dengan [trefeon/freebuff-proxy](https://github.com/trefeon/freebuff-proxy) v1.8.x: envelope CLI, katalog live, base3 agent, Freebucks-aware session. Ads chain **selalu mati**.

## Endpoints

| Method | Path              | Description                |
|--------|-------------------|----------------------------|
| GET    | `/healthz`        | Health check (no auth)     |
| GET    | `/v1/models`      | List available models      |
| POST   | `/v1/chat/completions` | Chat completions (OpenAI-compatible) |

### Model

Hanya **Muse Spark 1.3**:

`meta/muse-spark-1.3-contributor` (alias: `muse-spark-1.3`, `meta/muse-spark-1.2-contributor`)

Model lain → 400. Kalau upstream admit model lain (akun limited/region-blocked), request di-fail 403 dan session di-DELETE — tidak pernah chat di substitute.

## Auth

Set `FREEBUFF_API_KEY` sebagai secret. Client mengirim `Authorization: Bearer <api_key>` di setiap request. Jika tidak diset, auth tidak diaktifkan. `/healthz` selalu publik.

## Deploy

```bash
npm install
npx wrangler deploy
```

## Setting Secrets (wajib!)

Token Freebuff: login di **https://freebuff.071129.xyz/** lalu generate token.

```bash
echo "token1,token2,token3" | npx wrangler secret put FREEBUFF_TOKEN
echo "sk-xxx" | npx wrangler secret put FREEBUFF_API_KEY
```

### Local development

Buat `.dev.vars` (gitignore):

```
FREEBUFF_TOKEN=token1,token2,token3
FREEBUFF_API_KEY=***
```

```bash
npx wrangler dev
# atau: bun src/bun.ts
```

### Vars (`wrangler.json`)

| Var | Default | Description |
|-----|---------|-------------|
| `FREEBUFF_AD_PROVIDERS` | *(kosong, diabaikan)* | Ads **tidak pernah** dipanggil dari Worker |
| `FREEBUFF_TIMEOUT` | `30` | Session queue timeout (detik) |
| `FREEBUFF_DEBUG` | `false` | Debug logging |
| `REQUEST_JITTER_MS` | `200` | Jitter 0–N ms sebelum chat (anti-ban) |
| `CODEBUFF_API_URL` | `https://www.codebuff.com` | Upstream API URL |

## Anti-ban (non-CLI)

Worker ini **bukan** CLI resmi. Upstream mendeteksi proxy lewat toolset, system prompt, UA, dan `client_id`. Yang dilakukan supaya akun tidak kena `403 {"status":"banned"}` / trust-cap `third_party_client`:

1. **Ads chain selalu OFF.** Memanggil `/api/v1/ads` dari IP datacenter + fingerprint palsu adalah pola ad-fraud yang bikin akun di-ban permanen. `FREEBUFF_AD_PROVIDERS` diabaikan meski di-set.
2. **System prompt kanonik.** Gate free-mode adalah prefix exact `You are Buffy, the coding agent behind Codebuff.` di position 0. Prefix lama `You are Buffy. [System Override:…]` sudah ditutup upstream.
3. **UA per-path seperti CLI.** Chat: `ai-sdk/openai-compatible/1.0.0/codebuff`. Session/run: `Bun/1.3.14`. Bukan Chrome/120, bukan `0.0.0-test` / `runtime/browser`.
4. **`client_id` 13-char base36 per run** (bukan `freebuff-cli-worker` / UUID). Satu id diulang untuk seluruh step run yang sama — N id di satu `run_id` = `free_mode_run_fanout`.
5. **Root base3 saja.** Tidak spawn `context-pruner` / child run. FINISH membawa steps; tidak ada POST `/steps`.
6. **Envelope CLI:** `cost_mode=free`, `provider.data_collection=deny`, `stop=["\"cb_easp\""]`, stream forced, metadata `freebuff_instance_id` + `run_id`. Chat POST **tidak** kirim header `x-freebuff-*` (id hanya di body).
7. **Tools di-map ke nama signature Freebuff** (bukan di-strip). Request dengan tool asing tanpa signature tool = `foreign_toolset` → downgrade + trust cap. Nama client di-restore di response.
8. **Tidak inject `max_tokens` / temperature** kalau client tidak kirim. Sampling params + no-tools adalah sinyal foreign client (reported, belum enforced).
9. **Tidak background-warm session.** Setiap `POST /session` adalah charge Freebucks 1 jam. Warm = bakar kuota.
10. **DELETE session pakai `x-freebuff-instance-id`** saat ganti model (refund sisa jam).
11. **428 waiting room tidak diikuti ads chain.** Request gagal 503, bukan jalanin ads dari IP CF.
12. **Jitter 0–200ms** sebelum chat.

Sisa risiko yang **tidak bisa** dihilangkan di Cloudflare Workers: egress IP datacenter (upstream memblokir proxy/VPN/Tor). Kalau akun tetap di-flag, jalankan trefeon/freebuff-proxy di VPS residential, Worker cuma reverse-proxy.

### Token jangan masuk git

`.dev.vars` sudah di-gitignore. Secret guard:

```bash
git config core.hooksPath .githooks
```

Kalau token bocor atau banned, rotasi di https://freebuff.071129.xyz/ lalu `wrangler secret put FREEBUFF_TOKEN`.

## Multi-account pool

`FREEBUFF_TOKEN=token1,token2,token3` — round-robin, 1 request aktif per akun, skip banned, lease watchdog 5 menit, queue timeout 8 detik. Tidak ada partisi per-model (itu kelihatan seperti farm).
