# 30 — LOCAL PRINT AGENT ARCHITECTURE
## Checkout Charlie — Workstream 8C

**Date:** 2026-05-21
**Status:** Architecture audit complete — ready for implementation
**Type:** Design document (no implementation yet)
**Depends on:** 27_DESKTOP_AUTO_UPDATE_ARCHITECTURE.md (PWA + Print Agent recommended)

---

## The One Unbreakable Rule

Before everything else:

> **Sale commit and print are completely separate concerns.**
> Printing failure must NEVER corrupt a sale, duplicate a sale, block a database commit, or create orphan stock movement.

This is the foundational constraint that shapes every decision below. It is not a preference. It is a hard architectural rule.

The correct execution sequence is:

```
1. POST /api/pos/sales → wait for 200 response with { saleId }
2. Update PWA UI (clear cart, show success) ← immediate, no print dependency
3. POST http://127.0.0.1:8765/print          ← happens AFTER #2, non-blocking to UX
4a. Print success → log to server (fire-and-forget)
4b. Print failure → show notification → offer reprint button
```

Step 3 is NEVER inside the try/catch of the sale commit. If the print agent is unreachable, the sale still happened. The cashier is told the printer failed. The sale record exists on the server.

---

## Recommended Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Windows Till Computer                                         │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Edge / Chrome (installed PWA — display: standalone)    │   │
│  │                                                          │   │
│  │  All business logic                                      │   │
│  │  All pricing, stock, tax, finalization                   │   │
│  │  IndexedDB offline queue (sales only)                    │   │
│  │  Source of display truth: server API                     │   │
│  └────────────────────┬────────────────────────────────────┘   │
│                       │ POST http://127.0.0.1:8765/print        │
│                       │ (same machine only — localhost binding)  │
│  ┌────────────────────▼────────────────────────────────────┐   │
│  │  Print Agent (Node.js — one-time install per till)       │   │
│  │  Windows Service (NSSM, auto-start on boot)              │   │
│  │  No business logic. No database. Hardware bridge only.   │   │
│  │                                                          │   │
│  │  Responsibilities:                                       │   │
│  │  · Accept JSON receipt from PWA                         │   │
│  │  · Convert to ESC/POS bytes                             │   │
│  │  · Write to TCP:9100 (network printer) or USB           │   │
│  │  · Send cash drawer kick via printer RJ11 port          │   │
│  │  · Return { success, jobId }                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                │
│  USB Barcode Scanner → HID keyboard emulation → browser input  │
│  Thermal Printer     ← USB or TCP:9100 from print agent        │
│  Cash Drawer         ← RJ11/RJ12 through printer port          │
└────────────────────────────────────────────────────────────────┘
                        │ HTTPS
┌───────────────────────▼────────────────────────────────────────┐
│  Zeabur (always-on)                                            │
│  Express backend + Supabase PostgreSQL                         │
│  Authoritative source for all business data                    │
│  Print event audit log (RECEIPT_PRINTED, PRINT_FAILED, etc.)  │
└────────────────────────────────────────────────────────────────┘
```

---

## 1. Communication Model

### Protocol: HTTP REST over localhost

The PWA communicates with the Print Agent via plain HTTP to `127.0.0.1:8765`.

**Why HTTP, not WebSocket:**
- Stateless — each print is an independent request with no session management
- Simple to debug (`curl http://localhost:8765/health`)
- No persistent connection to maintain
- Works without any browser extension or special permissions
- WebSocket push from Print Agent to PWA (for printer status) is a future enhancement, not required for pilot

**Why port 8765:**
- Avoids collisions with common ports: 3000 (React dev), 4000 (dev), 8080 (dev/common), 8000 (common), 5000 (Flask)
- Clearly non-standard — reduces risk of port conflict on till machines
- Easy to remember for IT support: "the POS printer is on 8765"

**Why localhost only (127.0.0.1, not 0.0.0.0):**
- The Print Agent listens exclusively on the loopback interface
- Not accessible from any other machine on the LAN
- A malicious actor on the LAN cannot reach the print agent
- Not a web service — no firewall rules needed, no exposure

