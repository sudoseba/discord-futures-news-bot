/**
 * Token-bucket rate limiter to stay within API free-tier limits.
 */
class RateLimiter {
    /**
     * @param {number} maxTokens  - Max requests allowed in the window
     * @param {number} windowMs   - Time window in milliseconds
     */
    constructor(maxTokens, windowMs) {
        this.maxTokens = maxTokens;
        this.windowMs = windowMs;
        this.tokens = maxTokens;
        this.lastRefill = Date.now();
    }

    /**
     * Refill tokens based on elapsed time.
     */
    _refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const refillAmount = (elapsed / this.windowMs) * this.maxTokens;
        this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
        this.lastRefill = now;
    }

    /**
     * Try to consume a token. Returns true if allowed, false if rate limited.
     */
    tryConsume() {
        this._refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false;
    }

    /**
     * Wait until a token is available, then consume it.
     */
    async waitForToken() {
        while (!this.tryConsume()) {
            const waitTime = Math.ceil(this.windowMs / this.maxTokens);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
}

// Pre-configured limiters for our APIs
const finnhubLimiter = new RateLimiter(60, 60_000);       // 60 req/min
const alphaVantageLimiter = new RateLimiter(5, 60_000);   // 5 req/min (free tier)

module.exports = { RateLimiter, finnhubLimiter, alphaVantageLimiter };
