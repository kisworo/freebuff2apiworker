import { agentValidationPayload } from "./models";

export class CodebuffError extends Error {
  public status_code: number;
  constructor(message: string, status_code: number = 502) {
    super(message);
    this.name = "CodebuffError";
    this.status_code = status_code;
  }
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
  FREEBUFF_TIMEZONE?: string;
  FREEBUFF_LOCALE?: string;
  FREEBUFF_OS?: string;
  FREEBUFF_BROWSER_UA?: string;
  CLIENT_ID: string;
  FREEBUFF_DEBUG?: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    } else {
      this.locked = false;
    }
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
    this.user_agent = env.FREEBUFF_BROWSER_UA || "Bun/1.3.11";
    this.ad_providers = (env.FREEBUFF_AD_PROVIDERS || "gravity,zeroclick")
      .split(",")
      .map(p => p.trim())
      .filter(Boolean);

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
    let hostVal = "www.codebuff.com";
    try {
      hostVal = new URL(this.api_url).host;
    } catch {}
    const headers: Record<string, string> = {
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate",
      Connection: "keep-alive",
      Host: hostVal,
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
      const response = await fetch(url, {
        method,
        headers: reqHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });

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
          }
        } catch {}
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

  public async validateAgents(): Promise<void> {
    try {
      await this.request("POST", "/api/agents/validate", {
        body: agentValidationPayload(),
        requireAuth: false,
      });
      console.log("[Codebuff] Agent validation completed");
    } catch (err) {
      console.warn("[Codebuff] Agent validation failed; continuing anyway", err);
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

  public async deleteSession(): Promise<void> {
    await this.request("DELETE", "/api/v1/freebuff/session");
    console.log("[Codebuff] Active session deleted");
  }

  public async requestAds(
    provider: string,
    messages?: any[]
  ): Promise<any> {
    const body = {
      provider,
      messages: this.adMessages(messages),
      sessionId: crypto.randomUUID(),
      device: {
        os: this.env.FREEBUFF_OS || "windows",
        timezone: this.env.FREEBUFF_TIMEZONE || "Asia/Shanghai",
        locale: this.env.FREEBUFF_LOCALE || "zh-CN",
      },
      userAgent: this.user_agent,
    };

    return this.request("POST", "/api/v1/ads", {
      body,
      userAgentOverride: "Freebuff-CLI/0.0.95",
    });
  }

  public async requestAdChain(messages?: any[]): Promise<void> {
    for (const provider of this.ad_providers) {
      try {
        const adsData = await this.requestAds(provider, messages);
        const ads = adsData.ads || [];
        const ad = ads[0] || null;
        console.log(`[Codebuff] Ads provider=${provider} count=${ads.length} selected=${ad ? "yes" : "no"}`);
      } catch (err) {
        console.warn(`[Codebuff] Ads request failed for provider=${provider}`, err);
      }
    }
  }

  private adMessages(messages?: any[]): any[] {
    if (!messages || messages.length === 0) {
      return [{ role: "user", content: "ping" }];
    }
    return messages.slice(-3);
  }

  // Run management
  public async startRun(agentId: string, ancestorRunIds?: string[]): Promise<string> {
    const body = {
      action: "START",
      agentId,
      ancestorRunIds: ancestorRunIds || [],
    };
    const data = await this.request("POST", "/api/v1/agent-runs", { body });
    if (!data.runId) {
      throw new CodebuffError(`Failed to start run, no runId returned: ${JSON.stringify(data)}`, 502);
    }
    return data.runId;
  }

  public async recordRunStep(
    runId: string,
    {
      stepNumber,
      childRunIds = [],
      messageId = null,
      startTime,
    }: {
      stepNumber: number;
      childRunIds?: string[];
      messageId?: string | null;
      startTime: string;
    }
  ): Promise<void> {
    const body = {
      stepNumber,
      credits: 0,
      childRunIds,
      messageId,
      status: "completed",
      startTime,
    };
    await this.request("POST", `/api/v1/agent-runs/${runId}/steps`, { body });
  }

  public async finishRun(runId: string, totalSteps: number): Promise<void> {
    const body = {
      action: "FINISH",
      runId,
      status: "completed",
      totalSteps,
      directCredits: 0,
      totalCredits: 0,
    };
    await this.request("POST", "/api/v1/agent-runs", { body });
  }

  public async chatEventsStream(payload: any): Promise<Response> {
    const url = `${this.api_url}/api/v1/chat/completions`;
    const reqHeaders = this.getHeaders({
      jsonBody: true,
      userAgentOverride: "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.20 runtime/browser",
    });

    if (this.env.FREEBUFF_DEBUG === "true") {
      console.log("[Upstream Stream Request]", {
        url,
        headers: { ...reqHeaders, Authorization: reqHeaders.Authorization ? "Bearer [REDACTED]" : undefined },
        body: payload,
      });
    }

    const response = await fetch(url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(payload),
    });

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

  constructor(client: CodebuffClient) {
    this.client = client;
  }

  async acquireSession(model: string, messages?: any[]): Promise<{ session: FreebuffSession; release: () => void }> {
    await this.lock.acquire();
    try {
      const session = await this.ensureSessionLocked(model, messages);
      return {
        session,
        release: () => this.lock.release()
      };
    } catch (err) {
      this.lock.release();
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

    await this.client.requestAdChain(messages);

    try {
      const session = await this.client.createSession(model);
      this.sessions.set(model, session);
      console.log(`[Codebuff] Created session model=${model} instance_id=${session.instance_id} remaining_ms=${session.remaining_ms}`);
      return session;
    } catch (err: any) {
      if (!String(err).includes("model_locked")) {
        throw err;
      }
      console.log(`[Codebuff] Session locked during create; delete and retry model=${model}`);
      await this.client.deleteSession();
      this.sessions.clear();
      await this.client.requestAdChain(messages);
      const session = await this.client.createSession(model);
      this.sessions.set(model, session);
      return session;
    }
  }

  private isSessionFresh(session: FreebuffSession): boolean {
    return session.remaining_ms === undefined || session.remaining_ms > 60000;
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
      await this.client.deleteSession();
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
}

export interface CodebuffAccountLease {
  client: CodebuffClient;
  session: FreebuffSession;
  release: () => Promise<void>;
}

export class CodebuffAccountPool {
  private accounts: CodebuffAccount[] = [];
  private nextIndex = 0;
  private waitingQueue: ((idx: number) => void)[] = [];

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
  }

  public get accountCount(): number {
    return this.accounts.length;
  }

  public async acquireSession(model: string, messages?: any[]): Promise<CodebuffAccountLease> {
    const accountIndex = await this.reserveAccount();
    const account = this.accounts[accountIndex];
    console.log(`[AccountPool] Leased account index=${accountIndex} (token=${account.client.getTokenPrefix()}) for model=${model}`);
    try {
      const { session, release: releaseSessionLock } = await account.sessions.acquireSession(model, messages);
      let closed = false;
      return {
        client: account.client,
        session,
        release: async () => {
          if (closed) return;
          closed = true;
          releaseSessionLock();
          console.log(`[AccountPool] Released account index=${accountIndex} (token=${account.client.getTokenPrefix()})`);
          await this.releaseAccount(accountIndex);
        }
      };
    } catch (err) {
      await this.releaseAccount(accountIndex);
      throw err;
    }
  }

  private async reserveAccount(): Promise<number> {
    const index = this.nextAvailableIndex();
    if (index !== null) {
      this.accounts[index].busy = true;
      this.nextIndex = (index + 1) % this.accounts.length;
      return index;
    }

    return new Promise<number>(resolve => {
      this.waitingQueue.push(resolve);
    });
  }

  private async releaseAccount(index: number): Promise<void> {
    const nextWaiter = this.waitingQueue.shift();
    if (nextWaiter) {
      nextWaiter(index);
    } else {
      this.accounts[index].busy = false;
    }
  }

  private nextAvailableIndex(): number | null {
    const count = this.accounts.length;
    for (let i = 0; i < count; i++) {
      const idx = (this.nextIndex + i) % count;
      if (!this.accounts[idx].busy) {
        return idx;
      }
    }
    return null;
  }
}

export function utcNowIso(): string {
  return new Date().toISOString();
}
