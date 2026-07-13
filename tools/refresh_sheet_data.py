import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account


ROOT = Path(__file__).resolve().parents[1]
SPREADSHEET_ID = "1K14ioxhRa-oCNOQ9T3DodnpNIyimkfQvsOPHP59rCbw"
PAYMENT_RANGE = "PP!A7:J200"
WITHDRAWAL_RANGE = "PP!L26:N200"
DEFAULT_SERVICE_ACCOUNT = (
    Path.home()
    / "OneDrive - Sindibad Travels"
    / "Desktop"
    / "Projects"
    / "Payments Email Maker"
    / "taha-soa-90c7ef538bca.json"
)


def get_service_account_path():
    configured = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
    return Path(configured) if configured else DEFAULT_SERVICE_ACCOUNT


def fetch_values(credentials, sheet_range):
    encoded_range = quote(sheet_range, safe="")
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{encoded_range}"
    response = requests.get(
        url,
        headers={"Authorization": f"Bearer {credentials.token}"},
        params={"valueRenderOption": "FORMULA"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("values", [])


def parse_args():
    parser = argparse.ArgumentParser(description="Refresh the mobile planner sheet snapshot.")
    parser.add_argument(
        "--only-if-changed",
        action="store_true",
        help="Leave the existing snapshot untouched when both sheet ranges are unchanged.",
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

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "Sheet snapshot",
        "spreadsheetId": SPREADSHEET_ID,
        "paymentRange": PAYMENT_RANGE,
        "withdrawalRange": WITHDRAWAL_RANGE,
        "paymentsRows": fetch_values(credentials, PAYMENT_RANGE),
        "withdrawalRows": fetch_values(credentials, WITHDRAWAL_RANGE),
    }

    output_path = ROOT / "sheet-data.json"
    if args.only_if_changed and output_path.exists():
        try:
            existing = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = {}

        if (
            existing.get("paymentsRows") == payload["paymentsRows"]
            and existing.get("withdrawalRows") == payload["withdrawalRows"]
        ):
            print("Sheet rows are unchanged; snapshot was not rewritten.")
            print(f"Payment rows: {len(payload['paymentsRows'])}")
            print(f"Withdrawal rows: {len(payload['withdrawalRows'])}")
            return

    output_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {output_path}")
    print(f"Payment rows: {len(payload['paymentsRows'])}")
    print(f"Withdrawal rows: {len(payload['withdrawalRows'])}")


if __name__ == "__main__":
    main()
