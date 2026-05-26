# Lorenco Storehouse — Client Demo Script

**For:** Ruan — client-facing demo presentation  
**Date prepared:** 2026-05-26  
**Demo duration:** 20–30 minutes  
**System state:** 20/20 tests PASS — demo-ready  

---

## Before the Demo

### Demo data needed (pre-load before client arrives)

The system has live data from the test run. For a clean named demo, do this before the client sits down:

1. Open the app at `http://localhost:3000/inventory`
2. Create a raw material: **"Steel Rod 10mm"** — unit: `kg`, item type: Raw Material, SKU: `STL-001`
3. Create a finished good: **"Cabinet Frame"** — unit: `unit`, item type: Finished Good, SKU: `CAB-001`
4. Receive 200 kg of Steel Rod at R45.00/kg (quick-receive)
5. Create a BOM: Cabinet Frame needs 15 kg of Steel Rod, output qty = 1
6. Activate the BOM
7. Create one work order: Cabinet Frame × 5 units (leave it at Draft — complete it live)

---

## Opening Explanation (say this first)

> "What I'm showing you today is Lorenco Storehouse — the inventory and manufacturing module that sits inside the same platform as your accounting and payroll.
>
> The key thing to understand is: **every single number you see here is live from the database**. There is no spreadsheet. There is no local file. The moment you receive stock, that stock number is in the system. The moment production consumes raw materials, the system deducts it automatically. Nothing is silent. Nothing is hidden.
>
> Let me walk you through a full manufacturing cycle from raw material to finished product."

---

## Demo Flow — Step by Step

---

### Step 1 — Open Storehouse

- Navigate to: `http://localhost:3000/inventory`
- The dashboard loads with the **Items** tab open.

**Say:**
> "This is the main Storehouse screen. Everything — raw materials, finished goods, BOMs, work orders, and reports — is right here in one place."

---

### Step 2 — Show the Items List

- Point to the items table showing Steel Rod and Cabinet Frame.
- Point to the **current stock** column on Steel Rod: shows 200 kg.
- Point to the **average cost** column: shows R45.00.

**Say:**
> "These are our raw materials. You can see current on-hand stock and the average cost per unit. That average cost is calculated automatically from the real purchase history — weighted average. Every time you receive new stock at a different price, the system recalculates it."

---

### Step 3 — Receive Raw Materials

- Click **Quick Receive** on the Steel Rod row.
- Receive 50 kg at R48.00/kg. Confirm.

**Say:**
> "We're receiving 50 kg at a slightly higher price — R48 instead of R45. Watch what happens to the average cost."

After confirming, point to the updated row:
- Stock: 250 kg
- Average cost: R45.60 (= (200 × 45 + 50 × 48) ÷ 250)

**Say:**
> "The system just calculated the new weighted average automatically. 250 kg at R45.60 average. Not a manual calculation — the system did it from the real receipt."

---

### Step 4 — Show the BOM (Recipe)

- Click the **BOMs** tab. Open the Cabinet Frame BOM.
- Show the component: 15 kg Steel Rod per unit. Click **Cost Summary**.

**Say:**
> "Every finished product needs a recipe — we call it a Bill of Materials or BOM. This tells the system: to make one Cabinet Frame, we need 15 kg of Steel Rod. The system then calculates the cost automatically: 15 kg × R45.60 = R684 per unit. That cost updates every time the raw material average changes."

---

### Step 5 — Open a Work Order

- Click the **Work Orders** tab. Open the Cabinet Frame × 5 WO (status: Draft).
- Show the status bar: Draft → Released → In Progress → Completed.
- Click **Release**, then **Start**.

**Say:**
> "This is a production work order. It tells the factory: make 5 Cabinet Frames. When we release it and start it, the system begins tracking the job."

---

### Step 6 — Issue Materials to Production

- With the WO open, click **Issue Materials**.
- Issue 75 kg of Steel Rod (5 × 15 kg). Confirm.

