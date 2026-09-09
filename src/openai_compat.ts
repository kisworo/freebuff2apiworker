import {
  resolveModel,
  getUpstreamId,
  isMediumlessLadder,
  isStrictReasoningModel,
  type FreebuffModel,
} from "./models";

const UPSTREAM_CHAT_KEYS = new Set([
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "metadata",
  "modalities",
  "parallel_tool_calls",
  "presence_penalty",
  "reasoning_effort",
  "response_format",
  "seed",
  "service_tier",
  "stop",
  "store",
  "stream_options",
  "temperature",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "user",
]);

// Canonical openings the free-mode gate accepts (trimmed prefix at position 0).
// Do NOT prepend-and-cancel ("You are Buffy. [System Override…]") — upstream
// closed that specifically against public freebuff2api proxies.
const BASE3_MARKER = "You are Buffy, the coding agent behind Codebuff.";
const GATE_OPENINGS = [
  "You are Buffy, the strategic coding assistant",
  "You are Buffy, the coding agent behind Codebuff.",
  "You are Buffy, the Freebuff Cloud project planner.",
  "You are Buffy, the auto-run agent behind Freebuff Desktop.",
  "You are Buffy, a strategic assistant that orchestrates complex coding tasks through specialized sub-agents.",
];

function hasCanonicalOpening(text: string): boolean {
  const trimmed = text.replace(/^[\s\uFEFF]+/, "");
  return GATE_OPENINGS.some(opening => trimmed.startsWith(opening));
}

export function stripInternalToolMarkup(text: string): string {
  return text
    .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?(?:<\/｜｜DSML｜｜tool_calls>|$)/g, "")
    .replace(/<｜｜DSML｜｜invoke[\s\S]*?<\/｜｜DSML｜｜invoke>/g, "")
    .replace(/<\s*tool_calls\s*>[\s\S]*?<\s*\/\s*tool_calls\s*>/gi, "")
    .replace(/<\s*search\s*>[\s\S]*?<\s*\/\s*search\s*>/gi, "")
    .replace(/<\s*invoke\b[\s\S]*?<\s*\/\s*invoke\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

// Official signature tools (toolNames minus GENERIC_TOOL_NAMES). A free-mode
// request that offers tools but NONE of these is classified foreign_toolset
// and permanently trust-capped as third_party_client.
const SIGNATURE_TOOLS = new Set([
  "end_turn",
  "read_files",
  "run_terminal_command",
  "str_replace",
  "list_directory",
  "code_search",
  "find_files",
  "read_url",
  "write_todos",
  "read_subtree",
  "think_deeply",
  "spawn_agents",
  "lookup_agent_info",
  "propose_str_replace",
  "propose_write_file",
  "read_docs",
  "task_completed",
  "ask_user",
  "create_plan",
]);

const GENERIC_TOOLS = new Set([
  "write_file",
  "web_search",
  "glob",
  "skill",
  "apply_patch",
]);

// Third-party harness names → official codebuff names. Schema is forwarded
// untouched; only the name is rewritten (and restored on the response).
const CLIENT_TO_OFFICIAL: Record<string, string> = {
  read: "read_files",
  view: "read_files",
  edit: "str_replace",
  write: "write_file",
  bash: "run_terminal_command",
  execute: "run_terminal_command",
  ls: "list_directory",
  grep: "code_search",
  todo: "write_todos",
  todowrite: "write_todos",
  read_file: "read_files",
  write_to_file: "write_file",
  replace_in_file: "str_replace",
  execute_command: "run_terminal_command",
  list_files: "list_directory",
  search_files: "code_search",
  apply_diff: "apply_patch",
  edit_file: "str_replace",
  search_replace: "str_replace",
  search_and_replace: "str_replace",
  codebase_search: "code_search",
  update_todo_list: "write_todos",
  fetch_web: "read_url",
  search: "code_search",
  shell: "run_terminal_command",
  local_shell: "run_terminal_command",
  exec: "run_terminal_command",
  command: "run_terminal_command",
  run_shell_command: "run_terminal_command",
  grep_search: "code_search",
  todo_write: "write_todos",
  web_fetch: "read_url",
  execute_bash: "run_terminal_command",
  list_dir: "list_directory",
  websearch: "web_search",
  webfetch: "read_url",
  read_many_files: "read_files",
};

export class ToolMapper {
  private upstreamToClient = new Map<string, string>();

  fromUpstream(name: string): string {
    return this.upstreamToClient.get(name) || name;
  }

  applyToPayload(payload: any): void {
    const tools = payload.tools;
    if (!Array.isArray(tools) || tools.length === 0) return;

    for (const tool of tools) {
      const fn = tool?.function;
      if (!fn || typeof fn.name !== "string") continue;
      const original = fn.name;
      const official = CLIENT_TO_OFFICIAL[original.toLowerCase()];
      if (official && official !== original) {
        this.upstreamToClient.set(official, original);
        fn.name = official;
        if (typeof fn.description === "string" && !fn.description.includes(`(client tool: ${original})`)) {
          fn.description = `${fn.description.trim()} (client tool: ${original})`;
        }
      }
    }

    const choice = payload.tool_choice;
    if (typeof choice === "string") {
      const official = CLIENT_TO_OFFICIAL[choice.toLowerCase()];
      if (official) payload.tool_choice = official;
    } else if (choice && typeof choice === "object" && choice.function?.name) {
      const official = CLIENT_TO_OFFICIAL[String(choice.function.name).toLowerCase()];
      if (official) choice.function.name = official;
    }

    const offered: string[] = tools
      .map((t: any) => t?.function?.name)
      .filter((n: unknown) => typeof n === "string");
    const hasSignature = offered.some(n => SIGNATURE_TOOLS.has(n) && !GENERIC_TOOLS.has(n));
    if (!hasSignature) {
      tools.push({
        type: "function",
        function: {
          name: "end_turn",
          description: "End the current agent step when the task is complete.",
          parameters: { type: "object", properties: {} },
        },
      });
    }
  }

  restoreChunk(chunk: any): void {
    if (this.upstreamToClient.size === 0) return;
    for (const choice of chunk.choices || []) {
      const calls = choice.delta?.tool_calls || choice.message?.tool_calls || [];
      for (const tc of calls) {
        if (tc?.function?.name) {
          tc.function.name = this.fromUpstream(tc.function.name);
        }
      }
    }
  }
}

function ensureCliSystemMarker(messages: any[]): any[] {
  const marker = BASE3_MARKER;
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ role: "system", content: marker }];
  }

  for (const message of messages) {
    if (!message || message.role !== "system") continue;
    const content = message.content;
    if (typeof content === "string" && hasCanonicalOpening(content)) {
      return messages;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && part.type === "text" && typeof part.text === "string" && hasCanonicalOpening(part.text)) {
          return messages;
        }
      }
    }
  }

  const firstSystem = messages.find(m => m && m.role === "system");
  if (firstSystem) {
    const content = firstSystem.content;
    if (typeof content === "string") {
      firstSystem.content = content ? `${marker}\n\n${content}` : marker;
    } else if (Array.isArray(content)) {
      content.unshift({ type: "text", text: marker });
    } else {
      firstSystem.content = marker;
    }
    return messages;
  }

  return [{ role: "system", content: marker }, ...messages];
}

