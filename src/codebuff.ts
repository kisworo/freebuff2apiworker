export class CodebuffError extends Error {
  public status_code: number;
  constructor(message: string, status_code: number = 502) {
    super(message);
    this.name = "CodebuffError";
    this.status_code = status_code;
  }
}

/** Chat-only UA. Official CLI pins llm-providers 1.0.0 on model calls. */
export const CLI_CHAT_UA = "ai-sdk/openai-compatible/1.0.0/codebuff";
/** Session / agent-runs / probe: plain Bun fetch default (.bun-version 1.3.14). */
export const CLI_BUN_UA = "Bun/1.3.14";

/** SDK-faithful 13-char base36 client_id (Math.random().toString(36).substring(2,15)).
 *  One per run. Prefixed forms (sess:/run:/wf-) are fingerprintable as a proxy. */
export function generateClientID(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(13);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < 13; i++) id += alphabet[bytes[i] % 36];
  return id;
}

export interface FreebuffSession {
  instance_id: string;
  model: string;
  expires_at?: string;
  remaining_ms?: number;
}

export interface FreebuffRun {
  run_id: string;
  agent_id: string;
  started_at: string;
  child_run_id?: string;
  chat_run_id?: string;
  chat_started_at?: string;
}

export interface CodebuffEnv {
  FREEBUFF_TOKEN: string;
  CODEBUFF_API_URL: string;
  FREEBUFF_AD_PROVIDERS?: string;
  FREEBUFF_TIMEOUT?: string;
  FREEBUFF_DEBUG?: string;
  REQUEST_JITTER_MS?: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;
  private generation = 0;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  tryAcquire(): boolean {
    if (!this.locked) {
      this.locked = true;
      return true;
    }
    return false;
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    } else {
      this.locked = false;
    }
  }

  /** Hard-reset a stuck lock so a hung acquire/warm cannot permanently brick an account. */
  forceReset(): void {
    this.generation += 1;
    this.queue = [];
    this.locked = false;
  }

  getGeneration(): number {
    return this.generation;
  }
}

export class CodebuffClient {
  private env: CodebuffEnv;
  private api_url: string;
  private token: string;
  private user_agent: string;
  private ad_providers: string[];

  constructor(env: CodebuffEnv, token: string) {
    this.env = env;
    this.api_url = env.CODEBUFF_API_URL || "https://www.codebuff.com";
    this.token = token;
    this.user_agent = CLI_BUN_UA;
    // Never fire /api/v1/ads from a Worker/datacenter IP. Freebuff funds free
    // inference with ads that only first-party clients render; automated ads
    // from CF/VPS IPs is the pattern that produces 403 {"status":"banned"}.
    if (env.FREEBUFF_AD_PROVIDERS) {
      console.warn("[Codebuff] FREEBUFF_AD_PROVIDERS is set but ignored — ads from a proxy IP get accounts banned");
    }
    this.ad_providers = [];

    if (!this.token) {
      throw new CodebuffError("FREEBUFF_TOKEN environment variable is required", 500);
    }
  }

  public getTokenPrefix(): string {
    return this.token ? `${this.token.substring(0, 8)}...` : "none";
  }


  private getHeaders({
    jsonBody = false,
    requireAuth = true,
    userAgentOverride,
    extra = {},
  }: {
    jsonBody?: boolean;
    requireAuth?: boolean;
    userAgentOverride?: string;
    extra?: Record<string, string>;
  } = {}): Record<string, string> {
    // CLI-faithful: bun fetch on session/runs does not set Host / Connection /
    // Accept-Encoding. Forcing those is a proxy fingerprint.
    const headers: Record<string, string> = {
      Accept: "*/*",
      "User-Agent": userAgentOverride || this.user_agent,
    };
    if (requireAuth) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (jsonBody) {
      headers["Content-Type"] = "application/json";
    }
    return { ...headers, ...extra };
  }

