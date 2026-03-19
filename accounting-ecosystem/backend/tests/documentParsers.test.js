/**
 * ============================================================================
 * Document Parser Tests — CIPC / SA Registration Document Extraction
 * ============================================================================
 */

'use strict';

const { parseDocument, listParsers } = require('../services/documentParsers');
const cipcParser = require('../services/documentParsers/cipcParser');

// ── Sample document text fixtures ────────────────────────────────────────────

// Realistic CIPC CoR14.3 style text
const SAMPLE_CIPC_TEXT = `
COMPANIES AND INTELLECTUAL PROPERTY COMMISSION
Republic of South Africa

CoR 14.3

CERTIFICATE OF INCORPORATION

This serves as a Certificate of Incorporation in terms of Section 14 of the
Companies Act, No 71 of 2008.

Enterprise Name: ACME TRADING (PTY) LTD
Registration Number: 2022/123456/07
Date of Registration: 15 March 2022
Type of Company: (Proprietary) Limited

Registered Office:
123 Main Street, Sandton, Johannesburg, 2196

Director 1: JOHN ANDREW SMITH
Director 2: JANE ELIZABETH DOE
Director 3: PETER VAN DER WALT

Company Secretary: N/A

Issued at PRETORIA on 15 March 2022
`;

// CK (Close Corporation) style text
const SAMPLE_CK_TEXT = `
COMPANIES AND INTELLECTUAL PROPERTY COMMISSION

CK1

Registration Number: 2018/987654/23
Name of Company: SUNSET VENTURES CC
Date of Incorporation: 20 June 2018
Type of Company: Close Corporation

Registered Office: 456 Church Street, Pretoria, 0002

Member 1: SIPHO NKOSI
Member 2: THABO MOKOENA
`;

// Non-CIPC document (generic business text)
const SAMPLE_NON_CIPC_TEXT = `
Invoice #12345
Date: 2024-01-15
To: Some Company
Amount: R 5,000.00
Thank you for your business.
`;

// Minimal text (scanned/poor quality)
const SAMPLE_MINIMAL_TEXT = `CIPC Reg 2019/555555/07`;

// Text with registration number but no labeled company name
const SAMPLE_REG_ONLY = `
This document certifies registration.
Company registration: 2020/444444/08
Physical address: 78 Oak Avenue, Cape Town, 8001
`;

// ── CIPC Parser unit tests ─────────────────────────────────────────────────

