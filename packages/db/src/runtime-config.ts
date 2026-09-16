import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  expandHomePrefix,
  resolveDefaultEmbeddedPostgresDir,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipEnvPathForConfig,
} from "@paperclipai/shared/home-paths";

const CONFIG_BASENAME = "config.json";

type PartialConfig = {
  database?: {
    mode?: "embedded-postgres" | "postgres";
    connectionString?: string;
    embeddedPostgresDataDir?: string;
    embeddedPostgresPort?: number;
    pgliteDataDir?: string;
    pglitePort?: number;
  };
};

export type ResolvedDatabaseTarget =
  | {
      mode: "postgres";
      connectionString: string;
      source:
        | "DATABASE_MIGRATION_URL"
        | "paperclip-env:DATABASE_MIGRATION_URL"
        | "cwd-env:DATABASE_MIGRATION_URL"
        | "DATABASE_URL"
        | "paperclip-env"
        | "cwd-env"
        | "config.database.connectionString";
      configPath: string;
      envPath: string;
    }
  | {
      mode: "embedded-postgres";
      dataDir: string;
      port: number;
      source: `embedded-postgres@${number}`;
      configPath: string;
      envPath: string;
    };

function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}

function findConfigFileFromAncestors(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", CONFIG_BASENAME);
    if (existsSync(candidate)) return candidate;

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) return null;
    currentDir = nextDir;
  }
}

function resolvePaperclipConfigPath(): string {
  if (process.env.PAPERCLIP_CONFIG?.trim()) {
    return path.resolve(process.env.PAPERCLIP_CONFIG.trim());
  }
  return findConfigFileFromAncestors(process.cwd()) ?? resolvePaperclipConfigPathForInstance();
}

function resolvePaperclipEnvPath(configPath: string): string {
  return resolvePaperclipEnvPathForConfig(configPath);
}

function parseEnvFile(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value) {
      entries[key] = "";
      continue;
    }

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      entries[key] = value.slice(1, -1);
      continue;
    }

    entries[key] = value.replace(/\s+#.*$/, "").trim();
  }

  return entries;
}

function readEnvEntries(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  return parseEnvFile(readFileSync(envPath, "utf8"));
}

function sameFile(firstPath: string, secondPath: string): boolean {
  if (!existsSync(firstPath) || !existsSync(secondPath)) return firstPath === secondPath;
  return realpathSync(firstPath) === realpathSync(secondPath);
}

export type DatabaseEnvironment = Record<string, string | undefined>;
export type DatabaseUrlEnvironmentKey = "DATABASE_URL" | "DATABASE_MIGRATION_URL";

export interface DatabaseEnvironmentLayers {
  configPath: string;
  paperclipEnvPath: string;
  cwdEnvPath: string;
  process: DatabaseEnvironment;
  paperclip: Record<string, string>;
  cwd: Record<string, string>;
  combined: DatabaseEnvironment;
}

export function resolveDatabaseEnvironmentLayers(): DatabaseEnvironmentLayers {
  const configPath = resolvePaperclipConfigPath();
  const paperclipEnvPath = resolvePaperclipEnvPath(configPath);
  const cwdEnvPath = path.resolve(process.cwd(), ".env");
  const paperclip = readEnvEntries(paperclipEnvPath);
  // PAPERCLIP_DISABLE_CWD_ENV_FILE mirrors server/src/env-file-policy.ts (upstream #12894,
  // used by `paperclipai test-drive` isolation).
  const cwd =
    sameFile(cwdEnvPath, paperclipEnvPath) || process.env.PAPERCLIP_DISABLE_CWD_ENV_FILE === "true"
      ? {}
      : readEnvEntries(cwdEnvPath);
  const processEntries = { ...process.env };

  return {
    configPath,
    paperclipEnvPath,
    cwdEnvPath,
    process: processEntries,
    paperclip,
    cwd,
    combined: { ...cwd, ...paperclip, ...processEntries },
  };
}

