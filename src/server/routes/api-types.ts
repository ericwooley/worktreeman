import type { AiCommandProcessHooks, AiCommandProcessDescription } from "../services/ai-command-process-service.js";
import type { OperationalStateStore } from "../services/operational-state-service.js";

export interface ApiAiProcesses {
  startProcess: (options: {
    processName: string;
    command: string;
    input: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
    hooks?: AiCommandProcessHooks;
  }) => Promise<AiCommandProcessDescription>;
  getProcess: (processName: string) => Promise<AiCommandProcessDescription | null>;
  waitForProcess: (processName: string) => Promise<AiCommandProcessDescription | null>;
  deleteProcess: (processName: string) => Promise<void>;
  isProcessActive: (status: string | undefined) => boolean;
}

export interface ApiRouterOptions {
  repoRoot: string;
  configPath: string;
  configSourceRef: string;
  configFile: string;
  configWorktreePath: string;
  operationalState: OperationalStateStore;
  aiProcessPollIntervalMs?: number;
  aiLogStreamPollIntervalMs?: number;
  stateStreamFullRefreshIntervalMs?: number;
  gitWatchDebounceMs?: number;
  aiProcesses?: ApiAiProcesses;
}

export interface RunProjectManagementDocumentAiRequest {
  input?: unknown;
  commandId?: unknown;
  origin?: unknown;
  worktreeStrategy?: unknown;
  targetBranch?: unknown;
  worktreeName?: unknown;
}