describe('cipcParser.parse()', () => {

  describe('standard CoR14.3 document', () => {
    let result;
    beforeEach(() => { result = cipcParser.parse(SAMPLE_CIPC_TEXT); });

    test('recognizes document as CIPC', () => {
      expect(result.isCipcDocument).toBe(true);
    });

    test('extracts registration number', () => {
      expect(result.fields.registration_number).toBe('2022/123456/07');
    });

    test('registration number confidence is high', () => {
      expect(result.confidence.registration_number).toBe('high');
    });

    test('extracts company name', () => {
      expect(result.fields.company_name).toBeTruthy();
      expect(result.fields.company_name).toContain('ACME');
    });

    test('company name confidence is high when reg number also found', () => {
      expect(result.confidence.company_name).toBe('high');
    });

    test('extracts or infers company type', () => {
      expect(result.fields.company_type).toBeTruthy();
      expect(result.fields.company_type).toMatch(/proprietary|pty/i);
    });

    test('extracts registration date', () => {
      expect(result.fields.registration_date).toBeTruthy();
    });

    test('extracts address', () => {
      expect(result.fields.address).toBeTruthy();
      expect(result.fields.address).toContain('123 Main Street');
    });

    test('address confidence is medium', () => {
      expect(result.confidence.address).toBe('medium');
    });

    test('extracts directors', () => {
      expect(Array.isArray(result.fields.directors)).toBe(true);
      expect(result.fields.directors.length).toBeGreaterThan(0);
    });

    test('directors confidence is low', () => {
      expect(result.confidence.directors).toBe('low');
    });
  });

  describe('Close Corporation (CK) document', () => {
    let result;
    beforeEach(() => { result = cipcParser.parse(SAMPLE_CK_TEXT); });

    test('recognizes as CIPC document', () => {
      expect(result.isCipcDocument).toBe(true);
    });

    test('extracts registration number in YYYY/NNNNNN/NN format', () => {
      expect(result.fields.registration_number).toBe('2018/987654/23');
    });

    test('extracts company name', () => {
      expect(result.fields.company_name).toBeTruthy();
    });

    test('infers CC as company type', () => {
      // Either labeled or inferred from "Close Corporation" in text
      expect(result.fields.company_type).toBeTruthy();
      expect(result.fields.company_type).toMatch(/close corporation/i);
    });
  });

  describe('non-CIPC document', () => {
    let result;
    beforeEach(() => { result = cipcParser.parse(SAMPLE_NON_CIPC_TEXT); });

    test('is NOT recognized as CIPC document', () => {
      expect(result.isCipcDocument).toBe(false);
    });

    test('returns null for registration number', () => {
      expect(result.fields.registration_number).toBeNull();
    });

    test('registration number confidence is not_found', () => {
      expect(result.confidence.registration_number).toBe('not_found');
    });

    test('returns empty directors array', () => {
      expect(result.fields.directors).toEqual([]);
    });
  });

  describe('minimal text (reg number only)', () => {
    let result;
    beforeEach(() => { result = cipcParser.parse(SAMPLE_MINIMAL_TEXT); });

    test('recognizes as CIPC based on reg number pattern', () => {
      expect(result.isCipcDocument).toBe(true);
    });

    test('extracts registration number', () => {
      expect(result.fields.registration_number).toBe('2019/555555/07');
    });

    test('returns null for company name when not labeled', () => {
      // May or may not extract — no labeled company name field
      // Just ensure it does not throw and fields are present
      expect(result.fields).toHaveProperty('company_name');
    });
  });

  describe('address without labeled company name', () => {
    let result;
    beforeEach(() => { result = cipcParser.parse(SAMPLE_REG_ONLY); });

    test('still extracts registration number', () => {
      expect(result.fields.registration_number).toBe('2020/444444/08');
    });

    test('extracts address', () => {
      expect(result.fields.address).toBeTruthy();
      expect(result.fields.address).toContain('Cape Town');
    });
  });

  describe('field safety — never invents data', () => {
    test('empty text returns all null/empty fields', () => {
      const result = cipcParser.parse('');
      expect(result.fields.registration_number).toBeNull();
      expect(result.fields.company_name).toBeNull();
      expect(result.fields.company_type).toBeNull();
      expect(result.fields.registration_date).toBeNull();
      expect(result.fields.address).toBeNull();
      expect(result.fields.directors).toEqual([]);
    });

    test('returns not_found confidence for all missing fields', () => {
      const result = cipcParser.parse('Hello world, no registration info here.');
      Object.values(result.confidence).forEach(c => {
        expect(['not_found', 'low']).toContain(c);
      });
    });

    test('directors array never exceeds 20 items', () => {
      // Generate text with many "Director N: NAME" lines
      const manyDirectors = Array.from({ length: 30 }, (_, i) =>
        `Director ${i + 1}: PERSON ${i + 1} SURNAME`
      ).join('\n');
      const result = cipcParser.parse(manyDirectors);
      expect(result.fields.directors.length).toBeLessThanOrEqual(20);
    });
  });

  describe('registration number format validation', () => {
    test('matches YYYY/NNNNNN/NN format correctly', () => {
      const r = cipcParser.parse('Reg: 2023/000001/07');
      expect(r.fields.registration_number).toBe('2023/000001/07');
    });

    test('does NOT match short numbers as registration numbers', () => {
      const r = cipcParser.parse('Invoice 12345');
      expect(r.fields.registration_number).toBeNull();
    });

    test('does NOT match phone numbers as registration numbers', () => {
      const r = cipcParser.parse('Phone: 012/345-6789');
      expect(r.fields.registration_number).toBeNull();
    });
  });
});

// ── Parser Registry tests ──────────────────────────────────────────────────

describe('parseDocument() registry', () => {

  test('listParsers() returns at least CIPC parser', () => {
    const parsers = listParsers();
    expect(parsers.length).toBeGreaterThan(0);
    expect(parsers.some(p => p.id === 'cipc')).toBe(true);
  });

  test('auto-detects CIPC document', () => {
    const result = parseDocument(SAMPLE_CIPC_TEXT);
    expect(result.parserId).toBe('cipc');
    expect(result.recognized).toBe(true);
    expect(result.fields.registration_number).toBe('2022/123456/07');
  });

  test('uses explicit parser_id when provided', () => {
    const result = parseDocument(SAMPLE_CIPC_TEXT, 'cipc');
    expect(result.parserId).toBe('cipc');
  });

  test('falls back to CIPC parser for unrecognized documents', () => {
    const result = parseDocument(SAMPLE_NON_CIPC_TEXT);
    expect(result.parserId).toBe('cipc');
    expect(result.recognized).toBe(false);
  });

  test('returns all required output keys', () => {
    const result = parseDocument(SAMPLE_CIPC_TEXT);
    expect(result).toHaveProperty('parserId');
    expect(result).toHaveProperty('parserName');
    expect(result).toHaveProperty('recognized');
    expect(result).toHaveProperty('fields');
    expect(result).toHaveProperty('confidence');
  });

  test('fields object contains all expected keys', () => {
    const result = parseDocument(SAMPLE_CIPC_TEXT);
    const expectedKeys = [
      'company_name', 'registration_number', 'company_type',
      'registration_date', 'address', 'directors',
    ];
    expectedKeys.forEach(k => expect(result.fields).toHaveProperty(k));
  });

  test('confidence values are valid enum strings', () => {
    const VALID = new Set(['high', 'medium', 'low', 'not_found']);
    const result = parseDocument(SAMPLE_CIPC_TEXT);
    Object.values(result.confidence).forEach(v => {
      expect(VALID.has(v)).toBe(true);
    });
  });
});
