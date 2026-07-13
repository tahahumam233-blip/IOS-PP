const SPREADSHEET_ID = "1K14ioxhRa-oCNOQ9T3DodnpNIyimkfQvsOPHP59rCbw";
const PAYMENT_RANGE = "PP!A7:J200";
const WITHDRAWAL_RANGE = "PP!L26:N200";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const RESPONSE_CACHE_MS = 5000;

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type SheetPayload = {
  generatedAt: string;
  source: string;
  spreadsheetId: string;
  paymentRange: string;
  withdrawalRange: string;
  paymentsRows: unknown[][];
  withdrawalRows: unknown[][];
};

let accessToken = "";
let accessTokenExpiresAt = 0;
let cachedPayload: SheetPayload | null = null;
let cachedPayloadExpiresAt = 0;
let pendingSheetRequest: Promise<SheetPayload> | null = null;

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
  });
  const token = await response.json();
  if (!response.ok || !token.access_token) {
    throw new Error(`Google authentication failed with status ${response.status}.`);
  }

  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
  return accessToken;
}

async function fetchSheetPayload() {
  const token = await getGoogleAccessToken();
  const params = new URLSearchParams({
    majorDimension: "ROWS",
    valueRenderOption: "FORMULA",
  });
  params.append("ranges", PAYMENT_RANGE);
  params.append("ranges", WITHDRAWAL_RANGE);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchGet?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google Sheets returned status ${response.status}.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "Live Google Sheet",
    spreadsheetId: SPREADSHEET_ID,
    paymentRange: PAYMENT_RANGE,
    withdrawalRange: WITHDRAWAL_RANGE,
    paymentsRows: data.valueRanges?.[0]?.values || [],
    withdrawalRows: data.valueRanges?.[1]?.values || [],
  } satisfies SheetPayload;
}

async function getSheetPayload(forceRefresh: boolean) {
  if (!forceRefresh && cachedPayload && Date.now() < cachedPayloadExpiresAt) return cachedPayload;
  if (pendingSheetRequest) return pendingSheetRequest;

  pendingSheetRequest = fetchSheetPayload()
    .then((payload) => {
      cachedPayload = payload;
      cachedPayloadExpiresAt = Date.now() + RESPONSE_CACHE_MS;
      return payload;
    })
    .finally(() => {
      pendingSheetRequest = null;
    });
  return pendingSheetRequest;
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
    const url = new URL(request.url);
    const payload = await getSheetPayload(url.searchParams.get("fresh") === "1");
    return new Response(JSON.stringify(payload), { status: 200, headers });
  } catch (error) {
    console.error("Live sheet fetch failed:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Live sheet fetch failed." }),
      { status: 502, headers },
    );
  }
});
