const GOOGLE_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;

// These are exact origins. Never reflect an arbitrary Origin value.
const ALLOWED_ORIGINS = new Set([
  "https://tahahumam233-blip.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

const SOURCE_SELECT = [
  "id",
  "name",
  "spreadsheet_id",
  "sheet_name",
  "sheet_gid",
  "payment_range",
  "withdrawal_range",
  "layout_key",
  "enabled",
  "config_version",
  "tested_config_version",
  "last_test_status",
  "last_tested_at",
  "last_test_message",
  "created_at",
  "updated_at",
].join(",");

const CATALOG_SOURCE_SELECT = [
  "id",
  "name",
  "enabled",
  "config_version",
  "tested_config_version",
  "last_test_status",
  "created_at",
].join(",");

const CREATE_FIELDS = new Set([
  "id",
  "name",
  "spreadsheetId",
  "sheetName",
  "sheetGid",
  "paymentRange",
  "withdrawalRange",
  "layoutKey",
  "enabled",
]);

const EDIT_FIELDS = new Set([
  "name",
  "spreadsheetId",
  "sheetName",
  "sheetGid",
  "paymentRange",
  "withdrawalRange",
  "layoutKey",
  "enabled",
]);

type JsonObject = Record<string, unknown>;

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type SourceRow = {
  id: string;
  name: string;
  spreadsheet_id: string;
  sheet_name: string;
  sheet_gid: string;
  payment_range: string;
  withdrawal_range: string;
  layout_key: string;
  enabled: boolean;
  config_version: number | string;
  tested_config_version: number | string | null;
  last_test_status: "untested" | "success" | "error";
  last_tested_at: string | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
};

type CatalogSourceRow = Pick<
  SourceRow,
  "id" | "name" | "enabled" | "config_version" | "tested_config_version" | "last_test_status" | "created_at"
>;

type SettingsRow = {
  active_source_id: string;
  version: number | string;
  updated_at: string;
};

type SessionContext = {
  tokenHash: string;
  expiresAt: string;
  clientHash: string;
};

type SourceInput = {
  id?: string;
  name?: string;
  spreadsheetId?: string;
  sheetName?: string;
  sheetGid?: string;
  paymentRange?: string;
  withdrawalRange?: string;
  layoutKey?: string;
  enabled?: boolean;
};

type TestResult = {
  paymentRowCount: number;
  withdrawalRowCount: number;
  message: string;
};

class HttpError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class SourceTestError extends HttpError {
  constructor(code: string, message: string, status = 422) {
    super(status, code, message);
    this.name = "SourceTestError";
  }
}

let googleAccessToken = "";
let googleAccessTokenExpiresAt = 0;
let globalRateBucketHash = "";

function baseHeaders(origin: string | null) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(
  origin: string | null,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(origin), ...extraHeaders },
  });
}

function errorResponse(origin: string | null, error: unknown) {
  const safeError = error instanceof HttpError
    ? error
    : new HttpError(500, "internal_error", "The source manager could not complete the request.");
  const extraHeaders: Record<string, string> = {};
  if (safeError.retryAfterSeconds) {
    extraHeaders["Retry-After"] = String(safeError.retryAfterSeconds);
  }
  return jsonResponse(
    origin,
    { error: { code: safeError.code, message: safeError.message } },
    safeError.status,
    extraHeaders,
  );
}

function assertAllowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "origin_not_allowed", "This site is not allowed to use the source manager.");
  }
  return origin;
}

function getRuntimeConfig() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new HttpError(503, "runtime_unavailable", "The source manager is not configured.");
  }
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ""), serviceRoleKey };
}

async function databaseRequest(path: string, init: RequestInit = {}) {
  const { supabaseUrl, serviceRoleKey } = getRuntimeConfig();
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceRoleKey);
  headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers });
  } catch {
    throw new HttpError(503, "database_unavailable", "The source registry is temporarily unavailable.");
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if (response.status === 409) {
      throw new HttpError(409, "source_conflict", "A source with those identifying values already exists.");
    }
    throw new HttpError(502, "database_error", "The source registry rejected the request.");
  }
  return data;
}

