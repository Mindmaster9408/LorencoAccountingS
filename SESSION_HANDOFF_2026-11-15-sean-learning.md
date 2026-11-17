# Session handoff — 2026-11-13 → 2026-11-15: Sean learning (slips + bank statement formats) + Leo Send & New

Nothing in this session is committed yet (Ruan batches into one commit).

## 1. Leo invoices — "Send & New"
- `frontend-accounting/invoices.html`: "Save & New" became **Send & New** = save → post to GL → email → blank invoice. Confirm dialog first (posting is final); blocked when the annual/monthly billing option is ticked (client's choice must be recorded first). Any failure closes the modal and says how far it got (no duplicate on retry). `sendInvoiceEmail()` now returns true/false.
- Needs `SMTP_*` on Render for the email step. Syntax-checked only — not clicked through.

## 2. Slip layout learning (option B) — migration 182 RUN
- New: `backend/config/migrations/182_slip_layout_learning.sql`, `modules/slips/services/slipLayout.js`, `sean/slip-layout-learning.js`, `tests/slips-layout.test.js`.
- Changed: `slipParser.js` (optional `layout`: learned total line + date format; behaviour without a layout unchanged), `slipReader.js` (looks up the layout once a VAT number is read), `routes/slips.js` (learn on save), `sean/routes.js` + `frontend-ecosystem/sevco.html` (tab "Slip Layout Learning").
- Rule (Ruan): layout is global knowledge, the slip itself is the client's. Per company automatic (2 agreeing slips); global only after super-user approval, proposals need ≥2 companies; rejection is final; only VAT-keyed chains can go global.
- E2E 16/16 in company 51 (fictional VAT numbers, cleaned up).

## 3. Slip AI examples (option A) — no migration
- `localAiSlipJob.js`: ≤2 earlier slips from the same supplier, same company only, active + saved, total printed in their text → sent as text examples. `local-ai-worker/worker.js` puts them in the prompt ("never copy their values").
- Measured (fictional month/day/year slip, qwen2.5vl:3b on Ruan's CPU): without 6–9 s, date wrong; with 18 s, date right.
- `tests/slips-ai-examples.test.js`.

## 4. Bank statement FORMAT learning — migration 183 NOT RUN YET
- New: `backend/config/migrations/183_bank_statement_formats.sql`, `sean/bank-format/{recipeReader,formatStore,bankFormatJob}.js`, `tests/bank-format-learning.test.js`.
- Changed: `sean/pdf-statement-import-service.js` (unknown bank → try learned formats; `needsFormatLearning` when the generic parse does not reconcile; statement text only as a non-enumerable property for the server), `modules/accounting/routes/bank.js` (queue learning, `GET /bank/format-learning/:id`), `shared/routes/localAiWorker.js` (kind `bank_format`), `frontend-accounting/bank.html` (learned-format badge, "Sean is learning" box + Check now, CHECK badge on unverified rows), `sean/routes.js` + `sevco.html` (tab "Bank Statement Formats": approve for everyone / reject), `local-ai-worker/worker.js` + `config.env`/`config.example.env` (`JOB_KINDS` += `bank_format`).
- How it works: Ollama (text model) describes only the FORMAT (date format, separators, negative marker, opening/closing labels). Deterministic reader + balance chain judges: a row is verified only when a printed amount (or amount + fee, split into two rows) equals the balance change. Small model slips corrected by trying variations. Up to 3 tries with feedback. Learned format usable at once in its company; global only after approval. Statement text kept only while learning.
- Measured on real statements (local only): Investec (no parser) learned 1st try 23 s, 3/3 + closing; ABSA 1st try 34 s, 45/45 of the known parser; Capitec 1st try 25 s, 802/802 of the known parser. Standard Bank layout (date at end of line) is NOT handled by recipes — keeps its own parser.

## Testing still required
- **Run migration 183** (blocked by the permission classifier this session — Ruan must approve), then upload an Investec PDF in company 51 with the worker running: expect the "Sean is learning" box → Check now → learned → upload again → read with learned format.
- Restart the local AI worker after pulling (new prompt + new job kind).
- SEVCO tabs (slip layouts, bank formats) not opened in a browser yet.
- Real-slip accuracy for A+B still unmeasured (needs Ruan's 20–30 slips).

## Follow-ups / risks
- Learned formats: a short statement with one odd line is rejected (strict on purpose); scanned/password PDFs not covered.
- `bank_format_requests.statement_text` holds client text while learning; cleared on learned/failed. Abandoned 'retry' requests keep it — add a cleanup (e.g. >30 days) later.
