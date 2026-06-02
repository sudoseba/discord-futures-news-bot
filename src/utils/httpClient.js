const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const log = require('./logger').child('http');

/**
 * Per-host token-bucket limiters. We construct one client per logical service so
 * each gets its own quota window and retry policy.
 */
class HostLimiter {
    constructor(maxTokens, windowMs) {
        this.maxTokens = maxTokens;
        this.windowMs = windowMs;
        this.tokens = maxTokens;
        this.lastRefill = Date.now();
        this.queue = [];
    }

    _refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        if (elapsed <= 0) return;
        this.tokens = Math.min(this.maxTokens, this.tokens + (elapsed / this.windowMs) * this.maxTokens);
        this.lastRefill = now;
    }

    async take() {
        this._refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }
        const waitMs = Math.max(50, Math.ceil(this.windowMs / this.maxTokens));
        await new Promise((resolve) => {
            this.queue.push(resolve);
            setTimeout(() => {
                const idx = this.queue.indexOf(resolve);
                if (idx >= 0) this.queue.splice(idx, 1);
                resolve();
            }, waitMs);
        });
        return this.take();
    }
}

const limiters = {
    finnhub: new HostLimiter(60, 60_000),
    alphaVantage: new HostLimiter(5, 60_000),
    yahoo: new HostLimiter(100, 60_000),
    binance: new HostLimiter(120, 60_000),
    coingecko: new HostLimiter(30, 60_000),
    stooq: new HostLimiter(60, 60_000),
    forexFactory: new HostLimiter(2, 5 * 60_000),
    cftc: new HostLimiter(30, 60_000),
    deepgram: new HostLimiter(20, 60_000),
    cerebras: new HostLimiter(60, 60_000),
    discord: new HostLimiter(50, 1_000),
    default: new HostLimiter(30, 60_000),
};

/**
 * Build an axios instance with sensible defaults: timeout, retries with
 * exponential backoff, and an automatic per-host rate limit before each request.
 */
function makeClient({ host = 'default', timeout = 10_000, retries = 3, baseURL } = {}) {
    const limiter = limiters[host] || limiters.default;

    const instance = axios.create({
        baseURL,
        timeout,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FuturesNewsBot/2.0)' },
    });

    axiosRetry(instance, {
        retries,
        retryDelay: axiosRetry.exponentialDelay,
        retryCondition: (err) => {
            if (axiosRetry.isNetworkOrIdempotentRequestError(err)) return true;
            const status = err.response?.status;
            return status === 429 || (status >= 500 && status < 600);
        },
        onRetry: (count, err, cfg) => {
            log.warn({ host, attempt: count, status: err.response?.status, url: cfg?.url }, 'HTTP retry');
        },
    });

    instance.interceptors.request.use(async (cfg) => {
        await limiter.take();
        return cfg;
    });

    return instance;
}

/**
 * Convenience one-shot GET with a freshly-built client.
 * For repeated calls to the same host prefer `makeClient` once and reuse it.
 */
async function get(url, opts = {}) {
    const { host, timeout, retries, ...rest } = opts;
    const client = makeClient({ host, timeout, retries });
    return client.get(url, rest);
}

module.exports = { makeClient, get, HostLimiter, limiters };