async function callRpc(name: string, parameters: JsonObject) {
  return await databaseRequest(`rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(parameters),
  });
}

async function parseJsonObject(request: Request, allowEmpty = false) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "The request is too large.");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "The request is too large.");
  }
  if (!text.trim()) {
    if (allowEmpty) return {} as JsonObject;
    throw new HttpError(400, "body_required", "A JSON request body is required.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_body", "The request body must be a JSON object.");
  }
  return value as JsonObject;
}

function rejectUnknownFields(body: JsonObject, allowed: Set<string>) {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, "unknown_field", `Unsupported field: ${unknown[0]}.`);
  }
}

function requiredString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_source", `${label} is required.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new HttpError(400, "invalid_source", `${label} is invalid.`);
  }
  return normalized;
}

function normalizeSourceId(value: unknown) {
  const id = requiredString(value, "Source ID", 63).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) {
    throw new HttpError(400, "invalid_source", "Source ID must contain only lowercase letters, numbers, dashes, or underscores.");
  }
  return id;
}

function normalizeSpreadsheetId(value: unknown) {
  const id = requiredString(value, "Spreadsheet ID", 200);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(id)) {
    throw new HttpError(400, "invalid_source", "Spreadsheet ID is invalid.");
  }
  return id;
}

function normalizeSheetName(value: unknown) {
  const name = requiredString(value, "Worksheet tab", 100);
  if (/[\[\]:*?/\\]/.test(name)) {
    throw new HttpError(400, "invalid_source", "Worksheet tab contains unsupported characters.");
  }
  return name;
}

function normalizeSheetGid(value: unknown) {
  const gid = requiredString(value, "Worksheet gid", 20);
  if (!/^\d+$/.test(gid)) {
    throw new HttpError(400, "invalid_source", "Worksheet gid must be a non-negative integer.");
  }
  const numeric = Number(gid);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 2147483647) {
    throw new HttpError(400, "invalid_source", "Worksheet gid is outside the supported range.");
  }
  return String(numeric);
}

function columnNumber(column: string) {
  return column.split("").reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0);
}

function normalizeRange(value: unknown, label: string, minimumColumns: number) {
  const range = requiredString(value, label, 32).toUpperCase();
  const match = /^([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/.exec(range);
  if (!match) {
    throw new HttpError(400, "invalid_source", `${label} must be an A1 range such as A7:J200.`);
  }
  const startColumn = columnNumber(match[1]);
  const endColumn = columnNumber(match[3]);
  const startRow = Number(match[2]);
  const endRow = Number(match[4]);
  if (endColumn < startColumn || endRow < startRow || endColumn - startColumn + 1 < minimumColumns) {
    throw new HttpError(400, "invalid_source", `${label} does not cover the required pp-v1 columns.`);
  }
  return range;
}

function normalizeEnabled(value: unknown) {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_source", "Enabled must be true or false.");
  }
  return value;
}

function normalizeLayoutKey(value: unknown) {
  if (value !== "pp-v1") {
    throw new HttpError(400, "invalid_source", "Only the pp-v1 sheet layout is currently supported.");
  }
  return "pp-v1";
}

function normalizeCreateInput(body: JsonObject): Required<SourceInput> {
  rejectUnknownFields(body, CREATE_FIELDS);
  return {
    id: normalizeSourceId(body.id),
    name: requiredString(body.name, "Source name", 80),
    spreadsheetId: normalizeSpreadsheetId(body.spreadsheetId),
    sheetName: normalizeSheetName(body.sheetName),
    sheetGid: normalizeSheetGid(body.sheetGid),
    paymentRange: normalizeRange(body.paymentRange, "Payment range", 10),
    withdrawalRange: normalizeRange(body.withdrawalRange, "Withdrawal range", 3),
    layoutKey: normalizeLayoutKey(body.layoutKey),
    enabled: body.enabled === undefined ? true : normalizeEnabled(body.enabled),
  };
}

function normalizeEditInput(body: JsonObject): SourceInput {
  rejectUnknownFields(body, EDIT_FIELDS);
  if (!Object.keys(body).length) {
    throw new HttpError(400, "empty_update", "At least one source field must be provided.");
  }
  const input: SourceInput = {};
  if ("name" in body) input.name = requiredString(body.name, "Source name", 80);
  if ("spreadsheetId" in body) input.spreadsheetId = normalizeSpreadsheetId(body.spreadsheetId);
  if ("sheetName" in body) input.sheetName = normalizeSheetName(body.sheetName);
  if ("sheetGid" in body) input.sheetGid = normalizeSheetGid(body.sheetGid);
  if ("paymentRange" in body) input.paymentRange = normalizeRange(body.paymentRange, "Payment range", 10);
  if ("withdrawalRange" in body) input.withdrawalRange = normalizeRange(body.withdrawalRange, "Withdrawal range", 3);
  if ("layoutKey" in body) input.layoutKey = normalizeLayoutKey(body.layoutKey);
  if ("enabled" in body) input.enabled = normalizeEnabled(body.enabled);
  return input;
}

function sourceInputToRow(input: SourceInput) {
  const row: JsonObject = {};
  if (input.id !== undefined) row.id = input.id;
  if (input.name !== undefined) row.name = input.name;
  if (input.spreadsheetId !== undefined) row.spreadsheet_id = input.spreadsheetId;
  if (input.sheetName !== undefined) row.sheet_name = input.sheetName;
  if (input.sheetGid !== undefined) row.sheet_gid = input.sheetGid;
  if (input.paymentRange !== undefined) row.payment_range = input.paymentRange;
  if (input.withdrawalRange !== undefined) row.withdrawal_range = input.withdrawalRange;
  if (input.layoutKey !== undefined) row.layout_key = input.layoutKey;
  if (input.enabled !== undefined) row.enabled = input.enabled;
  return row;
}

function safeInteger(value: number | string, label: string) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new HttpError(502, "database_error", `The saved ${label} is invalid.`);
  }
  return numeric;
}

