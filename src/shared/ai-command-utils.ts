import type { AiCommandConfig, AiCommandId, AiCommandJob, AiCommandLogError, AiCommandOrigin } from "./types.js";

export function resolveAiCommandTemplate(aiCommands: AiCommandConfig, commandId: AiCommandId): string {
  return commandId === "simple" ? aiCommands.simple.trim() : aiCommands.smart.trim();
}

export function cloneAiCommandJob(job: AiCommandJob | null): AiCommandJob | null {
  if (!job) {
    return null;
  }

  return {
    ...job,
    completedAt: job.completedAt,
    worktreePath: job.worktreePath,
    error: job.error,
    outputEvents: job.outputEvents?.map((event) => ({ ...event })) ?? [],
    origin: job.origin
      ? {
          ...job.origin,
          location: { ...job.origin.location },
        }
      : job.origin ?? null,
  };
}

export function toAiCommandLogError(error: unknown): AiCommandLogError | null {
  if (!error) {
    return null;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  if (typeof error !== "object") {
    return { message: String(error) };
  }

  const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    stack: typeof candidate.stack === "string" ? candidate.stack : undefined,
  };
}

export function parseAiCommandOrigin(value: unknown): AiCommandOrigin | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const origin = value as AiCommandOrigin;
  if (typeof origin.kind !== "string" || typeof origin.label !== "string" || !origin.location || typeof origin.location !== "object") {
    return null;
  }

  return {
    ...origin,
    location: { ...origin.location },
  };
}
