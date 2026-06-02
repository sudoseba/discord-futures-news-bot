const { RSI, MACD, SMA, ATR } = require('technicalindicators');
const config = require('../config');

/**
 * Calculate RSI for a series of closing prices.
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]}
 */
function calculateRSI(closes, period = config.analysis.rsiPeriod) {
    return RSI.calculate({ values: closes, period });
}

/**
 * Calculate MACD for a series of closing prices.
 * @param {number[]} closes
 * @returns {{ MACD: number, signal: number, histogram: number }[]}
 */
function calculateMACD(closes) {
    return MACD.calculate({
        values: closes,
        fastPeriod: config.analysis.macdFast,
        slowPeriod: config.analysis.macdSlow,
        signalPeriod: config.analysis.macdSignal,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    });
}

/**
 * Calculate Simple Moving Average.
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]}
 */
function calculateSMA(closes, period) {
    return SMA.calculate({ values: closes, period });
}

/**
 * Find local peaks (highs) and troughs (lows) in a data series.
 * @param {number[]} data
 * @param {number} window - how many bars on each side to compare
 * @returns {{ peaks: {index: number, value: number}[], troughs: {index: number, value: number}[] }}
 */
function findPeaksAndTroughs(data, window = 3) {
    const peaks = [];
    const troughs = [];

    // Strict inequalities (`<`, `>`) so flat plateaus don't register as both
    // peak and trough on the same bar, which would produce phantom divergences.
    for (let i = window; i < data.length - window; i++) {
        let isPeak = true;
        let isTrough = true;

        for (let j = 1; j <= window; j++) {
            if (data[i] < data[i - j] || data[i] < data[i + j]) isPeak = false;
            if (data[i] > data[i - j] || data[i] > data[i + j]) isTrough = false;
        }

        // A flat plateau where data[i] equals both neighbours is neither.
        if (isPeak && (data[i] > data[i - 1] || data[i] > data[i + 1])) {
            peaks.push({ index: i, value: data[i] });
        }
        if (isTrough && (data[i] < data[i - 1] || data[i] < data[i + 1])) {
            troughs.push({ index: i, value: data[i] });
        }
    }

    return { peaks, troughs };
}

/**
 * Detect RSI divergence by comparing price peaks/troughs with RSI peaks/troughs.
 *
 * Bullish divergence: price makes lower low, RSI makes higher low
 * Bearish divergence: price makes higher high, RSI makes lower high
 *
 * @param {number[]} closes  - closing prices
 * @param {number[]} rsiValues - corresponding RSI values
 * @param {number} lookback - how many bars to consider
 * @returns {{ type: 'bullish'|'bearish'|'none', details: string, strength: number }}
 */
