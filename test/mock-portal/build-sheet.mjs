'use strict';

/**
 * T3-07 — TEST-FIXTURE sheet builder for the mock portal.
 *
 * Builds xlsx buffers the same way the BE's `Tm30SheetService.buildSheetBuffer` does (exceljs,
 * one worksheet, header row 1, every cell a TEXT string) — with every part OVERRIDABLE so the
 * validation tests can produce each broken variant (wrong sheet name, reordered headers, …).
 *
 * Also a tiny CLI for the manual e2e:
 *
 *   node test/mock-portal/build-sheet.mjs               → writes Villa_Demo_..._TM30.xlsx (valid)
 *   node test/mock-portal/build-sheet.mjs --broken      → writes broken_TM30.xlsx (3 violations)
 */

import ExcelJS from 'exceljs';
import { SHEET_NAME, HEADER_ROW } from './validate-sheet.mjs';

/** A golden guest row, template order. Spread + override to mutate one cell in a test. */
export const GOLDEN_ROWS = Object.freeze([
    ['ANNA MARIA', '', 'KOWALSKA', 'F', 'ZK1234567', 'POL', '17/06/1985', '02/08/2026', '+48601234567'],
    // birth date with the template's 00-placeholders — explicitly legal (D-2)
    ['SOMCHAI', '', 'RAKPRAYOON', 'M', 'AA7654321', 'THA', '10/00/1985', '02/08/2026', ''],
    ['JOHN', '', 'DOE', 'M', 'US9988776', 'USA', '00/00/1990', '02/08/2026', '+15550100']
]);

/**
 * @param {object} [opts]
 * @param {string}   [opts.sheetName] worksheet name (default: the contract's)
 * @param {string[]} [opts.headers]   header row (default: byte-exact contract headers)
 * @param {string[][]} [opts.rows]    data rows, arrays of ≤9 strings (default: GOLDEN_ROWS)
 * @param {string[]} [opts.extraSheets] names of additional (empty) worksheets to add
 * @returns {Promise<Buffer>}
 */
export async function buildSheetBuffer(opts = {}) {
    const {
        sheetName = SHEET_NAME,
        headers = HEADER_ROW,
        rows = GOLDEN_ROWS,
        extraSheets = []
    } = opts;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow([...headers]);
    for (const r of rows) sheet.addRow([...r]);
    for (const name of extraSheets) workbook.addWorksheet(name);
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ── CLI for the manual e2e ─────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const { writeFileSync } = await import('node:fs');
    const broken = process.argv.includes('--broken');
    const file = broken ? 'broken_TM30.xlsx' : 'Villa_Demo_2026-07-27_2026-08-02_TM30.xlsx';
    const buf = broken
        ? await buildSheetBuffer({
              rows: [
                  ['', '', 'KOWALSKA', 'X', 'ZK1234567', 'PL', '1985-06-17', '02/08/2026', ''],
                  ['JOHN', '', 'DOE', 'M', '', 'USA', '17/06/1985', '32/13/2026', '']
              ]
          })
        : await buildSheetBuffer();
    writeFileSync(file, buf);
    process.stdout.write(`wrote ${file} (${buf.length} bytes, ${broken ? 'BROKEN — expect an itemized rejection' : 'valid — expect a receipt'})\n`);
}
