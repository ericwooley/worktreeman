import fs from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const DEFAULT_MAX_CONNECTIONS = 32;

interface ManagedDatabaseSocket {
  db: PGlite;
  socketServer: PGLiteSocketServer;
  connectionString: string;
}

const managedSockets = new Map<string, ManagedDatabaseSocket>();

function resolveDatabasePath(repoRoot: string) {
  return path.join(repoRoot, ".logs", "database", "pgdata");
}

function formatConnectionString(hostAndPort: string) {
  return `postgres://postgres:postgres@${hostAndPort}/postgres`;
}

export async function startDatabaseSocketServer(repoRoot: string): Promise<{ connectionString: string }> {
  const existing = managedSockets.get(repoRoot);
  if (existing) {
    return { connectionString: existing.connectionString };
  }

  const dataPath = resolveDatabasePath(repoRoot);
  await fs.mkdir(path.dirname(dataPath), { recursive: true });

  const db = await PGlite.create(dataPath);
  const socketServer = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 0,
    maxConnections: DEFAULT_MAX_CONNECTIONS,
  });

  try {
    await socketServer.start();
    const connectionString = formatConnectionString(socketServer.getServerConn());
    managedSockets.set(repoRoot, { db, socketServer, connectionString });
    return { connectionString };
  } catch (error) {
    await Promise.allSettled([socketServer.stop(), db.close()]);
    throw error;
  }
}

export async function stopDatabaseSocketServer(repoRoot: string): Promise<void> {
  const managed = managedSockets.get(repoRoot);
  if (!managed) {
    return;
  }

  managedSockets.delete(repoRoot);
  await Promise.allSettled([managed.socketServer.stop(), managed.db.close()]);
}

export async function stopAllDatabaseSocketServers(): Promise<void> {
  const entries = Array.from(managedSockets.entries());
  managedSockets.clear();
  await Promise.all(entries.map(async ([, managed]) => {
    await Promise.allSettled([managed.socketServer.stop(), managed.db.close()]);
  }));
}
