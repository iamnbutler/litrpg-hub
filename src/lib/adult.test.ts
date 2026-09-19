import { describe, expect, it } from 'vitest';
import { defaultFilters } from './catalog';
import { adultUnlocked, applyAdultGate, isAdult, noConsent, parseAdultConsent, parseBirthDate } from './adult';

const at = '2026-09-19T12:00:00.000Z';
const open = { ...defaultFilters, hideSexualized: false, hideExplicit: false, hideHarem: false };

describe('date of birth', () => {
  it('accepts a real past date and rejects malformed, future and impossible ones', () => {
    expect(parseBirthDate('1990-02-28', new Date(at))).toBe('1990-02-28');
    expect(parseBirthDate('1990-02-30', new Date(at))).toBeNull();
    expect(parseBirthDate('2030-01-01', new Date(at))).toBeNull();
    expect(parseBirthDate('1850-01-01', new Date(at))).toBeNull();
    expect(parseBirthDate('1990-1-1', new Date(at))).toBeNull();
    expect(parseBirthDate(19900101, new Date(at))).toBeNull();
  });
  it('turns 18 on the birthday, not before it', () => {
    expect(isAdult('2008-09-18', at)).toBe(true);
    expect(isAdult('2008-09-19', at)).toBe(true);
    expect(isAdult('2008-09-20', at)).toBe(false);
    expect(isAdult(null, at)).toBe(false);
  });
  // A leap-day birth has no 29th in a common year; the cutoff resolves it to March 1 rather
  // than granting access a day early.
  it('resolves a leap-day birth without moving the birthday forward', () => {
    expect(isAdult('2008-02-29', '2026-02-28T12:00:00.000Z')).toBe(false);
    expect(isAdult('2008-02-29', '2026-03-01T12:00:00.000Z')).toBe(true);
  });
});

describe('the adult gate', () => {
  it('forces sexual-content filters on and leaves every other preference alone', () => {
    expect(applyAdultGate(open, false)).toEqual({ ...open, hideSexualized: true, hideExplicit: true });
    expect(applyAdultGate(open, false).hideHarem).toBe(false);
    expect(applyAdultGate(open, true)).toEqual(open);
  });
  it('stays shut with no claim, with a minor’s claim, and until the reader opts in', () => {
    expect(adultUnlocked(noConsent(), at)).toBe(false);
    expect(adultUnlocked({ birthDate: '2008-09-20', attestedAt: at, allowAdult: true }, at)).toBe(false);
    expect(adultUnlocked({ birthDate: '1990-01-01', attestedAt: at, allowAdult: false }, at)).toBe(false);
    expect(adultUnlocked({ birthDate: '1990-01-01', attestedAt: at, allowAdult: true }, at)).toBe(true);
  });
  // The reason the date is stored rather than a derived flag: the option must appear on its
  // own once the reader is old enough, without asking them to confirm a second time.
  it('re-derives from the date, so a claim made at 17 ages up on its own', () => {
    const attested = parseAdultConsent({ birthDate: '2008-09-20', attestedAt: at, allowAdult: true }, at);
    expect(attested).toEqual({ birthDate: '2008-09-20', attestedAt: at, allowAdult: false });
    expect(isAdult(attested.birthDate, '2026-09-20T12:00:00.000Z')).toBe(true);
  });
  it('never lets an unlock claim survive without a date that supports it', () => {
    expect(parseAdultConsent({ allowAdult: true }, at)).toEqual(noConsent());
    expect(parseAdultConsent({ birthDate: 'nonsense', attestedAt: at, allowAdult: true }, at)).toEqual(noConsent());
    expect(parseAdultConsent(null, at)).toEqual(noConsent());
    expect(parseAdultConsent('yes', at)).toEqual(noConsent());
  });
});

// The product rule: a reader who has set no date of birth, or one under 18, must never learn
// from the app that adult content exists in it. These assert the data layer cannot leak it;
// the UI enforces the matching rule by rendering the section only when verifiedAdult.
describe('discretion before a date of birth is set', () => {
  it('reports a locked gate identically for no claim and for a minor', () => {
    const none = parseAdultConsent(null, at);
    const minor = parseAdultConsent({ birthDate: '2015-01-01', attestedAt: at, allowAdult: true }, at);
    expect(adultUnlocked(none, at)).toBe(adultUnlocked(minor, at));
    expect(applyAdultGate(open, adultUnlocked(none, at))).toEqual(applyAdultGate(open, adultUnlocked(minor, at)));
  });
  it('hides the same signals whether or not the reader has ever been asked', () => {
    const locked = applyAdultGate(open, false);
    expect(locked.hideSexualized).toBe(true);
    expect(locked.hideExplicit).toBe(true);
  });
});
