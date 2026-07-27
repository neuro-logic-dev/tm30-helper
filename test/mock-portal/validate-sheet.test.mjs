'use strict';

/**
 * T3-07 — unit tests for the mock portal's xlsx validation (`validate-sheet.mjs`).
 *
 * Golden buffers are built with exceljs by `build-sheet.mjs`, the same way the BE writes real
 * sheets; each broken variant mutates exactly ONE thing off the golden build, so a failure names
 * the check that regressed. Every rejection must carry ROW-NUMBERED, specific messages — the
 * mock is the mistake-prevention testbed, not a boolean gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSheetBuffer, SHEET_NAME, HEADER_ROW } from './validate-sheet.mjs';
import { buildSheetBuffer, GOLDEN_ROWS } from './build-sheet.mjs';

const messages = (v) => v.violations.map((x) => x.message).join('\n');

test('accepts the golden buffer (incl. 00-placeholder birth dates) and parses every guest', async () => {
    const verdict = await validateSheetBuffer(await buildSheetBuffer());
    assert.equal(verdict.ok, true, `expected ok, got violations:\n${verdict.ok ? '' : messages(verdict)}`);
    assert.equal(verdict.guests.length, GOLDEN_ROWS.length);
    assert.deepEqual(verdict.guests[0], {
        row: 2,
        firstName: 'ANNA MARIA',
        middleName: '',
        lastName: 'KOWALSKA',
        gender: 'F',
        passport: 'ZK1234567',
        nationality: 'POL',
        birthDate: '17/06/1985',
        checkoutDate: '02/08/2026',
        phone: '+48601234567'
    });
    // the 00-placeholder rows really are the accepted ones
    assert.equal(verdict.guests[1].birthDate, '10/00/1985');
    assert.equal(verdict.guests[2].birthDate, '00/00/1990');
});

test('rejects a wrong worksheet name, naming both expected and found', async () => {
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ sheetName: 'Sheet1' }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), new RegExp(SHEET_NAME));
    assert.match(messages(verdict), /"Sheet1"/);
});

test('rejects a second worksheet — the template has exactly ONE', async () => {
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ extraSheets: ['Sheet2'] }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /exactly ONE worksheet, found 2/);
});

test('rejects a missing header (column 9 blank), naming the column', async () => {
    const headers = [...HEADER_ROW.slice(0, 8), ''];
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ headers }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /header column 9/);
    assert.match(messages(verdict), /Phone No\./);
});

test('rejects reordered headers (First↔Last Name swapped), naming both columns', async () => {
    const headers = [...HEADER_ROW];
    [headers[0], headers[2]] = [headers[2], headers[0]];
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ headers }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /header column 1/);
    assert.match(messages(verdict), /header column 3/);
});

test('rejects a NEARLY-exact header — byte-exact means the embedded \\n and trailing space too', async () => {
    const headers = [...HEADER_ROW];
    headers[0] = 'First Name *'; // English line only, no Thai + \n
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ headers }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /header column 1 must be byte-exact/);
});

test('rejects an empty required cell with the row number and field name', async () => {
    const rows = GOLDEN_ROWS.map((r) => [...r]);
    rows[0][0] = ''; // First Name, xlsx row 2
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ rows }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /row 2: First Name is required/);
});

test('rejects a bad gender with the row number and the offending value', async () => {
    const rows = GOLDEN_ROWS.map((r) => [...r]);
    rows[1][3] = 'X'; // xlsx row 3
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ rows }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /row 3: Gender must be "M" or "F", got "X"/);
});

test('rejects a bad nationality (not 3 A-Z letters) with the row number', async () => {
    const rows = GOLDEN_ROWS.map((r) => [...r]);
    rows[0][5] = 'PL'; // xlsx row 2
    rows[2][5] = 'usa'; // xlsx row 4 — lowercase is NOT ICAO
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ rows }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /row 2: Nationality must be a 3-letter ICAO code \(A–Z\), got "PL"/);
    assert.match(messages(verdict), /row 4: Nationality .* got "usa"/);
});

test('rejects bad date formats with the row number; 00-placeholders stay birth-date-only', async () => {
    const rows = GOLDEN_ROWS.map((r) => [...r]);
    rows[0][6] = '1985-06-17'; // ISO, not DD/MM/YYYY — xlsx row 2
    rows[1][7] = '32/13/2026'; // out-of-range checkout — xlsx row 3
    rows[2][7] = '00/08/2026'; // 00-placeholder is ILLEGAL for checkout — xlsx row 4
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ rows }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /row 2: Birth Date must be DD\/MM\/YYYY .* got "1985-06-17"/);
    assert.match(messages(verdict), /row 3: Check-out Date day "32" is out of range/);
    assert.match(messages(verdict), /row 4: Check-out Date day "00" is out of range \(01–31\)/);
});

test('rejects a header-only sheet — at least one data row is required', async () => {
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ rows: [] }));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /no data rows/);
});

test('a broken row reports EVERY violation at once, not just the first', async () => {
    const rows = [['', '', 'KOWALSKA', 'X', 'ZK1234567', 'PL', '1985-06-17', '02/08/2026', '']];
    const verdict = await validateSheetBuffer(await buildSheetBuffer({ rows }));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.violations.length, 4, messages(verdict)); // name, gender, nationality, birth date
    assert.ok(verdict.violations.every((v) => v.message.startsWith('row 2:')), messages(verdict));
});

test('rejects a buffer that is not an xlsx workbook at all', async () => {
    const verdict = await validateSheetBuffer(Buffer.from('definitely not a zip'));
    assert.equal(verdict.ok, false);
    assert.match(messages(verdict), /not a readable \.xlsx workbook/);
});
