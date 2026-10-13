'use strict';

/**
 * MO-TM30-PORTAL-DATE — the date the Helper types into the portal's `วันที่เข้าพัก / Check-in Date`.
 *
 * The rule is the operator's, recorded in ADR-0011: check-in today → today; any earlier check-in →
 * YESTERDAY, however much earlier it actually was; a future check-in → nothing at all, because a
 * notification cannot precede the arrival it notifies.
 *
 * 🔴 The middle branch is why this file has a decision record attached. `row.checkin` carries the
 * real arrival day and the worklist card already prints it, so the accurate value is available and
 * is deliberately not used. That is the operator's call about the operator's own filings; the
 * requirement it places on this code is that the substitution be VISIBLE — hence `basis`, which the
 * pane renders next to the value.
 *
 * Loaded as a plain `<script src>` by `app.html` (which has no node integration) and `require`d by
 * the tests. No dependencies, no clock of its own: `nowMs` is always passed in, so a day-boundary
 * case is a test, not a wait.
 *
 * DAYS ARE BANGKOK DAYS. The portal, the filing deadline and the operator are all in ICT; a date
 * derived from UTC would name the wrong day for the first seven hours of every Bangkok morning —
 * exactly when a manager is filing yesterday's late arrivals.
 */

/** ICT is a fixed +07:00 — Thailand has no DST, so an offset is the whole conversion. */
var BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Epoch ms of Bangkok midnight for the Bangkok day that `ms` falls in. */
function bangkokDayStart(ms) {
    var shifted = new Date(ms + BANGKOK_OFFSET_MS);
    return (
        Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
        BANGKOK_OFFSET_MS
    );
}

/**
 * The check-in DAY as Bangkok midnight, or null when unusable.
 *
 * `checkin` arrives as a `DATEONLY` serialised to UTC midnight (`2026-08-07T00:00:00.000Z`) — it
 * names a DAY, and its time part is an artefact of transport. So the day is read off the string,
 * never off a `Date` in some local zone, and then anchored to Bangkok midnight.
 */
function checkinDayStart(checkin) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(checkin || ''));
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - BANGKOK_OFFSET_MS;
}

/** Bangkok-midnight epoch ms → `DD/MM/YYYY`, the format the portal prints under both inputs. */
function formatPortalDate(dayStartMs) {
    var d = new Date(dayStartMs + BANGKOK_OFFSET_MS);
    var dd = String(d.getUTCDate()).padStart(2, '0');
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return dd + '/' + mm + '/' + d.getUTCFullYear();
}

var DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What to type into `Check-in Date`, and why.
 *
 * @param {string} checkin  the row's check-in (`YYYY-MM-DD…`); anything else ⇒ `{ value: null }`
 * @param {number} nowMs    the instant the pane is deciding at
 * @returns {{ value: string|null, basis: 'today'|'yesterday'|null, reason: string }}
 *          `value` is `DD/MM/YYYY` or null. NULL MEANS FILL NOTHING — never a default, never today.
 *          `basis` is what the pane shows the operator; `reason` is why nothing was filled.
 */
function portalCheckinDate(checkin, nowMs) {
    var day = checkinDayStart(checkin);
    if (day === null) return { value: null, basis: null, reason: 'no usable check-in date' };

    var today = bangkokDayStart(nowMs);
    if (day > today) {
        // The guest has not arrived. Filing a future arrival as "today" or "yesterday" would be
        // inventing an event; the human decides what to do with an early-prepared filing.
        return { value: null, basis: null, reason: 'check-in is in the future' };
    }
    if (day === today) return { value: formatPortalDate(today), basis: 'today', reason: '' };
    // Any earlier day — one day late or ten — is filed as yesterday (ADR-0011).
    return { value: formatPortalDate(today - DAY_MS), basis: 'yesterday', reason: '' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { portalCheckinDate: portalCheckinDate, formatPortalDate: formatPortalDate };
}
if (typeof window !== 'undefined') {
    window.portalCheckinDate = portalCheckinDate;
}
