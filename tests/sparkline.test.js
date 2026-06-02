import { describe, it, expect } from 'vitest';
const { render } = require('../src/utils/sparkline');

describe('sparkline.render', () => {
    it('returns empty for empty input', () => {
        expect(render([])).toBe('');
        expect(render(null)).toBe('');
    });
    it('renders one char per data point', () => {
        const out = render([1, 2, 3, 4, 5]);
        expect(out.length).toBe(5);
    });
    it('skips NaN/Infinity safely', () => {
        const out = render([1, NaN, 3, Infinity, 5]);
        expect(out.length).toBe(3); // only finite values render
    });
    it('produces lowest block for the min and highest for the max', () => {
        const out = render([0, 100]);
        expect(out[0]).toBe('▁');
        expect(out[1]).toBe('█');
    });
});
