export interface FreebuffModel {
  id: string;
  agent_id: string;
  owned_by: string;
  upstream_model_id?: string;
  session_model_id?: string;
  parent_agent_id?: string;
}

export const FREEBUFF_MODELS: FreebuffModel[] = [
  { id: "deepseek/deepseek-v4-flash", agent_id: "base2-free-deepseek-flash", owned_by: "freebuff" },
  { id: "deepseek/deepseek-v4-pro", agent_id: "base2-free-deepseek", owned_by: "freebuff" },
  { id: "moonshotai/kimi-k2.6", agent_id: "base2-free-kimi", owned_by: "freebuff" },
  { id: "minimax/minimax-m2.7", agent_id: "base2-free", owned_by: "freebuff" },
  { id: "minimax/minimax-m3", agent_id: "base2-free-minimax-m3", owned_by: "minimax" },
  { id: "mimo/mimo-v2.5", agent_id: "base2-free-mimo", owned_by: "mimo" },
  { id: "mimo/mimo-v2.5-pro", agent_id: "base2-free-mimo-pro", owned_by: "mimo" },
  { id: "z-ai/glm-5.2", agent_id: "base2-free-glm-5.2", owned_by: "z-ai" },
];

export const CONTEXT_PRUNER_AGENT_ID = "context-pruner";
export const GEMINI_THINKER_AGENT_ID = "thinker-with-files-gemini";
export const GEMINI_THINKER_PARENT_AGENT_ID = "base2-free-kimi";
export const GEMINI_THINKER_PARENT_MODEL_ID = "moonshotai/kimi-k2.6";
export const GEMINI_FLASH_LITE_SESSION_MODEL_ID = FREEBUFF_MODELS[0].id;

export const GEMINI_FREE_MODELS: FreebuffModel[] = [
  {
    id: "google/gemini-2.5-flash-lite",
    agent_id: "file-picker",
    owned_by: "google",
    session_model_id: GEMINI_FLASH_LITE_SESSION_MODEL_ID,
    parent_agent_id: FREEBUFF_MODELS[0].agent_id,
  },
  {
    id: "google/gemini-3.1-flash-lite-preview",
    agent_id: "file-picker-max",
    owned_by: "google",
    session_model_id: GEMINI_FLASH_LITE_SESSION_MODEL_ID,
    parent_agent_id: FREEBUFF_MODELS[0].agent_id,
  },
  {
    id: "google/gemini-3.1-pro-preview",
    agent_id: GEMINI_THINKER_AGENT_ID,
    owned_by: "google",
    session_model_id: GEMINI_THINKER_PARENT_MODEL_ID,
    parent_agent_id: GEMINI_THINKER_PARENT_AGENT_ID,
  },
];

export const ALL_MODELS = [...FREEBUFF_MODELS, ...GEMINI_FREE_MODELS];

export function resolveModel(requested: string | null | undefined): FreebuffModel {
  const modelName = requested || FREEBUFF_MODELS[0].id;
  const found = ALL_MODELS.find(m => m.id === modelName);
  if (!found) {
    throw new Error(`Unsupported Freebuff model: ${modelName}`);
  }
  return found;
}

export function getUpstreamId(model: FreebuffModel): string {
  return model.upstream_model_id || model.id;
}

export function getSessionId(model: FreebuffModel): string {
  return model.session_model_id || getUpstreamId(model);
}

export function modelsResponse() {
  return {
    object: "list",
    data: ALL_MODELS.map(model => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.owned_by,
    })),
  };
}

export function agentValidationPayload() {
  const modelsByAgent: Record<string, FreebuffModel> = {};
  const spawnableByAgent: Record<string, Set<string>> = {};

  for (const model of ALL_MODELS) {
    if (!modelsByAgent[model.agent_id]) {
      modelsByAgent[model.agent_id] = model;
    }
    if (!spawnableByAgent[model.agent_id]) {
      spawnableByAgent[model.agent_id] = new Set();
    }
    spawnableByAgent[model.agent_id].add(CONTEXT_PRUNER_AGENT_ID);

    if (model.parent_agent_id) {
      if (!spawnableByAgent[model.parent_agent_id]) {
        spawnableByAgent[model.parent_agent_id] = new Set();
      }
      spawnableByAgent[model.parent_agent_id].add(model.agent_id);
    }
  }

  const definitions = Object.values(modelsByAgent).map(model => {
    const spawnable = Array.from(spawnableByAgent[model.agent_id] || []);
    return _agentDefinition({
      agent_id: model.agent_id,
      model_id: getUpstreamId(model),
      display_name: `Freebuff ${getUpstreamId(model)}`,
      spawnable_agents: spawnable,
    });
  });

  definitions.push(
    _agentDefinition({
      agent_id: CONTEXT_PRUNER_AGENT_ID,
      model_id: FREEBUFF_MODELS[0].id,
      display_name: "Context Pruner",
      spawnable_agents: [],
    })
  );

  return { agentDefinitions: definitions };
}

function _agentDefinition({
  agent_id,
  model_id,
  display_name,
  spawnable_agents,
}: {
  agent_id: string;
  model_id: string;
  display_name: string;
  spawnable_agents: string[];
}) {
  return {
    id: agent_id,
    publisher: "codebuff",
    model: model_id,
    displayName: display_name,
    spawnerPrompt: "Freebuff OpenAI-compatible orchestrator",
    inputSchema: {
      prompt: {
        type: "string",
        description: "A coding task to complete",
      },
      params: { type: "object", properties: {}, required: [] },
    },
    outputMode: "last_message",
    includeMessageHistory: true,
    toolNames: spawnable_agents.length > 0 ? ["spawn_agents"] : [],
    spawnableAgents: spawnable_agents,
    systemPrompt: "Act as a helpful coding assistant.",
  };
}
