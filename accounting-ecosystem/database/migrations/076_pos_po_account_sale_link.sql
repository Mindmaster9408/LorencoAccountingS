-- Migration 076: link Purchase Orders to a real POS account sale
--
-- Purchase Order invoicing (purchase-orders.js generatePoInvoice(), now
-- createAccountSaleFromPO()) previously wrote to inter_company_invoices — a
-- standalone table that never fed Gross Profit, VAT, or Customer Reports
-- (those all read from `sales`/`sale_items`). Replaced with a real account
-- sale on the supplier's side, so this column replaces the old invoice_id
-- (inter_company_invoices) reference with a sale_id (sales) reference.
--
-- Run in: Supabase SQL Editor
-- Date: 2026-08-06

ALTER TABLE pos_purchase_orders ADD COLUMN IF NOT EXISTS sale_id INTEGER REFERENCES sales(id);
