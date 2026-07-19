const GOOGLE_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type SourceRow = {
  id: string;
  spreadsheet_id: string;
  sheet_name: string;
  sheet_gid: string;
  payment_range: string;
  withdrawal_range: string;
  enabled: boolean;
};

let accessToken = "";
let accessTokenExpiresAt = 0;

class ProbeError extends Error {
  code: string;
  status: number;
  details: Record<string, number>;

  constructor(code: string, message: string, status = 502, details: Record<string, number> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function runtimeConfig() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Runtime configuration is unavailable.");
  }
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ""), serviceRoleKey };
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
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
}

function readServiceAccount(): ServiceAccount {
  const encoded = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_BASE64");
  const raw = encoded
    ? new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)))
    : Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("Google Sheets access is not configured.");
  const account = JSON.parse(raw) as ServiceAccount;
  if (!account.client_email || !account.private_key) {
    throw new Error("Google Sheets access is not configured correctly.");
  }
  return account;
}

async function createSignedAssertion(account: ServiceAccount) {
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
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) return accessToken;
  const account = readServiceAccount();
  const assertion = await createSignedAssertion(account);
  const response = await fetch(account.token_uri || GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new Error("Google Sheets authentication failed.");
  }
  accessToken = String(data.access_token);
  accessTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return accessToken;
}

function validateSource(source: SourceRow) {
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(String(source.id || ""))) {
    throw new Error("The saved source ID is invalid.");
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(source.spreadsheet_id || ""))) {
    throw new Error("The saved spreadsheet ID is invalid.");
  }
  if (!String(source.sheet_name || "").trim() || !/^\d+$/.test(String(source.sheet_gid ?? ""))) {
    throw new Error("The saved worksheet identity is invalid.");
  }
  if (!/^[A-Za-z]+\d+:[A-Za-z]+\d+$/.test(String(source.payment_range || ""))
    || !/^[A-Za-z]+\d+:[A-Za-z]+\d+$/.test(String(source.withdrawal_range || ""))) {
    throw new Error("A saved worksheet range is invalid.");
  }
}

function qualifyRange(sheetName: string, range: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetName)) return `${sheetName}!${range}`;
  return `'${sheetName.replace(/'/g, "''")}'!${range}`;
}

async function loadSource(sourceId: string) {
  const { supabaseUrl, serviceRoleKey } = runtimeConfig();
  const path = "app_sheet_sources?select=id,spreadsheet_id,sheet_name,sheet_gid,payment_range,withdrawal_range,enabled"
    + `&id=eq.${encodeURIComponent(sourceId)}&enabled=eq.true&limit=1`;
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data) || data.length !== 1) {
    throw new Error("The requested source is unavailable.");
  }
  const source = data[0] as SourceRow;
  validateSource(source);
  return source;
}

function parseAmount(value: unknown) {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("=")) return 0;
  const amount = Number(raw.replace(/[^\d.-]/g, "").trim());
  return Number.isFinite(amount) ? amount : 0;
}

function isSummaryRow(value: unknown) {
  const name = String(value ?? "").trim().toLowerCase();
  return !name || name === "total" || name.startsWith("total ") || name.startsWith("updated");
}

function valueRows(value: unknown, label: string) {
  if (value === undefined) return [] as unknown[][];
  if (!Array.isArray(value) || value.some((row) => !Array.isArray(row))) {
    throw new ProbeError("google_invalid_rows", `Google Sheets returned invalid ${label} rows.`);
  }
  return value as unknown[][];
}

async function probeSource(source: SourceRow) {
  const token = await getGoogleAccessToken();
  const params = new URLSearchParams({
    majorDimension: "ROWS",
    valueRenderOption: "FORMULA",
  });
  params.append("ranges", qualifyRange(source.sheet_name, source.payment_range));
  params.append("ranges", qualifyRange(source.sheet_name, source.withdrawal_range));
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheet_id}/values:batchGet?${params}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ProbeError(
      "google_request_failed",
      `Google Sheets returned status ${response.status}.`,
      502,
      { googleStatus: response.status },
    );
  }
  if (!Array.isArray(data?.valueRanges) || data.valueRanges.length !== 2) {
    throw new ProbeError("google_missing_ranges", "Google Sheets did not return both configured ranges.");
  }
  const paymentRows = valueRows(data.valueRanges[0]?.values, "payment");
  const withdrawalRows = valueRows(data.valueRanges[1]?.values, "withdrawal");
  const paymentRowCount = paymentRows.filter((row) =>
    String(row[0] ?? "").trim() && (parseAmount(row[8]) > 0 || parseAmount(row[9]) > 0)
  ).length;
  const withdrawalRowCount = withdrawalRows.filter((row) =>
    !isSummaryRow(row[0]) && (parseAmount(row[1]) > 0 || parseAmount(row[2]) > 0)
  ).length;
  if (!paymentRowCount && !withdrawalRowCount) {
    throw new ProbeError(
      "sheet_has_no_usable_data",
      "The configured ranges returned rows, but none matched the pp-v1 payment or withdrawal layout.",
      422,
      {
        paymentRowsReturned: paymentRows.length,
        withdrawalRowsReturned: withdrawalRows.length,
      },
    );
  }
  return { paymentRowCount, withdrawalRowCount };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "Not found." }, 404);
  try {
    const { serviceRoleKey } = runtimeConfig();
    const expected = `Bearer ${serviceRoleKey}`;
    if (!constantTimeEqual(request.headers.get("authorization") || "", expected)) {
      return jsonResponse({ error: "Not found." }, 404);
    }
    const body = await request.json().catch(() => null);
    const sourceId = String(body?.sourceId || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(sourceId)) {
      return jsonResponse({ error: "Invalid source." }, 400);
    }
    const source = await loadSource(sourceId);
    const result = await probeSource(source);
    return jsonResponse(result);
  } catch (error) {
    console.error("sheet-source-probe failed", error instanceof Error ? error.message : "Unknown error");
    if (error instanceof ProbeError) {
      return jsonResponse({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      }, error.status);
    }
    return jsonResponse({
      error: {
        code: "source_probe_failed",
        message: "The source probe could not validate this sheet.",
      },
    }, 502);
  }
});
