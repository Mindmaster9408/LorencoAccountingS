# Slip Capture App — Concept (Dext/Hubdoc-style)

> Status: **Phase 1 built 2026-10-19 (not yet live)** — see SESSION_HANDOFF_2026-10-19.md.
> Working name: TBD (follows the Leo / Charlie / Stockton naming style). Internal key: `slips` (proposed).
> Reference products: Dext (formerly Receipt Bank) and Hubdoc (part of Xero).

---

## 1. What it is

A phone-first app where **any user photographs a slip or invoice and it is kept safely online**.

The core is deliberately small:
1. Take a photo (or upload a PDF or image).
2. The original is stored on the server and linked to the right company.
3. The user can find it again later: list, search, open, download.

Data extraction by OCR or AI, and integrations with other accounting systems, come **after** the core. They are not part of v1.

---

## 2. Ruan's decisions (2026-10-19)

| Question | Decision |
|---|---|
| Who uses it? | **Any user** of the app, not just staff and not just the client owner. |
| Where does it live? | **Its own tile** on the Eco dashboard. |
| Separate product? | **Yes.** It must be able to be sold or used on its own, outside Eco, and must later be able to **integrate with other systems** (Xero, Sage, QuickBooks, etc.), not only with Ledger Leo. |
| Retention | **7 years.** |

---

## 3. Hard architectural rules for this app

1. **Separable by design.** Its own backend module (`backend/modules/slips/`) and its own frontend (`frontend-slips/`). Leo integration goes through an adapter interface, never through direct coupling, so Xero, Sage and QBO adapters can plug in the same way later.
2. **No browser storage for slips (Part D).** Photos go straight to server storage (Supabase Storage via `backend/shared/services/storage.js`, the same pattern the Collector uses). No offline queue in IndexedDB. If an upload fails, the user sees it immediately and retries; the photo stays in the phone's own gallery.
3. **The original is immutable.** The uploaded file is never overwritten. Store a SHA-256 hash at upload so it can be shown later that the file was not tampered with. Corrections to amounts or dates are stored as separate fields with an audit trail.
4. **7-year retention lock.** A user can "delete" (hide) a slip, but the file and record are **not physically removed** until the 7-year period has expired. Every hide or restore is audit logged.
5. **Company isolation.** Every slip is linked to a `company_id`. All queries are company-scoped.
6. **Super users see the tile automatically (Rule F1).** Add the app to `APP_DEFS`, and enable it by default on the test company (id 51 / eco_client 44) (Rule H2).
7. **Dark-native UI** from the first line of CSS (Eco dark-cosmic pattern).

---

## 4. What already exists that we build on

| Piece | Where | Use |
|---|---|---|
| File storage wrapper | `backend/shared/services/storage.js`, `backend/modules/collector/services/storageService.js` | Upload and download pattern, bucket and path structure |
| Installable PWA pattern | `frontend-pos/manifest.json` + `service-worker.js` (also Paytime) | Install on phone, home-screen icon |
| OCR plus human-approval layer | `backend/modules/accounting/routes/supplierOcrDrafts.js`, `backend/sean/invoice-ocr-service.js` | Phase 3: extraction as a draft, never accounting truth without approval |
| Bank matching | Ledger Leo | Phase 2: attach a slip to a bank transaction |

---

## 5. Phases

### Phase 1 — Capture + keep online (core, ~1–2 weeks)
- PWA with a big "Take photo" button (camera opens directly on the phone).
- Also accepts gallery images and PDFs.
- Optional quick fields: date, amount, supplier, category, note.
- Per-company archive: list, search and filter by date, supplier or amount; open, download.
- Hide (soft delete) with the 7-year lock.
- Tables (proposed): `slips` (metadata, company_id, uploaded_by, hash, storage path, retain_until) and `slip_audit_log`.

### Phase 2 — Leo integration (adapter #1)
- Attach a slip to a bank transaction or supplier invoice in Leo.
- In Leo, show "proof attached / proof missing" on transactions.

### Phase 3 — Extraction (optional, needs a decision)
- Read date, amount, VAT and supplier off the slip, **as a draft only**, which the user confirms.
- **Open decision:** external AI or cloud OCR (accurate) vs Tesseract (free, but weak on till slips). Conflicts with the "Sean uses no external LLM" intent. Ruan's call.

### Phase 4 — Standalone + external integrations
- Its own sign-up for users who are not Eco clients (ties into the user profile/invite model idea of 2026-10-01).
- Adapters for Xero, Sage and QuickBooks: push slips as attachments or bills.
- Optional: wrap it as a native app (Capacitor) for App Store and Play Store presence.
- Optional: a per-client email-in address for invoices.

---

## 6. Open questions

```
FOLLOW-UP NOTE
- Area: 7-year retention
- Dependency: legal start point
- What was done now: Ruan decided on 7 years (covers SARS's 5 years and the Companies Act's 7 years).
- What still needs to be checked: does the 7 years count from the upload date, the slip date, or the end of the financial year?
- Risk if not checked: slips removed too early.
- Recommended next review point: before Phase 1 migration is written.
```

- Working name for the app?
- Storage cost: 7 years of photos per client adds up. Compress images at upload (without losing readability), and build the cost into the price.
- Standalone pricing and billing model (Phase 4).
- Extraction: external AI yes or no (Phase 3).
