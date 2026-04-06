import type { AiCommandProcessDescription } from "../services/ai-command-process-service.js";
import type { OperationalStateStore } from "../services/operational-state-service.js";

export interface ApiAiProcesses {
  startProcess: (options: {
    processName: string;
    command: string;
    input: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<AiCommandProcessDescription>;
  getProcess: (processName: string) => Promise<AiCommandProcessDescription | null>;
  deleteProcess: (processName: string) => Promise<void>;
  readProcessLogs: (processInfo: AiCommandProcessDescription | null) => Promise<{
    stdout: string;
    stderr: string;
  }>;
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
