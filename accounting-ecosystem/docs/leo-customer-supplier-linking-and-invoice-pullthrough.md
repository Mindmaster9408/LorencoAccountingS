# Leo: Customer↔Supplier Company Linking + Invoice Pull-Through — Research (Step 1)

> **Status: research only, no design decided, no code written.** Per Ruan's
> instruction: we work in this MD file until everything here is agreed,
> before any implementation starts. This document has two jobs: (1) restate
> the requirement precisely so we both know we mean the same thing, and (2)
> map exactly what already exists in the codebase that's relevant — reused
> correctly or not at all, on purpose. Related but distinct from
> [[charlie-leo-customer-account-integration.md]] — that one is about POS
> Account-sale balances; this one is about company-to-company customer/
> supplier linking and invoice hand-off inside Leo.

---

## 0. CORRECTION (2026-08-21, after Ruan's clarification) — the matching key is `client_code`, not `customer_number`

Section 1 below originally assumed the DB column `customers.customer_number`
was the intended matching key. That was wrong. Ruan's actual reference is
the **Lorenco Ecosystem client code** — `eco_clients.client_code`, format
`CLT-XXXXXXXX` (e.g. `CLT-38EF9A29`), already shown on the ECO Dashboard —
meant to be the ONE code that identifies a client everywhere (invoices,
whichever accountant takes over the client, etc.).

Confirmed live in the DB: `customers` already has an **`eco_client_id`**
column (FK-shaped, points at `eco_clients.id`) — used today by
`shared/routes/eco-clients.js`'s `syncToApps()` when a new eco_client is
provisioned with the POS app enabled. **`suppliers` has no equivalent
column at all** — confirmed via a live schema check. So the "customer"
side of this already has a real foundation to build on; the "supplier"
side needs a matching column added first for symmetry (see section 7).

Also confirmed: `customer_number` (the thing section 1/2 focused on) really is
just an internal, timestamp-based ID (`C-${Date.now().toString(36)}`,
generated the same way for every ordinary customer, not only mirrored
ones) — it was never meant to be a human-facing cross-company reference at
all. `client_code` is that reference. Sections 1–6 below are kept as
originally written for the history/reasoning trail, but wherever they say
"customer_number" as the matching key, read `client_code` instead.

---

## 1. The requirement, restated

Ruan's own words: *"vir Leo is dieselfde prinsiep as Charlie"* — the same
principle Charlie already has (Workstream 100: link two companies, each
side gets both a customer AND a supplier record for the other) — but built
for Leo specifically, with three pieces working together:

1. **Linking, keyed by customer number.** From Leo's Customers list, a
   customer record can be linked to the matching company on the other
   side. The match key is the **customer number** — and it must be the
   **same number already used at Charlie**, not a separately-invented
   number for this new feature. Explicit requirement: *"ek wil nie deur die
   program met 20 verskillende nr sit nie"* — one number per
   customer/relationship, consistent everywhere in the platform, not a new
   parallel numbering scheme.
2. **Request → approval, surfaced on the Supplier list.** Initiating a link
   from Company A's Customers list creates a pending request that Company
   B sees and must act on from **their Supplier list** (mirroring which
   record type each side sees the relationship through).
3. **Invoice pull-through.** Once linked, a customer invoice Company A
   raises against that customer should pull through to Company B's side as
   a matching supplier invoice, which B reviews and approves — not
   re-captured from scratch.

Ruan also flagged, from experience building the Charlie version: *"ons het
baie gesukkel... veral met die gedeelte waar ons die customers moes kry om
met mekaar te praat"* — the hard part last time was getting the linked
customer/supplier records to actually recognise each other correctly. See
section 4 for the specific bugs that caused that, so we don't repeat them.

---

## 2. What already exists — the InterCompanyNetwork engine

There is a full company-to-company relationship + invoice-trading engine
already built: `backend/inter-company/` (`network.js`, `invoice-sender.js`,
`invoice-receiver.js`, `payment-sync.js`, `routes.js`), mounted at
`/api/inter-company/*`. It is gated behind the `sean` addon module
(`requireModule('sean')` in `server.js`) — only exists at all for a company
with that module enabled.

