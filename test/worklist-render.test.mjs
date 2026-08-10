/**
 * The pane's PURE render decisions — row state, priority rank, header counter (ADR-0014).
 *
 * 🔴 Why this file exists at all. `app.html` is a zero-dependency Electron renderer: its logic
 * lives in one inline `<script>`, has no module boundary and has never had a single test. That
 * was tolerable while the pane only *displayed* server facts — but MO-TM30-DUE-DATE-001 deletes
 * `isToday` / `isPostponed` and re-ranks the list, and "the code changed" is not evidence that
 * the list still orders correctly.
 *
 * The approach: lift the three pure functions out of the inline script BY NAME and evaluate them
 * against stubbed `state` / `el`. That is deliberately brittle — rename a function and this test
 * fails loudly rather than silently covering nothing, which is the failure mode of a mirrored
 * copy. It is not a substitute for looking at the pane; it is a floor under it.
 *
 * Run: node --test test/worklist-render.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app.html'), 'utf8');

/** Lift one `function name(...) { ... }` out of the inline script, braces balanced. */
function lift(name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `app.html no longer declares ${name}() — update this test`);
    let depth = 0;
    let i = src.indexOf('{', start);
    const from = i;
    for (; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces lifting ${name}`);
}

/** The `STATE_ART` table, lifted the same way — it is the badge/row art contract. */
function liftStateArt() {
    const start = src.indexOf('var STATE_ART = {');
    assert.notEqual(start, -1, 'app.html no longer declares STATE_ART — update this test');
    const end = src.indexOf('};', start);
    return src.slice(start, end + 2);
}

/**
 * Build a sandbox holding the lifted functions plus the minimum they close over.
 * `state` and `el` are the real names the script uses, so the lifted bodies run unmodified.
 */
function sandbox() {
    const countEl = { textContent: '' };
    const factory = new Function(
        `
        var state = { worklist: [], rowLocal: Object.create(null), renderNow: 0 };
        var el = { count: arguments[0] };
        ${liftStateArt()}
        ${lift('isFinishedState')}
        ${lift('checkinDayMs')}
        ${lift('rowState')}
        ${lift('priorityRank')}
        ${lift('byPriority')}
        ${lift('renderCount')}
        return { state: state, STATE_ART: STATE_ART, rowState: rowState,
                 priorityRank: priorityRank, byPriority: byPriority, renderCount: renderCount };
        `,
    );
    const api = factory(countEl);
    api.countText = () => countEl.textContent;
    return api;
}

const row = (over = {}) => ({
    filing_id: 1,
    villa: 'Villa Alpha',
    checkin: '2026-08-22T07:00:00.000Z',
    status: 'sheet_ready',
    sheet_download_url: 'https://api/tm30/filings/1/sheet',
    ...over,
});

// ── the art table ───────────────────────────────────────────────────────────────────────

test('STATE_ART carries all seven states, and `upcoming` is a ring not a fill', () => {
    const { STATE_ART } = sandbox();
    assert.deepEqual(
        Object.keys(STATE_ART).sort(),
        ['approved', 'awaiting', 'downloaded', 'need', 'nosheet', 'overdue', 'upcoming'],
    );
    assert.equal(STATE_ART.upcoming.label, 'upcoming');
    assert.equal(STATE_ART.upcoming.row, 's-up');
    assert.equal(STATE_ART.upcoming.badge, 'b-up');
    // The collision the DD-4 gate was about: it must not borrow the blocked art.
    assert.notEqual(STATE_ART.upcoming.badge, STATE_ART.nosheet.badge);
    assert.notEqual(STATE_ART.upcoming.row, STATE_ART.nosheet.row);
});

// ── rowState ────────────────────────────────────────────────────────────────────────────

test('an upcoming dot renders the upcoming state', () => {
    const { rowState } = sandbox();
    assert.equal(rowState(row({ dot: 'upcoming' })), 'upcoming');
    assert.equal(rowState(row({ dot: 'overdue' })), 'overdue');
    assert.equal(rowState(row({ dot: 'due' })), 'need');
});

test('precedence is unchanged: finished → blocked → local → urgency', () => {
    const api = sandbox();
    const { rowState, state } = api;

    // finished beats everything
    assert.equal(rowState(row({ dot: 'upcoming', status: 'acknowledged' })), 'approved');
    assert.equal(rowState(row({ dot: 'upcoming', status: 'submitted' })), 'awaiting');

    // no sheet beats urgency, upcoming included
    const noSheet = row({ dot: 'upcoming', sheet_download_url: undefined });
    assert.equal(rowState(noSheet), 'nosheet');

    // the Helper-local download beats urgency, exactly as it does for overdue
    state.rowLocal[1] = { downloadPath: '/tmp/x.xlsx' };
    assert.equal(rowState(row({ dot: 'upcoming' })), 'downloaded');
    assert.equal(rowState(row({ dot: 'overdue' })), 'downloaded');
});

// ── priorityRank / byPriority ───────────────────────────────────────────────────────────

test('🔴 rank comes from the DOT alone — never from a second reading of the calendar', () => {
    const { priorityRank } = sandbox();
    assert.equal(priorityRank(row({ dot: 'overdue' })), 0);
    assert.equal(priorityRank(row({ dot: 'due' })), 1);
    assert.equal(priorityRank(row({ dot: 'upcoming' })), 2);
    assert.equal(priorityRank(row({ dot: undefined })), 2);
    assert.equal(priorityRank(row({ dot: 'upcoming', status: 'acknowledged' })), 3);
});

test('a `due` row outranks an `upcoming` one even when its check-in is LATER', () => {
    // The regression the old ranking could produce: it split ranks on the check-in date, so a
    // due row whose check-in sat further out could be pushed below a nearer upcoming one.
    const { priorityRank } = sandbox();
    const dueLater = row({ dot: 'due', checkin: '2026-12-31T00:00:00.000Z' });
    const upcomingSooner = row({ dot: 'upcoming', checkin: '2026-08-23T00:00:00.000Z' });
    assert.ok(priorityRank(dueLater) < priorityRank(upcomingSooner));
});

test('the ordered list is overdue → due → upcoming → finished, then soonest check-in', () => {
    const { byPriority } = sandbox();
    const rows = [
        row({ filing_id: 4, dot: 'upcoming', checkin: '2026-08-25T00:00:00.000Z' }),
        row({ filing_id: 1, dot: 'due', checkin: '2026-08-20T00:00:00.000Z' }),
        row({ filing_id: 5, dot: 'upcoming', checkin: '2026-08-23T00:00:00.000Z' }),
        row({ filing_id: 9, dot: 'due', checkin: '2026-08-01T00:00:00.000Z', status: 'acknowledged' }),
        row({ filing_id: 0, dot: 'overdue', checkin: '2026-07-01T00:00:00.000Z' }),
    ];
    assert.deepEqual(
        byPriority(rows).map((r) => r.filing_id),
        [0, 1, 5, 4, 9],
    );
});

// ── the header counter ──────────────────────────────────────────────────────────────────

test('🔴 "to file" counts what is OWED — upcoming is reported, never added in', () => {
    const api = sandbox();
    // The reported screenshot's data, corrected: 2 overdue + 1 upcoming.
    api.state.worklist = [
        row({ filing_id: 1, dot: 'overdue' }),
        row({ filing_id: 2, dot: 'overdue' }),
        row({ filing_id: 3, dot: 'upcoming' }),
    ];
    api.renderCount();
    assert.equal(api.countText(), '2 to file · 2 overdue · 1 upcoming');
});

test('nothing owed but work visible reads "nothing due", not "0 to file"', () => {
    const api = sandbox();
    api.state.worklist = [row({ filing_id: 1, dot: 'upcoming' }), row({ filing_id: 2, dot: 'upcoming' })];
    api.renderCount();
    assert.equal(api.countText(), 'nothing due · 2 upcoming');
});

test('with no upcoming rows the header is byte-identical to the old one', () => {
    const api = sandbox();
    api.state.worklist = [
        row({ filing_id: 1, dot: 'due' }),
        row({ filing_id: 2, dot: 'due' }),
        row({ filing_id: 3, dot: 'overdue' }),
    ];
    api.renderCount();
    assert.equal(api.countText(), '3 to file · 1 overdue');
});

test('finished rows count as neither owed nor upcoming', () => {
    const api = sandbox();
    api.state.worklist = [
        row({ filing_id: 1, dot: 'due' }),
        row({ filing_id: 2, dot: 'upcoming', status: 'acknowledged' }),
        row({ filing_id: 3, dot: 'overdue', status: 'submitted' }),
    ];
    api.renderCount();
    assert.equal(api.countText(), '1 to file');
});

test('an empty worklist still reads "0"', () => {
    const api = sandbox();
    api.state.worklist = [];
    api.renderCount();
    assert.equal(api.countText(), '0');
});

// ── the deletions ───────────────────────────────────────────────────────────────────────

test('🔴 isToday / isPostponed / POSTPONED_AFTER_MS are GONE from the pane', () => {
    // They existed only to work out what "not overdue" meant. Their return would mean urgency
    // has two sources again — the defect this feature removed.
    assert.equal(/function isToday\(/.test(src), false);
    assert.equal(/function isPostponed\(/.test(src), false);
    assert.equal(/var POSTPONED_AFTER_MS/.test(src), false);
});

/**
 * 🔴 The update strip must be INVISIBLE when there is nothing to say.
 *
 * It shipped visible-and-empty — "TM30 Helper  is available — you are running ." — on a Helper
 * that was perfectly up to date, because `.updbar { display: flex }` overrides the browser's
 * `[hidden] { display: none }`. The attribute alone hides nothing from an element that sets its
 * own `display`. Asserted against the stylesheet text, since there is no DOM here.
 */
test('🔴 the update strip has a rule that actually honours the hidden attribute', () => {
    // It shipped visible-and-empty — "TM30 Helper  is available — you are running ." — on a
    // Helper that was perfectly up to date, because `.updbar { display: flex }` overrides the
    // browser's `[hidden] { display: none }`. The attribute alone hides nothing from an element
    // that sets its own `display`. Asserted against the stylesheet text: there is no DOM here.
    assert.match(
        src,
        /\.updbar\[hidden\]\s*\{[^}]*display:\s*none/,
        '.updbar sets display:flex, so it needs an explicit [hidden] rule or it never hides',
    );
});

test('every element carrying `hidden` that sets its own display has such a rule', () => {
    // Generalised, so the next element of this shape cannot repeat the mistake.
    const hiddenIds = [...src.matchAll(/<(\w+)[^>]*\bid="([\w-]+)"[^>]*\bhidden\b/g)].map(
        (m) => m[2],
    );
    assert.ok(hiddenIds.length > 0, 'expected at least one hidden element in the markup');
    for (const id of hiddenIds) {
        const el = new RegExp(`<\\w+[^>]*id="${id}"[^>]*>`).exec(src)?.[0] ?? '';
        const cls = /class="([\w -]+)"/.exec(el)?.[1]?.split(/\s+/)[0];
        if (!cls) continue; // no class ⇒ no custom display ⇒ the attribute works by itself
        if (!new RegExp(`\\.${cls}\\s*\\{[^}]*display:`).test(src)) continue;
        assert.match(
            src,
            new RegExp(`\\.${cls}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`),
            `.${cls} sets display and #${id} carries [hidden] — it needs a [hidden] rule`,
        );
    }
});
