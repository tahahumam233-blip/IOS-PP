# Zaki Payment Tasks

A phone-first task app for Zaki. It reads payment and withdrawal work from Google Sheets, then lets him mark items done and attach receipt/invoice files.

## Connected Sheet

The app is configured for:

- Supplier names: `A7:A100`
- IQD payments: `I7:I100`
- USD payments: `J7:J100`
- Withdrawal names: `L26:L38`
- IQD withdrawals: `M26:M38`
- USD withdrawals: `N26:N38`
- Sheet ID: `1K14ioxhRa-oCNOQ9T3DodnpNIyimkfQvsOPHP59rCbw`
- GID: `0`

Tap **Update Data** inside the phone whenever you want to fetch the latest rows and recalculate totals.

## Current Storage

The current app is a static Netlify app. It saves done/pending status and selected receipt file names in the browser's local storage so the workflow can be tested.

For real multi-user use, receipt/invoice uploads and daily completion status need a backend database and file storage, such as Supabase or Firebase. That will let Zaki's uploaded receipts be visible later from other phones/computers.

## Google Sheets Access

Static browser apps can only fetch a Google Sheet when Google allows anonymous CSV access.

If the dashboard shows an access message:

1. Open your Google Sheet.
2. Choose **File > Share > Publish to web**.
3. Publish the target tab.
4. Or set sharing so anyone with the link can view.

Private sheets require a small authenticated backend or Google OAuth flow.

## Run

Open `index.html` in a browser, or run a small local server:

```powershell
python -m http.server 5173
```

Then visit `http://localhost:5173`.