function publicSource(row: SourceRow, activeSourceId: string) {
  return {
    id: row.id,
    name: row.name,
    spreadsheetId: row.spreadsheet_id,
    sheetName: row.sheet_name,
    sheetGid: row.sheet_gid,
    paymentRange: row.payment_range,
    withdrawalRange: row.withdrawal_range,
    layoutKey: row.layout_key,
    enabled: row.enabled,
    configVersion: safeInteger(row.config_version, "source configuration version"),
    testedConfigVersion: row.tested_config_version === null
      ? null
      : safeInteger(row.tested_config_version, "tested configuration version"),
    lastTestStatus: row.last_test_status,
    lastTestedAt: row.last_tested_at,
    lastTestMessage: row.last_test_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: row.id === activeSourceId,
  };
}

function publicCatalogSource(row: CatalogSourceRow) {
  const configVersion = safeInteger(row.config_version, "source configuration version");
  const testedConfigVersion = row.tested_config_version === null
    ? null
    : safeInteger(row.tested_config_version, "tested configuration version");
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    isValidated: row.enabled
      && row.last_test_status === "success"
      && testedConfigVersion === configVersion,
  };
}

function publicSettings(row: SettingsRow) {
  return {
    activeSourceId: row.active_source_id,
    version: safeInteger(row.version, "settings version"),
    updatedAt: row.updated_at,
  };
}

async function getSettings() {
  const data = await databaseRequest(
    "app_sheet_settings?select=active_source_id,version,updated_at&id=eq.global&limit=1",
  );
  if (!Array.isArray(data) || data.length !== 1) {
    throw new HttpError(503, "settings_missing", "The active source setting has not been configured.");
  }
  return data[0] as SettingsRow;
}

async function getSourceRow(id: string) {
  const data = await databaseRequest(
    `app_sheet_sources?select=${SOURCE_SELECT}&id=eq.${encodeURIComponent(id)}&limit=1`,
  );
  if (!Array.isArray(data) || data.length !== 1) {
    throw new HttpError(404, "source_not_found", "The sheet source was not found.");
  }
  return data[0] as SourceRow;
}

async function getAllSourceRows() {
  const data = await databaseRequest(`app_sheet_sources?select=${SOURCE_SELECT}&order=created_at.asc`);
  if (!Array.isArray(data)) {
    throw new HttpError(502, "database_error", "The source registry returned an invalid response.");
  }
  return data as SourceRow[];
}

