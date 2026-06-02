const axios = require('axios');
const Parser = require('rss-parser');
const config = require('../config');
const Cache = require('../utils/cache');
const { finnhubLimiter } = require('../utils/rateLimiter');

const cache = new Cache(300_000); // 5-min cache
const rssParser = new Parser({ timeout: 10_000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarketBot/2.0)' } });

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const NEWSAPI_BASE = 'https://newsapi.org/v2';
const BENZINGA_BASE = 'https://api.benzinga.com/api/v2';

// ─── Source Credibility Tiers ─────────────────────────────────────────────────
// Tier 1: Wire services & major financial press — highest accuracy, fastest
// Tier 2: Major financial media — reliable but can have editorial spin
// Tier 3: General news / aggregators — useful but needs more filtering
const SOURCE_TIERS = {
    // Tier 1 — Wire + Institutional
    'reuters': 1, 'reuters.com': 1, 'apnews.com': 1, 'ap news': 1, 'associated press': 1,
    'financial times': 1, 'ft.com': 1, 'wall street journal': 1, 'wsj.com': 1,
    'marketwatch': 1, 'marketwatch.com': 1,
    // Tier 2 — Major Financial Media
    'bloomberg': 2, 'bloomberg.com': 2, 'cnbc': 2, 'cnbc.com': 2,
    'the economist': 2, 'economist.com': 2, 'barron\'s': 2, 'barrons.com': 2,
    'benzinga': 2, 'benzinga.com': 2, 'investing.com': 2,
    // Tier 3 — General (default)
};

function getSourceTier(source, url = '') {
    const s = (source || '').toLowerCase();
    const u = (url || '').toLowerCase();
    for (const [key, tier] of Object.entries(SOURCE_TIERS)) {
        if (s.includes(key) || u.includes(key)) return tier;
    }
    return 3;
}

// ─── RSS Feed Definitions (free, no key) ──────────────────────────────────────
const RSS_FEEDS = {
    all: [
        { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters', tier: 1 },
        { url: 'https://feeds.reuters.com/reuters/topNews', source: 'Reuters', tier: 1 },
        { url: 'https://apnews.com/hub/business.rss', source: 'AP News', tier: 1 },
        { url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines', source: 'MarketWatch', tier: 1 },
        { url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse', source: 'MarketWatch', tier: 1 },
    ],
    metals: [
        { url: 'https://www.investing.com/rss/news_25.rss', source: 'Investing.com', tier: 2 }, // Gold
        { url: 'https://www.investing.com/rss/news_26.rss', source: 'Investing.com', tier: 2 }, // Silver
        { url: 'https://feeds.reuters.com/reuters/commoditiesNews', source: 'Reuters', tier: 1 },
    ],
    oil: [
        { url: 'https://www.investing.com/rss/news_166.rss', source: 'Investing.com', tier: 2 }, // Crude
        { url: 'https://feeds.reuters.com/reuters/commoditiesNews', source: 'Reuters', tier: 1 },
    ],
    crypto: [
        { url: 'https://www.investing.com/rss/news_301.rss', source: 'Investing.com', tier: 2 }, // Crypto
        { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph', tier: 2 },
        { url: 'https://bitcoinmagazine.com/.rss/full/', source: 'Bitcoin Magazine', tier: 2 },
    ],
    forex: [
        { url: 'https://www.investing.com/rss/news_1.rss', source: 'Investing.com', tier: 2 }, // Forex
        { url: 'https://feeds.reuters.com/reuters/currenciesNews', source: 'Reuters', tier: 1 },
    ],
};

// ─── NewsAPI Queries ───────────────────────────────────────────────────────────
const NEWS_API_QUERIES = {
    oil: '"crude oil" OR "oil price" OR "oil futures" OR "brent crude" OR OPEC OR "natural gas price" OR WTI',
    metals: '"gold price" OR "gold futures" OR "silver price" OR "copper futures" OR "precious metals" OR "spot gold"',
    crypto: 'bitcoin OR ethereum OR "crypto market" OR blockchain OR "bitcoin price"',
    forex: 'forex OR "EUR/USD" OR "dollar index" OR "treasury yield" OR "central bank" OR "fed rate"',
    all: '"crude oil" OR "gold price" OR bitcoin OR forex OR "copper price" OR "silver price" OR "treasury yield"',
};

const BENZINGA_TOPICS = { oil: 'energy', metals: 'commodities', crypto: 'cryptocurrency', forex: 'forex', all: 'general' };

// ─── High-impact keywords (raise score) ───────────────────────────────────────
const HIGH_IMPACT_KEYWORDS = [
    'federal reserve', 'fed rate', 'fomc', 'interest rate', 'rate hike', 'rate cut', 'basis points',
    'opec', 'opec+', 'production cut', 'sanctions', 'tariff', 'trade war',
    'cpi', 'inflation', 'ppi', 'gdp', 'nonfarm payroll', 'jobs report', 'unemployment',
    'debt ceiling', 'treasury', 'bond yield', 'treasury yield', '10-year',
    'geopolit', 'war', 'iran', 'russia', 'ukraine', 'china',
    'bitcoin etf', 'crypto regulation', 'sec', 'bank of england', 'ecb', 'bank of japan', 'boj',
    'supply disruption', 'inventory', 'drawdown', 'strategic reserve',
];

// ─── Negative keywords (filter out) ───────────────────────────────────────────
const NEGATIVE_KEYWORDS = [
    'gold medal', 'gold-medal', 'golden state warriors', 'golden globe',
    'silver screen', 'silver lining', 'copper fit',
    'nfl draft', 'nba playoffs', 'mlb standings', 'nhl standings',
    'touchdown', 'slam dunk', 'world cup qualifier',
    'kardashian', 'reality tv', 'movie review', 'box office',
    'red carpet', 'grammy awards', 'emmy awards', 'super bowl halftime',
    'bring a trailer', 'bringatrailer', 'recipe of the',
];

const BLOCKED_SOURCES = new Set([
    'bringatrailer.com', 'crooksandliars.com', 'rawstory.com',
    'tmz.com', 'people.com', 'eonline.com', 'buzzfeed.com',
    'theonion.com', 'espn.com', 'bleacherreport.com', 'sportsillustrated.com',
]);

const STOCK_NOISE_PATTERNS = [
    /\bstock\s+(dives?|surges?|soars?|plunges?|tumbles?|rallies|slumps?|drops?)\b/i,
    /\b(stock|shares?)\s+(is|are)\s+(down|up|falling|rising)/i,
    /\bearnings\s+(report|reveal|miss|beat|outlook|results?|guidance)\b/i,
    /\bfda\s+(approv|submit|filing|clearance)\b/i,
    /\b(buy|sell|hold|outperform|underperform)\s+rating\b/i,
    /\bprice\s+target\s+(raised|lowered|cut|set)\b/i,
    /\banalyst\s+(upgrades?|downgrades?|initiates?|reiterate)\b/i,
    /\bipo\s+(pric|filing|debut)\b/i,
    /\bwhy\s+did\s+.{0,30}\s+(stock|shares?)\b/i,
];

const MACRO_OVERRIDE_KEYWORDS = [
    'tariff', 'trade war', 'sanctions', 'opec', 'federal reserve',
    'interest rate', 'inflation', 'gdp', 'recession', 'treasury',
    'crude oil', 'gold price', 'bitcoin', 'forex', 'dollar index',
    'central bank', 'geopolit', 'war', 's&p 500', 'bond yield', 'cpi', 'fomc',
];

// ─── Normalizer ───────────────────────────────────────────────────────────────
function normalize(article) {
    return {
        headline: (article.headline || article.title || '').trim(),
        summary: (article.summary || article.description || article.teaser || article.body?.substring(0, 300) || '').trim(),
        source: article.source?.name || article.source || 'Unknown',
        url: article.url || article.link || '',
        timestamp: article.datetime || (article.pubDate ? Math.floor(new Date(article.pubDate).getTime() / 1000) : null) || (article.publishedAt ? Math.floor(new Date(article.publishedAt).getTime() / 1000) : Math.floor(Date.now() / 1000)),
        image: article.image || article.urlToImage || null,
        category: null,
        tier: article.tier || 3,
        impactScore: 0,
    };
}

// ─── Impact Scoring ───────────────────────────────────────────────────────────
function scoreArticle(article) {
    const text = `${article.headline} ${article.summary}`.toLowerCase();
    let score = 0;

    // Source tier bonus
    if (article.tier === 1) score += 4;
    else if (article.tier === 2) score += 2;

    // High-impact keyword matches
    const hitCount = HIGH_IMPACT_KEYWORDS.filter(kw => text.includes(kw)).length;
    score += Math.min(hitCount * 2, 6);

    // Recency bonus (< 2 hours = +3, < 6 hours = +1)
    const ageMs = Date.now() - (article.timestamp * 1000);
    if (ageMs < 2 * 3600 * 1000) score += 3;
    else if (ageMs < 6 * 3600 * 1000) score += 1;

    return Math.min(Math.max(score, 1), 10);
}

function getImpactTag(score) {
    if (score >= 8) return { emoji: '🔥', label: 'High Impact' };
    if (score >= 5) return { emoji: '📋', label: 'Medium' };
    return { emoji: '💤', label: 'Low' };
}

// ─── Fuzzy Dedup ──────────────────────────────────────────────────────────────
// More robust than exact-match: articles that are >70% the same words are dupes
function wordSet(text) {
    return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3));
}

function isFuzzyDuplicate(a, b) {
    const wa = wordSet(a);
    const wb = wordSet(b);
    if (wa.size === 0 || wb.size === 0) return false;
    const intersection = new Set([...wa].filter(w => wb.has(w)));
    const similarity = intersection.size / Math.min(wa.size, wb.size);
    return similarity > 0.72;
}

// ─── Relevance Filter ─────────────────────────────────────────────────────────
function isIrrelevant(article) {
    const srcLower = (article.source || '').toLowerCase();
    for (const blocked of BLOCKED_SOURCES) {
        if (srcLower.includes(blocked) || (article.url || '').toLowerCase().includes(blocked)) return true;
    }
    const text = `${article.headline} ${article.summary}`.toLowerCase();
    if (NEGATIVE_KEYWORDS.some(neg => text.includes(neg))) return true;
    const hasMacroOverride = MACRO_OVERRIDE_KEYWORDS.some(kw => text.includes(kw));
    if (!hasMacroOverride && STOCK_NOISE_PATTERNS.some(p => p.test(text))) return true;
    return false;
}

// ─── RSS Feed Fetcher ─────────────────────────────────────────────────────────
async function fetchRssFeed(feedDef) {
    try {
        const feed = await rssParser.parseURL(feedDef.url);
        const items = (feed.items || []).slice(0, 20);
        return items.map(item => ({
            headline: item.title || '',
            summary: item.contentSnippet || item.content || item.summary || '',
            source: feedDef.source,
            url: item.link || '',
            pubDate: item.pubDate || item.isoDate,
            timestamp: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
            tier: feedDef.tier || 3,
            image: null,
            category: null,
            impactScore: 0,
        }));
    } catch (err) {
        console.warn(`[RSS] Failed to fetch ${feedDef.url}: ${err.message}`);
        return [];
    }
}

async function fetchAllRssFeeds(category) {
    const feeds = [...(RSS_FEEDS[category] || [])];
    // Always include the 'all' feeds (Reuters/AP/MarketWatch) regardless of category
    if (category !== 'all') {
        for (const f of RSS_FEEDS.all) {
            if (!feeds.some(existing => existing.url === f.url)) feeds.push(f);
        }
    }

    const results = await Promise.allSettled(feeds.map(f => fetchRssFeed(f)));
    const articles = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    console.log(`[RSS] Fetched ${articles.length} articles from ${feeds.length} feeds for [${category}]`);
    return articles;
}

// ─── Source 2: Finnhub ────────────────────────────────────────────────────────
async function fetchFinnhub(category) {
    try {
        await finnhubLimiter.waitForToken();
        const { data } = await axios.get(`${FINNHUB_BASE}/news`, {
            params: { category: 'general', token: config.finnhubKey },
            timeout: 8000,
        });
        if (!Array.isArray(data)) return [];
        return data.map(a => ({ ...normalize(a), tier: 2 }));
    } catch (err) {
        console.warn('[News] Finnhub fetch failed:', err.message);
        return [];
    }
}

// ─── Source 3: NewsAPI.org ────────────────────────────────────────────────────
async function fetchNewsApi(category) {
    if (!config.newsApiKey) return [];
    try {
        const { data } = await axios.get(`${NEWSAPI_BASE}/everything`, {
            params: { q: NEWS_API_QUERIES[category] || NEWS_API_QUERIES.all, apiKey: config.newsApiKey, language: 'en', sortBy: 'publishedAt', pageSize: 30 },
            timeout: 8000,
        });
        if (!Array.isArray(data.articles)) return [];
        return data.articles.map(a => {
            const n = normalize(a);
            n.tier = getSourceTier(n.source, n.url);
            return n;
        });
    } catch (err) {
        console.warn('[News] NewsAPI fetch failed:', err.message);
        return [];
    }
}

// ─── Source 4: Benzinga ───────────────────────────────────────────────────────
async function fetchBenzinga(category) {
    if (!config.benzingaKey) return [];
    try {
        const topic = BENZINGA_TOPICS[category] || 'general';
        const { data } = await axios.get(`${BENZINGA_BASE}/news`, {
            params: { token: config.benzingaKey, channels: topic !== 'general' ? topic : undefined, displayOutput: 'abstract', pageSize: 30 },
            timeout: 8000,
        });
        const articles = Array.isArray(data) ? data : (Array.isArray(data.articles) ? data.articles : []);
        return articles.map(a => {
            const n = normalize({ ...a, headline: a.title || a.headline, summary: a.teaser || a.body?.substring(0, 300), source: a.source || 'Benzinga', url: a.url || a.link, datetime: a.created ? Math.floor(new Date(a.created).getTime() / 1000) : undefined });
            n.tier = 2;
            return n;
        });
    } catch (err) {
        console.warn('[News] Benzinga fetch failed:', err.message);
        return [];
    }
}

// ─── Merge, Filter, Score, Deduplicate ────────────────────────────────────────
function mergeAndFilter(articles, category) {
    const keywords = category === 'all'
        ? Object.values(config.newsKeywords).flat()
        : config.newsKeywords[category] || [];

    const kept = [];
    let rejected = 0;

    for (const article of articles) {
        if (!article.headline?.trim()) continue;
        if (isIrrelevant(article)) { rejected++; continue; }

        // Category keyword filter — match on word boundaries so "oil" doesn't
        // hit "toiletries". For multi-word phrases (e.g. "crude oil"), substring
        // match is fine because the phrase itself is already specific.
        const text = ` ${(article.headline + ' ' + article.summary).toLowerCase()} `;
        const matchesCategory = keywords.length === 0 || keywords.some(kw => {
            if (kw.includes(' ')) return text.includes(kw);
            return text.includes(` ${kw} `) || text.includes(` ${kw},`) || text.includes(` ${kw}.`);
        });
        if (!matchesCategory) { rejected++; continue; }

        // Fuzzy dedup against already-kept articles
        const isDupe = kept.some(k => isFuzzyDuplicate(k.headline, article.headline));
        if (isDupe) continue;

        // Score the article
        const tier = article.tier || getSourceTier(article.source, article.url);
        const scored = {
            ...article,
            summary: article.summary?.substring(0, 300) || '',
            category: detectCategory(article.headline + ' ' + (article.summary || '')),
            tier,
            impactScore: scoreArticle({ ...article, tier }),
        };

        kept.push(scored);
    }

    if (rejected > 0) console.log(`[News] Filtered ${rejected} irrelevant/duplicate articles for [${category}]`);

    // Sort: Tier 1 breaking news first, then by impact score desc, then by recency desc
    kept.sort((a, b) => {
        const ageA = Date.now() - (a.timestamp * 1000);
        const ageB = Date.now() - (b.timestamp * 1000);
        const breakingA = a.tier === 1 && ageA < 2 * 3600 * 1000 ? 1 : 0;
        const breakingB = b.tier === 1 && ageB < 2 * 3600 * 1000 ? 1 : 0;
        if (breakingA !== breakingB) return breakingB - breakingA;
        if (b.impactScore !== a.impactScore) return b.impactScore - a.impactScore;
        return (b.timestamp || 0) - (a.timestamp || 0);
    });

    return kept;
}

// ─── Main Public Function ──────────────────────────────────────────────────────
/**
 * Fetch and merge market news from RSS feeds (Reuters/AP/MarketWatch/Investing) +
 * Finnhub + NewsAPI + Benzinga. Impact-scored, fuzzy-deduped, sorted by tier+recency.
 * @param {'oil'|'metals'|'crypto'|'forex'|'all'} category
 * @param {boolean} breakingOnly - If true, return only Tier 1 articles from past 30min
 */
async function fetchMarketNews(category = 'all', breakingOnly = false) {
    const cacheKey = `news:${category}:${breakingOnly ? 'breaking' : 'all'}`;
    return cache.getOrFetch(cacheKey, async () => {
        const [rss, finnhub, newsapi, benzinga] = await Promise.all([
            fetchAllRssFeeds(category),
            fetchFinnhub(category),
            fetchNewsApi(category),
            fetchBenzinga(category),
        ]);

        const combined = [...rss, ...finnhub, ...newsapi, ...benzinga];
        console.log(`[News] Raw: RSS=${rss.length} Finnhub=${finnhub.length} NewsAPI=${newsapi.length} Benzinga=${benzinga.length}`);

        let filtered = mergeAndFilter(combined, category);
        console.log(`[News] After filter: ${filtered.length} unique for [${category}]`);

        if (breakingOnly) {
            const cutoff = Date.now() - 30 * 60 * 1000; // Last 30 min
            filtered = filtered.filter(a => a.tier === 1 && (a.timestamp * 1000) >= cutoff);
            console.log(`[News] Breaking: ${filtered.length} Tier-1 articles in last 30min`);
        }

        return filtered.slice(0, 50);
    }, breakingOnly ? 60_000 : 300_000); // Breaking cache: 1min; normal cache: 5min
}

// ─── Helpers (used elsewhere in the codebase) ─────────────────────────────────
function detectCategory(text) {
    const lower = text.toLowerCase();
    for (const [cat, keywords] of Object.entries(config.newsKeywords)) {
        if (keywords.some(kw => lower.includes(kw))) return cat;
    }
    return 'general';
}

function getSentimentEmoji(text) {
    const lower = text.toLowerCase();
    const bullish = ['surge', 'rally', 'gain', 'rise', 'jump', 'soar', 'bull', 'boost', 'recover', 'rebound', 'climb', 'advance', 'high'];
    const bearish = ['drop', 'fall', 'decline', 'crash', 'plunge', 'bear', 'loss', 'slump', 'tumble', 'fear', 'selloff', 'sell-off', 'weakness', 'low', 'cut'];
    const bull = bullish.filter(w => lower.includes(w)).length;
    const bear = bearish.filter(w => lower.includes(w)).length;
    if (bull > bear) return '📈';
    if (bear > bull) return '📉';
    return '➡️';
}

module.exports = { fetchMarketNews, detectCategory, getSentimentEmoji, getImpactTag, SOURCE_TIERS, getSourceTier };