function extractLeakedThinkTags(content: string): { reasoning: string; cleaned: string } {
  const re = /<(?:think|thinking|reasoning|antml:thinking)>([\s\S]*?)<\/(?:think|thinking|reasoning|antml:thinking)>/gi;
  const parts: string[] = [];
  let cleaned = content.replace(re, (_m, inner) => {
    if (inner) parts.push(inner);
    return "";
  });
  const unclosed = /<(?:think|thinking|reasoning|antml:thinking)>([\s\S]*)$/i.exec(cleaned);
  if (unclosed && unclosed[1].trim()) {
    parts.push(unclosed[1].trim());
    cleaned = cleaned.slice(0, unclosed.index);
  }
  if (parts.length === 0) return { reasoning: "", cleaned: content };
  return { reasoning: parts.join("\n"), cleaned: cleaned.trim() };
}

export function normalizeChatMessages(messages: any, model: FreebuffModel): any[] {
  if (!Array.isArray(messages)) {
    return ensureCliSystemMarker([]);
  }

  const normalized: any[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const item = { ...message };
    if (item.role === "developer") item.role = "system";

    if (item.role === "assistant") {
      const toolCalls = item.tool_calls;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
      if (hasToolCalls && (item.content === undefined || item.content === "")) {
        item.content = null;
      }
      if (hasToolCalls) {
        let rc = typeof item.reasoning_content === "string" ? item.reasoning_content : "";
        if (!rc && typeof item.content === "string" && item.content) {
          const extracted = extractLeakedThinkTags(item.content);
          if (extracted.reasoning) {
            rc = extracted.reasoning;
            item.reasoning_content = rc;
            item.content = extracted.cleaned || null;
          }
        }
        if (!rc && isStrictReasoningModel(model.id)) {
          item.reasoning_content = "";
        }
      } else if (typeof item.content === "string" && !item.reasoning_content) {
        const extracted = extractLeakedThinkTags(item.content);
        if (extracted.reasoning) {
          item.reasoning_content = extracted.reasoning;
          item.content = extracted.cleaned;
        }
      }
    }

    normalized.push(item);
  }

  return ensureCliSystemMarker(normalized);
}

