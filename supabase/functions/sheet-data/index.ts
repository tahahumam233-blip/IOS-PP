const GOOGLE_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const RESPONSE_CACHE_MS = 5000;

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type SheetSourceRow = {
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
  updated_at?: string;
};

type SheetSource = {
  id: string;
  name: string;
  spreadsheetId: string;
  sheetName: string;
  sheetGid: string;
  paymentRange: string;
  withdrawalRange: string;
  layoutKey: string;
  configVersion: number;
  updatedAt: string;
};

type SheetPayload = {
  generatedAt: string;
  source: string;
  sourceId: string;
  sourceName: string;
  spreadsheetId: string;
  sheetName: string;
  sheetGid: string;
  sheetUrl: string;
  paymentRange: string;
  withdrawalRange: string;
  layoutKey: string;
  configVersion: number;
  paymentsRows: unknown[][];
  withdrawalRows: unknown[][];
};

let accessToken = "";
let accessTokenExpiresAt = 0;
const payloadCache = new Map<string, { payload: SheetPayload; expiresAt: number }>();
const pendingSheetRequests = new Map<string, Promise<SheetPayload>>();

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
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function readServiceAccount(): ServiceAccount {
  const encoded = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_BASE64");
  const raw = encoded
    ? new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)))
    : Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("The Google service account secret is not configured.");

  const account = JSON.parse(raw) as ServiceAccount;
  if (!account.client_email || !account.private_key) {
    throw new Error("The Google service account secret is incomplete.");
  }
  return account;
}

async function createSignedAssertion(account: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(JSON.stringify({
    iss: account.client_email,
    scope: GOOGLE_SCOPE,
    aud: account.token_uri || TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsignedToken = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );
  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getGoogleAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt - 60000) return accessToken;

  const account = readServiceAccount();
  const assertion = await createSignedAssertion(account);
  const response = await fetch(account.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = await response.json();
  if (!response.ok || !token.access_token) {
    throw new Error(`Google authentication failed with status ${response.status}.`);
  }

  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
  return accessToken;
}

function sourceFromRow(row: SheetSourceRow, configVersion = 0): SheetSource {
  return {
    id: String(row.id || "").trim(),
    name: String(row.name || "").trim(),
    spreadsheetId: String(row.spreadsheet_id || "").trim(),
    sheetName: String(row.sheet_name || "").trim(),
    sheetGid: String(row.sheet_gid ?? "").trim(),
    paymentRange: String(row.payment_range || "").trim(),
    withdrawalRange: String(row.withdrawal_range || "").trim(),
    layoutKey: String(row.layout_key || "").trim(),
    configVersion,
    updatedAt: String(row.updated_at || ""),
  };
}

function validateSource(source: SheetSource) {
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(source.id)) {
    throw new Error("The saved source ID is invalid.");
  }
  if (!source.name) {
    throw new Error("The saved source name is missing.");
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(source.spreadsheetId)) {
    throw new Error("The saved spreadsheet ID is invalid.");
  }
  if (!source.sheetName) {
    throw new Error("The saved worksheet name is missing.");
  }
  if (!/^\d+$/.test(source.sheetGid)) {
    throw new Error("The saved worksheet gid is invalid.");
  }
  const sheetGid = Number(source.sheetGid);
  if (!Number.isSafeInteger(sheetGid) || sheetGid < 0) {
    throw new Error("The saved worksheet gid is outside the supported range.");
  }
  if (!/^[A-Za-z]+\d+:[A-Za-z]+\d+$/.test(source.paymentRange)) {
    throw new Error("The saved payment range is invalid.");
  }
  if (!/^[A-Za-z]+\d+:[A-Za-z]+\d+$/.test(source.withdrawalRange)) {
    throw new Error("The saved withdrawal range is invalid.");
  }
  if (!source.layoutKey) {
    throw new Error("The saved sheet layout is missing.");
  }
}

function qualifyRange(sheetName: string, range: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetName)) {
    return `${sheetName}!${range}`;
  }
  const escapedName = sheetName.replace(/'/g, "''");
  return `'${escapedName}'!${range}`;
}

function parseAmount(value: unknown) {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("=")) return 0;
  const cleaned = raw.replace(/[^\d.-]/g, "").trim();
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : 0;
}

function isSummaryRow(value: unknown) {
  const name = String(value ?? "").trim().toLowerCase();
  return !name
    || name === "total"
    || name.startsWith("total ")
    || name.includes("total iqd")
    || name.includes("total usd")
    || name.startsWith("updated");
}

function hasMeaningfulPaymentRow(rows: unknown[][]) {
  return rows.some((row) => (
    String(row[0] ?? "").trim()
    && (parseAmount(row[8]) > 0 || parseAmount(row[9]) > 0)
  ));
}

function hasMeaningfulWithdrawalRow(rows: unknown[][]) {
  return rows.some((row) => (
    !isSummaryRow(row[0])
    && (parseAmount(row[1]) > 0 || parseAmount(row[2]) > 0)
  ));
}

function rowsFromValueRange(value: unknown, label: string): unknown[][] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((row) => !Array.isArray(row))) {
    throw new Error(`Google Sheets returned invalid ${label} rows.`);
  }
  return value as unknown[][];
}

