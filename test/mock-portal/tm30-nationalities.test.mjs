'use strict';

/**
 * MO-TM30-NAT / ADR-0007 — this repo's copy of the TM30 nationality vocabulary.
 *
 * The table is generated in villas-be-core from the government template and vendored into three
 * repositories. This one has no spreadsheet parser and should not grow one to read a file that
 * changes once a year, so the pin is the checksum: every copy carries the same value, and each
 * repo's own test fails if ITS copy drifts. Regenerate with
 * `node scripts/gen-tm30-nationalities.js` in villas-be-core — never edit the constant to match
 * an edited table.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TM30_NATIONALITY_CHECKSUM, TM30_NATIONALITY_CODES } from './validate-sheet.mjs';

const require = createRequire(import.meta.url);
const VOCABULARY = require('./tm30-nationalities.json');

test('hashes to the checksum every other copy carries', () => {
    const canonical = VOCABULARY.nationalities
        .map((n) => `${n.code}\t${n.en}\t${n.th}`)
        .join('\n');
    assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), TM30_NATIONALITY_CHECKSUM);
});

test('holds the 267 template entries, codes unique', () => {
    assert.equal(VOCABULARY.nationalities.length, 267);
    assert.equal(TM30_NATIONALITY_CODES.size, 267);
});

test('accepts what real passports carry, rejects what the portal has no entry for', () => {
    for (const code of ['RUS', 'BLR', 'THA', 'DEU', 'GBR', 'XXA']) {
        assert.ok(TM30_NATIONALITY_CODES.has(code), code);
    }
    // `D` is on every German passport; the backend maps it to DEU before anything is filed.
    for (const code of ['D', 'GBD', 'PSE', 'JEY', 'XXK', 'ZZZ']) {
        assert.ok(!TM30_NATIONALITY_CODES.has(code), code);
    }
});

test('keeps the twelve codes containing digits — a letters-only rule would drop them', () => {
    const withDigits = [...TM30_NATIONALITY_CODES].filter((c) => /[0-9]/.test(c));
    assert.equal(withDigits.length, 12);
    for (const code of ['B13', 'E01', 'Y03']) assert.ok(TM30_NATIONALITY_CODES.has(code), code);
});