  private async request(
    method: string,
    path: string,
    {
      body,
      headers,
      requireAuth = true,
      userAgentOverride,
    }: {
      body?: any;
      headers?: Record<string, string>;
      requireAuth?: boolean;
      userAgentOverride?: string;
    } = {}
  ): Promise<any> {
    const url = `${this.api_url}${path}`;
    const reqHeaders = headers || this.getHeaders({
      jsonBody: !!body,
      requireAuth,
      userAgentOverride,
    });

    if (this.env.FREEBUFF_DEBUG === "true") {
      console.log(`[Upstream Request] ${method} ${url}`, {
        headers: { ...reqHeaders, Authorization: reqHeaders.Authorization ? "Bearer [REDACTED]" : undefined },
        body,
      });
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const response = await fetch(url, {
        method,
        headers: reqHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (this.env.FREEBUFF_DEBUG === "true") {
        console.log(`[Upstream Response] status=${response.status}`);
      }

      if (response.status >= 400) {
        const text = await response.text();
        let errorMsg = `Upstream error (${response.status}): ${text}`;
        try {
          const errObj = JSON.parse(text);
          if (errObj.error?.message) {
            errorMsg = errObj.error.message;
          } else if (errObj.message) {
            errorMsg = errObj.message;
          } else if (typeof errObj.error === "string") {
            errorMsg = errObj.error;
          }
          if (errObj.status === "banned" || /banned/i.test(text)) {
            throw new CodebuffError("Upstream account banned", 403);
          }
          if (response.status === 428 || errorMsg.includes("waiting_room")) {
            throw new CodebuffError(
              "Upstream waiting room required. Not walking the ads chain from a proxy IP (ban risk). Retry later.",
              503
            );
          }
        } catch (err) {
          if (err instanceof CodebuffError) throw err;
        }
        throw new CodebuffError(errorMsg, response.status);
      }

      const text = await response.text();
      if (!text) return {};
      return JSON.parse(text);
    } catch (err: any) {
      if (err instanceof CodebuffError) throw err;
      throw new CodebuffError(`Connection error: ${err.message || err}`, 502);
    }
  }

  public async getSession(instanceId?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (instanceId) {
      headers["x-freebuff-instance-id"] = instanceId;
    }
    return this.request("GET", "/api/v1/freebuff/session", {
      headers: this.getHeaders({ extra: headers }),
    });
  }

  public async createSession(model: string): Promise<FreebuffSession> {
    // CLI session POST is bodyless: Authorization + x-freebuff-model only.
    // A JSON body / Content-Type here is a proxy fingerprint.
    const response = await this.request("POST", "/api/v1/freebuff/session", {
      headers: this.getHeaders({ extra: { "x-freebuff-model": model } }),
    });

    if (response.status === "queued") {
      return this.waitForActiveSession(response, model);
    }
    return this.sessionFromData(response, model);
  }

  private sessionFromData(data: any, model: string, instanceId?: string): FreebuffSession {
    const resolvedInstanceId = data.instanceId || instanceId;
    if (data.status !== "active" || !resolvedInstanceId) {
      throw new CodebuffError(`Freebuff session is not active: ${JSON.stringify(data)}`, 502);
    }
    return {
      instance_id: resolvedInstanceId,
      model: data.model || model,
      expires_at: data.expiresAt,
      remaining_ms: data.remainingMs,
    };
  }

  private async waitForActiveSession(data: any, model: string): Promise<FreebuffSession> {
    const instanceId = data.instanceId;
    if (!instanceId) {
      throw new CodebuffError(`Freebuff queued session ID missing: ${JSON.stringify(data)}`, 502);
    }

    const timeout = parseInt(this.env.FREEBUFF_TIMEOUT || "60", 10) * 1000;
    const deadline = Date.now() + timeout;
    let attempts = 0;
    let currentData = data;

    while (currentData.status === "queued") {
      console.log(`[Codebuff] Freebuff session queued. Position: ${currentData.position}. Estimated wait: ${currentData.estimatedWaitMs}ms`);

      if (Date.now() >= deadline) {
        throw new CodebuffError(`Freebuff session did not become active before timeout: ${JSON.stringify(currentData)}`, 502);
      }

      if (attempts > 0) {
        const pollDelay = this.queuePollDelay(currentData.estimatedWaitMs);
        await delay(pollDelay);
      }

      currentData = await this.getSession(instanceId);
      attempts++;
    }

    return this.sessionFromData(currentData, model, instanceId);
  }

  private queuePollDelay(estimatedWaitMs?: any): number {
    if (!estimatedWaitMs) return 2000;
    const waitMs = parseInt(estimatedWaitMs, 10);
    return Math.max(1000, Math.min(waitMs, 5000));
  }

  public async deleteSession(instanceId?: string): Promise<void> {
    const extra: Record<string, string> = {};
    if (instanceId) extra["x-freebuff-instance-id"] = instanceId;
    await this.request("DELETE", "/api/v1/freebuff/session", {
      headers: this.getHeaders({ extra }),
    });
    console.log(`[Codebuff] Active session deleted instance_id=${instanceId || "none"}`);
  }

  public async requestAdChain(_messages?: any[]): Promise<void> {
    return;
  }

  // Run management
  public async startRun(agentId: string, ancestorRunIds?: string[]): Promise<string> {
    const body = {
      action: "START",
      agentId,
      ancestorRunIds: ancestorRunIds || [],
    };
    const data = await this.request("POST", "/api/v1/agent-runs", {
      body,
      headers: this.getHeaders({
        jsonBody: true,
        extra: { "x-codebuff-api-key": this.token },
      }),
    });
    if (!data.runId) {
      throw new CodebuffError(`Failed to start run, no runId returned: ${JSON.stringify(data)}`, 502);
    }
    return data.runId;
  }

  public async finishRun(
    runId: string,
    {
      status = "completed",
      totalSteps = 1,
      startedAt,
      messageId = null,
      errorMessage,
    }: {
      status?: string;
      totalSteps?: number;
      startedAt: string;
      messageId?: string | null;
      errorMessage?: string;
    }
  ): Promise<void> {
    // CLI has no /steps endpoint — completed steps ride on FINISH.
    const payload: any = {
      action: "FINISH",
      runId,
      status,
      totalSteps,
      directCredits: 0,
      totalCredits: 0,
      steps: [
        {
          id: crypto.randomUUID(),
          stepNumber: 1,
          credits: 0,
          childRunIds: [],
          messageId,
          status: status === "completed" ? "completed" : "failed",
          startTime: startedAt,
        },
      ],
    };
    if (errorMessage) {
      payload.errorMessage = errorMessage.slice(0, 5000);
    }
    await this.request("POST", "/api/v1/agent-runs", {
      body: payload,
      headers: this.getHeaders({
        jsonBody: true,
        extra: { "x-codebuff-api-key": this.token },
      }),
    });
  }

  public async chatEventsStream(payload: any): Promise<Response> {
    const jitterMs = parseInt(this.env.REQUEST_JITTER_MS || "200", 10);
    if (jitterMs > 0) {
      await delay(Math.floor(Math.random() * jitterMs));
    }

    const url = `${this.api_url}/api/v1/chat/completions`;
    const reqHeaders = this.getHeaders({
      jsonBody: true,
      userAgentOverride: CLI_CHAT_UA,
      extra: { Accept: "application/json, text/event-stream" },
    });

    if (this.env.FREEBUFF_DEBUG === "true") {
      console.log("[Upstream Stream Request]", {
        url,
        headers: { ...reqHeaders, Authorization: reqHeaders.Authorization ? "Bearer [REDACTED]" : undefined },
        body: payload,
      });
    }

    const streamController = new AbortController();
    const streamTimeoutId = setTimeout(() => streamController.abort(), 60000);
    const response = await fetch(url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(payload),
      signal: streamController.signal,
    });
    clearTimeout(streamTimeoutId);

    if (response.status >= 400) {
      const text = await response.text();
      throw new CodebuffError(`Upstream stream error (${response.status}): ${text}`, response.status);
    }

    return response;
  }
}

export class SessionManager {
  private client: CodebuffClient;
  private sessions = new Map<string, FreebuffSession>();
  private lock = new Mutex();
  private warmingModels = new Set<string>();

