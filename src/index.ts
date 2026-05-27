import { Hono } from "hono";
import { resolveModel, modelsResponse } from "./models";
import { CodebuffAccountPool, utcNowIso, FreebuffRun, CodebuffClient } from "./codebuff";
import { buildUpstreamPayload, sanitizeStreamChunk, CompletionAccumulator } from "./openai_compat";

const app = new Hono<{ Bindings: Record<string, string> }>();

let pool: CodebuffAccountPool | null = null;

function getPool(env: any): CodebuffAccountPool {
  if (!pool) {
    pool = new CodebuffAccountPool(env);
    console.log(`[Worker] Initialized CodebuffAccountPool with count=${pool.accountCount}`);
  }
  return pool;
}

// Auth middleware
app.use("*", async (c, next) => {
  const localApiKey = c.env.FREEBUFF_API_KEY;
  if (localApiKey) {
    const authHeader = c.req.header("Authorization");
    if (authHeader !== `Bearer ${localApiKey}`) {
      return c.json({ detail: "Invalid API key" }, 401);
    }
  }
  await next();
});

// health check
app.get("/healthz", (c) => c.json({ status: "ok" }));

// models list
app.get("/v1/models", (c) => c.json(modelsResponse()));

// chat completions
app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json();
  let modelConfig;
  try {
    modelConfig = resolveModel(body.model);
  } catch (err: any) {
    return c.json({ detail: err.message }, 400);
  }

  const accountPool = getPool(c.env);
  let lease: any = null;

  try {
    // 1. Acquire session lease from the pool (rotates keys, locks sessions, validation, ads)
    lease = await accountPool.acquireSession(modelConfig.id, body.messages);
    const client = lease.client;
    const session = lease.session;

    // 2. Start freebuff run chain
    const run = await startFreebuffRunChain(client, modelConfig);

    // 3. Build upstream payload
    const traceSessionId = crypto.randomUUID();
    const payload = buildUpstreamPayload({
      body,
      instanceId: session.instance_id,
      runId: run.chat_run_id || run.run_id,
      clientId: c.env.CLIENT_ID || "freebuff-cli-worker",
      traceSessionId,
    });

    if (body.stream === true) {
      const responseStream = await client.chatEventsStream(payload);
      
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      
      const activeLease = lease;
      c.executionCtx.waitUntil(
        (async () => {
          let messageId: string | null = null;
          const reader = responseStream.body!.getReader();
          const encoder = new TextEncoder();
          try {
            for await (const line of getLines(reader)) {
              const data = decodeSseData(line);
              if (data === null) continue;
              if (data === "[DONE]") {
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                break;
              }
              if (data.id) {
                messageId = data.id;
              }
              const chunk = sanitizeStreamChunk(data);
              if (chunk !== null) {
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            }
          } catch (err: any) {
            console.error("[Worker] Error in stream forwarding", err);
            const errChunk = {
              error: {
                message: err.message || String(err),
                type: "upstream_error",
                code: "codebuff_error",
              }
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
          } finally {
            await writer.close();
            // Finalize run and release token lease in background
            await finalizeRun(client, run, messageId);
            await activeLease.release();
          }
        })()
      );

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
        },
      });
    } else {
      const responseStream = await client.chatEventsStream(payload);
      const reader = responseStream.body!.getReader();
      const accumulator = new CompletionAccumulator(modelConfig.id);
      let messageId: string | null = null;

      try {
        for await (const line of getLines(reader)) {
          const data = decodeSseData(line);
          if (data === null) continue;
          if (data === "[DONE]") break;
          if (data.id) {
            messageId = data.id;
          }
          accumulator.add(data);
        }
        const finalObj = accumulator.finalResponse();
        return c.json(finalObj);
      } finally {
        const activeLease = lease;
        c.executionCtx.waitUntil((async () => {
          await finalizeRun(client, run, messageId);
          await activeLease.release();
        })());
      }
    }
  } catch (err: any) {
    console.error("[Worker] Request failed", err);
    if (lease) {
      await lease.release();
    }
    return c.json({
      error: {
        message: err.message || String(err),
        type: "upstream_error",
        code: "codebuff_error",
      }
    }, err.status_code || 502);
  }
});

async function startFreebuffRunChain(client: CodebuffClient, model: any): Promise<FreebuffRun> {
  if (model.parent_agent_id) {
    return startChildChatRunChain(client, model);
  }

  const agent_id = model.agent_id;
  const started_at = utcNowIso();
  const run_id = await client.startRun(agent_id);
  const child_started_at = utcNowIso();
  const child_run_id = await client.startRun(
    "context-pruner",
    [run_id]
  );
  await client.recordRunStep(child_run_id, {
    stepNumber: 1,
    startTime: child_started_at,
  });
  await client.finishRun(child_run_id, 2);
  await client.recordRunStep(run_id, {
    stepNumber: 1,
    childRunIds: [child_run_id],
    startTime: started_at,
  });
  return {
    run_id,
    agent_id,
    started_at,
    child_run_id,
  };
}

async function startChildChatRunChain(client: CodebuffClient, model: any): Promise<FreebuffRun> {
  const started_at = utcNowIso();
  const parent_run_id = await client.startRun(model.parent_agent_id);
  const chat_started_at = utcNowIso();
  const chat_run_id = await client.startRun(
    model.agent_id,
    [parent_run_id]
  );
  return {
    run_id: parent_run_id,
    agent_id: model.parent_agent_id,
    started_at,
    child_run_id: chat_run_id,
    chat_run_id,
    chat_started_at,
  };
}

async function finalizeRun(client: CodebuffClient, run: FreebuffRun, messageId: string | null): Promise<void> {
  try {
    console.log(`[Codebuff] Finalizing run ID=${run.run_id} MsgID=${messageId}`);
    if (run.chat_run_id && run.chat_run_id !== run.run_id) {
      await client.recordRunStep(run.chat_run_id, {
        stepNumber: 1,
        messageId,
        startTime: run.chat_started_at || run.started_at,
      });
      await client.finishRun(run.chat_run_id, 2);
      await client.recordRunStep(run.run_id, {
        stepNumber: 1,
        childRunIds: [run.chat_run_id],
        startTime: run.started_at,
      });
      await client.finishRun(run.run_id, 2);
      console.log(`[Codebuff] Finalized parent/child run done run_id=${run.run_id}`);
      return;
    }

    await client.recordRunStep(run.run_id, {
      stepNumber: 2,
      messageId,
      startTime: run.started_at,
    });
    await client.finishRun(run.run_id, 3);
    console.log(`[Codebuff] Finalized run done run_id=${run.run_id}`);
  } catch (err) {
    console.warn(`[Codebuff] Finalize run failed run_id=${run.run_id}`, err);
  }
}

async function* getLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        yield line;
      }
    }
    if (buffer) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

function decodeSseData(line: string): any {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const dataVal = trimmed.slice(5).trim();
  if (dataVal === "[DONE]") return "[DONE]";
  try {
    return JSON.parse(dataVal);
  } catch {
    return null;
  }
}

export default app;
