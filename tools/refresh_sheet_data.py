import argparse
import json
import math
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account


ROOT = Path(__file__).resolve().parents[1]
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://aaeqnlchenzybkfycelo.supabase.co")
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZXFubGNoZW56eWJrZnljZWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ1OTUsImV4cCI6MjA5Mjg1MDU5NX0.2qHHPs2sx-WUjpTQGStbLKzjAI51NSv-xGl4wQvbU5Q",
)


def get_service_account_path():
    configured = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip()
    if not configured:
        raise RuntimeError(
            "GOOGLE_SERVICE_ACCOUNT_FILE is required and must point to the Google service-account JSON file."
        )

    path = Path(configured).expanduser()
    if not path.is_file():
        raise RuntimeError(f"GOOGLE_SERVICE_ACCOUNT_FILE does not exist or is not a file: {path}")
    return path


def response_rows(response, label):
    response.raise_for_status()
    try:
        rows = response.json()
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{label} returned invalid JSON.") from error
    if not isinstance(rows, list):
        raise RuntimeError(f"{label} returned an invalid registry response.")
    return rows


def config_version(value):
    if isinstance(value, bool):
        raise RuntimeError("The active sheet source version is invalid.")
    if isinstance(value, str) and not value.isdigit():
        raise RuntimeError("The active sheet source version is invalid.")
    if isinstance(value, float) and not value.is_integer():
        raise RuntimeError("The active sheet source version is invalid.")
    try:
        version = int(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError("The active sheet source version is invalid.") from error
    if version < 0:
        raise RuntimeError("The active sheet source version is invalid.")
    return version


def validate_source(source, version):
    if not isinstance(source, dict):
        raise RuntimeError("The active sheet source row is invalid.")

    normalized = dict(source)
    for key, label in (
        ("id", "source ID"),
        ("name", "source name"),
        ("spreadsheet_id", "spreadsheet ID"),
        ("sheet_name", "worksheet name"),
        ("sheet_gid", "worksheet gid"),
        ("payment_range", "payment range"),
        ("withdrawal_range", "withdrawal range"),
        ("layout_key", "sheet layout"),
    ):
        value = str(source.get(key, "")).strip()
        if not value:
            raise RuntimeError(f"The saved {label} is missing.")
        normalized[key] = value

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,62}", normalized["id"]):
        raise RuntimeError("The saved source ID is invalid.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,200}", normalized["spreadsheet_id"]):
        raise RuntimeError("The saved spreadsheet ID is invalid.")
    if not normalized["sheet_gid"].isdigit():
        raise RuntimeError("The saved worksheet gid is invalid.")
    if not re.fullmatch(r"[A-Za-z]+\d+:[A-Za-z]+\d+", normalized["payment_range"]):
        raise RuntimeError("The saved payment range is invalid.")
    if not re.fullmatch(r"[A-Za-z]+\d+:[A-Za-z]+\d+", normalized["withdrawal_range"]):
        raise RuntimeError("The saved withdrawal range is invalid.")

    normalized["version"] = config_version(version)
    return normalized


def fetch_active_source():
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    active_response = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/get_active_app_sheet_source",
        headers=headers,
        json={},
        timeout=15,
    )
    active_response.raise_for_status()
    try:
        payload = active_response.json()
    except (TypeError, ValueError) as error:
        raise RuntimeError("The active sheet source lookup returned invalid JSON.") from error
    response = payload[0] if isinstance(payload, list) and payload else payload
    if not isinstance(response, dict):
        raise RuntimeError("The active sheet source is missing or disabled.")
    source = response.get("source") if isinstance(response.get("source"), dict) else response
    normalized = {
        "id": source.get("source_id", source.get("id")),
        "name": source.get("source_name", source.get("name")),
        "spreadsheet_id": source.get("spreadsheet_id", source.get("spreadsheetId")),
        "sheet_name": source.get("sheet_name", source.get("sheetName")),
        "sheet_gid": source.get("sheet_gid", source.get("sheetGid")),
        "payment_range": source.get("payment_range", source.get("paymentRange")),
        "withdrawal_range": source.get("withdrawal_range", source.get("withdrawalRange")),
        "layout_key": source.get("layout_key", source.get("layoutKey")),
    }
    version = response.get("settings_version", response.get("settingsVersion", response.get("version")))
    return validate_source(normalized, version)


def qualify_range(sheet_name, cell_range):
    escaped_name = sheet_name.replace("'", "''")
    return f"'{escaped_name}'!{cell_range}"


def response_json(response, label):
    response.raise_for_status()
    try:
        data = response.json()
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{label} returned invalid JSON.") from error
    if not isinstance(data, dict):
        raise RuntimeError(f"{label} returned an invalid response.")
    return data


def validate_worksheet_identity(credentials, source):
    spreadsheet_id = source["spreadsheet_id"]
    response = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}",
        headers={"Authorization": f"Bearer {credentials.token}"},
        params={
            "fields": "sheets.properties(sheetId,title)",
            "includeGridData": "false",
            "ranges": qualify_range(source["sheet_name"], "A1"),
        },
        timeout=30,
    )
    data = response_json(response, "Google Sheets metadata")
    sheets = data.get("sheets")
    if not isinstance(sheets, list):
        raise RuntimeError("Google Sheets metadata did not include worksheet identities.")

    properties = [sheet.get("properties") for sheet in sheets if isinstance(sheet, dict)]
    properties = [item for item in properties if isinstance(item, dict)]
    named_sheet = next(
        (item for item in properties if item.get("title") == source["sheet_name"]),
        None,
    )
    if named_sheet is None:
        raise RuntimeError(
            f'The saved worksheet name "{source["sheet_name"]}" was not found in the spreadsheet.'
        )

    saved_gid = int(source["sheet_gid"])
    gid_sheet = next((item for item in properties if item.get("sheetId") == saved_gid), None)
    if gid_sheet is None:
        raise RuntimeError(
            f'The saved worksheet gid {source["sheet_gid"]} was not found in the spreadsheet.'
        )
    if named_sheet.get("sheetId") != gid_sheet.get("sheetId"):
        raise RuntimeError("The saved worksheet name and gid identify different Google Sheet tabs.")


