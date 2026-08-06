'use strict';

/**
 * T3-07 — server-side validation of an uploaded TM30 accommodation-notify sheet.
 *
 * PURE module: buffer in → verdict out. No http, no fs, no session — `server.mjs` calls it,
 * `validate-sheet.test.mjs` unit-tests it. The contract enforced here is the GOVERNMENT xlsx
 * import contract (Iteration 2 D-2, ground truth = the delivered template transcribed in
 * `villas-be-core/src/services/tm30/tm30-sheet.service.ts`):
 *
 *   · ONE worksheet, named exactly 'แบบแจ้งที่พัก Inform Accom'
 *   · header row 1: 9 header strings, byte-exact IN ORDER (embedded `\n`s and the trailing
 *     space after `(ค.ศ. / A.D.) ` included)
 *   · ≥1 data row (rows 2+; fully blank rows are ignored)
 *   · per row: First/Last Name, Gender, Passport, Nationality non-empty; Gender ∈ {M,F};
 *     Nationality ∈ the template's own 267-code vocabulary; Birth Date + Check-out Date TEXT
 *     `DD/MM/YYYY` (A.D.) — Birth Date may use `00` day/month placeholders, Check-out Date may not.
 *
 * 🔴 The nationality rule used to be `/^[A-Z]{3}$/` — "a 3-letter ICAO code". Both halves of
 * that were wrong (MO-TM30-NAT). It accepted `ZZZ` and `P0L`-shaped garbage the portal
 * rejects, AND it rejected twelve codes the government file really lists (`B13`, `E01`,
 * `Y03`… — they contain digits). Meanwhile the BE was writing country NAMES into that column,
 * so this testbed's own rule would have failed the real product's real output. Membership in
 * the vendored vocabulary is the only check that matches the portal.
 *
 * This is the MISTAKE-PREVENTION testbed: a rejection must name EVERY violation with its xlsx
 * row number, never a bare "invalid file".
 */

import { createRequire } from 'node:module';

import ExcelJS from 'exceljs';

const require = createRequire(import.meta.url);
/**
 * The accepted nationality vocabulary — GENERATED in villas-be-core from the government
 * template and vendored here (ADR-0007). `checksum` is the same value every other copy of this
 * table carries in every repo; `tm30-nationalities.test.mjs` pins this copy to it.
 */
const VOCABULARY = require('./tm30-nationalities.json');

export const TM30_NATIONALITY_CHECKSUM = VOCABULARY.checksum;
export const TM30_NATIONALITY_CODES = new Set(VOCABULARY.nationalities.map((n) => n.code));

/** The template's single worksheet name — byte-exact. */
export const SHEET_NAME = 'แบบแจ้งที่พัก Inform Accom';

/**
 * Template row 1, columns 1–9, byte-exact — copied verbatim from the BE sheet writer
 * (`tm30-sheet.service.ts` HEADER_ROW). DO NOT edit without a new delivered template.
 */
export const HEADER_ROW = Object.freeze([
    'ชื่อ\nFirst Name *',
    'ชื่อกลาง\nMiddle Name',
    'นามสกุล\nLast Name',
    'เพศ\nGender *',
    'เลขหนังสือเดินทาง\nPassport No. *',
    'สัญชาติ\nNationality *',
    'วัน เดือน ปี เกิด\nBirth Date\nDD/MM/YYYY(ค.ศ. / A.D.) \nเช่น 17/06/1985 หรือ 10/00/1985 หรือ 00/00/1985',
    'วันที่แจ้งออกจากที่พัก\nCheck-out Date\nDD/MM/YYYY(ค.ศ. / A.D.) \nเช่น 14/06/2023',
    'เบอร์โทรศัพท์\nPhone No.'
]);

/** English short names for messages — a row-numbered message must be READABLE, not Thai-exact. */
const COLUMN_LABEL = Object.freeze([
    'First Name', 'Middle Name', 'Last Name', 'Gender', 'Passport No.',
    'Nationality', 'Birth Date', 'Check-out Date', 'Phone No.'
]);

/** Required-per-row columns (1-based), per the contract's asterisks. */
const REQUIRED_COLS = Object.freeze([1, 3, 4, 5, 6]);

const BIRTH_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/; // 00 day/month placeholders allowed
const CHECKOUT_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** exceljs cell → the TEXT the portal would parse. Dates must arrive as text (D-2). */
function cellText(cell) {
    if (!cell || cell.value === null || cell.value === undefined) return '';
    const v = cell.value;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return `[excel date ${v.toISOString().slice(0, 10)}]`; // not text ⇒ fails the regex, loudly
    if (typeof v === 'object' && Array.isArray(v.richText)) {
        return v.richText.map((r) => r.text || '').join('');
    }
    if (typeof v === 'object' && 'result' in v) return v.result === undefined ? '' : String(v.result);
    if (typeof v === 'object' && 'text' in v) return String(v.text);
    return String(v);
}