async function getCatalogSourceRows() {
  const data = await databaseRequest(
    `app_sheet_sources?select=${CATALOG_SOURCE_SELECT}&enabled=eq.true&order=created_at.asc`,
  );
  if (!Array.isArray(data)) {
    throw new HttpError(502, "database_error", "The source catalog returned an invalid response.");
  }
  return data as CatalogSourceRow[];
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function requestClientHash(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const connecting = request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || forwarded;
  return await sha256Hex(connecting);
}

async function getGlobalRateBucketHash() {
  if (!globalRateBucketHash) {
    globalRateBucketHash = await sha256Hex("ios-pp-source-admin-global-v1");
  }
  return globalRateBucketHash;
}

async function consumeRateLimit(
  scope: string,
  bucketHash: string,
  maxAttempts: number,
  windowSeconds: number,
  blockSeconds: number,
) {
  const result = await callRpc("source_admin_consume_rate_limit", {
    p_scope: scope,
    p_bucket_hash: bucketHash,
    p_max_attempts: maxAttempts,
    p_window_seconds: windowSeconds,
    p_block_seconds: blockSeconds,
  });
  if (!result || typeof result !== "object" || !("allowed" in result)) {
    throw new HttpError(502, "database_error", "The rate limiter returned an invalid response.");
  }
  const allowed = (result as JsonObject).allowed === true;
  const retryAfterSeconds = Number((result as JsonObject).retryAfterSeconds || 1);
  if (!allowed) {
    throw new HttpError(
      429,
      "rate_limited",
      "Too many requests. Wait before trying again.",
      Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : 60,
    );
  }
}

async function audit(
  action: string,
  outcome: "success" | "denied" | "error",
  clientHash: string,
  sourceId?: string,
  detailCode?: string,
) {
  const body: JsonObject = {
    action,
    outcome,
    client_hash: clientHash,
  };
  if (sourceId) body.source_id = sourceId;
  if (detailCode) body.detail_code = detailCode;
  try {
    await databaseRequest("app_source_admin_audit", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
  } catch {
    // Audit failure must not expose internal details or log request material.
  }
}

async function cleanupExpiredSecurityRows() {
  const cutoff = encodeURIComponent(new Date().toISOString());
  const oldRateCutoff = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  try {
    await Promise.all([
      databaseRequest(`app_source_admin_sessions?expires_at=lte.${cutoff}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      }),
      databaseRequest(`app_source_admin_rate_limits?updated_at=lt.${oldRateCutoff}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      }),
    ]);
  } catch {
    // Opportunistic cleanup is not part of the request's security decision.
  }
}

async function createSession(request: Request, origin: string | null) {
  const clientHash = await requestClientHash(request);
  await consumeRateLimit("login.client", clientHash, 8, 15 * 60, 15 * 60);
  await consumeRateLimit("login.global", await getGlobalRateBucketHash(), 2000, 15 * 60, 60);

  const body = await parseJsonObject(request);
  rejectUnknownFields(body, new Set(["adminKey"]));
  const adminKey = body.adminKey;
  if (typeof adminKey !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(adminKey)) {
    await audit("session.create", "denied", clientHash, undefined, "invalid_key");
    throw new HttpError(401, "invalid_admin_key", "The administration key is incorrect.");
  }

  const keyHash = await sha256Hex(adminKey);
  const keyVersionValue = await callRpc("source_admin_verify_key_hash", { p_key_hash: keyHash });
  const keyVersion = Number(keyVersionValue);
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    await audit("session.create", "denied", clientHash, undefined, "invalid_key");
    throw new HttpError(401, "invalid_admin_key", "The administration key is incorrect.");
  }

  const sessionToken = randomToken();
  const tokenHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await databaseRequest("app_source_admin_sessions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      token_hash: tokenHash,
      key_version: keyVersion,
      client_hash: clientHash,
      expires_at: expiresAt,
    }),
  });
  await audit("session.create", "success", clientHash);
  cleanupExpiredSecurityRows();
  return jsonResponse(origin, { sessionToken, expiresAt }, 201);
}