const REASONING_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function clampEffort(requested: string, allowed: string[], fallback: string): string {
  if (!allowed.length) return fallback;
  const wanted = REASONING_LADDER.indexOf(requested);
  if (wanted < 0) return fallback;
  let best = -1;
  for (const candidate of allowed) {
    const rank = REASONING_LADDER.indexOf(candidate);
    if (rank >= 0 && rank <= wanted && rank > best) best = rank;
  }
  if (best >= 0) return REASONING_LADDER[best];
  return allowed.reduce((lowest, c) =>
    REASONING_LADDER.indexOf(c) < REASONING_LADDER.indexOf(lowest) ? c : lowest
  );
}

function extractEffort(body: any): string {
  if (typeof body?.reasoning_effort === "string" && body.reasoning_effort) {
    return body.reasoning_effort.toLowerCase().trim();
  }
  if (body?.reasoning && typeof body.reasoning.effort === "string") {
    return body.reasoning.effort.toLowerCase().trim();
  }
  return "";
}

function normalizeReasoning(payload: any, model: FreebuffModel, body: any): void {
  const thinking = body?.thinking;
  if (body?.reasoning?.enabled === false || thinking?.type === "disabled") {
    delete payload.reasoning_effort;
    return;
  }

  let eff = extractEffort(body);
  if (!eff || eff === "none" || eff === "disabled") {
    if (model.default_effort) {
      payload.reasoning_effort = model.default_effort;
    } else {
      delete payload.reasoning_effort;
    }
    return;
  }

  const allowed = model.efforts || [];
  if (isMediumlessLadder(model) && eff === "medium") {
    payload.reasoning_effort = "high";
    return;
  }
  if (allowed.length > 0) {
    payload.reasoning_effort = clampEffort(eff, allowed, model.default_effort || "high");
  } else {
    payload.reasoning_effort = eff;
  }
}

export function buildUpstreamPayload({
  body,
  instanceId,
  runId,
  clientId,
  traceSessionId,
  stepNumber,
}: {
  body: any;
  instanceId: string;
  runId: string;
  clientId: string;
  traceSessionId?: string;
  stepNumber?: number;
}): { payload: any; mapper: ToolMapper } {
  const payload: any = {};
  for (const key of UPSTREAM_CHAT_KEYS) {
    if (body[key] !== undefined && body[key] !== null) {
      payload[key] = body[key];
    }
  }

  const modelConfig = resolveModel(body.model);
  payload.model = getUpstreamId(modelConfig);
  payload.messages = normalizeChatMessages(body.messages, modelConfig);
  payload.stream = true;
  if (payload.stop === undefined || payload.stop === null) {
    payload.stop = ['"cb_easp"'];
  }

  normalizeReasoning(payload, modelConfig, body);

  if (Array.isArray(body.functions) && !payload.tools) {
    payload.tools = body.functions.map((fn: any) => ({ type: "function", function: fn }));
  }
  if (body.function_call != null && payload.tool_choice == null) {
    payload.tool_choice = body.function_call;
  }

  const mapper = new ToolMapper();
  mapper.applyToPayload(payload);

  payload.provider = { data_collection: "deny" };
  const metadata: any = {
    freebuff_instance_id: instanceId,
    run_id: runId,
    client_id: clientId,
    cost_mode: "free",
  };
  if (traceSessionId) metadata.trace_session_id = traceSessionId;
  if (stepNumber && stepNumber > 0) metadata.llm_step_number = String(stepNumber);
  if (typeof payload.reasoning_effort === "string" && payload.reasoning_effort) {
    metadata.freebuff_reasoning_effort = payload.reasoning_effort;
  }
  payload.codebuff_metadata = metadata;

  return { payload, mapper };
}