export function resolveDefinedDatabaseUrl(
  environment: DatabaseEnvironment,
  key: DatabaseUrlEnvironmentKey,
): string | undefined {
  const value = environment[key];
  if (value === undefined) return undefined;

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${key} must not be blank when defined`);
  }
  return normalized;
}

function effectiveEnvironmentLayer(
  layers: DatabaseEnvironmentLayers,
  key: DatabaseUrlEnvironmentKey,
): "process" | "paperclip" | "cwd" | undefined {
  if (layers.process[key] !== undefined) return "process";
  if (layers.paperclip[key] !== undefined) return "paperclip";
  if (layers.cwd[key] !== undefined) return "cwd";
  return undefined;
}

function migrateLegacyConfig(raw: unknown): PartialConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const config = { ...(raw as Record<string, unknown>) };
  const databaseRaw = config.database;
  if (typeof databaseRaw !== "object" || databaseRaw === null || Array.isArray(databaseRaw)) {
    return config;
  }

  const database = { ...(databaseRaw as Record<string, unknown>) };
  if (database.mode === "pglite") {
    database.mode = "embedded-postgres";

    if (
      typeof database.embeddedPostgresDataDir !== "string" &&
      typeof database.pgliteDataDir === "string"
    ) {
      database.embeddedPostgresDataDir = database.pgliteDataDir;
    }
    if (
      typeof database.embeddedPostgresPort !== "number" &&
      typeof database.pglitePort === "number" &&
      Number.isFinite(database.pglitePort)
    ) {
      database.embeddedPostgresPort = database.pglitePort;
    }
  }

  config.database = database;
  return config as PartialConfig;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

function readConfig(configPath: string): PartialConfig | null {
  if (!existsSync(configPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to parse config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const migrated = migrateLegacyConfig(parsed);
  if (migrated === null || typeof migrated !== "object" || Array.isArray(migrated)) {
    throw new Error(`Invalid config at ${configPath}: expected a JSON object`);
  }

  const database =
    typeof migrated.database === "object" &&
    migrated.database !== null &&
    !Array.isArray(migrated.database)
      ? migrated.database
      : undefined;

  return {
    database: database
      ? {
          mode: database.mode === "postgres" ? "postgres" : "embedded-postgres",
          connectionString:
            typeof database.connectionString === "string" ? database.connectionString : undefined,
          embeddedPostgresDataDir:
            typeof database.embeddedPostgresDataDir === "string"
              ? database.embeddedPostgresDataDir
              : undefined,
          embeddedPostgresPort: asPositiveInt(database.embeddedPostgresPort) ?? undefined,
          pgliteDataDir: typeof database.pgliteDataDir === "string" ? database.pgliteDataDir : undefined,
          pglitePort: asPositiveInt(database.pglitePort) ?? undefined,
        }
      : undefined,
  };
}

export function resolveDatabaseEnvironment(): DatabaseEnvironment {
  return resolveDatabaseEnvironmentLayers().combined;
}

export function loadDatabaseEnvironment(): DatabaseEnvironment {
  const environment = resolveDatabaseEnvironment();
  for (const [key, value] of Object.entries(environment)) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
  return environment;
}

export function resolveDatabaseTarget(options: {
  preferMigrationUrl?: boolean;
  environmentLayers?: DatabaseEnvironmentLayers;
} = {}): ResolvedDatabaseTarget {
  const layers = options.environmentLayers ?? resolveDatabaseEnvironmentLayers();
  const { configPath, paperclipEnvPath: envPath } = layers;

  if (options.preferMigrationUrl) {
    const migrationUrl = resolveDefinedDatabaseUrl(layers.combined, "DATABASE_MIGRATION_URL");
    if (migrationUrl !== undefined) {
      const layer = effectiveEnvironmentLayer(layers, "DATABASE_MIGRATION_URL");
      const source = layer === "process"
        ? "DATABASE_MIGRATION_URL"
        : layer === "paperclip"
          ? "paperclip-env:DATABASE_MIGRATION_URL"
          : "cwd-env:DATABASE_MIGRATION_URL";
      return { mode: "postgres", connectionString: migrationUrl, source, configPath, envPath };
    }
  }

  const databaseUrl = resolveDefinedDatabaseUrl(layers.combined, "DATABASE_URL");
  if (databaseUrl !== undefined) {
    const layer = effectiveEnvironmentLayer(layers, "DATABASE_URL");
    const source = layer === "process"
      ? "DATABASE_URL"
      : layer === "paperclip"
        ? "paperclip-env"
        : "cwd-env";
    return { mode: "postgres", connectionString: databaseUrl, source, configPath, envPath };
  }

  const config = readConfig(configPath);
  const connectionString = config?.database?.connectionString?.trim();
  if (config?.database?.mode === "postgres" && connectionString) {
    return {
      mode: "postgres",
      connectionString,
      source: "config.database.connectionString",
      configPath,
      envPath,
    };
  }

  const port = config?.database?.embeddedPostgresPort ?? 54329;
  const dataDir = resolveHomeAwarePath(
    config?.database?.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
  );

  return {
    mode: "embedded-postgres",
    dataDir,
    port,
    source: `embedded-postgres@${port}`,
    configPath,
    envPath,
  };
}
