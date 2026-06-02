import { describe, it, expect } from 'vitest';
const Cache = require('../src/utils/cache');

describe('Cache.set/get with TTL', () => {
    it('returns set values before expiry', () => {
        const c = new Cache(1000);
        c.set('k', 42);
        expect(c.get('k')).toBe(42);
    });
    it('returns null after expiry', async () => {
        const c = new Cache();
        c.set('k', 1, 10);
        await new Promise(r => setTimeout(r, 25));
        expect(c.get('k')).toBeNull();
    });
});

describe('Cache.getOrFetch dedup', () => {
    it('only invokes fetchFn once for concurrent callers', async () => {
        const c = new Cache(1000);
        let calls = 0;
        const fn = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return 'v'; };
        const [a, b] = await Promise.all([c.getOrFetch('k', fn), c.getOrFetch('k', fn)]);
        expect(calls).toBe(1);
        expect(a).toBe('v');
        expect(b).toBe('v');
    });
});

describe('Cache LRU eviction', () => {
    it('evicts the oldest entry once maxSize is reached', () => {
        const c = new Cache(60_000, 3);
        c.set('a', 1); c.set('b', 2); c.set('c', 3); c.set('d', 4);
        expect(c.get('a')).toBeNull();      // evicted
        expect(c.get('b')).toBe(2);
        expect(c.get('c')).toBe(3);
        expect(c.get('d')).toBe(4);
    });
});

describe('Cache.pruneExpired', () => {
    it('removes expired entries even if never read', async () => {
        const c = new Cache(60_000, 100);
        c.set('x', 1, 5);
        await new Promise(r => setTimeout(r, 15));
        c.pruneExpired();
        expect(c.store.has('x')).toBe(false);
    });
});
