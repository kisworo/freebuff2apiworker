# Freebuff2 API Worker

OpenAI-compatible proxy untuk Freebuff / Codebuff API.

Deployment aktif: **Bun standalone di VPS**. Cloudflare Worker build tidak lagi jadi target utama, tapi tetap didukung.

Wire-nya diselaraskan dengan [trefeon/freebuff-proxy](https://github.com/trefeon/freebuff-proxy) v1.8.x: envelope CLI, base3 agent, Freebucks-aware session. Ads chain **selalu mati**.

## Endpoints

| Method | Path              | Description                |
|--------|-------------------|----------------------------|
| GET    | `/healthz`        | Health check (no auth)     |
| GET    | `/v1/models`      | List available models      |
| POST   | `/v1/chat/completions` | Chat completions (OpenAI-compatible) |

### Model

Hanya **GLM 5.3 Flash**:

`z-ai/glm-5.3-flash` (alias: `glm-5.3-flash`, `glm`, `z-ai/glm-5.3`, plus semua nama `muse-spark*` lama tetap diterima demi backward compat)

Model lain → 400.

Riwayat pin:
- Muse Spark 1.3 → **ditarik Freebuff dari free mode** (409 `model_unavailable` / `withdrawn`, 2026-09-10). Freebuff merekomendasikan GLM 5.3 Flash.
- Muse Spark 1.2 → masih hidup, tapi premium pool (cuma 5 req/hari) dan 15 freebucks/request. Tidak dipakai.

## Auth

Set `FREEBUFF_API_KEY`. Client mengirim `Authorization: Bearer <key>` di setiap request. Jika tidak diset, auth tidak diaktifkan. `/healthz` selalu publik.

## Deploy

### VPS + Bun (yang dipakai sekarang)

```bash
bun install
# .dev.vars: FREEBUFF_TOKEN (comma-separated), FREEBUFF_API_KEY, CODEBUFF_API_URL, dll.
sudo systemctl restart freebuff2api   # ExecStart: bun run src/bun.ts (port 7300)
```

### Cloudflare Workers (alternatif)

```bash
npm install
npx wrangler deploy
```

## Setting Secrets (wajib!)

Token Freebuff: login di **https://freebuff.071129.xyz/** lalu generate token.

```bash
# Workers:
echo "token1,token2,token3" | npx wrangler secret put FREEBUFF_TOKEN
echo "sk-xxx" | npx wrangler secret put FREEBUFF_API_KEY

# VPS: langsung di .dev.vars (gitignored, jangan pernah di-commit)
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

## Kuota Freebuff

Cek kuota semua token di pool:

```bash
./check_quota.sh
```

Struktur kuota free tier (per token):
- **Freebucks harian: 100**, reset 07:00 UTC (14:00 WIB). GLM 5.3 Flash = 5/request → ~20 req/hari/token.
- **Premium pool: 5 req/hari** (base 5, referral/streak bisa nambah). Berlaku buat `gpt-5.6-luna`, `muse-spark-1.2`, `kimi-k3-eco`, `gemini-3.8-flash`, dst — bukan glm.
- Harga model lain jauh lebih mahal: muse-spark 15, deepseek-v4-flash 30 (+15 peak pricing sesekali), gemini-3.8-flash 50.
- Session aktif "mengunci" model: ganti model = DELETE session dulu (header `x-freebuff-instance-id` wajib) baru POST model baru. Freebucks sisa jam di-refund.
- Model yang sudah ditarik (mis. muse-spark-1.3) → 409 `model_unavailable, withdrawn`. Cek dulu ke upstream sebelum pin model.

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

Sisa risiko: egress IP datacenter (upstream memblokir proxy/VPN/Tor). Kalau akun tetap di-flag, jalankan di VPS residential.

### Token jangan masuk git

`.dev.vars` sudah di-gitignore (termasuk backup `check_quota.sh` yang membacanya — biarkan untracked). Secret guard:

```bash
git config core.hooksPath .githooks
```

Kalau token bocor atau banned, rotasi di https://freebuff.071129.xyz/ lalu update `.dev.vars` / `wrangler secret put FREEBUFF_TOKEN`.

## Multi-account pool

`FREEBUFF_TOKEN=token1,token2,token3` — round-robin, 1 request aktif per akun, skip banned, lease watchdog 5 menit, queue timeout 8 detik. Tidak ada partisi per-model (itu kelihatan seperti farm).
