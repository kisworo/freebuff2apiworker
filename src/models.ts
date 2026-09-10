export interface FreebuffModel {
  id: string;
  agent_id: string;
  owned_by: string;
  /** Catalog default reasoning effort. Empty = omit (upstream default). */
  default_effort?: string;
  /** Allowed effort rungs. Empty = pass through / ignore. */
  efforts?: string[];
  multimodal?: boolean;
}

// Pinned to GLM 5.3 Flash — Freebuff withdrew Muse Spark 1.3 from free mode and
// Freebuff itself recommends GLM 5.3 Flash (2026-09-10). Session+run verified live.
export const DEFAULT_MODEL_ID = "z-ai/glm-5.3-flash";
export const FALLBACK_MODEL_ID = DEFAULT_MODEL_ID;

export const FREEBUFF_MODELS: FreebuffModel[] = [
  {
    id: "z-ai/glm-5.3-flash",
    agent_id: "base3-free-glm-5-3-flash",
    owned_by: "z-ai",
  },
];

/** Convenience / family names → the single served row. Other models 400. */
const MODEL_ALIASES: Record<string, string> = {
  "glm-5.3-flash": DEFAULT_MODEL_ID,
  "glm": DEFAULT_MODEL_ID,
  "z-ai/glm-5.3": DEFAULT_MODEL_ID,
  "muse-spark-1.3-contributor": DEFAULT_MODEL_ID,
  "muse-spark-1.3": DEFAULT_MODEL_ID,
  "muse-spark": DEFAULT_MODEL_ID,
  "meta/muse-spark-1.3": DEFAULT_MODEL_ID,
  "meta/muse-spark-1.2-contributor": DEFAULT_MODEL_ID,
  "muse-spark-1.2-contributor": DEFAULT_MODEL_ID,
  "muse-spark-1.2": DEFAULT_MODEL_ID,
};

export const ALL_MODELS = [...FREEBUFF_MODELS];

const byId = new Map(ALL_MODELS.map(m => [m.id, m]));

export function resolveModel(requested: string | null | undefined): FreebuffModel {
  const raw = (requested || DEFAULT_MODEL_ID).trim();
  const aliased = MODEL_ALIASES[raw] || raw;
  const found = byId.get(aliased);
  if (!found) {
    throw new Error(`Unsupported Freebuff model: ${raw}`);
  }
  if (aliased !== raw) {
    console.log(`[models] Alias ${raw} → ${aliased}`);
  }
  return found;
}

export function getUpstreamId(model: FreebuffModel): string {
  return model.id;
}

export function getSessionId(model: FreebuffModel): string {
  return model.id;
}

export function isDeepSeekModel(modelId: string): boolean {
  return modelId.includes("deepseek-v4-flash") || modelId.includes("deepseek-v4-pro");
}

export function isMediumlessLadder(model: FreebuffModel): boolean {
  const efforts = model.efforts || [];
  return efforts.length >= 2 && !efforts.includes("medium");
}

export function isStrictReasoningModel(modelId: string): boolean {
  const m = modelId.toLowerCase();
  return m.includes("mimo") || m.includes("deepseek-v4") || m.includes("kimi");
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