  constructor(client: CodebuffClient) {
    this.client = client;
  }

  /** Clear cache + mutex so a hung session path cannot keep the account unusable. */
  public forceReset(reason = "manual"): void {
    console.warn(`[Codebuff] Force-resetting session manager (${reason}) token=${this.client.getTokenPrefix()}`);
    this.sessions.clear();
    this.warmingModels.clear();
    this.lock.forceReset();
  }

  async acquireSession(model: string, messages?: any[]): Promise<{ session: FreebuffSession; release: () => void }> {
    await this.lock.acquire();
    const genAtHold = this.lock.getGeneration();
    try {
      const session = await this.ensureSessionLocked(model, messages);
      return {
        session,
        release: () => {
          // Ignore stale holders after a force-reset.
          if (this.lock.getGeneration() === genAtHold) {
            this.lock.release();
          }
        }
      };
    } catch (err) {
      if (this.lock.getGeneration() === genAtHold) {
        this.lock.release();
      }
      throw err;
    }
  }

  private async ensureSessionLocked(model: string, messages?: any[]): Promise<FreebuffSession> {
    const cached = this.sessions.get(model);
    if (cached && this.isSessionFresh(cached)) {
      try {
        const data = await this.client.getSession(cached.instance_id);
        if (data.status === "active" && (data.model === undefined || data.model === null || data.model === model)) {
          cached.remaining_ms = data.remainingMs;
          console.log(`[Codebuff] Reuse session model=${model} instance_id=${cached.instance_id} remaining_ms=${cached.remaining_ms}`);
          return cached;
        }
        if (data.status === "active") {
          console.log(`[Codebuff] Cached session model mismatch cached=${model} upstream=${data.model}`);
          this.sessions.delete(model);
        }
      } catch (err) {
        console.log(`[Codebuff] Cached session invalid model=${model} instance_id=${cached.instance_id}`);
        this.sessions.delete(model);
      }
    }

    const activeSession = await this.deleteLockedSession(model);
    if (activeSession) {
      return activeSession;
    }

    try {
      const session = await this.rejectIfSubstituted(model, await this.client.createSession(model));
      this.sessions.set(model, session);
      console.log(`[Codebuff] Created session model=${model} instance_id=${session.instance_id} remaining_ms=${session.remaining_ms}`);
      return session;
    } catch (err: any) {
      if (!String(err).includes("model_locked")) {
        throw err;
      }
      console.log(`[Codebuff] Session locked during create; delete and retry model=${model}`);
      const locked = this.sessions.get(model);
      await this.client.deleteSession(locked?.instance_id);
      this.sessions.clear();
      await delay(500);
      const session = await this.rejectIfSubstituted(model, await this.client.createSession(model));
      this.sessions.set(model, session);
      return session;
    }
  }

