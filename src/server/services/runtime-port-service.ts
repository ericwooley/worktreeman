import net from "node:net";

export interface AllocatedPort {
  envName: string;
  port: number;
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

export async function allocateRuntimePorts(envNames: string[]): Promise<AllocatedPort[]> {
  const uniqueEnvNames = [...new Set(envNames.map((envName) => envName.trim()).filter(Boolean))];
  const allocatedPorts: AllocatedPort[] = [];

  for (const envName of uniqueEnvNames) {
    allocatedPorts.push(await allocateSinglePort(envName));
  }

  return allocatedPorts;
}
