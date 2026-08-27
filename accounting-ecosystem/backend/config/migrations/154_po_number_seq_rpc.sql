-- =============================================================================
-- Migration 154: Create the missing nextval() RPC for PO number generation
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem (Stockton audit finding #10, 2026-08-27): routes/purchase-orders.js
-- calls supabase.rpc('nextval', { seq_name: 'po_number_seq' }) to generate
-- sequential PO numbers (LPO-2026-1042 style). The sequence itself already
-- exists (created in migration 055_inventory_procurement.sql), but no RPC
-- function was ever created to expose it through PostgREST — Postgres's
-- built-in nextval() is not callable directly via the REST API. Confirmed
-- live: the call fails with "Could not find the function public.nextval
-- (seq_name) in the schema cache". Because the route destructures seqErr but
-- never checks it, this failure was silently swallowed every single time and
-- masked by an unconditional `seqData || Date.now()` fallback — meaning
-- every PO number ever generated has been a raw millisecond timestamp, not a
-- real gap-free sequence value.
--
-- Fix: create the RPC wrapper so the real sequence is actually used. The
-- sequence name is allowlisted inside the function (rather than executing
-- an arbitrary caller-supplied identifier) since this function is exposed
-- as a public RPC — new sequences must be added to the allowlist explicitly.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.nextval(seq_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_val bigint;
BEGIN
  IF seq_name NOT IN ('po_number_seq') THEN
    RAISE EXCEPTION 'nextval(): unknown or unlisted sequence "%"', seq_name;
  END IF;

  EXECUTE format('SELECT nextval(%L)', seq_name) INTO v_val;
  RETURN v_val;
END;
$$;

GRANT EXECUTE ON FUNCTION public.nextval(text) TO service_role, authenticated;

NOTIFY pgrst, 'reload schema';

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT nextval('po_number_seq') AS direct_call_should_be_a_number;
