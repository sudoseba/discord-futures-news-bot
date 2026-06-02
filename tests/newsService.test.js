import { describe, it, expect } from 'vitest';

// We only test the pure helpers, not the network fetchers.
const { getSentimentEmoji, detectCategory, getSourceTier } = require('../src/services/newsService');

describe('getSentimentEmoji', () => {
    it('returns bullish for surge/rally', () => {
        expect(getSentimentEmoji('Gold prices surge to record high')).toBe('📈');
    });
    it('returns bearish for plunge/sell-off', () => {
        expect(getSentimentEmoji('Bitcoin plunges in sell-off')).toBe('📉');
    });
    it('returns neutral for balanced text', () => {
        expect(getSentimentEmoji('Bonds trade sideways ahead of Fed decision')).toBe('➡️');
    });
});

describe('detectCategory', () => {
    it('classifies oil text', () => {
        expect(detectCategory('OPEC announces production cut, crude oil rallies')).toBe('oil');
    });
    it('classifies metals text', () => {
        expect(detectCategory('Gold price hits new monthly high')).toBe('metals');
    });
    it('classifies crypto text', () => {
        expect(detectCategory('Bitcoin breaks above 70k as ETH gains')).toBe('crypto');
    });
});

describe('getSourceTier', () => {
    it('marks Reuters as tier 1', () => {
        expect(getSourceTier('Reuters')).toBe(1);
        expect(getSourceTier('', 'https://reuters.com/article')).toBe(1);
    });
    it('marks Bloomberg as tier 2', () => {
        expect(getSourceTier('Bloomberg')).toBe(2);
    });
    it('defaults unknown to tier 3', () => {
        expect(getSourceTier('Random Blog')).toBe(3);
    });
});