async function authenticateSession(request: Request): Promise<SessionContext> {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) {
    throw new HttpError(401, "session_required", "An administration session is required.");
  }
  const tokenHash = await sha256Hex(match[1]);
  const now = encodeURIComponent(new Date().toISOString());
  const data = await databaseRequest(
    `app_source_admin_sessions?select=token_hash,key_version,expires_at,client_hash&token_hash=eq.${tokenHash}&expires_at=gt.${now}&limit=1`,
  );
  if (!Array.isArray(data) || data.length !== 1) {
    throw new HttpError(401, "session_expired", "The administration session has expired.");
  }

  const session = data[0] as {
    token_hash: string;
    key_version: number | string;
    expires_at: string;
    client_hash: string;
  };
  const currentClientHash = await requestClientHash(request);
  if (session.client_hash !== currentClientHash) {
    await audit("session.verify", "denied", currentClientHash, undefined, "client_changed");
    databaseRequest(`app_source_admin_sessions?token_hash=eq.${tokenHash}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    }).catch(() => undefined);
    throw new HttpError(
      401,
      "session_context_changed",
      "The administration session is no longer valid on this connection.",
    );
  }
  const keyVersion = safeInteger(session.key_version, "administration key version");
  const configData = await databaseRequest(
    `app_source_admin_config?select=key_version&id=eq.global&enabled=eq.true&key_version=eq.${keyVersion}&limit=1`,
  );
  if (!Array.isArray(configData) || configData.length !== 1) {
    throw new HttpError(401, "session_expired", "The administration session has expired.");
  }

  databaseRequest(`app_source_admin_sessions?token_hash=eq.${tokenHash}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  }).catch(() => undefined);

  return {
    tokenHash,
    expiresAt: session.expires_at,
    clientHash: currentClientHash,
  };
}

async function deleteSession(session: SessionContext, origin: string | null) {
  await databaseRequest(`app_source_admin_sessions?token_hash=eq.${session.tokenHash}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  await audit("session.delete", "success", session.clientHash);
  return jsonResponse(origin, { ok: true });
}

async function getState(session: SessionContext, origin: string | null) {
  const [settings, sources] = await Promise.all([getSettings(), getAllSourceRows()]);
  return jsonResponse(origin, {
    sessionExpiresAt: session.expiresAt,
    settings: publicSettings(settings),
    sources: sources.map((source) => publicSource(source, settings.active_source_id)),
  });
}

async function getCatalog(origin: string | null) {
  const [settings, sources] = await Promise.all([getSettings(), getCatalogSourceRows()]);
  const active = sources.find((source) => source.id === settings.active_source_id && source.enabled);
  if (!active) {
    throw new HttpError(503, "settings_missing", "The active source is unavailable.");
  }
  return jsonResponse(origin, {
    activeSourceId: settings.active_source_id,
    sources: sources.map(publicCatalogSource),
  });
}

async function createSource(
  request: Request,
  session: SessionContext,
  origin: string | null,
) {
  const input = normalizeCreateInput(await parseJsonObject(request));
  try {
    const data = await databaseRequest("app_sheet_sources", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(sourceInputToRow(input)),
    });
    if (!Array.isArray(data) || data.length !== 1) {
      throw new HttpError(502, "database_error", "The source registry returned an invalid response.");
    }
    const settings = await getSettings();
    await audit("source.create", "success", session.clientHash, input.id);
    return jsonResponse(origin, { source: publicSource(data[0] as SourceRow, settings.active_source_id) }, 201);
  } catch (error) {
    await audit("source.create", "error", session.clientHash, input.id, errorCode(error));
    throw error;
  }
}

async function editSource(
  id: string,
  request: Request,
  session: SessionContext,
  origin: string | null,
) {
  const settings = await getSettings();
  if (settings.active_source_id === id) {
    await audit("source.edit", "denied", session.clientHash, id, "active_source");
    throw new HttpError(409, "active_source_protected", "Activate another source before editing this active source.");
  }
  await getSourceRow(id);
  const input = normalizeEditInput(await parseJsonObject(request));
  try {
    const data = await databaseRequest(
      `app_sheet_sources?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(sourceInputToRow(input)),
      },
    );
    if (!Array.isArray(data) || data.length !== 1) {
      throw new HttpError(404, "source_not_found", "The sheet source was not found.");
    }
    await audit("source.edit", "success", session.clientHash, id);
    return jsonResponse(origin, { source: publicSource(data[0] as SourceRow, settings.active_source_id) });
  } catch (error) {
    await audit("source.edit", "error", session.clientHash, id, errorCode(error));
    throw error;
  }
}