function detectDivergence(closes, rsiValues, lookback = config.analysis.divergenceLookback) {
    // Align arrays — RSI is shorter than closes by (period) bars
    const offset = closes.length - rsiValues.length;
    const trimmedCloses = closes.slice(offset);

    // Only look at the most recent `lookback` bars
    const recentCloses = trimmedCloses.slice(-lookback);
    const recentRSI = rsiValues.slice(-lookback);

    const pricePeaksTroughs = findPeaksAndTroughs(recentCloses);
    const rsiPeaksTroughs = findPeaksAndTroughs(recentRSI);

    // Check for bearish divergence (higher price highs, lower RSI highs)
    const pricePeaks = pricePeaksTroughs.peaks;
    const rsiPeaks = rsiPeaksTroughs.peaks;

    if (pricePeaks.length >= 2 && rsiPeaks.length >= 2) {
        const lastPricePeak = pricePeaks[pricePeaks.length - 1];
        const prevPricePeak = pricePeaks[pricePeaks.length - 2];
        const lastRSIPeak = rsiPeaks[rsiPeaks.length - 1];
        const prevRSIPeak = rsiPeaks[rsiPeaks.length - 2];

        if (lastPricePeak.value > prevPricePeak.value && lastRSIPeak.value < prevRSIPeak.value) {
            const strength = Math.abs(lastRSIPeak.value - prevRSIPeak.value);
            return {
                type: 'bearish',
                details: `Price made higher high (${prevPricePeak.value.toFixed(2)} → ${lastPricePeak.value.toFixed(2)}) but RSI made lower high (${prevRSIPeak.value.toFixed(1)} → ${lastRSIPeak.value.toFixed(1)})`,
                strength: Math.min(10, Math.round(strength / 3)),
            };
        }
    }

    // Check for bullish divergence (lower price lows, higher RSI lows)
    const priceTroughs = pricePeaksTroughs.troughs;
    const rsiTroughs = rsiPeaksTroughs.troughs;

    if (priceTroughs.length >= 2 && rsiTroughs.length >= 2) {
        const lastPriceTrough = priceTroughs[priceTroughs.length - 1];
        const prevPriceTrough = priceTroughs[priceTroughs.length - 2];
        const lastRSITrough = rsiTroughs[rsiTroughs.length - 1];
        const prevRSITrough = rsiTroughs[rsiTroughs.length - 2];

        if (lastPriceTrough.value < prevPriceTrough.value && lastRSITrough.value > prevRSITrough.value) {
            const strength = Math.abs(lastRSITrough.value - prevRSITrough.value);
            return {
                type: 'bullish',
                details: `Price made lower low (${prevPriceTrough.value.toFixed(2)} → ${lastPriceTrough.value.toFixed(2)}) but RSI made higher low (${prevRSITrough.value.toFixed(1)} → ${lastRSITrough.value.toFixed(1)})`,
                strength: Math.min(10, Math.round(strength / 3)),
            };
        }
    }

    return { type: 'none', details: 'No divergence detected in the current lookback window.', strength: 0 };
}

/**
 * Calculate Average True Range (ATR).
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]}
 */
function calculateATR(highs, lows, closes, period = 14) {
    return ATR.calculate({ high: highs, low: lows, close: closes, period });
}

/**
 * Calculate volatility regime based on current ATR vs average ATR.
 * @param {number[]} atrValues
 * @returns {{ current: number, average: number, regime: string, regimeEmoji: string }}
 */
function getVolatilityRegime(atrValues) {
    if (!atrValues || atrValues.length < 10) {
        return { current: 0, average: 0, regime: 'Unknown', regimeEmoji: '❓' };
    }

    const currentATR = atrValues[atrValues.length - 1];
    // Average ATR over last 50 periods (or all available)
    const lookback = Math.min(50, atrValues.length);
    const avgATR = atrValues.slice(-lookback).reduce((a, b) => a + b, 0) / lookback;
    const ratio = currentATR / avgATR;

    let regime, regimeEmoji;
    if (ratio > 1.5) { regime = 'Extreme'; regimeEmoji = '🔴'; }
    else if (ratio > 1.2) { regime = 'High'; regimeEmoji = '🟠'; }
    else if (ratio > 0.8) { regime = 'Normal'; regimeEmoji = '🟢'; }
    else { regime = 'Low'; regimeEmoji = '🔵'; }

    return {
        current: +currentATR.toFixed(4),
        average: +avgATR.toFixed(4),
        regime,
        regimeEmoji,
    };
}

/**
 * Run full technical analysis on candle data.
 * @param {object} candles - { open, high, low, close, volume, timestamp }
 * @returns {object} Full analysis result including TA + risk metrics
 */
