/**
 * Tiny ASCII sparkline renderer for embed-friendly trend visualisation.
 * No native deps — just braille-ish unicode blocks.
 *
 *   render([1, 2, 3, 5, 4, 6, 8])  // "▁▂▃▄▃▅▇"
 */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function render(series) {
    if (!Array.isArray(series) || series.length === 0) return '';
    const clean = series.filter((v) => Number.isFinite(v));
    if (clean.length === 0) return '';
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const range = max - min || 1;
    return clean.map((v) => {
        const idx = Math.min(BLOCKS.length - 1, Math.floor(((v - min) / range) * BLOCKS.length));
        return BLOCKS[idx];
    }).join('');
}

module.exports = { render };
