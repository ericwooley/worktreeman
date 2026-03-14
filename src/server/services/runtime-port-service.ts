import net from "node:net";

export interface ReservedPort {
  envName: string;
  port: number;
  release: () => Promise<void>;
}

async function reserveSinglePort(envName: string): Promise<ReservedPort> {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error(`Unable to reserve a local port for ${envName}.`);
  }

  return {
    envName,
    port: address.port,
    release: async () => {
      if (!server.listening) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

export async function reserveRuntimePorts(envNames: string[]): Promise<ReservedPort[]> {
  const uniqueEnvNames = [...new Set(envNames.map((envName) => envName.trim()).filter(Boolean))];
  const reservedPorts: ReservedPort[] = [];

  try {
    for (const envName of uniqueEnvNames) {
      reservedPorts.push(await reserveSinglePort(envName));
    }

    return reservedPorts;
  } catch (error) {
    await Promise.allSettled(reservedPorts.map((entry) => entry.release()));
    throw error;
  }
}

export async function releaseReservedPorts(entries: ReservedPort[]): Promise<void> {
  await Promise.allSettled(entries.map((entry) => entry.release()));
}
