import { configureDatabaseConnection } from "./src/server/services/database-connection-service.js";

// Vitest global setup: use in-process AI job dispatch so tests don't wait
// on pg-boss's 500ms polling floor between enqueue and worker pickup.
// Production code path is identical; only the queue layer short-circuits.
// pg-boss itself stays fully tested by dedicated contract tests.
if (!process.env.WTM_AI_JOB_INLINE) {
  process.env.WTM_AI_JOB_INLINE = "1";
}

// Tests should default to per-repo local databases unless a suite explicitly
// opts into a socket-backed/shared database connection.
delete process.env.WTM_DATABASE_URL;
delete process.env.DATABASE_URL;
configureDatabaseConnection(null);