async function deleteSource(id: string, session: SessionContext, origin: string | null) {
  const settings = await getSettings();
  if (settings.active_source_id === id) {
    await audit("source.delete", "denied", session.clientHash, id, "active_source");
    throw new HttpError(409, "active_source_protected", "The active source cannot be deleted.");
  }
  await getSourceRow(id);
  try {
    const data = await databaseRequest(
      `app_sheet_sources?id=eq.${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { Prefer: "return=representation" } },
    );
    if (!Array.isArray(data) || data.length !== 1) {
      throw new HttpError(404, "source_not_found", "The sheet source was not found.");
    }
    await audit("source.delete", "success", session.clientHash, id);
    return jsonResponse(origin, { ok: true });
  } catch (error) {
    await audit("source.delete", "error", session.clientHash, id, errorCode(error));
    throw error;
  }
}

function base64UrlEncode(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function privateKeyBytes(pem: string) {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  try {
    return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(503, "google_credentials_invalid", "Google Sheets access is not configured correctly.");
  }
}

function readGoogleServiceAccount(): ServiceAccount {
  const encoded = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_BASE64");
  let raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") || "";
  if (encoded) {
    try {
      raw = new TextDecoder().decode(
        Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
      );
    } catch {
      throw new HttpError(503, "google_credentials_invalid", "Google Sheets access is not configured correctly.");
    }
  }
  if (!raw) {
    throw new HttpError(503, "google_credentials_missing", "Google Sheets access is not configured.");
  }

  let account: ServiceAccount;
  try {
    account = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new HttpError(503, "google_credentials_invalid", "Google Sheets access is not configured correctly.");
  }
  if (!account.client_email || !account.private_key) {
    throw new HttpError(503, "google_credentials_invalid", "Google Sheets access is not configured correctly.");
  }
  return account;
}

async function createGoogleAssertion(account: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(JSON.stringify({
    iss: account.client_email,
    scope: GOOGLE_SCOPE,
    aud: account.token_uri || GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsignedToken = `${header}.${claims}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes(account.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new HttpError(503, "google_credentials_invalid", "Google Sheets access is not configured correctly.");
  }
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );
  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getGoogleAccessToken() {
  if (googleAccessToken && Date.now() < googleAccessTokenExpiresAt - 60_000) {
    return googleAccessToken;
  }
  const account = readGoogleServiceAccount();
  const assertion = await createGoogleAssertion(account);
  let response: Response;
  try {
    response = await fetch(account.token_uri || GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(503, "google_unavailable", "Google Sheets authentication is temporarily unavailable.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new HttpError(503, "google_auth_failed", "Google Sheets authentication failed.");
  }
  googleAccessToken = String(data.access_token);
  googleAccessTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return googleAccessToken;
}

function qualifyRange(sheetName: string, range: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetName)) {
    return `${sheetName}!${range}`;
  }
  return `'${sheetName.replace(/'/g, "''")}'!${range}`;
}

async function googleJson(url: string, token: string, label: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SourceTestError("google_unavailable", `Google Sheets ${label} did not respond in time.`, 503);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new SourceTestError(
        "sheet_not_accessible",
        "The spreadsheet was not found or is not shared with the configured service account.",
      );
    }
    throw new SourceTestError("google_request_failed", `Google Sheets returned status ${response.status}.`, 502);
  }
  return data;
}