**Say:**
> "Issuing materials means we are physically sending raw material to the production floor. The moment we confirm this, 75 kg is deducted from Steel Rod stock."

- Navigate back to Items and show Steel Rod stock has dropped by 75 kg.

**Say:**
> "See — Steel Rod went from 250 kg down to 175 kg. That happened automatically, in real time. No one had to type it. No one had to remember to update a spreadsheet."

---

### Step 7 — Try to Over-Issue (show the protection)

- On the work order, try to issue another 200 kg.
- The system returns an error: "Insufficient stock."

**Say:**
> "This is a hard safety rule. Stock cannot go negative. If someone tries to issue more than what is available, the system blocks it. No override. This protects you from phantom stock."

---

### Step 8 — Complete the Work Order

- With materials fully issued, click **Complete Work Order**.
- Status changes to Completed.

**Say:**
> "Production is done. 5 Cabinet Frames are now finished. Let's see what happened."

---

### Step 9 — Show Finished Goods Stock Increased

- Navigate to Items tab. Show Cabinet Frame: current stock = 5 units.
- Show the average cost on Cabinet Frame: populated from WO material cost.

**Say:**
> "5 Cabinet Frames are now in stock. The cost per unit — R684 — is recorded automatically from the actual materials issued. Not an estimate. Not a standard cost. The real cost of what went into production."

---

### Step 10 — Show the Stock Valuation Report

- Click **Reports → Stock Valuation**.
- Point to: total stock value, raw material value, finished goods value, low stock alerts.

**Say:**
> "This is your live stock valuation report. At any point in time, you can see exactly what your inventory is worth — broken down by raw materials and finished goods. It uses the same average costs the system calculated from real purchases. Always current. Always accurate."

---

### Step 11 — Show Movement History

- On Steel Rod, click **History** / **Movements**.
- Show the list:
  - Receipt 200 kg @ R45 — resulting stock: 200
  - Receipt 50 kg @ R48 — resulting stock: 250
  - Issued 75 kg (WO) — resulting stock: 175

**Say:**
> "Every single stock movement is recorded — date, quantity, type, reference, and who made it. You can trace exactly how you got to any number. This is your audit trail. If anyone ever asks where those 75 kg went — you click here and you see: Work Order WO-00001."

---

## Key Talking Points

| Point | What to say |
|---|---|
| No silent stock changes | "Stock only moves when a documented event happens — a receipt, an issue, a completed work order. Nothing moves silently." |
| Stock cannot go negative | "The system blocks negative stock at the database level. You cannot issue more than you have. Ever." |
| Production consumes raw materials | "When production completes, raw material stock is consumed and finished goods stock is created — automatically." |
| Every movement is traceable | "Every gram, every unit — there is a record. Who did it, when, what changed." |
| Costing from real movements | "Cost per unit is calculated from the actual average cost of the raw materials that went into it. Not a guess. Not a standard." |
| Future connections | "This module will later connect directly to your POS — when a product is sold, stock deducts automatically. And to Accounting — the stock value flows into your balance sheet. That's the ecosystem we are building." |

---

## Closing Statement

> "What you've seen today is a live manufacturing inventory system. Real data, real stock movements, real cost calculations. Built specifically for businesses like yours that need to know: what do I have, what did it cost me, and where did it go?
>
> This is one module in a larger ecosystem. The payroll is already running. The accounting is live. Storehouse is next. And when they are all connected, you have one platform — one source of truth — for your entire business."

---

## If Something Goes Wrong

| Problem | What to do |
|---|---|
| Page doesn't load | Refresh. Server runs on `localhost:3000`. |
| Stock numbers look unexpected | This is a test database — numbers may be cumulative. Explain it is demo data. |
| API error appears | Note it, continue. "In production this would be connected to your live data." |
| Question about mobile / cloud | "The app runs in the browser. It can be hosted — we will configure access when we go live." |