**The relationship half is real and in active use** — via Charlie's
`modules/pos/routes/company-links.js`, which the header comment describes
as *"a thin, POS-permissioned wrapper"* around this same engine, specifically
so "POS and Accounting always see the exact same relationship state for a
company pair." This is the part behind Charlie's existing Settings →
Suppliers → Company Link feature:
- `network.enable()` — generates/persists a company-level invitation code.
- `network.findCompanies()` — matches a candidate company by **invitation
  code, tax number, VAT number, email domain, or fuzzy company name** —
  never by anything at the individual customer-record level.
- `network.createRelationship()` / `confirmRelationship()` — the
  pending → active state machine, requiring both sides to confirm.
- `ensureMirroredRecords()` (company-links.js) — once active, auto-creates
  whichever of {supplier@A, customer@A, supplier@B, customer@B} doesn't
  already exist, named after the partner company.

**The invoice-trading half exists but has never been connected to
anything.** `invoice-sender.js` / `invoice-receiver.js` / `payment-sync.js`
implement send / inbox / approve / reject / pay / reconcile against a
dedicated `inter_company_invoices` construct — but:
- Confirmed via search: **zero files anywhere in `frontend-accounting`
  reference `inter-company` at all.**
- Confirmed via reading `company-links.js` in full: its wrapper only
  exposes `lookup` / list / `confirm` / `revoke` / `permissions` /
  `statement` — it never calls `/invoices/send`, `/invoices/:id/approve`,
  or any of the payment-sync endpoints either.

So this part of the engine is real, working code with real logic in it —
but dormant. No UI in either app has ever called it.

**Critically: even if it were wired up, "approve" does not do what we now
want.** Reading `invoice-receiver.js`'s `approve()` in full: it flips the
invoice's own status, then creates one **synthetic bank-transaction row per
line item** (`store.addBankTransaction`, with a SEAN-suggested category) —
as if the invoice were an unallocated bank feed line to be categorised. It
does **not** create a `supplier_invoices` row, and never touches
`JournalService` or any real GL posting. This is a materially different,
more primitive mechanism than Leo's actual Purchase/Supplier workflow — not
something we can just "turn on" and get the requirement in section 1.3.

**The auto-generated customer number is not meaningful.**
`ensureMirroredRecords()` sets the mirrored customer's `customer_number` to
`` `C-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}` ``
— a random, non-sequential string, unrelated to the company's normal
customer numbering. This is exactly the kind of inconsistency Ruan flagged
wanting to avoid — confirms the current mirroring mechanism was never
designed with "same number everywhere" as a goal.

---

## 3. Leo's real invoice mechanisms, for comparison

- **AR (what Company A would raise against the linked customer):**
  `customer_invoices` / `customer_invoice_lines` (`customer-invoices.js`) —
  the real, live invoicing Leo already uses day to day. `POST /:id/send`
  is what actually posts to the GL via `JournalService`.
- **AP (where a pulled-through invoice would need to land for Company B):**
  `supplier_invoices` / `supplier_invoice_lines` (`suppliers.js`) — Leo's
  real bill-capture mechanism.
- **A directly useful existing precedent:** `supplierOcrDrafts.js` already
  implements "a supplier invoice arrives (via OCR, not company-link) as a
  **draft**, sits there for a human to review, and only becomes a real
  `supplier_invoices` row on explicit approval." That's structurally very
  close to what section 1.3 is asking for — worth studying as a template
  rather than inventing a new draft/approval shape from nothing.

None of `customer_invoices`, `supplier_invoice_lines`, or
`supplierOcrDrafts` currently have any relationship to `inter_company_invoices`
or to `linked_relationship_id` at all. The two worlds — Leo's real
invoicing, and the dormant inter-company invoice engine — have never been
connected.

---