**CORS on Print Agent:**
The Print Agent must respond to cross-origin requests from the PWA (which loads from the production HTTPS domain). CORS headers required:
```
Access-Control-Allow-Origin: https://checkout-charlie.yourdomain.com
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Print-Agent-Key
```
Lock `Allow-Origin` to the exact production domain. Do NOT use `*`. This prevents any webpage from sending print jobs.

---

## 2. Print Agent API Specification

All responses use HTTP 200 if the Print Agent handled the request (even if the print failed). Non-200 only for server/agent errors.

**Reasoning:** A print failure is not an HTTP failure. If the agent is running and received the request, it returns 200 with a structured body. HTTP 5xx means the agent itself broke.

### `GET /health`
```json
{
  "status": "ok",
  "version": "1.0.0",
  "apiVersion": 1,
  "printers": [
    { "id": "receipt", "name": "EPSON TM-T88", "type": "network", "host": "192.168.1.100", "port": 9100, "online": true },
    { "id": "kitchen", "name": null, "type": null, "configured": false }
  ]
}
```
The PWA calls this on startup. If no response → Print Agent not installed → disable print, fall back to `window.print()` dialog.

### `GET /printers`
Returns the same `printers` array as `/health`. Used by POS settings UI to show printer status without doing a full health check.

### `POST /print`

**Request body:**
```json
{
  "jobId": "uuid-v4",
  "target": "receipt",
  "reprint": false,
  "triggerCashDraw": true,
  "agentApiVersion": 1,
  "receipt": {
    "storeName": "Acme Bottle Store",
    "address": "12 Main Road, Cape Town",
    "vatNumber": "4200123456",
    "saleNumber": "S-20260521-0042",
    "tillNumber": "TILL-001",
    "cashier": "Jane",
    "dateTime": "2026-05-21T10:30:00+02:00",
    "items": [
      { "name": "Castle Lager 6-Pack", "qty": 2, "unitPrice": 109.99, "lineTotal": 219.98 }
    ],
    "subtotal": 219.98,
    "vatAmount": 28.69,
    "total": 219.98,
    "vatInclusive": true,
    "paymentMethod": "CASH",
    "amountTendered": 250.00,
    "change": 30.02,
    "footerNote": "Thank you for your purchase!"
  }
}
```

**Success response (HTTP 200):**
```json
{ "jobId": "uuid-v4", "success": true, "printedAt": "2026-05-21T10:30:01.234Z" }
```

**Print failure response (HTTP 200 — agent ran, printer failed):**
```json
{
  "jobId": "uuid-v4",
  "success": false,
  "error": "PRINTER_OFFLINE",
  "message": "Receipt printer not responding on 192.168.1.100:9100",
  "retriable": true
}
```

**Error codes:**
| Code | Meaning | Retriable |
|---|---|---|
| `PRINTER_OFFLINE` | TCP connection refused or timed out | Yes |
| `PRINTER_TIMEOUT` | Connected but no ACK within 8 seconds | Yes |
| `PRINTER_NOT_CONFIGURED` | No printer configured for this target | No |
| `DUPLICATE_JOB` | jobId already processed (dedup cache hit) | No |
| `INVALID_REQUEST` | Malformed request body | No |
| `PAPER_END` | Printer reported out of paper (if detectable) | Yes after paper reload |

### `GET /print/:jobId`
Status check endpoint. In-memory only. Returns `not_found` after TTL expires.
```json
{ "jobId": "uuid-v4", "status": "completed" | "failed" | "not_found" }
```

---

## 3. Security Model

### Threat model for a POS environment

The Print Agent runs on a dedicated till computer at the retail counter. The threat surface is:

| Threat | Risk | Mitigation |
|---|---|---|
| Remote attacker on LAN sending print jobs | Low — Print Agent listens on 127.0.0.1 only. Not reachable from LAN. | localhost binding |
| Local malware on till PC sending junk to Print Agent | Low — Print Agent only prints; it cannot read or write business data | Stateless design |
| Cross-site request from a malicious webpage | Medium — PWA is HTTPS, Print Agent is HTTP. Browsers block mixed-content from HTTPS pages to HTTP. | Mixed-content policy + CORS locked to production origin |
| Print job interception (man-in-the-middle on localhost) | Negligible — localhost traffic is machine-internal | localhost only |

### Mixed-content note

Modern browsers block HTTP requests from an HTTPS page by default (Mixed Active Content). Two options:

