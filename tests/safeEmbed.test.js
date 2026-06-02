import { describe, it, expect } from 'vitest';
const {
    LIMITS, truncate,
    safeTitle, safeDescription, safeFieldName, safeFieldValue,
    safeFields, embedCharCount, enforceTotalLimit,
} = require('../src/utils/safeEmbed');

describe('truncate', () => {
    it('passes short strings through', () => {
        expect(truncate('hi', 10)).toBe('hi');
    });
    it('truncates with ellipsis', () => {
        expect(truncate('abcdefghij', 5)).toBe('abcd…');
    });
    it('handles null/undefined', () => {
        expect(truncate(null, 5)).toBe('');
        expect(truncate(undefined, 5)).toBe('');
    });
});

describe('per-field clamps', () => {
    it('clamp title to 256', () => {
        const s = 'a'.repeat(1000);
        expect(safeTitle(s).length).toBeLessThanOrEqual(LIMITS.title);
    });
    it('clamp description to 4096', () => {
        const s = 'a'.repeat(5000);
        expect(safeDescription(s).length).toBeLessThanOrEqual(LIMITS.description);
    });
    it('clamp field value to 1024', () => {
        const s = 'a'.repeat(2000);
        expect(safeFieldValue(s).length).toBeLessThanOrEqual(LIMITS.fieldValue);
    });
});

describe('safeFields', () => {
    it('drops fields past the 25-field cap', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
        expect(safeFields(many)).toHaveLength(25);
    });
    it('substitutes zero-width for empty name/value', () => {
        const out = safeFields([{ name: '', value: '' }]);
        expect(out[0].name).toBeTruthy();
        expect(out[0].value).toBeTruthy();
    });
});

describe('enforceTotalLimit', () => {
    it('passes an under-limit embed unchanged', () => {
        const e = { title: 'hello', description: 'world', fields: [{ name: 'a', value: 'b' }] };
        const out = enforceTotalLimit(e);
        expect(out.description).toBe('world');
        expect(out.fields).toHaveLength(1);
    });
    it('trims description first when oversized', () => {
        const longDesc = 'a'.repeat(4000);
        const e = { title: 'x', description: longDesc, fields: Array.from({ length: 25 }, () => ({ name: 'a'.repeat(100), value: 'b'.repeat(100) })) };
        const out = enforceTotalLimit(e);
        expect(embedCharCount(out)).toBeLessThanOrEqual(LIMITS.totalChars);
    });
    it('drops trailing fields if description trim still leaves it over', () => {
        const e = {
            title: 'x',
            description: 'a'.repeat(500),
            fields: Array.from({ length: 25 }, () => ({ name: 'a'.repeat(250), value: 'b'.repeat(1000) })),
        };
        const out = enforceTotalLimit(e);
        expect(embedCharCount(out)).toBeLessThanOrEqual(LIMITS.totalChars);
        expect(out.fields.length).toBeLessThan(25);
    });
});