## 4. Specific past struggles (why the customer/supplier records "talking to
each other" was hard) — from the Charlie build and this codebase

Both confirmed by direct code/memory review, not secondhand:

1. **A list endpoint silently missing a column broke everything downstream,
   with no visible symptom.** `GET /pos/suppliers` selected `link_status`
   and `linked_company_id` but not `linked_relationship_id`. The frontend's
   permission-checkbox save logic needed `linked_relationship_id` and got
   `null` every time — checkboxes rendered fine, looked tickable, "Supplier
   updated" toast fired, nothing ever actually saved. Took direct
   DB-timestamp checks and a temporary `alert()` to pin down. **Lesson for
   this build: whenever a list/summary screen feeds a detail action, audit
   that the list endpoint selects every column the detail action depends
   on — not just what's rendered on screen.**
2. **Denormalised status columns drift out of sync with the source of
   truth.** `suppliers.link_status` / `customers.link_status` are a cached
   copy of `inter_company_relationships.status`, kept in sync by
   `syncLinkedRecords()` — but only for relationships that go through that
   sync path. A relationship confirmed before that sync fix existed was
   left permanently stuck on `link_status = 'pending'` even though the real
   relationship was `'active'`, silently hiding that supplier from PO
   selection and hiding the whole permissions UI section. **Lesson: any
   cached/denormalised status this build introduces needs either a single
   source of truth read at request time, or an explicit backfill path for
   records that predate the sync logic — not just "sync goes forward from
   here."**
3. Related, same root cause class as #2: `syncLinkedRecords()` originally
   scoped its UPDATE to only the confirming company's own row, so the
   *initiating* side's mirrored record could stay stuck on `'pending'`
   forever even once the relationship was genuinely active on both sides.
   Fixed by dropping the `company_id` filter entirely (`relationship_id` is
   already globally unique). **Lesson: when two companies each hold their
   own copy of a shared relationship's status, a fix/sync path that updates
   "the caller's side" only is very likely wrong — it usually needs to
   touch both sides in one pass.**

---

## 5. The core design fork this document surfaces (not resolved here)

The existing InterCompanyNetwork engine's matching model is
**company-level** identity (tax number / VAT / email domain / invitation
code / fuzzy name) — deliberately so, since a relationship is fundamentally
between two companies, and either side can already trade in both
directions once linked (Workstream 100's "both a customer and a supplier
record on both sides" rule).

What's being asked for now is **customer-record-level** matching by
`customer_number` from Leo's Customers list. These are two different
starting points for "how do we find the other side":
- Reuse the existing company-level relationship engine underneath (it
  already does pending→active, both-sides-confirm, and mirrored-record
  creation correctly today) and layer customer_number matching/display on
  top of it as the entry point a bookkeeper actually uses — OR
- Treat this as a genuinely new, customer-record-first linking mechanism
  that happens to also need a company-to-company relationship underneath
  it somewhere.

Not deciding this here — flagging it as the first real fork to settle
before any design doc gets written, since it changes how much of section 2
is reusable versus how much is legacy weight to route around.

---

## 6. Open questions for Ruan (no answers assumed)

1. Confirm the fork in section 5: build on top of the existing
   relationship engine (reuse pending/active/confirm + mirrored-record
   creation, just change the matching key and entry-point screen), or
   treat it as new?
2. The dormant invoice-trading half (`invoice-sender.js`/`invoice-receiver.js`)
   — abandon it entirely and build the pull-through directly against real
   `customer_invoices` → `supplier_invoices`, or is there a reason to try to
   repair/reuse it first?
3. `customer_number` as the matching key — is this always going to be
   entered manually by whoever initiates the link (typing in the number
   they were given by their trading partner), or does it need its own
   lookup/search step first (similar to today's invitation-code lookup)?
4. Should supplier-side numbering (`supplier_number`, if/when generated for
   a mirrored record) follow the identical "same number as their own
   customer_number" rule, or is this only a customer-list-initiated flow
   for now?

No code has been written or changed as part of this document.