**Option A (preferred): Print Agent serves HTTPS via self-signed cert**
- Print Agent generates a self-signed cert on first run
- Cert pinned in the PWA config (delivered from server on login)
- No mixed-content block
- Downside: cert management adds setup complexity

**Option B: Localhost exemption**
- Chrome/Edge have a special exemption for `http://localhost` from HTTPS pages for development purposes
- As of Chrome 94+, `http://127.0.0.1` requests from HTTPS pages ARE allowed under the "local network access" policy
- This exemption is specifically designed for this use case (web app communicating with local services)
- Simpler for pilot — no cert management

**Pilot recommendation: Option B (localhost exemption).**
The spec browsers (Chrome/Edge on Windows) support this. If it proves unreliable, implement Option A at that point.

### Optional API key authentication

For defense-in-depth (shared PCs, multi-user environments):
- Print Agent generates a random key on first run, stores in `%ProgramData%\CheckoutCharlie\print-agent.json`
- Key is registered with the server during Print Agent setup (`POST /api/pos/print-agent/register`)
- Server delivers the key to the PWA as part of till session init
- PWA includes `X-Print-Agent-Key: <key>` header on every request
- Print Agent validates the key before processing

For the pilot on a dedicated till: skip this. Add it when the deployment has shared machines.

---

## 4. Printer Handling Model

### Connection types

| Type | Connection | ESC/POS delivery |
|---|---|---|
| Network printer (preferred for pilot) | TCP socket to printer IP:9100 | Raw TCP write |
| USB printer | node-usb or node-hid | USB bulk transfer |
| Serial printer | serialport npm package | COM port write |
| Windows Spooler printer | PDF via SumatraPDF CLI | Standard printing |

**Network printer is strongly recommended for pilot.** No USB driver issues. No COM port assignment changes. Printer can be relocated without reconfiguring the Print Agent. IP can be fixed via DHCP reservation on the router.

### ESC/POS library

`@node-escpos/core` with the `@node-escpos/network` adapter for TCP connections.
- Mature, well-tested, supports EPSON/Star/Generic ESC/POS
- Handles character encoding (important for Afrikaans special characters)
- 80mm paper width (standard SA retail thermal)

### Character encoding

South African receipts may include Afrikaans characters. Set the ESC/POS code page to `PC858` (multilingual) or configure explicitly. If characters appear garbled, this is the first thing to check.

### Printer offline detection

Before every print job, open a TCP connection with a 3-second timeout. If connection refused or timeout → return `PRINTER_OFFLINE` immediately without attempting to print. This gives fast failure feedback to the cashier.

For persistent monitoring: `GET /health` checks printer connectivity on each call. The POS can poll `/health` every 60 seconds to show a persistent "Printer offline" indicator in the status bar.

### PDF fallback

If `receipt.target === 'pdf-fallback'` or Print Agent has no ESC/POS printer configured:
- Generate a PDF using `pdfkit` (Node.js)
- 80mm wide (226 points), thermal paper-style layout
- Send to default Windows printer via `SumatraPDF.exe -print-to-default receipt.pdf`
- SumatraPDF is a free, trusted utility — bundle with Print Agent installer

The PDF fallback is slower (2–5 seconds) and requires a Windows printer driver. For pilot thermal printing, ESC/POS is the primary path.

---

## 5. Cash Drawer Trigger Flow

Cash drawers in retail connect via the printer's RJ11/RJ12 port (not directly to the PC). The printer delivers the pulse.

```
POST /print  { triggerCashDraw: true }
    ↓
Print Agent sends receipt ESC/POS bytes to printer
    ↓ (after receipt finishes)
Print Agent sends drawer kick command:
    ESC p 0 0x19 0xfa    (pulse pin 2, 25ms on, 250ms off)
    ↓
Printer's RJ11 port pulses → cash drawer latch opens
```

