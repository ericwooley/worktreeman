import fs from "node:fs/promises";
import path from "node:path";
import { Client, Pool, type QueryResultRow } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { getDatabaseConnectionString } from "./database-connection-service.js";

export interface ManagedDatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<void>;
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  transaction<T>(callback: (client: ManagedDatabaseClient) => Promise<T>): Promise<T>;
  listen(channel: string, listener: (payload: string | null) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

interface ManagedDatabaseHandle {
  client: ManagedDatabaseClient;
  readyPromise: Promise<void>;
}

const managedClients = new Map<string, ManagedDatabaseHandle>();

function resolveFallbackDatabasePath(repoRoot: string, namespace: string) {
  return path.join(repoRoot, ".logs", namespace, "pgdata");
}

async function createConnectionStringClient(connectionString: string): Promise<ManagedDatabaseClient> {
  const pool = new Pool({ connectionString });
  pool.on("error", () => undefined);
  let closeClient: (() => Promise<void>) | null = async () => {
    await pool.end();
  };

  return {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      const result = await pool.query<QueryResultRow>(text, values);
      return { rows: result.rows as T[] };
    },
    async exec(text) {
      await pool.query(text);
    },
    async executeSql(text, values) {
      const result = await pool.query<QueryResultRow>(text, values);
      return { rows: result.rows };
    },
    async transaction<T>(callback: (client: ManagedDatabaseClient) => Promise<T>) {
      const client = await pool.connect();
      const transactionalClient: ManagedDatabaseClient = {
        async query<U extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
          const result = await client.query<QueryResultRow>(text, values);
          return { rows: result.rows as U[] };
        },
        async exec(text) {
          await client.query(text);
        },
        async executeSql(text, values) {
          const result = await client.query<QueryResultRow>(text, values);
          return { rows: result.rows };
        },
        async transaction<U>(nestedCallback: (nestedClient: ManagedDatabaseClient) => Promise<U>) {
          return nestedCallback(transactionalClient);
        },
        async listen() {
          throw new Error("LISTEN is not supported inside a transaction-scoped database client.");
        },
        async close() {},
      };

      try {
        await client.query("begin");
        const result = await callback(transactionalClient);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async listen(channel, listener) {
      const client = new Client({ connectionString });
      client.on("error", () => undefined);
      await client.connect();
      const onNotification = (message: { channel: string; payload?: string }) => {
        if (message.channel !== channel) {
          return;
        }

        listener(message.payload ?? null);
      };

      client.on("notification", onNotification);
      await client.query(`LISTEN ${channel}`);

      return async () => {
        client.off("notification", onNotification);
        await client.query(`UNLISTEN ${channel}`).catch(() => undefined);
        await client.end().catch(() => undefined);
      };
    },
    async close() {
      await closeClient?.();
      closeClient = null;
    },
  };
}

async function createFallbackPgliteClient(repoRoot: string, namespace: string): Promise<ManagedDatabaseClient> {
  const dbPath = resolveFallbackDatabasePath(repoRoot, namespace);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = await PGlite.create(dbPath);
  let closeClient: (() => Promise<void>) | null = async () => {
    await db.close();
  };

  return {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      const result = values && values.length > 0
        ? await db.query(text, values)
        : await db.query(text);
      return { rows: (result.rows ?? []) as T[] };
    },
    async exec(text) {
      await db.exec(text);
    },
    async executeSql(text, values) {
      if (values && values.length > 0) {
        const result = await db.query(text, values);
        return { rows: result.rows ?? [] };
      }

      const results = await db.exec(text);
      const last = results.at(-1) ?? { rows: [] };
      return { rows: last.rows ?? [] };
    },
    async transaction<T>(callback: (client: ManagedDatabaseClient) => Promise<T>) {
      const transactionalClient: ManagedDatabaseClient = {
        async query<U extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
          const result = values && values.length > 0
            ? await db.query(text, values)
            : await db.query(text);
          return { rows: (result.rows ?? []) as U[] };
        },
        async exec(text) {
          await db.exec(text);
        },
        async executeSql(text, values) {
          if (values && values.length > 0) {
            const result = await db.query(text, values);
            return { rows: result.rows ?? [] };
          }

          const results = await db.exec(text);
          const last = results.at(-1) ?? { rows: [] };
          return { rows: last.rows ?? [] };
        },
        async transaction<U>(nestedCallback: (nestedClient: ManagedDatabaseClient) => Promise<U>) {
          return nestedCallback(transactionalClient);
        },
        async listen() {
          throw new Error("LISTEN is not supported inside a transaction-scoped database client.");
        },
        async close() {},
      };

      await db.exec("begin");
      try {
        const result = await callback(transactionalClient);
        await db.exec("commit");
        return result;
      } catch (error) {
        await db.exec("rollback").catch(() => undefined);
        throw error;
      }
    },
    async listen(channel, listener) {
      return await db.listen(channel, listener);
    },
    async close() {
      await closeClient?.();
      closeClient = null;
    },
  };
}

export async function getManagedDatabaseClient(repoRoot: string, namespace: string): Promise<ManagedDatabaseClient> {
  const key = `${repoRoot}:${namespace}`;
  const existing = managedClients.get(key);
  if (existing) {
    await existing.readyPromise;
    return existing.client;
  }

  let client: ManagedDatabaseClient | null = null;
  const readyPromise = (async () => {
    const connectionString = getDatabaseConnectionString();
    client = connectionString
      ? await createConnectionStringClient(connectionString)
      : await createFallbackPgliteClient(repoRoot, namespace);
  })();

  const handle: ManagedDatabaseHandle = {
    client: new Proxy({} as ManagedDatabaseClient, {
      get(_target, prop) {
        if (!client) {
          throw new Error(`Database client for ${key} is not ready.`);
        }

        return Reflect.get(client, prop);
      },
    }),
    readyPromise,
  };

  managedClients.set(key, handle);

  try {
    await readyPromise;
    return handle.client;
  } catch (error) {
    managedClients.delete(key);
    throw error;
  }
}

export async function closeManagedDatabaseClient(repoRoot: string, namespace: string): Promise<void> {
  const key = `${repoRoot}:${namespace}`;
  const handle = managedClients.get(key);
  if (!handle) {
    return;
  }

  managedClients.delete(key);
  await handle.readyPromise.catch(() => undefined);
  await handle.client.close().catch(() => undefined);
}

export async function closeAllManagedDatabaseClients(): Promise<void> {
  const entries = Array.from(managedClients.entries());
  managedClients.clear();
  await Promise.all(entries.map(async ([, handle]) => {
    await handle.readyPromise.catch(() => undefined);
    await handle.client.close().catch(() => undefined);
  }));
}