/** DD/MM/YYYY with optional 00-placeholders; returns an error string or null. */
function dateError(text, { allowZeroPlaceholders }) {
    const m = (allowZeroPlaceholders ? BIRTH_DATE_RE : CHECKOUT_DATE_RE).exec(text);
    if (!m) return `must be DD/MM/YYYY (A.D.) as text, got "${text}"`;
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const min = allowZeroPlaceholders ? 0 : 1;
    if (dd < min || dd > 31) return `day "${m[1]}" is out of range (${allowZeroPlaceholders ? '00' : '01'}–31)`;
    if (mm < min || mm > 12) return `month "${m[2]}" is out of range (${allowZeroPlaceholders ? '00' : '01'}–12)`;
    return null;
}

/** Preview a header cell for an error message without dumping 4 Thai lines. */
function headerPreview(s) {
    const flat = String(s).replace(/\n/g, '⏎');
    return flat.length > 60 ? flat.slice(0, 57) + '…' : flat;
}

/**
 * Validate an uploaded xlsx buffer against the government import contract.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<{ok: true, guests: object[]} | {ok: false, violations: {row: number|null, message: string}[]}>}
 *   `violations[].row` is the xlsx row number (2 = first data row); `null` = workbook-level.
 */
export async function validateSheetBuffer(buffer) {
    const violations = [];
    const fail = () => ({ ok: false, violations });

    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.load(buffer);
    } catch {
        violations.push({ row: null, message: 'the uploaded file is not a readable .xlsx workbook' });
        return fail();
    }

    const sheet = workbook.getWorksheet(SHEET_NAME);
    if (!sheet) {
        const names = workbook.worksheets.map((w) => `"${w.name}"`).join(', ') || '(none)';
        violations.push({
            row: null,
            message: `workbook must contain a worksheet named exactly "${SHEET_NAME}" — found: ${names}`
        });
        return fail(); // nothing else is checkable without the sheet
    }
    if (workbook.worksheets.length !== 1) {
        violations.push({
            row: null,
            message: `workbook must contain exactly ONE worksheet, found ${workbook.worksheets.length}`
        });
    }

    // ── header row 1: byte-exact, in order ────────────────────────────────────────────────
    const headerRow = sheet.getRow(1);
    let headersOk = true;
    for (let c = 1; c <= HEADER_ROW.length; c += 1) {
        const got = cellText(headerRow.getCell(c));
        const want = HEADER_ROW[c - 1];
        if (got !== want) {
            headersOk = false;
            violations.push({
                row: 1,
                message:
                    `header column ${c} must be byte-exact "${headerPreview(want)}" ` +
                    `(${COLUMN_LABEL[c - 1]}), got "${headerPreview(got)}"`
            });
        }
    }
    const extra = cellText(headerRow.getCell(HEADER_ROW.length + 1));
    if (extra !== '') {
        headersOk = false;
        violations.push({
            row: 1,
            message: `unexpected extra header in column ${HEADER_ROW.length + 1}: "${headerPreview(extra)}" — the template has exactly 9 columns`
        });
    }

    // ── data rows 2+ ──────────────────────────────────────────────────────────────────────
    const dataRows = [];
    for (let r = 2; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const cells = [];
        for (let c = 1; c <= HEADER_ROW.length; c += 1) cells.push(cellText(row.getCell(c)).trim());
        if (cells.some((t) => t !== '')) dataRows.push({ r, cells });
    }
    if (dataRows.length === 0) {
        violations.push({ row: null, message: 'the sheet has no data rows — at least one guest row (row 2+) is required' });
    }

    // With a broken header, per-cell checks would validate the WRONG columns and bury the real
    // problem in noise — report the header violations alone and stop there.
    if (!headersOk) return fail();

    const guests = [];
    for (const { r, cells } of dataRows) {
        const [firstName, middleName, lastName, gender, passport, nationality, birthDate, checkoutDate, phone] = cells;

        for (const c of REQUIRED_COLS) {
            if (cells[c - 1] === '') {
                violations.push({ row: r, message: `row ${r}: ${COLUMN_LABEL[c - 1]} is required and must not be empty` });
            }
        }
        if (gender !== '' && gender !== 'M' && gender !== 'F') {
            violations.push({ row: r, message: `row ${r}: Gender must be "M" or "F", got "${gender}"` });
        }
        if (nationality !== '' && !TM30_NATIONALITY_CODES.has(nationality)) {
            violations.push({
                row: r,
                message:
                    `row ${r}: Nationality must be one of the ${TM30_NATIONALITY_CODES.size} codes on the ` +
                    `template's สัญชาติ Nationality worksheet, got "${nationality}"`
            });
        }
        if (birthDate !== '') {
            const err = dateError(birthDate, { allowZeroPlaceholders: true });
            if (err) violations.push({ row: r, message: `row ${r}: Birth Date ${err}` });
        }
        if (checkoutDate !== '') {
            const err = dateError(checkoutDate, { allowZeroPlaceholders: false });
            if (err) violations.push({ row: r, message: `row ${r}: Check-out Date ${err}` });
        }

        guests.push({ row: r, firstName, middleName, lastName, gender, passport, nationality, birthDate, checkoutDate, phone });
    }

    if (violations.length > 0) return fail();
    return { ok: true, guests };
}