**Rules:**
- `triggerCashDraw: true` only when `paymentMethod === 'CASH'`
- Card payments do not open the drawer (cashier doesn't need it)
- If print fails (printer offline), `triggerCashDraw` is NOT sent — cashier opens manually using the physical key
- The drawer kick is bundled in the same print job — if the receipt prints, the drawer opens. They cannot be split without a separate print job.

**Separate drawer kick (future):** If a cashier needs to open the drawer without printing (e.g., to give change from a no-receipt customer), send a minimal "blank" print job with `triggerCashDraw: true` and an empty receipt body. The Print Agent sends just the drawer kick command — no visible receipt printed.

---

## 6. Printer Failure Handling

### The invariant: print failure never affects sale data

The print call is in the success callback of the checkout API response. The sale is already committed in the database before the first byte is sent to the printer.

```
PWA checkout():
    1. const result = await fetch('/api/pos/sales', { method: 'POST', body: saleData })
    2. if (!result.ok) → show error, STOP (sale not committed)
    3. const sale = await result.json()
    4. clearCart()                   ← sale is done, update UI immediately
    5. showSuccessModal(sale)        ← cashier sees success, no waiting for print
    6. triggerPrint(sale)            ← separate async call, does NOT affect UX flow
```

`triggerPrint()` runs independently. Its failure path is:
```
triggerPrint fails:
    → showNotification('Printer error — please reprint', 'warning')
    → set hasPrintPending = true on the sale record in UI state
    → Reprint button visible in sale success modal
    → Log PRINT_FAILED event to server (fire-and-forget)
```

### Retry strategy

```
Attempt 1: immediate
Attempt 2: after 2 seconds (if Attempt 1 fails with PRINTER_OFFLINE or PRINTER_TIMEOUT)
Attempt 3: after 4 seconds
After 3 failures: stop. Show notification. Enable Reprint button.
```

Max 3 attempts, max 10 seconds total. After that, the cashier decides. No infinite background retry — that would cause confusing duplicate receipt scenarios when the printer comes back online.

### Cashier feedback UX

| State | What cashier sees |
|---|---|
| Printing... | No visible feedback (instant for thermal printers) |
| Print success | Nothing — normal flow, sale modal visible |
| Printer offline | Yellow notification banner: "Printer unavailable — Reprint available" |
| Print failed (timeout) | Yellow notification: "Receipt did not print — tap Reprint when ready" |
| Print Agent not found | Orange notification: "Print service not running — press F12 for browser print" |

The cashier is never blocked. The sale is done. The notification is informational, not blocking.

### Reprint button

Available on:
- The sale success modal
- The till session detail view (any historical sale)
- The receipt history sidebar (future)

Reprint flow:
1. PWA fetches sale data from server (`GET /api/pos/sales/:id`)
2. Builds receipt object from server data (not from memory — server is authoritative)
3. Generates new `jobId` (UUID)
4. Sends to Print Agent with `reprint: true`
5. Print Agent adds "REPRINT" header at top of receipt
6. PWA logs `RECEIPT_REPRINTED` audit event to server (includes original saleId, new jobId, cashier, timestamp)

The "REPRINT" visual marker ensures cashiers and customers know this is a duplicate receipt.

---

## 7. Duplicate Print Prevention

### The risk

If the PWA retries a failed print job (e.g., the print succeeded but the HTTP response was lost due to a connection glitch), the same receipt could be printed twice.

### The solution: in-memory job ID deduplication

The Print Agent maintains an in-memory LRU cache of recently processed `jobId` values.

- **Capacity:** 200 entries
- **TTL:** 5 minutes
- **Scope:** Per Print Agent process (cleared on restart — acceptable since TTL covers any active retry window)

On receiving a `POST /print`:
1. Check if `jobId` is in the dedup cache
2. If YES → return `{ success: false, error: 'DUPLICATE_JOB', message: 'Already printed' }`
3. If NO → proceed to print → add `jobId` to cache → return result

**Why in-memory and not persisted?**
- Print jobs are transient. There is no reason to keep job IDs after 5 minutes.
- Persisting to disk adds complexity and a failure mode (disk full, corrupt file).
- If the Print Agent restarts, it clears its cache. A retry after restart is not a duplicate — it's a legitimate retry of an unconfirmed job.

### Reprint jobs bypass deduplication

Reprints use a NEW `jobId`. They are not retries. Deduplication does not apply. The `reprint: true` flag distinguishes them.

---

## 8. Offline Printing Behaviour

### When the internet is offline but the till is still operating

The Print Agent is on the same machine as the PWA. `http://127.0.0.1:8765` is always reachable regardless of internet connectivity. Printing continues normally during internet outages.

Receipt data for offline sales is built from the IndexedDB record (which contains all the data needed: items, prices, totals, cashier, timestamp). No server call is needed to build a receipt — the PWA has everything locally.

### Offline sale print flow

```
1. Internet offline → sale saved to IndexedDB (existing flow)
2. Print Agent is reachable → print receipt from IndexedDB data
   - Receipt shows offline sale number (OFFLINE-timestamp)
   - No "cash change" calculation (already computed client-side)
3. Internet restored → IndexedDB sale syncs to server → gets real saleNumber
4. After sync: optionally reprint with real saleNumber (cashier decision)
   - Or accept that the OFFLINE-timestamp number is in the receipt history
```

For pilot: offline receipts are printed with the temporary OFFLINE number. The receipt history in the POS will show the real sale number after sync. If the cashier or customer needs a reprinted receipt with the real number, the Reprint button handles it.

### When the Print Agent is offline (the service crashed)

NSSM restarts the service within 5 seconds. If the cashier tries to print during this window:
- HTTP request fails (connection refused)
- PWA shows "Print service unavailable — will retry in 5 seconds"
- Auto-retry once after 5 seconds
- If still unavailable: show Reprint button, fall back to `window.print()`

---

## 9. Audit Linkage

Every print event is logged to the server. This creates an auditable trail of what was printed, by whom, and whether it succeeded.

### New `pos_audit_events` event types (additions to existing table)

| Event type | Category | Triggered when |
|---|---|---|
| `RECEIPT_PRINTED` | `print` | Receipt printed successfully |
| `RECEIPT_REPRINTED` | `print` | Cashier triggered reprint |
| `PRINT_FAILED` | `print` | All retry attempts failed |
| `PRINT_AGENT_UNAVAILABLE` | `print` | No response from localhost:8765 |

### Event metadata structure

```javascript
// RECEIPT_PRINTED
{
  saleId: 'sale-uuid',
  saleNumber: 'S-20260521-0042',
  jobId: 'print-job-uuid',
  target: 'receipt',
  agentVersion: '1.0.0',
  printedAt: '2026-05-21T10:30:01.234Z'
}

// RECEIPT_REPRINTED
{
  originalSaleId: 'sale-uuid',
  originalSaleNumber: 'S-20260521-0042',
  jobId: 'new-print-job-uuid',
  reprintedBy: 'cashier@email.com',
  reprintedAt: '...',
  agentVersion: '1.0.0'
}

// PRINT_FAILED
{
  saleId: 'sale-uuid',
  jobId: 'print-job-uuid',
  error: 'PRINTER_OFFLINE',
  attempts: 3,
  lastAttemptAt: '...'
}
```

Print audit events are logged asynchronously (`POST /api/pos/audit/print-event`) and are fire-and-forget from the PWA perspective. If the log call fails, it does not affect the print result or the sale. The primary sale record is already in `pos_audit_events` from the sale commit.

---

## 10. Windows Service Strategy

### NSSM (Non-Sucking Service Manager)

NSSM wraps the Print Agent Node.js process as a Windows Service. It handles:
- Automatic start on Windows boot (before any user logs in)
- Restart on crash (configurable: restart after 5 seconds, up to 3 times per 24 hours, then alert)
- Logging stdout/stderr to rotating log files
- Start/stop via Windows Services panel or `nssm start CheckoutCharliePrintAgent`

### Distribution package

The Print Agent is distributed as a single installable package:
```
CheckoutCharliePrintAgent-1.0.0-Setup.exe
├── PrintAgent.exe         (pkg-bundled Node.js + app code, ~45MB)
├── SumatraPDF.exe         (PDF printing fallback, redistributable)
├── nssm.exe               (Service manager, public domain)
└── install.bat            (Registers service, opens config page)
```

Built with `pkg` — bundles the Node.js runtime into the executable. No Node.js installation required on the till.

### Install location

```
C:\Program Files\CheckoutCharlie\PrintAgent\
    PrintAgent.exe
    SumatraPDF.exe
    nssm.exe

%ProgramData%\CheckoutCharlie\
    print-agent.json    (config — survives app updates)
    logs\              (rotating log files)
```

### First-run setup

On first start, Print Agent:
1. Generates a random API key, saves to config
2. Opens `http://127.0.0.1:8765/setup` in the default browser
3. Setup page shows:
   - "Enter printer IP address" (or select USB device)
   - "Test print" button
   - "Save" → writes to `print-agent.json`

The cashier's supervisor completes this once when installing the agent.

### Service configuration

```
Service name: CheckoutCharliePrintAgent
Start type: Automatic
Failure action 1: Restart after 5000ms
Failure action 2: Restart after 10000ms
Failure action 3: Run script alert.bat (log to file, optional)
Reset fail count after: 24 hours
```

---

## 11. Auto-Update Strategy

### Print Agent update contract

The Print Agent version is included in every `/health` response. The PWA checks this on startup. If the Print Agent version is below the minimum required by the PWA, the PWA shows:

```
"Print service needs updating. Ask your manager to update the Print Agent."
```

The minimum required version is a configurable constant in the PWA (e.g., `MIN_PRINT_AGENT_VERSION = '1.0.0'`). Bumped only when the PWA requires a new Print Agent API feature.

### Update mechanism

**Phase 1 (Pilot): Manual update**
- When a new Print Agent version is released, the setup `.exe` is uploaded to the server
- The operator downloads it and re-runs the installer on each till
- Acceptable for pilot scale (1–3 tills)

**Phase 2 (Production): Server-triggered auto-update**
Print Agent polls `GET /api/pos/print-agent/version` on startup and every 4 hours.

```json
{
  "currentVersion": "1.2.0",
  "downloadUrl": "https://cdn.lorenco.co.za/print-agent/1.2.0/setup.exe",
  "checksum": "sha256:abc123...",
  "mandatory": false
}
```

If update available:
1. Download to temp dir
2. Verify SHA256
3. If `mandatory: true` → wait for idle (no active print jobs), then restart
4. If not mandatory → flag for next scheduled restart window (e.g., 02:00 AM)

Update never interrupts an active print job. If an update is pending during business hours, it waits until the next natural restart or until a 6-hour timeout (mandatory updates only).

### ESC/POS stability

ESC/POS commands have been standardised since the 1980s. They do not change. The Print Agent is expected to be very stable — major updates are rare. Most issues are config-level (wrong IP address, paper size) not code-level.

---

## 12. Multi-Printer and Kitchen Printer Future Support

The Print Agent config supports named printer targets from day one:

```json
{
  "printers": {
    "receipt": { "type": "network", "host": "192.168.1.100", "port": 9100 },
    "kitchen": null,
    "label": null
  }
}
```

When `kitchen` is configured, the PWA can send `{ target: 'kitchen' }` print jobs. Kitchen receipts use:
- Larger font (ESC/POS double-height text for item names)
- No prices, no VAT, no totals
- Just: item names, quantities, sale number, time
- No cash drawer trigger

The `target` field in the print job determines which printer receives it. The Print Agent routes by `target`. Neither the PWA nor the kitchen printer knows about each other.

### Multi-printer in one request (future)

`POST /print` with `targets: ['receipt', 'kitchen']` sends the receipt data to both printers. The Print Agent sends to each target, collects results, returns:

```json
{
  "success": true,
  "results": {
    "receipt": { "success": true },
    "kitchen": { "success": false, "error": "PRINTER_OFFLINE" }
  }
}
```

The PWA treats these independently: receipt success + kitchen failure shows "Kitchen printer offline" without affecting the sale.

### Barcode scanner support

USB barcode scanners work as HID (Human Interface Device) keyboard emulators. They "type" the barcode string followed by Enter into the focused browser input field. **No code changes required in the PWA or Print Agent.**

Requirements:
- Scanner must be in "USB HID Keyboard" mode (standard for most retail scanners)
- POS product search field must remain focused (handled by existing `autofocus` behaviour)

The Print Agent plays no role in barcode scanning. Scanners plug directly into the till USB port.

**Future wireless/Bluetooth scanners:** Work identically if they pair as Bluetooth HID keyboard. Web Bluetooth API would be needed only if a non-HID scanner is used — not a pilot concern.

---

## 13. Stale Print Job Cleanup

The Print Agent has no persistent queue. It does not buffer jobs.

**Philosophy:** If a print job fails, the PWA is responsible for deciding whether to retry or reprint. The Print Agent is stateless — it tries once per request and returns success or failure.

In-memory dedup cache cleanup:
- LRU eviction at 200 entries
- TTL expiry at 5 minutes per entry
- On Print Agent restart: cache is cleared (acceptable — any pending retry within 5 min would have a new jobId or been resolved)

No disk writes, no database, no persistent queue.

---

## 14. Printer Selection Persistence

| What | Where stored | Why |
|---|---|---|
| Physical printer config (IP address, port, type) | `%ProgramData%\CheckoutCharlie\print-agent.json` | Machine-level setting, survives app updates |
| Logical printer assignment (which printer = receipt) | Same config file | Machine-level |
| Per-till printer preference in POS settings | Server-side: `pos_location_settings` table | Multi-till consistency, no browser storage |
| Cashier-selected preferred printer (future) | Server-side: `user_preferences` table | Syncs across logins |

**Nothing printer-related is stored in `localStorage` or `sessionStorage`.** The Print Agent config file is the only local persistent store — it's a system-level file, not browser storage.

---

## 15. App Version Compatibility

### PWA → Print Agent version check

On first `POST /print` after page load, the PWA reads the `X-Print-Agent-Version` response header. If the Print Agent version is below `MIN_PRINT_AGENT_VERSION`:

```
PWA: Show persistent "Print Agent outdated" warning in status bar
PWA: Continue printing (degraded mode) if API is still compatible
PWA: If API is incompatible: disable print, show "Please update Print Agent"
```

### Print Agent → PWA version awareness

The Print Agent does not need to know the PWA version. It is a dumb hardware bridge. It prints what it's told.

### API versioning

Print Agent endpoint prefix: `/v1/print`. When a breaking change to the print API is needed:
- Add `/v2/print` alongside `/v1/print`
- PWA sends `agentApiVersion: 1` in the request body
- Print Agent routes accordingly
- Old clients still work against v1

For pilot: no versioning needed. Just `/print` (implied v1).

---

## 16. What Intentionally Does NOT Belong in the Print Agent

This is as important as what does belong.

| NOT allowed in Print Agent | Reason |
|---|---|
| Sale price calculation | Business logic — PWA and server are authoritative |
| Stock quantity checks | Business logic — all stock is managed server-side |
| VAT calculation | Tax compliance logic — must be on server |
| Discount or loyalty logic | Business logic |
| Customer balance checks | Business data — server only |
| Payment processing | Never in a local agent |
| Offline sale queue | IndexedDB is the sole offline queue |
| Database connection (any) | Print Agent has zero DB access |
| Auth token storage | Auth is managed by the PWA session |
| Sale confirmation logic | The sale is committed BEFORE print is called |
| Report generation | Server-side concern |
| IRP5/PAYE/payroll anything | Out of scope entirely |
| Cross-till communication | The Print Agent is per-machine only |
| Network sync to server | PWA manages all server communication |

The Print Agent knows about:
- Printer hardware
- ESC/POS command set
- Receipt layout and formatting
- Cash drawer pulse command

The Print Agent knows nothing about:
- What makes a valid sale
- Whether the price is correct
- Whether the cashier is authorized
- Whether the product is in stock

---

## 17. Failure Matrix

This table defines the correct outcome for every failure combination:

| Failure | Sale recorded? | Stock updated? | Receipt printed? | Cashier sees |
|---|---|---|---|---|
| Print Agent not installed | ✅ Yes | ✅ Yes | ❌ No | "Print service not found — use browser print" |
| Print Agent installed, printer offline | ✅ Yes | ✅ Yes | ❌ No | "Printer offline — Reprint button available" |
| Print Agent installed, printer times out | ✅ Yes | ✅ Yes | ❌ No | "Printer did not respond — Reprint button available" |
| Print partially completed (paper out) | ✅ Yes | ✅ Yes | ⚠️ Partial | "Reprint available" (cashier decides) |
| Print succeeds, HTTP response lost | ✅ Yes | ✅ Yes | ✅ Yes (printed) | Possibly sees "Print failed" — reprint dedup catches it |
| Internet offline, till operating | ✅ Queued (IndexedDB) | ✅ Estimated locally | ✅ Yes (from local data) | Offline banner, sale proceeds normally |
| Print Agent crashes during print | ✅ Yes | ✅ Yes | ❌ No | NSSM restarts agent. "Printer unavailable — Reprint" |
| Sale API fails (500 from server) | ❌ Not committed | ❌ No change | ❌ Not attempted | "Sale could not be completed — no charge made" |

In every scenario, the sale is either fully committed or fully rejected. There is no partial state. Print outcome never affects this.

---

## 18. Pilot Rollout Recommendation

### Phase 1 — Pilot (1 location, 1–2 tills)

**Printer recommendation:** Network thermal printer (EPSON TM-T88 series or equivalent).
- Fixed IP via DHCP reservation on the router
- No USB driver complexity
- Tested with `@node-escpos/network` adapter

**Setup process (per till, ~15 minutes):**
1. Run `CheckoutCharliePrintAgent-Setup.exe` (one-time)
2. Open setup page at `http://127.0.0.1:8765/setup`
3. Enter printer IP address, port 9100
4. Click "Test Print" — confirm receipt prints
5. Click "Save"
6. Open POS, confirm "Print Agent connected" status

**What to test before going live:**
- [ ] Receipt prints correctly (items, totals, VAT, change)
- [ ] Cash drawer opens on cash sales
- [ ] Cash drawer stays closed on card sales
- [ ] Reprint works from sale modal
- [ ] Reprint marks receipt as "REPRINT"
- [ ] Printer offline: sale still completes, notification shown
- [ ] Print Agent restart during operation: NSSM restarts within 10s

**What is NOT needed for pilot:**
- Auto-update mechanism (manual update is fine for 1–2 tills)
- Kitchen printer support (unless location has one)
- PDF fallback (network ESC/POS is reliable)
- API key authentication (dedicated till, no shared machines)
- Multi-printer routing (single receipt printer only)

### Phase 2 — Multi-location rollout

- Automated installer via PowerShell script or SCCM/Intune (if managed by IT)
- Server-triggered auto-update (Phase 2 implementation)
- API key authentication enabled
- Kitchen printer support activated where needed
- Centralised print health monitoring via `GET /api/pos/print-agent/status` endpoint (Print Agents ping server on startup)

---

## 19. Critical Implementation Constraints

These must be enforced in code, not just documentation:

1. **Print is called AFTER the sale API response** — never inside the sale commit block
2. **Print failure never throws** — all errors in `triggerPrint()` are caught and shown as notifications
3. **No sale data written to `localStorage`/`sessionStorage`** — receipt data passed in memory only
4. **No print job state persisted in browser** — `hasPrintPending` is UI state, not business truth
5. **Reprint fetches from server** — never from local memory or IndexedDB; receipt is rebuilt from server-authoritative sale data
6. **Print Agent config never in DB** — it's a machine-level file, not a synced setting
7. **Print Agent never opens outbound connections to the internet** — it only connects to local printer hardware and responds to localhost requests. The PWA handles all server communication.

---

## Summary — Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Communication | HTTP REST to localhost:8765 | Simple, debuggable, no browser extension |
| Security | localhost binding + CORS lock | Loopback = machine-internal; no LAN exposure |
| Mixed content | Localhost exemption (Chrome/Edge) | Simpler than self-signed cert for pilot |
| Printer connection | Network TCP:9100 (recommended) | No driver issues, relocatable |
| ESC/POS library | @node-escpos/core + network adapter | Mature, 80mm support, Afrikaans encoding |
| Windows service | NSSM | Proven, free, wraps any executable |
| Distribution | pkg single .exe + NSIS installer | No Node.js required, one-click install |
| Deduplication | In-memory LRU, 200 entries, 5 min TTL | Stateless, no disk dependency |
| Update (pilot) | Manual re-run installer | 1–2 tills; auto-update in Phase 2 |
| Cash drawer | ESC/POS kick command via printer port | Standard RJ11 pass-through, no separate wiring |
| Offline print | Always works (localhost not internet-dependent) | Print Agent on same machine as PWA |
| Audit | Server-side `pos_audit_events` + new print event types | Existing table, no schema change |
| Reprint data source | Server API (not memory/IndexedDB) | Server is authoritative for sale data |