function analyze(candles) {
    // Support legacy call with just closes array
    const closes = Array.isArray(candles) ? candles : candles.close;
    const highs = Array.isArray(candles) ? null : candles.high;
    const lows = Array.isArray(candles) ? null : candles.low;

    const rsiValues = calculateRSI(closes);
    const macdValues = calculateMACD(closes);
    const smaShortValues = calculateSMA(closes, config.analysis.smaShort);
    const smaLongValues = calculateSMA(closes, config.analysis.smaLong);

    const currentRSI = rsiValues[rsiValues.length - 1];
    const currentMACD = macdValues[macdValues.length - 1];
    const currentSMAShort = smaShortValues[smaShortValues.length - 1];
    const currentSMALong = smaLongValues[smaLongValues.length - 1];

    // RSI signal interpretation
    let rsiSignal = 'Neutral';
    if (currentRSI > 70) rsiSignal = '⚠️ Overbought';
    else if (currentRSI > 60) rsiSignal = 'Bullish';
    else if (currentRSI < 30) rsiSignal = '⚠️ Oversold';
    else if (currentRSI < 40) rsiSignal = 'Bearish';

    // MACD signal
    let macdSignal = 'Neutral';
    if (currentMACD) {
        if (currentMACD.histogram > 0) macdSignal = 'Bullish';
        else if (currentMACD.histogram < 0) macdSignal = 'Bearish';
    }

    // SMA crossover
    let trendSignal = 'Neutral';
    if (currentSMAShort && currentSMALong) {
        if (currentSMAShort > currentSMALong) trendSignal = '📈 Uptrend (SMA20 > SMA50)';
        else trendSignal = '📉 Downtrend (SMA20 < SMA50)';
    }

    const divergence = detectDivergence(closes, rsiValues);

    // Risk metrics (ATR + Expected Move + Vol Regime). Guard against zero or
    // non-finite current price — otherwise expectedMovePercent becomes Infinity
    // and the embed renders "Infinity%".
    let riskMetrics = null;
    if (highs && lows) {
        const atrValues = calculateATR(highs, lows, closes);
        if (atrValues.length > 0) {
            const volRegime = getVolatilityRegime(atrValues);
            const currentPrice = closes[closes.length - 1];
            const expectedMove = volRegime.current;
            const expectedMovePercent = Number.isFinite(currentPrice) && currentPrice > 0
                ? (expectedMove / currentPrice * 100)
                : 0;

            riskMetrics = {
                atr: volRegime.current,
                atrAvg: volRegime.average,
                expectedMove: +expectedMove.toFixed(2),
                expectedMovePercent: +expectedMovePercent.toFixed(2),
                regime: volRegime.regime,
                regimeEmoji: volRegime.regimeEmoji,
            };
        }
    }

    return {
        rsi: currentRSI ? +currentRSI.toFixed(2) : null,
        rsiSignal,
        macd: currentMACD ? {
            value: +currentMACD.MACD.toFixed(4),
            signal: +currentMACD.signal.toFixed(4),
            histogram: +currentMACD.histogram.toFixed(4),
        } : null,
        macdSignal,
        smaShort: currentSMAShort ? +currentSMAShort.toFixed(4) : null,
        smaLong: currentSMALong ? +currentSMALong.toFixed(4) : null,
        trendSignal,
        divergence,
        riskMetrics,
    };
}

/**
 * Cluster nearby price levels together.
 * Levels within `threshold` percent of each other are merged into one (averaged).
 */
function clusterLevels(prices, thresholdPct = 0.5) {
    if (!prices || prices.length === 0) return [];
    const sorted = [...prices].filter(Number.isFinite).sort((a, b) => a - b);
    const clusters = [];

    for (const price of sorted) {
        const last = clusters[clusters.length - 1];
        // Guard against last.center === 0 (degenerate price series).
        const distancePct = last && last.center !== 0
            ? Math.abs(price - last.center) / Math.abs(last.center) * 100
            : Infinity;
        if (last && distancePct < thresholdPct) {
            last.prices.push(price);
            last.center = last.prices.reduce((s, v) => s + v, 0) / last.prices.length;
            last.strength++;
        } else {
            clusters.push({ center: price, prices: [price], strength: 1 });
        }
    }

    return clusters;
}

