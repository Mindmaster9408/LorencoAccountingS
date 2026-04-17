-- Migration 015: Add logo_data (base64) column to companies
-- The existing logo_url (VARCHAR 255) was intended for URL-based logos.
-- logo_data (TEXT) stores the full base64 DataURL uploaded via the Company Details logo uploader.
-- pdf-branding.js reads this field to embed the logo in payslip PDFs.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS logo_data TEXT;
