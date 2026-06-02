/**
 * Weekly CFTC COT (Commitment of Traders) Report
 *
 * Runs every Friday late afternoon (after the CFTC publishes) and pulls
 * commercial (hedger) positioning for the futures-eligible watchlist symbols.
 * Builds a single embed grouped by asset showing commercial net change and
 * speculator extremes — classical positioning intel for the trading desk.
 */
const config = require('../config');
const { fetchCotForSymbol, CFTC_CODES } = require('./macroService');
const cooldownStore = require('./cooldownStore');
const log = require('../utils/logger').child('cot');

const COOLDOWN_MS = 60 * 60 * 60_000; // 60h — only emit one report per week

async function gather() {
    const reports = [];
    for (const symbol of Object.keys(config.watchlist)) {
        if (!CFTC_CODES[symbol]) continue;
        try {
            const cot = await fetchCotForSymbol(symbol);
            if (cot) reports.push({ symbol, ...cot, meta: config.watchlist[symbol] });
        } catch (err) {
            log.warn({ symbol, err: err.message }, 'cot fetch failed');
        }
    }
    return reports;
}

async function maybeBuildWeekly() {
    if (cooldownStore.isOnCooldown('cot_weekly')) {
        log.debug('cot weekly on cooldown');
        return null;
    }
    const reports = await gather();
    if (reports.length === 0) {
        log.warn('no COT reports available — skipping post');
        return null;
    }
    cooldownStore.setCooldown('cot_weekly', COOLDOWN_MS);
    return reports;
}

module.exports = { gather, maybeBuildWeekly };
