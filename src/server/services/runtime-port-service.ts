import net from "node:net";

export interface AllocatedPort {
  envName: string;
  port: number;
}

async function isLocalPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(true);
      });
    });
  });
}

async function allocateSinglePort(envName: string): Promise<AllocatedPort> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error(`Unable to allocate a local port for ${envName}.`)));
        return;
      }

      const allocatedPort = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(allocatedPort);
      });
    });
  });

  return { envName, port };
}

async function allocateRequestedPort(envName: string, requestedPort: number): Promise<AllocatedPort> {
  if (await isLocalPortAvailable(requestedPort)) {
    return { envName, port: requestedPort };
  }

  return allocateSinglePort(envName);
}

export async function allocateRuntimePorts(
  envNames: string[],
  preferredPorts: Record<string, number> = {},
): Promise<AllocatedPort[]> {
  const uniqueEnvNames = [...new Set(envNames.map((envName) => envName.trim()).filter(Boolean))];
  const allocatedPorts: AllocatedPort[] = [];

  for (const envName of uniqueEnvNames) {
    const preferredPort = preferredPorts[envName];
    if (Number.isInteger(preferredPort) && preferredPort > 0) {
      allocatedPorts.push(await allocateRequestedPort(envName, preferredPort));
      continue;
    }

    allocatedPorts.push(await allocateSinglePort(envName));
  }

  return allocatedPorts;
}