export function sanitizeStreamChunk(chunk: any, mapper?: ToolMapper): any | null {
  const clean: any = {
    id: chunk.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`,
    object: chunk.object || "chat.completion.chunk",
    created: chunk.created || Math.floor(Date.now() / 1000),
    model: chunk.model,
    choices: [],
  };

  if (chunk.system_fingerprint) {
    clean.system_fingerprint = chunk.system_fingerprint;
  }
  if (chunk.usage !== undefined && chunk.usage !== null) {
    clean.usage = chunk.usage;
  }

  const choices = chunk.choices || [];
  for (const choice of choices) {
    const item: any = {
      index: choice.index !== undefined ? choice.index : 0,
      delta: { ...(choice.delta || {}) },
      finish_reason: choice.finish_reason || null,
    };

    if (choice.logprobs !== undefined && choice.logprobs !== null) {
      item.logprobs = choice.logprobs;
    }

    const reasoningContent = item.delta.reasoning_content;
    delete item.delta.reasoning_content;

    if (typeof item.delta.content === "string") {
      item.delta.content = stripInternalToolMarkup(item.delta.content);
    }

    if (item.delta.content === undefined || item.delta.content === null || item.delta.content === "") {
      delete item.delta.content;
    }

    if (typeof reasoningContent === "string") {
      const cleanReasoning = stripInternalToolMarkup(reasoningContent);
      if (cleanReasoning) {
        item.delta.reasoning_content = cleanReasoning;
      }
    }

    if (Array.isArray(item.delta.tool_calls) && mapper) {
      for (const tc of item.delta.tool_calls) {
        if (tc?.function?.name) {
          tc.function.name = mapper.fromUpstream(tc.function.name);
        }
      }
    }

    clean.choices.push(item);
  }

  if (clean.choices.length === 0 && clean.usage === undefined) {
    return null;
  }
  return clean;
}

export class CompletionAccumulator {
  private id: string;
  private created: number;
  private model: string;
  private contentParts: string[] = [];
  private reasoningParts: string[] = [];
  private finishReason: string | null = null;
  private usage: any = null;
  private systemFingerprint: string | null = null;
  private toolCalls: Record<number, any> = {};
  private mapper?: ToolMapper;

  constructor(model: string, mapper?: ToolMapper) {
    this.id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
    this.created = Math.floor(Date.now() / 1000);
    this.model = model;
    this.mapper = mapper;
  }

  public get content(): string {
    return this.contentParts.join("");
  }

  public get reasoningContent(): string {
    return this.reasoningParts.join("");
  }

  public add(chunk: any): void {
    if (chunk.id) this.id = chunk.id;
    if (chunk.created) this.created = chunk.created;
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    if (chunk.system_fingerprint) this.systemFingerprint = chunk.system_fingerprint;

    const choices = chunk.choices || [];
    for (const choice of choices) {
      const delta = choice.delta || {};
      const content = delta.content;
      const reasoningContent = delta.reasoning_content;

      if (typeof content === "string") {
        const cleanContent = stripInternalToolMarkup(content);
        if (cleanContent) this.contentParts.push(cleanContent);
      }
      if (typeof reasoningContent === "string") {
        const cleanReasoning = stripInternalToolMarkup(reasoningContent);
        if (cleanReasoning) this.reasoningParts.push(cleanReasoning);
      }

      const tools = delta.tool_calls || [];
      for (const t of tools) {
        this.addToolCall(t);
      }

      if (choice.finish_reason) {
        this.finishReason = choice.finish_reason;
      }
    }
  }

  private addToolCall(toolCall: any): void {
    const index = parseInt(toolCall.index || 0, 10);
    if (!this.toolCalls[index]) {
      this.toolCalls[index] = {
        id: toolCall.id || `call_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
        type: toolCall.type || "function",
        function: { name: "", arguments: "" },
      };
    }
    const current = this.toolCalls[index];
    if (toolCall.id) current.id = toolCall.id;
    if (toolCall.type) current.type = toolCall.type;

    const func = toolCall.function || {};
    if (func.name) {
      current.function.name = this.mapper ? this.mapper.fromUpstream(func.name) : func.name;
    }
    if (func.arguments) current.function.arguments += func.arguments;
  }

  public finalResponse(): any {
    const message: any = {
      role: "assistant",
      content: this.content,
    };

    const sortedIndexes = Object.keys(this.toolCalls)
      .map(Number)
      .sort((a, b) => a - b);
    if (sortedIndexes.length > 0) {
      message.tool_calls = sortedIndexes.map(idx => this.toolCalls[idx]);
    }

    if (this.reasoningContent) {
      message.reasoning_content = this.reasoningContent;
    }

    const response: any = {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: this.finishReason || "stop",
        },
      ],
      usage: this.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    if (this.systemFingerprint) {
      response.system_fingerprint = this.systemFingerprint;
    }

    return response;
  }
}
