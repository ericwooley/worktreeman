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

export interface DockerConfig {
  composeFile?: string;
  projectPrefix?: string;
  portMappings?: DockerPortMapping[];
  servicePorts?: Record<string, NamedServicePort>;
}

export interface BackgroundCommandConfigEntry {
  command: string;
}

export interface QuickLinkConfigEntry {
  name: string;
  url: string;
}

export interface WorktreeManagerConfig {
  env: Record<string, string>;
  runtimePorts: string[];
  derivedEnv: Record<string, string>;
  quickLinks: QuickLinkConfigEntry[];
  startupCommands: string[];
  backgroundCommands: Record<string, BackgroundCommandConfigEntry>;
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
  quickLinks: QuickLinkConfigEntry[];
  allocatedPorts: Record<string, number>;
  ports: PortBinding[];
  servicePorts: Record<string, PortBinding>;
  tmuxSession: string;
  dockerStartedAt?: string;
}

export interface BackgroundCommandState {
  name: string;
  command: string;
  processName: string;
  manager: "pm2" | "runtime";
  running: boolean;
  status: string;
  requiresRuntime: boolean;
  canStart: boolean;
  note?: string;
  pid?: number;
  startedAt?: string;
}

export interface BackgroundCommandLogLine {
  id: string;
  source: "stdout" | "stderr";
  text: string;
  timestamp?: string;
}

export interface BackgroundCommandLogsResponse {
  commandName: string;
  lines: BackgroundCommandLogLine[];
}

export interface BackgroundCommandLogStreamEvent {
  type: "snapshot" | "append";
  commandName: string;
  lines: BackgroundCommandLogLine[];
}

export interface TmuxClientInfo {
  id: string;
  pid: number;
  tty: string;
  name: string;
  sessionName: string;
  createdAt?: string;
  lastActiveAt?: string;
  isControlMode: boolean;
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

export interface ShutdownLogEntry {
  id: number;
  level: "info" | "error";
  message: string;
  timestamp: string;
}

export interface ShutdownStatus {
  active: boolean;
  completed: boolean;
  failed: boolean;
  logs: ShutdownLogEntry[];
}

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "ready"; session: string; clientId: string | null }
  | { type: "error"; message: string };
