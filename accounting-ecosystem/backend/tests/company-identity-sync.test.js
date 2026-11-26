'use strict';

/**
 * One identity record across Leo, Paytime, Firmflow, ECO Hub and Charlie
 * (shared/services/companyIdentitySync + practice/lib/company-sync). Fictional data.
 */

jest.mock('../config/database', () => ({ supabase: {} }));

const sync = require('../shared/services/companyIdentitySync');
const practice = require('../modules/practice/lib/company-sync');

describe('canonical company columns', () => {
  test('one-line address from the structured columns', () => {
    expect(sync.composeAddress({ address_street: '1 Main Rd', address_suburb: '', address_city: 'Testville', address_province: 'Gauteng', address_postal_code: '0001' }))
      .toBe('1 Main Rd, Testville, Gauteng, 0001');
    expect(sync.composeAddress({})).toBeNull();
  });

  test('only columns that really changed (forms send every field)', () => {
    expect(sync.changedColumns(
      { company_name: 'A', contact_email: null, address_city: 'X' },
      { company_name: 'A', contact_email: '', address_city: 'Y', updated_at: 'now' },
    )).toEqual(['address_city']);
  });
});

describe('company → ECO Hub client', () => {
  const co = { company_name: 'Fictional (Pty) Ltd', contact_email: 'a@test.example', contact_phone: '011', address_street: '1 Main Rd', address_city: 'Testville' };
  test('name, contact_email/contact_phone and address mirror when changed', () => {
    expect(sync.ecoPatchFromCompany(co, ['company_name', 'contact_email', 'contact_phone', 'address_city']))
      .toEqual({ name: 'Fictional (Pty) Ltd', email: 'a@test.example', phone: '011', address: '1 Main Rd, Testville' });
  });
  test('numbers are not ECO Hub fields', () => {
    expect(sync.ecoPatchFromCompany(co, ['vat_number', 'paye_reference_number'])).toEqual({});
  });
});

describe('ECO Hub client → company', () => {
  test('name / email / phone; the one-line address never overwrites the structured one', () => {
    expect(sync.companyPatchFromEco({ name: 'New', email: 'b@test.example', phone: '012', address: 'x' }, ['name', 'email', 'phone', 'address']))
      .toEqual({ company_name: 'New', contact_email: 'b@test.example', contact_phone: '012' });
  });
});

describe('Firmflow field map', () => {
  test('numbers, address and contact map to the canonical columns', () => {
    expect(practice.COMPANY_FIELD_MAP).toEqual(expect.objectContaining({
      paye_reference_number: 'paye_reference_number', coida_registration_number: 'coid_reference_number',
      address_line1: 'address_street', address_line2: 'address_suburb', address_postal_code: 'address_postal_code',
      email: 'contact_email', phone: 'contact_phone',
    }));
  });
  test('non-empty company values only', () => {
    expect(practice.practiceFieldsFromCompany({ vat_number: '4000000000', address_street: '', contact_email: null, address_city: 'Testville' }))
      .toEqual({ vat_number: '4000000000', address_city: 'Testville' });
  });
});