async function probeSourceValues(sourceId: string) {
  const { supabaseUrl, serviceRoleKey } = getRuntimeConfig();
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/sheet-source-probe`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sourceId }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new SourceTestError("source_probe_unavailable", "The worksheet value check did not respond in time.", 503);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof data?.error?.code === "string" ? data.error.code : "source_probe_failed";
    let message = typeof data?.error?.message === "string"
      ? data.error.message
      : "The worksheet ranges could not be validated.";
    if (code === "sheet_has_no_usable_data") {
      const paymentRows = Number(data?.error?.details?.paymentRowsReturned);
      const withdrawalRows = Number(data?.error?.details?.withdrawalRowsReturned);
      if (Number.isSafeInteger(paymentRows) && paymentRows >= 0
        && Number.isSafeInteger(withdrawalRows) && withdrawalRows >= 0) {
        message += ` Google returned ${paymentRows} payment-range rows and ${withdrawalRows} withdrawal-range rows.`;
      }
    }
    const status = response.status === 422 ? 400 : 502;
    throw new SourceTestError(code, message, status);
  }
  const paymentRowCount = Number(data?.paymentRowCount);
  const withdrawalRowCount = Number(data?.withdrawalRowCount);
  if (!Number.isSafeInteger(paymentRowCount) || paymentRowCount < 0
    || !Number.isSafeInteger(withdrawalRowCount) || withdrawalRowCount < 0
    || (!paymentRowCount && !withdrawalRowCount)) {
    throw new SourceTestError("source_probe_invalid", "The worksheet value check returned an invalid result.", 502);
  }
  return { paymentRowCount, withdrawalRowCount };
}

async function testGoogleSource(source: SourceRow): Promise<TestResult> {
  const token = await getGoogleAccessToken();
  const metadataParams = new URLSearchParams({
    fields: "sheets.properties(sheetId,title)",
    includeGridData: "false",
  });
  metadataParams.append("ranges", qualifyRange(source.sheet_name, "A1"));
  const metadata = await googleJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheet_id}?${metadataParams}`,
    token,
    "worksheet validation request",
  );
  const sheets = Array.isArray(metadata?.sheets) ? metadata.sheets : null;
  if (!sheets) {
    throw new SourceTestError("google_invalid_metadata", "Google Sheets returned invalid worksheet metadata.");
  }
  const namedSheet = sheets.find((sheet: JsonObject) => sheet?.properties &&
    (sheet.properties as JsonObject).title === source.sheet_name);
  if (!namedSheet) {
    throw new SourceTestError("sheet_name_not_found", `Worksheet tab "${source.sheet_name}" was not found.`);
  }
  const savedGid = Number(source.sheet_gid);
  const gidSheet = sheets.find((sheet: JsonObject) => sheet?.properties &&
    (sheet.properties as JsonObject).sheetId === savedGid);
  if (!gidSheet) {
    throw new SourceTestError("sheet_gid_not_found", `Worksheet gid ${source.sheet_gid} was not found.`);
  }
  if ((namedSheet.properties as JsonObject).sheetId !== (gidSheet.properties as JsonObject).sheetId) {
    throw new SourceTestError("sheet_identity_mismatch", "The worksheet name and gid identify different tabs.");
  }

  const { paymentRowCount, withdrawalRowCount } = await probeSourceValues(source.id);

  return {
    paymentRowCount,
    withdrawalRowCount,
    message: `Validated ${source.sheet_name} (gid ${source.sheet_gid}): ${paymentRowCount} payment rows and ${withdrawalRowCount} withdrawal rows.`,
  };
}

async function recordTestResult(
  source: SourceRow,
  status: "success" | "error",
  message: string,
) {
  const result = await callRpc("source_admin_record_app_sheet_source_test", {
    p_source_id: source.id,
    p_config_version: safeInteger(source.config_version, "source configuration version"),
    p_status: status,
    p_message: message,
  });
  if (result !== true) {
    throw new HttpError(409, "source_changed", "The source changed while it was being tested. Test it again.");
  }
}