async function supabaseRows(path: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase runtime configuration is unavailable.");

  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || data?.hint || `Supabase returned ${response.status}.`;
    throw new Error(message);
  }
  if (!Array.isArray(data)) {
    throw new Error("Supabase returned an invalid source registry response.");
  }
  return data;
}

async function loadSheetSource() {
  const settingsRows = await supabaseRows(
    "app_sheet_settings?select=active_source_id,version&id=eq.global&limit=1",
  );
  if (!settingsRows.length) {
    throw new Error("The active sheet source setting is missing.");
  }

  const settings = settingsRows[0] as { active_source_id: string; version: number };
  const activeSourceId = String(settings.active_source_id || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(activeSourceId)) {
    throw new Error("The active sheet source setting is invalid.");
  }
  const configVersion = Number(settings.version);
  if (!Number.isSafeInteger(configVersion) || configVersion < 0) {
    throw new Error("The active sheet source version is invalid.");
  }
  const sourceRows = await supabaseRows(
    `app_sheet_sources?select=*&id=eq.${encodeURIComponent(activeSourceId)}&enabled=eq.true&limit=1`,
  );
  if (!sourceRows.length) throw new Error("The active sheet source is missing or disabled.");
  const sourceRow = sourceRows[0] as SheetSourceRow;
  const sourceConfigVersion = Number(sourceRow.config_version);
  const testedConfigVersion = Number(sourceRow.tested_config_version);
  if (!Number.isSafeInteger(sourceConfigVersion) || sourceConfigVersion < 1
    || sourceRow.last_test_status !== "success"
    || !Number.isSafeInteger(testedConfigVersion)
    || testedConfigVersion !== sourceConfigVersion) {
    throw new Error("The active sheet source has not passed validation for its current configuration.");
  }
  return sourceFromRow(sourceRow, configVersion);
}

async function fetchSheetPayload(source: SheetSource) {
  validateSource(source);
  const token = await getGoogleAccessToken();
  const paymentRange = qualifyRange(source.sheetName, source.paymentRange);
  const withdrawalRange = qualifyRange(source.sheetName, source.withdrawalRange);
  const params = new URLSearchParams({
    majorDimension: "ROWS",
    valueRenderOption: "FORMULA",
  });
  params.append("ranges", paymentRange);
  params.append("ranges", withdrawalRange);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}/values:batchGet?${params}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const data = await response.json();
  if (!response.ok) {
    const detail = data?.error?.message ? ` ${data.error.message}` : "";
    throw new Error(`Google Sheets returned status ${response.status}.${detail}`);
  }

  const valueRanges = data.valueRanges;
  if (!Array.isArray(valueRanges) || valueRanges.length < 2) {
    throw new Error("Google Sheets did not return both configured ranges.");
  }
  const paymentsRows = rowsFromValueRange(valueRanges[0]?.values, "payment");
  const withdrawalRows = rowsFromValueRange(valueRanges[1]?.values, "withdrawal");
  if (!hasMeaningfulPaymentRow(paymentsRows) && !hasMeaningfulWithdrawalRow(withdrawalRows)) {
    throw new Error("The configured ranges contain no usable payment or withdrawal rows.");
  }

  return {
    generatedAt: new Date().toISOString(),
    source: source.name,
    sourceId: source.id,
    sourceName: source.name,
    spreadsheetId: source.spreadsheetId,
    sheetName: source.sheetName,
    sheetGid: source.sheetGid,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit?gid=${source.sheetGid}#gid=${source.sheetGid}`,
    paymentRange,
    withdrawalRange,
    layoutKey: source.layoutKey,
    configVersion: source.configVersion,
    paymentsRows,
    withdrawalRows,
  } satisfies SheetPayload;
}

async function getSheetPayload(source: SheetSource, forceRefresh: boolean) {
  const cacheKey = JSON.stringify([
    source.id,
    source.name,
    source.spreadsheetId,
    source.sheetName,
    source.sheetGid,
    source.paymentRange,
    source.withdrawalRange,
    source.layoutKey,
    source.configVersion,
    source.updatedAt,
  ]);
  const cached = payloadCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() < cached.expiresAt) return cached.payload;

  const pending = pendingSheetRequests.get(cacheKey);
  if (pending) return pending;

  const request = fetchSheetPayload(source)
    .then((payload) => {
      payloadCache.set(cacheKey, { payload, expiresAt: Date.now() + RESPONSE_CACHE_MS });
      return payload;
    })
    .finally(() => {
      pendingSheetRequests.delete(cacheKey);
    });
  pendingSheetRequests.set(cacheKey, request);
  return request;
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = origin === "https://tahahumam233-blip.github.io"
    || origin.startsWith("http://127.0.0.1:")
    || origin.startsWith("http://localhost:")
    ? origin
    : "https://tahahumam233-blip.github.io";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
}

Deno.serve(async (request) => {
  const headers = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers });
  }

  try {
    const source = await loadSheetSource();
    const payload = await getSheetPayload(source, false);
    return new Response(JSON.stringify(payload), { status: 200, headers });
  } catch (error) {
    console.error("Live sheet fetch failed:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Live sheet fetch failed." }),
      { status: 502, headers },
    );
  }
});
