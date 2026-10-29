import { dirname } from "node:path";
import { checkServerIdentity } from "node:tls";
import type { ClientConfig } from "pg";
import { POSTGRESQL_CA_FILE_MAX_BYTES } from "../../daemon/config.js";
import { readBoundedRegularFile } from "../../security-files.js";
import { hasUrlQueryComponent } from "../../url-display.js";
import { StorageOperationError } from "../errors.js";
import type { PostgreSqlConnectionSettings } from "./contracts.js";

export interface ParsedPostgreSqlUrl {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

function configurationError(): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_INITIALIZATION_FAILED",
    "postgresql",
    undefined,
    "factory",
    "configure",
  );
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw configurationError();
  }
}

function normalizedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function parsePostgreSqlUrl(url: string): ParsedPostgreSqlUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw configurationError();
  }
  const databasePath = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  const database = decoded(databasePath);
  const user = decoded(parsed.username);
  const password = decoded(parsed.password);
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  if (
    parsed.protocol !== "postgresql:"
    || !url.toLowerCase().startsWith("postgresql://")
    || parsed.hostname === ""
    || user === ""
    || password === ""
    || database === ""
    || database.includes("/")
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || hasUrlQueryComponent(url)
    || parsed.hash !== ""
  ) {
    throw configurationError();
  }
  return { host: normalizedHostname(parsed.hostname), port, user, password, database };
}

/**
 * Largest delay Node.js timers honour; anything above it fires after 1 ms.
 * A deadline clamped here (about 24.8 days) is an explicit limit.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Floor for the transport grace so the server's own 57014 error wins the race. */
const MIN_QUERY_GRACE_MS = 5_000;

/**
 * Client-side deadline for a query that receives no response. The server ends
 * any healthy statement within statementTimeoutMs, so the deadline adds a
 * transport grace of at least five seconds. A text with several statements
 * gets one statement budget per statement, because the server applies
 * statement_timeout to each statement of a simple-query string separately.
 */
export function postgreSqlQueryDeadlineMs(
  settings: Pick<PostgreSqlConnectionSettings, "connectionTimeoutMs" | "statementTimeoutMs">,
  statements = 1,
): number {
  const grace = Math.max(settings.connectionTimeoutMs, MIN_QUERY_GRACE_MS);
  return Math.min(settings.statementTimeoutMs * statements + grace, MAX_TIMER_DELAY_MS);
}

export function buildPostgreSqlClientConfig(
  settings: PostgreSqlConnectionSettings,
  options: { applicationName?: string; database?: string } = {},
): ClientConfig {
  const parsed = parsePostgreSqlUrl(settings.url);
  let ca: string;
  try {
    ca = readBoundedRegularFile(settings.caFile, {
      allowedRoot: dirname(settings.caFile),
      maxBytes: POSTGRESQL_CA_FILE_MAX_BYTES,
    });
  } catch {
    throw configurationError();
  }
  if (ca.length === 0) throw configurationError();
  const config = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: options.database ?? parsed.database,
    ssl: {
      ca,
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(parsed.host, certificate),
    },
    application_name: options.applicationName ?? "lcm",
    options: "-c timezone=UTC -c search_path=pg_catalog,public",
    client_encoding: "UTF8",
    replication: "false",
    sslnegotiation: "postgres",
    binary: false,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    statement_timeout: settings.statementTimeoutMs,
    idle_in_transaction_session_timeout: settings.statementTimeoutMs,
    query_timeout: postgreSqlQueryDeadlineMs(settings),
    keepAlive: true,
  } satisfies ClientConfig & {
    readonly replication: "false";
    readonly sslnegotiation: "postgres";
    readonly binary: false;
  };
  return config;
}
