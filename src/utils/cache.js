/**
 * In-memory cache with TTL expiration and stampede protection.
 * Concurrent callers for the same key will await a single in-flight fetch
 * instead of each triggering their own API call.
 *
 * - Periodic prune sweeps expired keys every 5 minutes so unused keys don't
 *   linger forever (the original implementation only purged on `get()`).
 * - `maxSize` evicts the oldest key when the cap is reached.
 */
class Cache {
    constructor(defaultTTL = 300_000, maxSize = 1000) {
        this.store = new Map();      // Map preserves insertion order → LRU eviction
        this.pending = new Map();
        this.defaultTTL = defaultTTL;
        this.maxSize = maxSize;

        if (Cache._cleanupAttached !== true) {
            // Single shared pruner — avoids piling up timers if many Cache instances exist.
            Cache._instances = Cache._instances || new Set();
            Cache._cleanupAttached = true;
            const handle = setInterval(() => {
                for (const c of Cache._instances) c.pruneExpired();
            }, 5 * 60_000);
            handle.unref();
        }
        if (Cache._instances) Cache._instances.add(this);
    }

    pruneExpired() {
        const now = Date.now();
        for (const [k, v] of this.store) {
            if (v.expiresAt <= now) this.store.delete(k);
        }
    }

    /**
     * Get a cached value, or null if expired / missing.
     */
    get(key) {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    /**
     * Set a value with optional custom TTL (ms). If the cache is at maxSize,
     * evict the oldest entry (Map iteration order is insertion order).
     */
    set(key, value, ttl) {
        if (this.store.size >= this.maxSize && !this.store.has(key)) {
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) this.store.delete(oldest);
        }
        // Re-insert to update insertion order on overwrite
        this.store.delete(key);
        this.store.set(key, {
            value,
            expiresAt: Date.now() + (ttl ?? this.defaultTTL),
        });
    }

    /**
     * Delete a specific key.
     */
    delete(key) {
        this.store.delete(key);
    }

    /**
     * Clear all entries.
     */
    clear() {
        this.store.clear();
        this.pending.clear();
    }

    /**
     * Get or fetch: returns cached value if available, otherwise calls fetchFn
     * and caches the result. Prevents cache stampede by tracking in-flight
     * promises — if another caller is already fetching this key, new callers
     * await the same promise instead of firing a duplicate request.
     */
    async getOrFetch(key, fetchFn, ttl) {
        // 1. Return cached value if available
        const cached = this.get(key);
        if (cached !== null) return cached;

        // 2. If a fetch is already in-flight for this key, wait for it
        if (this.pending.has(key)) {
            return this.pending.get(key);
        }

        // 3. Start the fetch and track the promise
        const fetchPromise = (async () => {
            try {
                const value = await fetchFn();
                this.set(key, value, ttl);
                return value;
            } finally {
                this.pending.delete(key);
            }
        })();

        this.pending.set(key, fetchPromise);
        return fetchPromise;
    }
}

module.exports = Cache;
