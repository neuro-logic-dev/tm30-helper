'use strict';

/**
 * MO-TM30-PORTAL-DATE / ADR-0011 — the rule that decides what goes into the portal's
 * `วันที่เข้าพัก / Check-in Date`.
 *
 * The rule is the operator's and it can write a date that is not the guest's arrival date; these
 * tests pin exactly which three branches exist, so the substitution can never widen by accident
 * into a fourth case nobody decided on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { portalCheckinDate, formatPortalDate } = require('../portal-dates.js');

/** An instant expressed in Bangkok local time — the only clock this feature reasons in. */
const ict = (iso) => Date.parse(iso + '+07:00');

test('check-in today → today', () => {
    const r = portalCheckinDate('2026-08-07T00:00:00.000Z', ict('2026-08-07T14:00:00'));
    assert.equal(r.value, '07/08/2026');
    assert.equal(r.basis, 'today');
});

test('check-in yesterday → yesterday', () => {
    const r = portalCheckinDate('2026-08-06T00:00:00.000Z', ict('2026-08-07T14:00:00'));
    assert.equal(r.value, '06/08/2026');
    assert.equal(r.basis, 'yesterday');
});

test('check-in TEN days ago → still yesterday, and that is the decision, not a bug', () => {
    // ADR-0011: the operator files late arrivals as yesterday. The real date is available in the
    // row and is deliberately not used; this test exists so nobody "fixes" it by accident.
    const r = portalCheckinDate('2026-07-28T00:00:00.000Z', ict('2026-08-07T09:00:00'));
    assert.equal(r.value, '06/08/2026');
    assert.equal(r.basis, 'yesterday');
});

test('check-in in the future → fills NOTHING', () => {
    const r = portalCheckinDate('2026-08-09T00:00:00.000Z', ict('2026-08-07T09:00:00'));
    assert.equal(r.value, null);
    assert.equal(r.basis, null);
    assert.match(r.reason, /future/);
});

test('unusable check-in → fills NOTHING, never a default', () => {
    for (const bad of ['', null, undefined, 'tomorrow', '07/08/2026']) {
        const r = portalCheckinDate(bad, ict('2026-08-07T09:00:00'));
        assert.equal(r.value, null, String(bad));
    }
});

test('05:00 in Bangkok is still the SAME Bangkok day — the UTC clock would say yesterday', () => {
    // 05:00 ICT on 7 Aug is 22:00 UTC on 6 Aug. Anything reasoning in UTC calls the 7 Aug check-in
    // "not today" and files it as yesterday — wrong, and wrong exactly during the early morning
    // when a manager is catching up on late arrivals.
    const r = portalCheckinDate('2026-08-07T00:00:00.000Z', ict('2026-08-07T05:00:00'));
    assert.equal(r.value, '07/08/2026');
    assert.equal(r.basis, 'today');
});

test('00:30 in Bangkok: last night\'s check-in is now YESTERDAY', () => {
    // The day rolled over 30 minutes ago. A check-in at 23:00 on the 6th is a different Bangkok
    // day from 00:30 on the 7th, so the rule files it as yesterday — 06/08.
    const r = portalCheckinDate('2026-08-06T00:00:00.000Z', ict('2026-08-07T00:30:00'));
    assert.equal(r.value, '06/08/2026');
    assert.equal(r.basis, 'yesterday');
});

test('23:59 in Bangkok: today is still today', () => {
    const r = portalCheckinDate('2026-08-07T00:00:00.000Z', ict('2026-08-07T23:59:00'));
    assert.equal(r.value, '07/08/2026');
    assert.equal(r.basis, 'today');
});

test('crossing a month and a year boundary backwards', () => {
    assert.equal(
        portalCheckinDate('2026-07-31T00:00:00.000Z', ict('2026-08-01T10:00:00')).value,
        '31/07/2026'
    );
    assert.equal(
        portalCheckinDate('2025-12-31T00:00:00.000Z', ict('2026-01-01T10:00:00')).value,
        '31/12/2025'
    );
});

test('the format is DD/MM/YYYY Gregorian — the era the portal prints under the field', () => {
    // `DD/MM/YYYY(ค.ศ. / A.D.)`, read off the live page. Buddhist era would be 2569, not 2026.
    const r = portalCheckinDate('2026-08-07T00:00:00.000Z', ict('2026-08-07T12:00:00'));
    assert.match(r.value, /^\d{2}\/\d{2}\/\d{4}$/);
    assert.ok(r.value.endsWith('2026'));
    assert.equal(formatPortalDate(Date.parse('2026-01-09T00:00:00+07:00')), '09/01/2026');
});
