import { Hono } from "hono";
import http from "node:http";
import { Readable } from "node:stream";

const app = new Hono<{ Bindings: Record<string, string> }>();

const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = 8787;
const UPSTREAM_TIMEOUT_MS = 600_000;
const SSE_KEEPALIVE_MS = 15_000;

app.use("*", async (c, next) => {
  const localApiKey = c.env.FREEBUFF_API_KEY || "sk-xyz";
  if (localApiKey) {
    const authHeader = c.req.header("Authorization");
    if (authHeader !== `Bearer ${localApiKey}`) {
      return c.json({ detail: "Invalid API key" }, 401);
    }
  }
  await next();
});

app.get("/healthz", (c) =>
  c.json({ status: "ok", upstream: "cmdproxy", idleTimeout: 255, sseKeepaliveMs: SSE_KEEPALIVE_MS }),
);

function isEventStream(headers: Record<string, string | string[] | undefined>): boolean {
  const ct = headers["content-type"];
  const v = Array.isArray(ct) ? ct.join(",") : ct || "";
  return v.toLowerCase().includes("text/event-stream");
}

function withSseKeepalive(
  body: ReadableStream<Uint8Array>,
  intervalMs: number,
  onClientAbort?: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    reader.cancel().catch(() => {});
    onClientAbort?.();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, intervalMs);
    },
    async pull(controller) {
      if (closed) return;
      const { done, value } = await reader.read();
      if (done) {
        cleanup();
        controller.close();
        return;
      }
      if (value?.length) controller.enqueue(value);
    },
    cancel() {
      cleanup();
    },
  });
}

function proxyHttp(
  method: string,
  pathWithQuery: string,
  headers: Record<string, string>,
  body: string | undefined,
  clientSignal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method,
        path: pathWithQuery,
        headers: { ...headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
        timeout: 0,
      },
      (res) => {
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          outHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        }

        let stream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        if (isEventStream(res.headers)) {
          stream = withSseKeepalive(stream, SSE_KEEPALIVE_MS, () => req.destroy());
        }

        resolve(
          new Response(stream, {
            status: res.statusCode || 502,
            headers: outHeaders,
          }),
        );
      },
    );

    const wallTimer = setTimeout(() => {
      req.destroy(new Error("upstream wall timeout"));
    }, UPSTREAM_TIMEOUT_MS);

    const onAbort = () => req.destroy(new Error("client aborted"));
    if (clientSignal) {
      if (clientSignal.aborted) onAbort();
      else clientSignal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("error", (err) => {
      clearTimeout(wallTimer);
      reject(err);
    });
    req.on("close", () => clearTimeout(wallTimer));

    if (body) req.write(body);
    req.end();
  });
}

app.all("/v1/*", async (c) => {
  const url = new URL(c.req.url);
  const pathWithQuery = url.pathname + url.search;
  const method = c.req.method;
  const headers: Record<string, string> = {};

  c.req.raw.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length") return;
    headers[key] = value;
  });

  console.log(`[Proxy] ${method} ${pathWithQuery} -> http://${UPSTREAM_HOST}:${UPSTREAM_PORT}${pathWithQuery}`);

  try {
    const body = method !== "GET" && method !== "HEAD" ? await c.req.text() : undefined;
    if (body) headers["content-length"] = String(Buffer.byteLength(body));

    return await proxyHttp(method, pathWithQuery, headers, body, c.req.raw.signal);
  } catch (err: any) {
    console.error("[Proxy] Upstream error:", err?.message || err);
    return c.json(
      {
        error: {
          message: `Upstream unavailable: ${err?.message || String(err)}`,
          type: "proxy_error",
          code: "upstream_error",
        },
      },
      502,
    );
  }
});

export default app;