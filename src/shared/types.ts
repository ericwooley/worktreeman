export interface DockerPortMapping {
  service: string;
  containerPort: number;
  protocol?: "tcp" | "udp";
  envName: string;
}

export interface NamedServicePort {
  service: string;
  containerPort: number;
  protocol?: "tcp" | "udp";
  envName?: string;
}

export type InitEnvNameStyle =
  | "service-port-number"
  | "service-port-suffix"
  | "service-port";

export interface DockerConfig {
  composeFile?: string;
  projectPrefix?: string;
  portMappings?: DockerPortMapping[];
  servicePorts?: Record<string, NamedServicePort>;
  derivedEnv?: Record<string, string>;
}

export interface WorktreeManagerConfig {
  env: Record<string, string>;
  startupCommands: string[];
  worktrees: {
    baseDir: string;
  };
  docker: DockerConfig;
}

export interface PortBinding {
  name?: string;
  envName: string;
  service: string;
  containerPort: number;
  hostPort: number;
  protocol: "tcp" | "udp";
}

export interface WorktreeRuntime {
  branch: string;
  worktreePath: string;
  composeProject: string;
  env: Record<string, string>;
  ports: PortBinding[];
  servicePorts: Record<string, PortBinding>;
  tmuxSession: string;
  dockerStartedAt?: string;
}

export interface WorktreeRecord {
  branch: string;
  worktreePath: string;
  headSha?: string;
  isBare: boolean;
  isDetached: boolean;
  locked: boolean;
  prunable: boolean;
  runtime?: WorktreeRuntime;
}

export interface CreateWorktreeRequest {
  branch: string;
  path?: string;
}

export interface ApiStateResponse {
  repoRoot: string;
  configPath: string;
  config: WorktreeManagerConfig;
  worktrees: WorktreeRecord[];
}

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "ready"; session: string }
  | { type: "error"; message: string };
