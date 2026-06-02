require('dotenv').config();

module.exports = {
  // Discord
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  autoPostChannelId: process.env.AUTO_POST_CHANNEL_ID,

  // API Keys
  finnhubKey: process.env.FINNHUB_API_KEY,
  alphaVantageKey: process.env.ALPHA_VANTAGE_API_KEY,
  cerebrasApiKey: process.env.CEREBRAS_API_KEY,
  cerebrasModel: process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
  newsApiKey: process.env.NEWS_API_KEY,         // newsapi.org
  benzingaKey: process.env.BENZINGA_API_KEY,    // api.benzinga.com
  massiveKey: process.env.MASSIVE_API_KEY,      // massive.com (market data, not news)
  deepgramTtsKey: process.env.DEEPGRAM_TTS_API_KEY,  // deepgram.com TTS for recap audio
  // How long AI-generated outputs are cached before a fresh one is generated (ms).
  // If two users run the same command within this window, they get the same response
  // instantly — no duplicate LLM call, no extra latency.
  // Default: 20 minutes. Set to 0 to disable caching.
  llmCacheTtl: parseInt(process.env.LLM_CACHE_TTL_MS, 10) || 20 * 60 * 1000,


  // Schedules (cron)
  briefingCron: process.env.BRIEFING_CRON || '0 8 * * 1-5',   // 8 AM weekdays
  recapCron: process.env.RECAP_CRON || '30 16 * * 1-5',        // 4:30 PM weekdays
  anomalyScanCron: process.env.ANOMALY_SCAN_CRON || '*/15 * * * *', // every 15 min

  // Futures symbols mapped to Finnhub format
  watchlist: {
    // Commodities / Energy
    'OANDA:WTICO_USD': { name: 'Crude Oil (WTI)', category: 'oil', emoji: '🛢️' },
    'OANDA:BRENT_USD': { name: 'Brent Crude', category: 'oil', emoji: '🛢️' },
    'OANDA:NATGAS_USD': { name: 'Natural Gas', category: 'oil', emoji: '🔥' },

    // Metals
    'OANDA:XAU_USD': { name: 'Gold', category: 'metals', emoji: '🥇' },
    'OANDA:XAG_USD': { name: 'Silver', category: 'metals', emoji: '🥈' },
    'OANDA:XCU_USD': { name: 'Copper', category: 'metals', emoji: '🔶' },

    // Crypto
    'BINANCE:BTCUSDT': { name: 'Bitcoin', category: 'crypto', emoji: '₿' },
    'BINANCE:ETHUSDT': { name: 'Ethereum', category: 'crypto', emoji: 'Ξ' },

    // Forex
    'OANDA:EUR_USD': { name: 'EUR/USD', category: 'forex', emoji: '💶' },
    'OANDA:GBP_USD': { name: 'GBP/USD', category: 'forex', emoji: '💷' },
    'OANDA:USD_JPY': { name: 'USD/JPY', category: 'forex', emoji: '💴' },
  },

  // News keyword filters per category (use multi-word phrases to avoid false positives)
  newsKeywords: {
    oil: ['crude oil', 'brent crude', 'wti crude', 'opec', 'petroleum', 'natural gas', 'oil price', 'oil futures', 'energy sector', 'gasoline price', 'oil market', 'barrel', 'refinery', 'oil supply', 'oil demand'],
    metals: ['gold price', 'gold futures', 'silver price', 'silver futures', 'copper price', 'copper futures', 'platinum price', 'palladium', 'precious metals', 'gold mining', 'gold market', 'gold bullion', 'spot gold', 'xau'],
    crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'blockchain', 'defi', 'altcoin', 'stablecoin', 'binance', 'coinbase', 'crypto market'],
    forex: ['forex', 'currency market', 'eur/usd', 'gbp/usd', 'usd/jpy', 'dollar index', 'dxy', 'euro zone', 'interest rate', 'fed rate', 'central bank', 'treasury yield', 'bond yield', 'monetary policy'],
    // General financial terms — used when category is 'all' to catch macro/market news
    general: ['tariff', 'trade war', 'sanctions', 'inflation', 'gdp', 'earnings', 'stock market', 'wall street', 's&p 500', 'nasdaq', 'dow jones', 'federal reserve', 'treasury', 'bond market', 'recession', 'rally', 'sell-off', 'selloff', 'market crash', 'bull market', 'bear market', 'ipo', 'defense spending', 'fiscal policy', 'debt ceiling', 'trade deficit', 'jobs report', 'payroll', 'unemployment rate', 'consumer price', 'cpi', 'ppi', 'fomc'],
  },

  // Technical analysis defaults
  analysis: {
    rsiPeriod: 14,
    smaShort: 20,
    smaLong: 50,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    divergenceLookback: 30,  // bars to look back for divergence
    candleResolution: 'D',   // daily candles
    candleDays: 90,          // fetch 90 days of data
  },

  // Anomaly scanner thresholds (override via config.anomaly.* in code if needed)
  anomaly: {
    priceSpike: 2.0,    // % move in any watchlist asset
    vixSurge: 8.0,    // % move in VIX
    vixAbsolute: 25,     // VIX level cross
    dxyBreakout: 0.5,    // % move in DXY
    yieldSpike: 3.0,    // % move in 10Y yield
    fearGreedShift: 10,     // F&G point shift
    fundingExtreme: 0.0005, // 0.05% funding rate
    correlationSweep: 1.5,    // % threshold for multi-asset sweep
    correlationCount: 3,      // min assets moving together
  },
};
