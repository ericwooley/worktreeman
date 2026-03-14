import process from "node:process";
import type {
  DockerPortMapping,
  NamedServicePort,
  PortBinding,
  WorktreeManagerConfig,
  WorktreeRuntime,
} from "../../shared/types.js";
import { renderDerivedEnv } from "./config-service.js";
import { reserveRuntimePorts, type ReservedPort } from "./runtime-port-service.js";
import { runCommand } from "../utils/process.js";
import { sanitizeBranchName } from "../utils/paths.js";

export interface DockerRuntimeResult {
  runtime: WorktreeRuntime;
  reservedPorts: ReservedPort[];
}

export async function runStartupCommands(
  commands: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const command of commands) {
    await runCommand(process.env.SHELL || "bash", ["-lc", command], { cwd, env });
  }
}

function parseHostPort(raw: string): number {
  const line = raw.split(/\r?\n/).find(Boolean)?.trim();
  if (!line) {
    throw new Error(`Unable to parse docker port output: ${raw}`);
  }

  const match = line.match(/:(\d+)$/);
  if (!match) {
    throw new Error(`Unable to extract host port from docker output: ${line}`);
  }

  return Number(match[1]);
}

async function inspectPort(projectName: string, mapping: DockerPortMapping, cwd: string): Promise<PortBinding> {
  const protocol = mapping.protocol ?? "tcp";
  const { stdout: containerIdStdout } = await runCommand(
    "docker",
    ["compose", "-p", projectName, "ps", "-q", mapping.service],
    { cwd },
  );

  const containerId = containerIdStdout.split(/\r?\n/).find(Boolean)?.trim();
  if (!containerId) {
    throw new Error(`No running container found for service ${mapping.service} in project ${projectName}.`);
  }

  const { stdout } = await runCommand("docker", ["port", containerId, `${mapping.containerPort}/${protocol}`], { cwd });
  const hostPort = parseHostPort(stdout);

  return {
    envName: mapping.envName,
    service: mapping.service,
    containerPort: mapping.containerPort,
    hostPort,
    protocol,
  };
}

function defaultServicePortEnvName(name: string): string {
  return `${name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "SERVICE"}_PORT`;
}

async function inspectNamedServicePort(
  projectName: string,
  name: string,
  servicePort: NamedServicePort,
  cwd: string,
): Promise<PortBinding> {
  const binding = await inspectPort(
    projectName,
    {
      service: servicePort.service,
      containerPort: servicePort.containerPort,
      protocol: servicePort.protocol,
      envName: servicePort.envName ?? defaultServicePortEnvName(name),
    },
    cwd,
  );

  return {
    ...binding,
    name,
  };
}

export async function ensureDockerRuntime(
  config: WorktreeManagerConfig,
  branch: string,
  worktreePath: string,
): Promise<DockerRuntimeResult> {
  let reservedPorts: ReservedPort[] = [];

  try {
    reservedPorts = await reserveRuntimePorts(config.runtimePorts);
    const composeProject = `${config.docker.projectPrefix ?? "wt"}-${sanitizeBranchName(branch)}`;
    const composeArgs = ["compose", "-p", composeProject];

    if (config.docker.composeFile) {
      composeArgs.push("-f", config.docker.composeFile);
    }

    composeArgs.push("up", "-d");
    await runCommand("docker", composeArgs, { cwd: worktreePath });

    const ports = await Promise.all(
      (config.docker.portMappings ?? []).map((mapping) => inspectPort(composeProject, mapping, worktreePath)),
    );

    const namedServicePortEntries = await Promise.all(
      Object.entries(config.docker.servicePorts ?? {}).map(async ([name, servicePort]) => [
        name,
        await inspectNamedServicePort(composeProject, name, servicePort, worktreePath),
      ] as const),
    );

    const servicePorts = Object.fromEntries(namedServicePortEntries);
    const allocatedPorts = Object.fromEntries(reservedPorts.map((entry) => [entry.envName, entry.port]));

    const baseEnv = {
      ...config.env,
      ...Object.fromEntries(Object.entries(allocatedPorts).map(([key, value]) => [key, String(value)])),
      ...Object.fromEntries(ports.map((binding) => [binding.envName, String(binding.hostPort)])),
      ...Object.fromEntries(Object.values(servicePorts).map((binding) => [binding.envName, String(binding.hostPort)])),
    };

    const env = {
      ...baseEnv,
      ...renderDerivedEnv(config.docker.derivedEnv ?? {}, baseEnv),
    };

    const injectedEnv = {
      ...process.env,
      ...env,
    };

    await runStartupCommands(config.startupCommands, worktreePath, injectedEnv);

    return {
      runtime: {
        branch,
        worktreePath,
        composeProject,
        env,
        allocatedPorts,
        ports: [...ports, ...Object.values(servicePorts)],
        servicePorts,
        tmuxSession: `wt-${sanitizeBranchName(branch)}`,
        dockerStartedAt: new Date().toISOString(),
      },
      reservedPorts,
    };
  } catch (error) {
    await Promise.allSettled(reservedPorts.map((entry) => entry.release()));
    throw error;
  }
}

export async function stopDockerRuntime(runtime: WorktreeRuntime, config: WorktreeManagerConfig): Promise<void> {
  const args = ["compose", "-p", runtime.composeProject];

  if (config.docker.composeFile) {
    args.push("-f", config.docker.composeFile);
  }

  args.push("down", "--remove-orphans");
  await runCommand("docker", args, { cwd: runtime.worktreePath });
}