def fetch_values(credentials, spreadsheet_id, sheet_range):
    encoded_range = quote(sheet_range, safe="")
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{encoded_range}"
    response = requests.get(
        url,
        headers={"Authorization": f"Bearer {credentials.token}"},
        params={"valueRenderOption": "FORMULA"},
        timeout=30,
    )
    data = response_json(response, f"Google Sheets range {sheet_range}")
    rows = data.get("values", [])
    if not isinstance(rows, list) or any(not isinstance(row, list) for row in rows):
        raise RuntimeError(f"Google Sheets returned invalid rows for {sheet_range}.")
    return rows


def parse_amount(value):
    if isinstance(value, bool):
        return 0
    raw = str(value if value is not None else "").strip()
    if raw.startswith("="):
        return 0
    cleaned = re.sub(r"[^\d.-]", "", raw).strip()
    try:
        amount = float(cleaned)
    except ValueError:
        return 0
    return amount if math.isfinite(amount) else 0


def row_value(row, index):
    return row[index] if index < len(row) else None


def is_summary_row(value):
    name = str(value if value is not None else "").strip().lower()
    return (
        not name
        or name == "total"
        or name.startswith("total ")
        or "total iqd" in name
        or "total usd" in name
        or name.startswith("updated")
    )


def has_meaningful_payment_row(rows):
    return any(
        str(row_value(row, 0) or "").strip()
        and (parse_amount(row_value(row, 8)) > 0 or parse_amount(row_value(row, 9)) > 0)
        for row in rows
    )


def has_meaningful_withdrawal_row(rows):
    return any(
        not is_summary_row(row_value(row, 0))
        and (parse_amount(row_value(row, 1)) > 0 or parse_amount(row_value(row, 2)) > 0)
        for row in rows
    )


def validate_usable_rows(payments_rows, withdrawal_rows):
    if not has_meaningful_payment_row(payments_rows) and not has_meaningful_withdrawal_row(
        withdrawal_rows
    ):
        raise RuntimeError("The configured ranges contain no usable payment or withdrawal rows.")


SNAPSHOT_CONTENT_FIELDS = (
    "source",
    "sourceId",
    "sourceName",
    "spreadsheetId",
    "sheetName",
    "sheetGid",
    "sheetUrl",
    "paymentRange",
    "withdrawalRange",
    "layoutKey",
    "configVersion",
    "paymentsRows",
    "withdrawalRows",
)


def same_snapshot_content(existing, payload):
    return all(existing.get(field) == payload.get(field) for field in SNAPSHOT_CONTENT_FIELDS)


def write_snapshot(output_path, payload):
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.",
        suffix=".tmp",
        dir=output_path.parent,
        text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary_file:
            json.dump(payload, temporary_file, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary_name, output_path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def parse_args():
    parser = argparse.ArgumentParser(description="Refresh the mobile planner sheet snapshot.")
    parser.add_argument(
        "--only-if-changed",
        action="store_true",
        help="Leave the existing snapshot untouched when its source configuration and rows are unchanged.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    service_account_path = get_service_account_path()
    credentials = service_account.Credentials.from_service_account_file(
        service_account_path,
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
    )
    credentials.refresh(Request())

    source = fetch_active_source()
    validate_worksheet_identity(credentials, source)
    payment_range = qualify_range(source["sheet_name"], source["payment_range"])
    withdrawal_range = qualify_range(source["sheet_name"], source["withdrawal_range"])
    payments_rows = fetch_values(credentials, source["spreadsheet_id"], payment_range)
    withdrawal_rows = fetch_values(credentials, source["spreadsheet_id"], withdrawal_range)
    validate_usable_rows(payments_rows, withdrawal_rows)

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": f"Sheet snapshot · {source['name']}",
        "sourceId": source["id"],
        "sourceName": source["name"],
        "spreadsheetId": source["spreadsheet_id"],
        "sheetName": source["sheet_name"],
        "sheetGid": str(source["sheet_gid"]),
        "sheetUrl": (
            f"https://docs.google.com/spreadsheets/d/{source['spreadsheet_id']}"
            f"/edit?gid={source['sheet_gid']}#gid={source['sheet_gid']}"
        ),
        "paymentRange": payment_range,
        "withdrawalRange": withdrawal_range,
        "layoutKey": source["layout_key"],
        "configVersion": source["version"],
        "paymentsRows": payments_rows,
        "withdrawalRows": withdrawal_rows,
    }

    output_path = ROOT / "sheet-data.json"
    if args.only_if_changed and output_path.exists():
        try:
            existing = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = {}

        if same_snapshot_content(existing, payload):
            print("Sheet source configuration and rows are unchanged; snapshot was not rewritten.")
            print(f"Payment rows: {len(payload['paymentsRows'])}")
            print(f"Withdrawal rows: {len(payload['withdrawalRows'])}")
            return

    write_snapshot(output_path, payload)
    print(f"Wrote {output_path}")
    print(f"Payment rows: {len(payload['paymentsRows'])}")
    print(f"Withdrawal rows: {len(payload['withdrawalRows'])}")


if __name__ == "__main__":
    main()
