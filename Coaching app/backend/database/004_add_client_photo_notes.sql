-- Migration 004: Add photo and notes columns to clients table
-- These fields are required for the client details tab (photo upload + coach notes).
-- Safe to run multiple times — uses IF NOT EXISTS guard.

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS photo TEXT,
    ADD COLUMN IF NOT EXISTS notes TEXT;