async function testSource(
  id: string,
  request: Request,
  session: SessionContext,
  origin: string | null,
) {
  const body = await parseJsonObject(request, true);
  rejectUnknownFields(body, new Set());
  await consumeRateLimit("test.client", session.clientHash, 12, 10 * 60, 10 * 60);
  const source = await getSourceRow(id);
  try {
    const result = await testGoogleSource(source);
    await recordTestResult(source, "success", result.message);
    const [updated, settings] = await Promise.all([getSourceRow(id), getSettings()]);
    if (
      safeInteger(updated.config_version, "source configuration version") !==
        safeInteger(source.config_version, "source configuration version") ||
      updated.last_test_status !== "success" ||
      updated.tested_config_version === null ||
      safeInteger(updated.tested_config_version, "tested configuration version") !==
        safeInteger(updated.config_version, "source configuration version")
    ) {
      throw new HttpError(409, "source_changed", "The source changed while it was being tested. Test it again.");
    }
    await audit("source.test", "success", session.clientHash, id);
    return jsonResponse(origin, {
      source: publicSource(updated, settings.active_source_id),
      test: { status: "success", ...result },
    });
  } catch (error) {
    if (error instanceof SourceTestError) {
      try {
        await recordTestResult(source, "error", error.message);
      } catch (recordError) {
        if (recordError instanceof HttpError && recordError.code === "source_changed") {
          await audit("source.test", "error", session.clientHash, id, "source_changed");
          throw recordError;
        }
      }
    }
    await audit("source.test", "error", session.clientHash, id, errorCode(error));
    throw error;
  }
}

async function activateSource(
  id: string,
  request: Request,
  session: SessionContext,
  origin: string | null,
) {
  const body = await parseJsonObject(request);
  rejectUnknownFields(body, new Set(["expectedVersion"]));
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new HttpError(400, "invalid_version", "A valid settings version is required.");
  }
  await getSourceRow(id);
  try {
    const result = await callRpc("source_admin_activate_app_sheet_source", {
      p_target_source_id: id,
      p_expected_version: expectedVersion,
    });
    if (!result || typeof result !== "object") {
      throw new HttpError(502, "database_error", "The activation transaction returned an invalid response.");
    }
    await audit("source.activate", "success", session.clientHash, id);
    return jsonResponse(origin, { settings: result });
  } catch (error) {
    await audit("source.activate", "error", session.clientHash, id, errorCode(error));
    if (error instanceof HttpError && error.code === "database_error") {
      // PostgREST intentionally hides private exception details from this public API.
      throw new HttpError(409, "activation_rejected", "Refresh the sources, test this version, and try activation again.");
    }
    throw error;
  }
}

function errorCode(error: unknown) {
  return error instanceof HttpError ? error.code.slice(0, 64) : "internal_error";
}

function routePath(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf("source-admin");
  const routeParts = functionIndex >= 0 ? parts.slice(functionIndex + 1) : parts;
  return `/${routeParts.join("/")}`.replace(/\/$/, "") || "/";
}

Deno.serve(async (request) => {
  let origin: string | null = null;
  try {
    origin = assertAllowedOrigin(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders(origin) });
    }

    const path = routePath(new URL(request.url));
    if (path === "/session" && request.method === "POST") {
      return await createSession(request, origin);
    }
    if (path === "/catalog" && request.method === "GET") {
      const clientHash = await requestClientHash(request);
      await consumeRateLimit("catalog.client", clientHash, 120, 60, 60);
      await consumeRateLimit("catalog.global", await getGlobalRateBucketHash(), 5000, 60, 60);
      return await getCatalog(origin);
    }

    const session = await authenticateSession(request);
    await consumeRateLimit("admin.client", session.clientHash, 240, 60, 60);

    if (path === "/session" && request.method === "DELETE") {
      return await deleteSession(session, origin);
    }
    if (path === "/state" && request.method === "GET") {
      return await getState(session, origin);
    }
    if (path === "/sources" && request.method === "POST") {
      return await createSource(request, session, origin);
    }

    const sourceRoute = /^\/sources\/([a-z0-9][a-z0-9_-]{1,62})(?:\/(test|activate))?$/.exec(path);
    if (sourceRoute) {
      const id = sourceRoute[1];
      const action = sourceRoute[2] || "";
      if (!action && request.method === "PATCH") {
        return await editSource(id, request, session, origin);
      }
      if (!action && request.method === "DELETE") {
        return await deleteSource(id, session, origin);
      }
      if (action === "test" && request.method === "POST") {
        return await testSource(id, request, session, origin);
      }
      if (action === "activate" && request.method === "POST") {
        return await activateSource(id, request, session, origin);
      }
    }

    throw new HttpError(404, "route_not_found", "The source-manager route was not found.");
  } catch (error) {
    return errorResponse(origin, error);
  }
});
