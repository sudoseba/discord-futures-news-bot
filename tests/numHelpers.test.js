import { describe, it, expect } from 'vitest';
const { pctChange, safeDiv, clamp, formatPct, round, percentile } = require('../src/utils/numHelpers');

describe('numHelpers.pctChange', () => {
    it('computes the normal case', () => {
        expect(pctChange(100, 110)).toBeCloseTo(10);
        expect(pctChange(100, 90)).toBeCloseTo(-10);
    });
    it('returns null on zero denominator', () => {
        expect(pctChange(0, 5)).toBeNull();
    });
    it('returns null when either side is missing or non-finite', () => {
        expect(pctChange(null, 100)).toBeNull();
        expect(pctChange(100, undefined)).toBeNull();
        expect(pctChange(Infinity, 1)).toBeNull();
        expect(pctChange(1, NaN)).toBeNull();
    });
});

describe('numHelpers.safeDiv', () => {
    it('divides normally', () => {
        expect(safeDiv(10, 4)).toBe(2.5);
    });
    it('returns fallback on zero denom', () => {
        expect(safeDiv(10, 0)).toBe(0);
        expect(safeDiv(10, 0, -1)).toBe(-1);
    });
});

describe('numHelpers.clamp', () => {
    it('clamps within bounds', () => {
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(-1, 0, 10)).toBe(0);
        expect(clamp(20, 0, 10)).toBe(10);
    });
});

describe('numHelpers.formatPct', () => {
    it('formats with sign and 2dp', () => {
        expect(formatPct(3.456)).toBe('+3.46%');
        expect(formatPct(-1)).toBe('-1.00%');
    });
    it('returns dash for non-finite', () => {
        expect(formatPct(NaN)).toBe('—');
        expect(formatPct(null)).toBe('—');
    });
});

describe('numHelpers.round', () => {
    it('rounds to N digits', () => {
        expect(round(3.14159, 2)).toBe(3.14);
        expect(round(1.2345, 3)).toBe(1.235);
    });
    it('returns null for non-finite', () => {
        expect(round(NaN)).toBeNull();
    });
});

describe('numHelpers.percentile', () => {
    it('positions value in a series', () => {
        const s = [1, 2, 3, 4, 5];
        expect(percentile(s, 0)).toBe(0);
        expect(percentile(s, 3)).toBeCloseTo(0.4);
        expect(percentile(s, 10)).toBe(1);
    });
});
