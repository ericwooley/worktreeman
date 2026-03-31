let configuredDatabaseConnectionString = process.env.WTM_DATABASE_URL ?? process.env.DATABASE_URL ?? null;

export function configureDatabaseConnection(connectionString?: string | null) {
  configuredDatabaseConnectionString = connectionString ?? null;

  if (configuredDatabaseConnectionString) {
    process.env.WTM_DATABASE_URL = configuredDatabaseConnectionString;
    return;
  }

  delete process.env.WTM_DATABASE_URL;
}

export function getDatabaseConnectionString(): string | null {
  return configuredDatabaseConnectionString ?? process.env.WTM_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
}