  /** Limited-tier accounts get silently swapped to flash/mimo. Never chat on the substitute. */
  private async rejectIfSubstituted(requested: string, session: FreebuffSession): Promise<FreebuffSession> {
    if (session.model && session.model !== requested) {
      console.warn(`[Codebuff] Session substituted requested=${requested} admitted=${session.model} — deleting`);
      await this.client.deleteSession(session.instance_id);
      this.sessions.clear();
      throw new CodebuffError(
        `Muse Spark 1.3 was not admitted. Upstream opened ${session.model} instead (this account is likely limited-tier or region-blocked).`,
        403
      );
    }
    return session;
  }

  private isSessionFresh(session: FreebuffSession): boolean {
    return session.remaining_ms === undefined || session.remaining_ms > 10000;
  }

  public async warmSession(model: string): Promise<void> {
    if (this.warmingModels.has(model)) return;

    if (!this.lock.tryAcquire()) return;
    const genAtHold = this.lock.getGeneration();

    try {
      this.warmingModels.add(model);

      const cached = this.sessions.get(model);
      if (cached && this.isSessionFresh(cached)) {
        try {
          const data = await this.client.getSession(cached.instance_id);
          if (data.status === "active") {
            cached.remaining_ms = data.remainingMs;
            console.log(`[Codebuff] Warmed session (still active) model=${model} remaining_ms=${cached.remaining_ms}`);
            return;
          }
        } catch {
          this.sessions.delete(model);
        }
      }

      try {
        const session = await this.client.createSession(model);
        this.sessions.set(model, session);
        console.log(`[Codebuff] Warmed session (created) model=${model} remaining_ms=${session.remaining_ms}`);
      } catch (err: any) {
        if (String(err).includes("model_locked")) {
          console.log(`[Codebuff] Warm session locked; delete and retry model=${model}`);
          const locked = this.sessions.get(model);
          await this.client.deleteSession(locked?.instance_id);
          this.sessions.clear();
          await delay(500);
          const session = await this.client.createSession(model);
          this.sessions.set(model, session);
          console.log(`[Codebuff] Warmed session (retry after lock) model=${model} remaining_ms=${session.remaining_ms}`);
        } else {
          console.warn(`[Codebuff] Session warm failed model=${model}`, err);
        }
      }
    } catch (err) {
      console.warn(`[Codebuff] Session warm failed model=${model}`, err);
    } finally {
      this.warmingModels.delete(model);
      if (this.lock.getGeneration() === genAtHold) {
        this.lock.release();
      }
    }
  }