/**
 * Algorithmically detect real support and resistance levels using five methods:
 *  1. Swing highs/lows (local peak/trough detection)
 *  2. Standard Daily Pivot Point (PP, R1-R3, S1-S3)
 *  3. Fibonacci retracement levels from recent swing range
 *  4. SMA-20 and SMA-50 as dynamic levels
 *  5. Weekly high/low and all-time 90-day range extremes
 *
 * Returns { resistances, supports, pivot, fibLevels, smaDynamic }
 * All prices are taken directly from actual candle data — no LLM involved.
 *
 * @param {object} candles - { high, low, close, open }
 * @returns {object}
 */
function detectLevels(candles) {
    const { high, low, close, open } = candles;
    const len = close.length;
    if (len < 20) return null;
    if (!Number.isFinite(close[len - 1]) || close[len - 1] <= 0) return null;

    const currentPrice = close[len - 1];

    // ── 1. Swing Highs/Lows (local peaks with window=3, confirmed twice) ─────
    // Strict inequalities so flat plateaus aren't double-counted as both
    // peak and trough — see findPeaksAndTroughs() for the same rationale.
    const swingHighs = [];
    const swingLows = [];
    const WIN = 4;
    for (let i = WIN; i < len - WIN; i++) {
        let isPeak = true, isTrough = true;
        for (let j = 1; j <= WIN; j++) {
            if (high[i] < high[i - j] || high[i] < high[i + j]) isPeak = false;
            if (low[i] > low[i - j] || low[i] > low[i + j]) isTrough = false;
        }
        if (isPeak && (high[i] > high[i - 1] || high[i] > high[i + 1])) swingHighs.push(high[i]);
        if (isTrough && (low[i] < low[i - 1] || low[i] < low[i + 1])) swingLows.push(low[i]);
    }

    // ── 2. Classic Pivot Point (last completed session) ───────────────────────
    const prevH = high[len - 2];
    const prevL = low[len - 2];
    const prevC = close[len - 2];
    const pp = (prevH + prevL + prevC) / 3;
    const r1 = 2 * pp - prevL;
    const r2 = pp + (prevH - prevL);
    const r3 = prevH + 2 * (pp - prevL);
    const s1 = 2 * pp - prevH;
    const s2 = pp - (prevH - prevL);
    const s3 = prevL - 2 * (prevH - pp);

    // ── 3. Fibonacci from recent 90-day range ─────────────────────────────────
    const rangeHigh = Math.max(...high);
    const rangeLow = Math.min(...low);
    const range = rangeHigh - rangeLow;
    const fib236 = rangeHigh - range * 0.236;
    const fib382 = rangeHigh - range * 0.382;
    const fib500 = rangeHigh - range * 0.500;
    const fib618 = rangeHigh - range * 0.618;
    const fib786 = rangeHigh - range * 0.786;

    // ── 4. SMA Dynamic Levels ─────────────────────────────────────────────────
    const sma20 = close.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const sma50 = len >= 50 ? close.slice(-50).reduce((a, b) => a + b, 0) / 50 : null;

    // ── 5. Weekly range (last 5 sessions) and 90-day range extremes ───────────
    const weekHigh = Math.max(...high.slice(-5));
    const weekLow = Math.min(...low.slice(-5));

    // ── Cluster all resistance candidates above price ─────────────────────────
    const resCandidates = [
        ...swingHighs,
        r1, r2, r3,
        fib236, fib382,
        weekHigh, rangeHigh,
        ...(sma20 > currentPrice ? [sma20] : []),
        ...(sma50 && sma50 > currentPrice ? [sma50] : []),
    ].filter(p => p > currentPrice * 1.001); // must be meaningfully above price

    // ── Cluster all support candidates below price ────────────────────────────
    const supCandidates = [
        ...swingLows,
        s1, s2, s3,
        fib618, fib786, fib500,
        weekLow, rangeLow,
        ...(sma20 < currentPrice ? [sma20] : []),
        ...(sma50 && sma50 < currentPrice ? [sma50] : []),
    ].filter(p => p < currentPrice * 0.999); // must be meaningfully below price

    const resClusters = clusterLevels(resCandidates)
        .sort((a, b) => a.center - b.center) // nearest first
        .slice(0, 5);

    const supClusters = clusterLevels(supCandidates)
        .sort((a, b) => b.center - a.center) // nearest first (descending)
        .slice(0, 5);

    // Tag each level with which methods detected it
    function tagLevel(cluster, above) {
        const c = cluster.center;
        const tags = [];
        const tol = c * 0.005; // 0.5% tolerance for tagging

        if (above) {
            if (swingHighs.some(s => Math.abs(s - c) < tol)) tags.push('Swing High');
            if (Math.abs(r1 - c) < tol) tags.push('R1 Pivot');
            if (Math.abs(r2 - c) < tol) tags.push('R2 Pivot');
            if (Math.abs(r3 - c) < tol) tags.push('R3 Pivot');
            if (Math.abs(fib236 - c) < tol) tags.push('Fib 23.6%');
            if (Math.abs(fib382 - c) < tol) tags.push('Fib 38.2%');
            if (Math.abs(weekHigh - c) < tol) tags.push('Weekly High');
            if (Math.abs(rangeHigh - c) < tol) tags.push('90d High');
            if (sma20 > currentPrice && Math.abs(sma20 - c) < tol) tags.push('SMA-20');
            if (sma50 && sma50 > currentPrice && Math.abs(sma50 - c) < tol) tags.push('SMA-50');
        } else {
            if (swingLows.some(s => Math.abs(s - c) < tol)) tags.push('Swing Low');
            if (Math.abs(s1 - c) < tol) tags.push('S1 Pivot');
            if (Math.abs(s2 - c) < tol) tags.push('S2 Pivot');
            if (Math.abs(s3 - c) < tol) tags.push('S3 Pivot');
            if (Math.abs(fib618 - c) < tol) tags.push('Fib 61.8%');
            if (Math.abs(fib786 - c) < tol) tags.push('Fib 78.6%');
            if (Math.abs(fib500 - c) < tol) tags.push('Fib 50%');
            if (Math.abs(weekLow - c) < tol) tags.push('Weekly Low');
            if (Math.abs(rangeLow - c) < tol) tags.push('90d Low');
            if (sma20 < currentPrice && Math.abs(sma20 - c) < tol) tags.push('SMA-20');
            if (sma50 && sma50 < currentPrice && Math.abs(sma50 - c) < tol) tags.push('SMA-50');
        }

        // Strength label: more methods agreeing = stronger level
        const totalStrength = cluster.strength + tags.length;
        const label = totalStrength >= 4 ? 'Major' : totalStrength >= 2 ? 'Strong' : 'Minor';

        return {
            price: +c.toFixed(4),
            label,
            methods: tags.length > 0 ? tags : [above ? 'Swing High' : 'Swing Low'],
            strength: totalStrength,
            note: tags.length > 0 ? tags.join(' + ') : (above ? 'Swing resistance area' : 'Swing support area'),
        };
    }

    return {
        resistances: resClusters.map(c => tagLevel(c, true)),
        supports: supClusters.map(c => tagLevel(c, false)),
        pivot: +pp.toFixed(4),
        fibLevels: {
            rangeHigh: +rangeHigh.toFixed(4),
            rangeLow: +rangeLow.toFixed(4),
            fib236: +fib236.toFixed(4),
            fib382: +fib382.toFixed(4),
            fib500: +fib500.toFixed(4),
            fib618: +fib618.toFixed(4),
            fib786: +fib786.toFixed(4),
        },
        smaDynamic: {
            sma20: +sma20.toFixed(4),
            sma50: sma50 ? +sma50.toFixed(4) : null,
        },
        currentPrice,
    };
}

module.exports = {
    calculateRSI,
    calculateMACD,
    calculateSMA,
    calculateATR,
    getVolatilityRegime,
    findPeaksAndTroughs,
    detectDivergence,
    detectLevels,
    analyze,
};
