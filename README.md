# IOS Payment Tracker

The live tracker is served from `index.html`. Administrators can open the control console from **Settings > Administration** or directly at `user-manager.html`.

## Production source-manager setup

Complete this once before adding Q3. Keep Q2 active throughout the setup.

### 1. Confirm the Google service account

The Supabase project must already contain either `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_BASE64` as an Edge Function secret. The sheet Edge Functions use that same project-level secret. Never put the private key in this repository.

The scheduled snapshot runs in GitHub Actions, which is a separate secret store. Add the same service-account JSON as a repository Actions secret named `GOOGLE_SERVICE_ACCOUNT_JSON`.

### 2. Install the secure source registry

Open the Supabase SQL editor for project `aaeqnlchenzybkfycelo` and run `supabase-sheet-sources.sql`. The script is idempotent, imports the current workbook as `SOA 2026 Q2 PP`, and keeps Q2 active.

### 3. Create the source-control key

Generate a 32-byte random base64url key outside Supabase. The following PowerShell prints the raw key once and its lowercase SHA-256 hash:

```powershell
$keyBytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($keyBytes)
$rng.Dispose()

$adminKey = [Convert]::ToBase64String($keyBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$sha = [System.Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($adminKey))
$sha.Dispose()
$adminKeyHash = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()

"Source-control key - save in a password manager: $adminKey"
"SHA-256 hash - store in Supabase: $adminKeyHash"
```

Save the raw source-control key in the approved password manager. Do not commit it, place it in browser storage, or paste it into SQL. Store only the printed hash:

```sql
insert into public.app_source_admin_config (id, admin_key_hash, enabled)
values ('global', '<lowercase SHA-256 hash>', true)
on conflict (id) do update
set admin_key_hash = excluded.admin_key_hash,
    enabled = true;
```

Changing this hash rotates the key and revokes existing source-control sessions.

### 4. Deploy and verify the backend

Deploy the internal range probe, then the protected manager. The probe keeps JWT verification enabled and also accepts only service-role calls from the manager. The manager's JWT check must stay disabled because it exchanges the dedicated key for its own short-lived session:

```sh
supabase functions deploy sheet-source-probe --project-ref aaeqnlchenzybkfycelo
supabase functions deploy source-admin --no-verify-jwt --project-ref aaeqnlchenzybkfycelo
```

Before replacing the live data proxy, serve this repository locally and test Q2 from the new console:

```sh
python -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/user-manager.html`, sign in as an administrator, open **Data sources**, unlock the controls with the raw source-control key, and run **Test connection** for `SOA 2026 Q2 PP`. Confirm the exact `PP` worksheet and gid, payment count, withdrawal count, and representative amounts. Do not continue until Q2 passes this live validation.

Then deploy the active-source-aware proxy:

```sh
supabase functions deploy sheet-data --project-ref aaeqnlchenzybkfycelo
```

The source-control session lasts 60 minutes. Its token exists only in JavaScript memory, so refreshing or closing the manager locks the controls again.

### 5. Regenerate the Q2 fallback and deploy the site

The strict client rejects an old snapshot that lacks complete source identity. In GitHub Actions, manually run **Refresh planner sheet snapshot** and wait for its `sheet-data.json` commit to finish. Verify that the snapshot now includes `sourceId`, `sheetName`, `sheetGid`, `layoutKey`, and `configVersion` for Q2.

Deploy the updated static site only after the backend smoke test and snapshot refresh succeed. Verify that the tracker reports Q2 as active and that the live proxy and saved snapshot identify the same source.

## Add and cut over to SOA 2026 Q3

### Prepare the workbook

1. Create the Q3 workbook or copy the current workbook.
2. Keep the supported `pp-v1` layout, or update the parser before cutover:

   - Payments use 10 columns. Provider name is the first returned column, IQD is column 9, and USD is column 10. The current range is `A7:J200`.
   - Withdrawals use 3 columns: name, IQD, and USD. The current range is `L26:N200`.
   - Both ranges normally live on the `PP` worksheet tab.

3. Share the workbook as **Viewer** with the `client_email` from the configured Google service-account JSON. A new service account is not needed.
4. Copy the full Google Sheet URL. Confirm that the worksheet title and the numeric `gid` in the URL identify the same tab.
5. Add representative Q3 data before testing. The safety check rejects a blank or all-zero workbook; at least one usable payment or withdrawal row must contain a positive amount.

### Stage and test Q3

1. Open **Administration > Data sources** and unlock the source controls. If the 60-minute session expired or the page was refreshed, unlock it again.
2. Select **Add Q3 source**. The Q3 name, key, worksheet, and ranges are filled in automatically; paste the Google Sheet URL and confirm the detected tab gid.

   - Name: `SOA 2026 Q3 PP`
   - Source key: `soa-2026-q3` (this identifier cannot be renamed later)
   - Google Sheet URL: the full Q3 URL
   - Worksheet tab: normally `PP`
   - Tab gid: the numeric gid from that exact `PP` tab
   - Payment range: normally `A7:J200`
   - Withdrawal range: normally `L26:N200`

3. Save the source. It is registered but does not become active.
4. Select **Test connection**. Confirm both reported counts are reasonable, then compare several payment and withdrawal names and amounts with the Q3 sheet.
5. Leave Q2 active until the planned cutover. Editing any Q3 connection field invalidates its test and requires another successful test. Successful activation tests expire after 30 minutes, so retest immediately before cutover.

### Activate and verify Q3

1. Select **Activate** for `SOA 2026 Q3 PP` and confirm the production cutover.
2. In GitHub Actions, immediately run **Refresh planner sheet snapshot**. Wait for the Q3 snapshot commit and static deployment to complete; do not rely only on the five-minute schedule.
3. Verify all of the following:

   - The public active-source lookup reports `soa-2026-q3`.
   - The `sheet-data` Edge Function returns the same Q3 source identity and expected rows.
   - The tracker shows the Q3 active-source badge and Google Sheet link.
   - Representative payment and withdrawal amounts match the Q3 workbook.
   - Completing a Q3 task does not reuse Q2 completion state.
   - `sheet-data.json` contains the Q3 identity and current source version.

Devices check for a source change about every 20 seconds, or immediately after **Update Data**.

### Roll back to Q2

Do not delete the Q2 source. If Q3 has a problem:

1. Unlock the source controls.
2. Test `SOA 2026 Q2 PP` again if its last test is not current.
3. Activate Q2.
4. Immediately run **Refresh planner sheet snapshot** in GitHub Actions.
5. Verify the live proxy, tracker, and snapshot all report Q2 again.

## Hosting and fallback notes

`source-admin` accepts browser requests only from the exact `ALLOWED_ORIGINS` list in `supabase/functions/source-admin/index.ts`. The current GitHub Pages origin and supported local preview origins are already listed. Add a new production origin before deployment if the site moves to a custom domain.

The live Supabase proxy is the primary data path. The app accepts `sheet-data.json` only when every source-identity field matches the active workbook, preventing old Q2 data from appearing silently after Q3 activation. Direct Google CSV is the final fallback and normally works only when Google permits browser access; private workbooks rely on the service-account proxy and snapshot.

## Current authentication note

The project still uses its original browser-managed login system and plaintext legacy passwords. The protected source manager adds a separate server-side gate for production source changes, but a future security phase should migrate accounts and user administration to Supabase Auth with row-level security before treating the app as an internet-facing multi-tenant system.