  private async deleteLockedSession(requestedModel: string): Promise<FreebuffSession | null> {
    try {
      const data = await this.client.getSession();
      if (data.status !== "active") {
        return null;
      }
      const currentModel = data.model;
      const instanceId = data.instanceId;
      if (currentModel === requestedModel && instanceId) {
        const session: FreebuffSession = {
          instance_id: instanceId,
          model: currentModel,
          expires_at: data.expiresAt,
          remaining_ms: data.remainingMs,
        };
        this.sessions.set(requestedModel, session);
        console.log(`[Codebuff] Discovered active session model=${requestedModel} instance_id=${instanceId}`);
        return session;
      }

      if (!currentModel || currentModel === requestedModel) {
        return null;
      }

      console.log(`[Codebuff] Switch session current_model=${currentModel} requested_model=${requestedModel} instance_id=${instanceId}`);
      await this.client.deleteSession(instanceId);
      this.sessions.clear();
      return null;
    } catch (err) {
      return null;
    }
  }
}

export interface CodebuffAccount {
  client: CodebuffClient;
  sessions: SessionManager;
  busy: boolean;
  banned?: boolean;
}

export interface CodebuffAccountLease {
  client: CodebuffClient;
  session: FreebuffSession;
  release: () => Promise<void>;
}

// Lease watchdog: if a leased account never finishes, force-reset its session
// manager so the token cannot stay permanently stuck. 5min is generous enough
// for long complex prompts (2-5min generation) while still auto-recovering
// genuinely stuck/hung leases (see forceRecoverAccount).
const LEASE_TIMEOUT_MS = 300000;
// Fail-fast when all tokens for a model are busy. Prefer clear 429 over long hang.
const QUEUE_TIMEOUT_MS = 8000;
// Bound the session acquire path itself so a hung getSession/createSession cannot
// hold the account forever while the outer request waits for CHAT_FAIL_FAST.
const SESSION_ACQUIRE_TIMEOUT_MS = 25000;

type QueueWaiter = {
  resolve: (idx: number) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodebuffAccountPool {
  private accounts: CodebuffAccount[] = [];
  private nextIndex = 0;
  private waitingQueue: QueueWaiter[] = [];
  private modelToAccounts = new Map<string, number[]>();
  private nextModelPoolIndex = new Map<string, number>();
  private modelPoolQueues = new Map<string, QueueWaiter[]>();
  private leaseTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(env: CodebuffEnv) {
    const rawTokens = env.FREEBUFF_TOKEN || "";
    const tokens = rawTokens.split(",").map(t => t.trim()).filter(Boolean);
    const apiTokens = tokens.length > 0 ? tokens : ["invalid_placeholder"];

    for (const token of apiTokens) {
      const client = new CodebuffClient(env, token);
      this.accounts.push({
        client,
        sessions: new SessionManager(client),
        busy: false,
      });
    }

    // No per-model token partitions. Sticky farm-shaped pools (N tokens
    // dedicated to one model) look more like a reselling cluster than a CLI.
    // All accounts serve every model via global round-robin.
  }

  public get accountCount(): number {
    return this.accounts.length;
  }

  public async acquireSession(
    model: string,
    messages?: any[],
    routingKey?: string,
    signal?: AbortSignal
  ): Promise<CodebuffAccountLease> {
    if (signal?.aborted) {
      throw new CodebuffError("Session acquisition aborted", 504);
    }

    const maxAttempts = Math.min(5, this.accounts.length);
    let lastErr: any = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const modelPool = routingKey ? this.modelToAccounts.get(routingKey) : undefined;
      let accountIndex: number;

      if (modelPool && modelPool.length > 0) {
        accountIndex = await this.reserveFromModelPool(routingKey!, modelPool, signal);
      } else {
        accountIndex = await this.reserveAccount(model, signal);
      }

      const account = this.accounts[accountIndex];
      console.log(`[AccountPool] Leased account index=${accountIndex} (token=${account.client.getTokenPrefix()}) for model=${model} (attempt ${attempt + 1})`);

      const watchdogIdx = accountIndex;
      const timer = setTimeout(() => {
        console.warn(`[AccountPool] LEASE TIMEOUT after ${LEASE_TIMEOUT_MS}ms — auto-recovering account index=${watchdogIdx}`);
        this.leaseTimers.delete(watchdogIdx);
        this.forceRecoverAccount(watchdogIdx, `lease timeout after ${LEASE_TIMEOUT_MS}ms`);
      }, LEASE_TIMEOUT_MS);
      this.leaseTimers.set(accountIndex, timer);

      // Client abort (e.g. outer fail-fast timeout): recover the account
      // immediately instead of leaving a zombie lease busy until the watchdog
      // fires, which previously caused stuck accounts under load.
      let aborted = false;
      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        const t = this.leaseTimers.get(accountIndex);
        if (t) { clearTimeout(t); this.leaseTimers.delete(accountIndex); }
        this.forceRecoverAccount(accountIndex, "client abort");
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          throw new CodebuffError("Session acquisition aborted", 504);
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const { session, release: releaseSessionLock } = await this.withTimeout(
          account.sessions.acquireSession(model, messages),
          SESSION_ACQUIRE_TIMEOUT_MS,
          `Session acquire timeout after ${SESSION_ACQUIRE_TIMEOUT_MS / 1000}s for model=${model} account=${accountIndex}`
        );
        if (aborted) {
          // Caller gave up while the session was being created upstream; the
          // session lock is stale (forceReset bumped the mutex generation), so
          // just bail — the account was already recovered by onAbort.
          releaseSessionLock();
          throw new CodebuffError("Session acquisition aborted", 504);
        }
        let closed = false;
        return {
          client: account.client,
          session,
          release: async () => {
            if (closed) return;
            closed = true;
            signal?.removeEventListener("abort", onAbort);
            const t = this.leaseTimers.get(accountIndex);
            if (t) { clearTimeout(t); this.leaseTimers.delete(accountIndex); }
            releaseSessionLock();
            console.log(`[AccountPool] Released account index=${accountIndex} (token=${account.client.getTokenPrefix()})`);
            await this.releaseAccount(accountIndex);
          }
        };
      } catch (err: any) {
        signal?.removeEventListener("abort", onAbort);
        const t = this.leaseTimers.get(accountIndex);
        if (t) { clearTimeout(t); this.leaseTimers.delete(accountIndex); }

        const errStr = String(err);
        if (errStr.includes("banned") || (err && err.status_code === 403)) {
          console.warn(`[AccountPool] Account index=${accountIndex} (token=${account.client.getTokenPrefix()}) is BANNED. Marking banned.`);
          account.banned = true;
        }

        if (aborted) {
          // Already force-recovered on abort; don't double-release.
          throw err;
        }

        if (errStr.includes("Session acquire timeout")) {
          this.forceRecoverAccount(accountIndex, "session acquire timeout");
        } else {
          await this.releaseAccount(accountIndex);
        }

        lastErr = err;
        // If banned or session failed, continue loop to try another account
      }
    }

    throw lastErr || new CodebuffError(`Failed to acquire session after ${maxAttempts} attempts`, 502);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodebuffError(message, 504)), ms);
      promise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        err => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private forceRecoverAccount(index: number, reason: string): void {
    const account = this.accounts[index];
    if (!account) return;
    console.warn(`[AccountPool] Auto-recover account index=${index} token=${account.client.getTokenPrefix()} reason=${reason}`);
    try {
      account.sessions.forceReset(reason);
    } catch (err) {
      console.warn(`[AccountPool] forceReset failed account index=${index}`, err);
    }
    // Free the account for future waiters even if the original holder is still mid-flight.
    this.releaseAccount(index).catch(err => {
      console.warn(`[AccountPool] release after recover failed account index=${index}`, err);
    });
  }

  private async reserveAccount(model: string, signal?: AbortSignal): Promise<number> {
    const index = this.nextAvailableIndex();
    if (index !== null) {
      this.accounts[index].busy = true;
      this.nextIndex = (index + 1) % this.accounts.length;
      return index;
    }

    return this.enqueueWaiter(this.waitingQueue, model, "global", signal);
  }

  private reserveFromModelPool(model: string, pool: number[], signal?: AbortSignal): number | Promise<number> {
    const start = this.nextModelPoolIndex.get(model) || 0;
    for (let i = 0; i < pool.length; i++) {
      const poolOffset = (start + i) % pool.length;
      const idx = pool[poolOffset];
      if (!this.accounts[idx].busy && !this.accounts[idx].banned) {
        this.accounts[idx].busy = true;
        this.nextModelPoolIndex.set(model, (poolOffset + 1) % pool.length);
        return idx;
      }
    }

    // All accounts in this pool are busy — fail fast after QUEUE_TIMEOUT_MS.
    let queue = this.modelPoolQueues.get(model);
    if (!queue) {
      queue = [];
      this.modelPoolQueues.set(model, queue);
    }
    return this.enqueueWaiter(queue, model, "model-pool", signal);
  }

  private enqueueWaiter(queue: QueueWaiter[], model: string, scope: string, signal?: AbortSignal): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        const idx = queue.indexOf(waiter);
        if (idx >= 0) queue.splice(idx, 1);
        clearTimeout(waiter.timer);
        cleanup();
        reject(new CodebuffError("Session acquisition aborted", 504));
      };
      const waiter: QueueWaiter = {
        resolve: (idx: number) => {
          cleanup();
          resolve(idx);
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
        timer: setTimeout(() => {
          const idx = queue.indexOf(waiter);
          if (idx >= 0) queue.splice(idx, 1);
          cleanup();
          console.warn(`[AccountPool] QUEUE TIMEOUT after ${QUEUE_TIMEOUT_MS}ms model=${model} scope=${scope}`);
          reject(new CodebuffError(
            `Model account busy for ${model} — all tokens in use (queue timeout ${QUEUE_TIMEOUT_MS / 1000}s)`,
            429
          ));
        }, QUEUE_TIMEOUT_MS),
      };
      if (signal?.aborted) {
        reject(new CodebuffError("Session acquisition aborted", 504));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }

  private handOffToWaiter(waiter: QueueWaiter, index: number): void {
    clearTimeout(waiter.timer);
    waiter.resolve(index);
  }

  private async releaseAccount(index: number): Promise<void> {
    const nextWaiter = this.waitingQueue.shift();
    if (nextWaiter) {
      // Keep account marked busy; ownership transfers directly to the waiter.
      this.handOffToWaiter(nextWaiter, index);
      return;
    }

    // Check per-model pool queues — find a waiter for any model this account serves
    for (const [model, pool] of this.modelToAccounts) {
      if (pool.includes(index)) {
        const queue = this.modelPoolQueues.get(model);
        if (queue && queue.length > 0) {
          const waiter = queue.shift()!;
          if (queue.length === 0) this.modelPoolQueues.delete(model);
          this.handOffToWaiter(waiter, index);
          return;
        }
      }
    }

    this.accounts[index].busy = false;
    // Do not background-warm sessions. Each createSession is a Freebucks
    // charge (one session-hour). Warming unused models burns quota and
    // looks like farm traffic.
  }

  private nextAvailableIndex(): number | null {
    const count = this.accounts.length;
    for (let i = 0; i < count; i++) {
      const idx = (this.nextIndex + i) % count;
      if (!this.accounts[idx].busy && !this.accounts[idx].banned) {
        return idx;
      }
    }
    return null;
  }
}

export function utcNowIso(): string {
  return new Date().toISOString();
}
