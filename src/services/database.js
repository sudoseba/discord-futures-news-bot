const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ─── Database Location ──────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'bot.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

let db = null;

// ─── Initialize ─────────────────────────────────────────────────────────────

/**
 * Open the database connection and run migrations.
 * Called once at bot startup.
 * @returns {Database} The database instance
 */
function initDatabase() {
    if (db) return db;

    // Ensure data + backups directories exist
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    db = new Database(DB_PATH, {
        // WAL mode for better concurrent read performance
        verbose: process.env.DB_VERBOSE === 'true' ? console.log : undefined,
    });

    // Performance pragmas
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');  // 64MB cache
    db.pragma('foreign_keys = ON');
    db.pragma('temp_store = MEMORY');
    db.pragma('busy_timeout = 5000');  // wait up to 5s instead of SQLITE_BUSY

    // Integrity check — bail loudly rather than silently corrupting
    try {
        const integrity = db.prepare("PRAGMA integrity_check").get();
        const ok = integrity?.integrity_check === 'ok';
        if (!ok) {
            console.error('[DB] FATAL: integrity_check failed:', integrity);
            throw new Error('Database integrity check failed — restore from data/backups/');
        }
    } catch (err) {
        if (err.message.includes('integrity check failed')) throw err;
        console.warn('[DB] integrity_check pragma unavailable:', err.message);
    }

    runMigrations();
    scheduleCleanup();

    console.log(`[DB] Database initialized at ${DB_PATH}`);
    return db;
}

/**
 * Get the database instance (must call initDatabase first).
 */
function getDb() {
    if (!db) throw new Error('[DB] Database not initialized. Call initDatabase() first.');
    return db;
}

// ─── Schema & Migrations ────────────────────────────────────────────────────

function runMigrations() {
    // Schema version tracking
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        );
    `);

    const currentVersion = db.prepare(
        'SELECT MAX(version) as v FROM schema_version'
    ).get()?.v || 0;

    const migrations = [
        // ── v1: Core tables ──────────────────────────────────────────
        {
            version: 1,
            sql: `
                -- Historical price snapshots for every watchlist symbol
                CREATE TABLE IF NOT EXISTS market_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    name TEXT,
                    price REAL,
                    open REAL,
                    high REAL,
                    low REAL,
                    prev_close REAL,
                    change_val REAL,
                    change_pct REAL,
                    recorded_at TEXT DEFAULT (datetime('now')),
                    source TEXT DEFAULT 'yahoo'
                );
                CREATE INDEX IF NOT EXISTS idx_snapshots_symbol_time
                    ON market_snapshots(symbol, recorded_at);
                CREATE INDEX IF NOT EXISTS idx_snapshots_time
                    ON market_snapshots(recorded_at);

                -- News articles with deduplication and sentiment
                CREATE TABLE IF NOT EXISTS news_articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    headline TEXT NOT NULL,
                    summary TEXT,
                    source TEXT,
                    url TEXT,
                    category TEXT,
                    sentiment_score REAL,
                    sentiment_label TEXT,
                    is_curated INTEGER DEFAULT 0,
                    published_at INTEGER,
                    recorded_at TEXT DEFAULT (datetime('now')),
                    UNIQUE(headline, source)
                );
                CREATE INDEX IF NOT EXISTS idx_articles_category_time
                    ON news_articles(category, recorded_at);
                CREATE INDEX IF NOT EXISTS idx_articles_headline
                    ON news_articles(headline);

                -- Macro instrument snapshots (DXY, 10Y, VIX)
                CREATE TABLE IF NOT EXISTS macro_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instrument TEXT NOT NULL,
                    price REAL,
                    change_val REAL,
                    change_pct REAL,
                    recorded_at TEXT DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_macro_instr_time
                    ON macro_snapshots(instrument, recorded_at);

                -- Sentiment readings (Fear & Greed, funding rates)
                CREATE TABLE IF NOT EXISTS sentiment_readings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    metric TEXT NOT NULL,
                    value REAL,
                    label TEXT,
                    extra_json TEXT,
                    recorded_at TEXT DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_sentiment_metric_time
                    ON sentiment_readings(metric, recorded_at);

                -- LLM-generated analyses and briefings
                CREATE TABLE IF NOT EXISTS llm_outputs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    output_type TEXT NOT NULL,
                    symbol TEXT,
                    category TEXT,
                    content TEXT NOT NULL,
                    input_summary TEXT,
                    model TEXT,
                    tokens_used INTEGER,
                    recorded_at TEXT DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_llm_type_symbol_time
                    ON llm_outputs(output_type, symbol, recorded_at);
                CREATE INDEX IF NOT EXISTS idx_llm_type_time
                    ON llm_outputs(output_type, recorded_at);

                -- Economic calendar events with outcome tracking
                CREATE TABLE IF NOT EXISTS economic_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_name TEXT NOT NULL,
                    event_date TEXT,
                    event_time TEXT,
                    impact TEXT,
                    forecast TEXT,
                    previous TEXT,
                    actual TEXT,
                    source TEXT,
                    recorded_at TEXT DEFAULT (datetime('now')),
                    UNIQUE(event_name, event_date)
                );
                CREATE INDEX IF NOT EXISTS idx_events_date_impact
                    ON economic_events(event_date, impact);
            `,
        },

        // ── v2: Correlation & alert tracking ─────────────────────────
        {
            version: 2,
            sql: `
                -- Track correlation observations for pattern learning
                CREATE TABLE IF NOT EXISTS correlation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    dxy_price REAL,
                    dxy_change_pct REAL,
                    tnx_price REAL,
                    tnx_change_pct REAL,
                    vix_price REAL,
                    vix_change_pct REAL,
                    symbol_price REAL,
                    symbol_change_pct REAL,
                    notes TEXT,
                    recorded_at TEXT DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_corr_symbol_time
                    ON correlation_log(symbol, recorded_at);

                -- Track what was posted to avoid re-sending
                CREATE TABLE IF NOT EXISTS posted_content (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content_type TEXT NOT NULL,
                    content_hash TEXT NOT NULL UNIQUE,
                    channel_id TEXT,
                    posted_at TEXT DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_posted_hash
                    ON posted_content(content_hash);
            `,
        },

        // ── v3: Anomaly scanner tables ────────────────────────────────
        {
            version: 3,
            sql: `
                -- One row per scan cycle (every 15 min)
                CREATE TABLE IF NOT EXISTS anomaly_scans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scan_data_json TEXT NOT NULL,
                    anomalies_detected INTEGER DEFAULT 0,
                    anomalies_posted INTEGER DEFAULT 0,
                    recorded_at TEXT DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_scans_time
                    ON anomaly_scans(recorded_at);

                -- One row per detected anomaly
                CREATE TABLE IF NOT EXISTS anomaly_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scan_id INTEGER,
                    anomaly_type TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    anomaly_key TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    fields_json TEXT,
                    was_posted INTEGER DEFAULT 0,
                    recorded_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY (scan_id) REFERENCES anomaly_scans(id)
                );
                CREATE INDEX IF NOT EXISTS idx_anomaly_type_time
                    ON anomaly_events(anomaly_type, recorded_at);
                CREATE INDEX IF NOT EXISTS idx_anomaly_severity_time
                    ON anomaly_events(severity, recorded_at);
                CREATE INDEX IF NOT EXISTS idx_anomaly_scan
                    ON anomaly_events(scan_id);
            `,
        },

        // ── v4: Anomaly DM subscriber opt-in ─────────────────────────
        {
            version: 4,
            sql: `
                -- Users who have opted in to receive anomaly DM alerts
                CREATE TABLE IF NOT EXISTS anomaly_subscribers (
                    user_id TEXT PRIMARY KEY,
                    categories TEXT DEFAULT 'all',
                    subscribed_at TEXT DEFAULT (datetime('now')),
                    active INTEGER DEFAULT 1
                );
            `,
        },

        // ── v5: Persistent cooldowns + dead-letter queue + user prefs ───
        {
            version: 5,
            sql: `
                -- Survives restart: anomaly/level-break/event cooldowns
                CREATE TABLE IF NOT EXISTS cooldowns (
                    key TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_cooldowns_expires
                    ON cooldowns(expires_at);

                -- Posts that failed to deliver; retried by the deadletter cron
                CREATE TABLE IF NOT EXISTS pending_posts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    channel_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    attempts INTEGER DEFAULT 0,
                    next_retry_at INTEGER NOT NULL,
                    last_error TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_pending_next
                    ON pending_posts(next_retry_at);

                -- Per-user alert snooze / mute preferences
                CREATE TABLE IF NOT EXISTS user_prefs (
                    user_id TEXT NOT NULL,
                    pref_key TEXT NOT NULL,
                    pref_value TEXT,
                    expires_at INTEGER,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (user_id, pref_key)
                );
            `,
        },

        // ── v6: Signal replay scorecard + level-break state + funding-flip state
        {
            version: 6,
            sql: `
                -- Each row = one alert captured at time of fire with the price snapshot.
                -- The scorecard cron resolves price_1h / price_4h / price_24h later.
                CREATE TABLE IF NOT EXISTS signal_replay (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    signal_type TEXT NOT NULL,         -- 'divergence', 'price_spike', 'level_break', 'vix_surge', ...
                    direction TEXT NOT NULL,           -- 'bullish' | 'bearish'
                    symbol TEXT,
                    snapshot_json TEXT,
                    captured_price REAL NOT NULL,
                    captured_at INTEGER NOT NULL,
                    price_1h REAL,
                    price_4h REAL,
                    price_24h REAL,
                    pnl_1h_pct REAL,
                    pnl_4h_pct REAL,
                    pnl_24h_pct REAL,
                    resolved_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_replay_unresolved
                    ON signal_replay(captured_at, resolved_at);
                CREATE INDEX IF NOT EXISTS idx_replay_type_dir
                    ON signal_replay(signal_type, direction, captured_at);

                -- Tracks last-known state of each price-vs-level relationship so
                -- we only emit on transitions, not while price stays one side.
                CREATE TABLE IF NOT EXISTS level_break_state (
                    symbol TEXT NOT NULL,
                    level_price REAL NOT NULL,
                    level_label TEXT,
                    last_side TEXT NOT NULL,         -- 'above' | 'below'
                    last_break_at INTEGER,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (symbol, level_price)
                );

                -- Tracks last sign of funding rate per symbol for flip detection
                CREATE TABLE IF NOT EXISTS funding_flip_state (
                    symbol TEXT PRIMARY KEY,
                    last_sign INTEGER NOT NULL,      -- -1, 0, 1
                    last_rate REAL NOT NULL,
                    last_flip_at INTEGER,
                    updated_at INTEGER NOT NULL
                );
            `,
        },
    ];

    const insertVersion = db.prepare('INSERT INTO schema_version (version) VALUES (?)');

    for (const migration of migrations) {
        if (migration.version > currentVersion) {
            console.log(`[DB] Running migration v${migration.version}...`);
            db.exec(migration.sql);
            insertVersion.run(migration.version);
            console.log(`[DB] Migration v${migration.version} applied.`);
        }
    }
}

// ─── Prepared Statements (lazy-initialized) ─────────────────────────────────

const stmts = {};

function getStmt(name, sql) {
    if (!stmts[name]) {
        stmts[name] = getDb().prepare(sql);
    }
    return stmts[name];
}

// ─── Market Snapshots ───────────────────────────────────────────────────────

function insertMarketSnapshot(symbol, name, quote, source = 'yahoo') {
    if (!quote || !quote.current) return;
    return getStmt('insert_snapshot', `
        INSERT INTO market_snapshots (symbol, name, price, open, high, low, prev_close, change_val, change_pct, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        symbol, name,
        quote.current, quote.open, quote.high, quote.low, quote.prevClose,
        quote.change, quote.changePercent,
        source
    );
}

function getRecentSnapshots(symbol, limit = 30) {
    return getStmt('get_recent_snapshots', `
        SELECT * FROM market_snapshots
        WHERE symbol = ?
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(symbol, limit);
}

function getSnapshotRange(symbol, daysBack = 7) {
    return getStmt('get_snapshot_range', `
        SELECT * FROM market_snapshots
        WHERE symbol = ? AND recorded_at >= datetime('now', '-' || ? || ' days')
        ORDER BY recorded_at ASC
    `).all(symbol, daysBack);
}

/**
 * Get the latest snapshot for a symbol (used for change-detection).
 */
function getLatestSnapshot(symbol) {
    return getStmt('get_latest_snapshot', `
        SELECT * FROM market_snapshots
        WHERE symbol = ?
        ORDER BY recorded_at DESC
        LIMIT 1
    `).get(symbol);
}

// ─── News Articles ──────────────────────────────────────────────────────────

/**
 * Insert a news article. Returns false if duplicate (headline+source already exists).
 * Only swallows constraint violations — schema/disk errors are logged and re-thrown.
 */
function insertArticle(article) {
    try {
        getStmt('insert_article', `
            INSERT OR IGNORE INTO news_articles
            (headline, summary, source, url, category, sentiment_score, sentiment_label, is_curated, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            article.headline,
            article.summary || null,
            article.source || null,
            article.url || null,
            article.category || 'general',
            article.sentimentScore ?? null,
            article.sentimentLabel ?? null,
            article.isCurated ? 1 : 0,
            article.publishedAt || null
        );
        return true;
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
        console.error('[DB] insertArticle failed:', err.message);
        throw err;
    }
}

/**
 * Batch insert articles efficiently using a transaction.
 */
function insertArticlesBatch(articles) {
    const insert = getStmt('insert_article', `
        INSERT OR IGNORE INTO news_articles
        (headline, summary, source, url, category, sentiment_score, sentiment_label, is_curated, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = getDb().transaction((items) => {
        let inserted = 0;
        for (const a of items) {
            const result = insert.run(
                a.headline,
                a.summary || null,
                a.source || null,
                a.url || null,
                a.category || 'general',
                a.sentimentScore ?? null,
                a.sentimentLabel ?? null,
                a.isCurated ? 1 : 0,
                a.publishedAt || null
            );
            if (result.changes > 0) inserted++;
        }
        return inserted;
    });

    return tx(articles);
}

function isHeadlineKnown(headline) {
    const row = getStmt('check_headline', `
        SELECT 1 FROM news_articles WHERE headline = ? LIMIT 1
    `).get(headline);
    return !!row;
}

function getRecentArticles(category = null, limit = 20, daysBack = 7) {
    if (category && category !== 'all') {
        return getStmt('get_articles_cat', `
            SELECT * FROM news_articles
            WHERE category = ? AND recorded_at >= datetime('now', '-' || ? || ' days')
            ORDER BY recorded_at DESC
            LIMIT ?
        `).all(category, daysBack, limit);
    }
    return getStmt('get_articles_all', `
        SELECT * FROM news_articles
        WHERE recorded_at >= datetime('now', '-' || ? || ' days')
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(daysBack, limit);
}

/**
 * Mark articles as LLM-curated (survived the filter).
 */
function markArticlesCurated(headlines) {
    const stmt = getStmt('mark_curated', `
        UPDATE news_articles SET is_curated = 1 WHERE headline = ?
    `);
    const tx = getDb().transaction((items) => {
        for (const h of items) stmt.run(h);
    });
    tx(headlines);
}

// ─── Macro Snapshots ────────────────────────────────────────────────────────

function insertMacroSnapshot(instrument, price, changeVal, changePct) {
    return getStmt('insert_macro', `
        INSERT INTO macro_snapshots (instrument, price, change_val, change_pct)
        VALUES (?, ?, ?, ?)
    `).run(instrument, price, changeVal, changePct);
}

function insertMacroSnapshotsBatch(macro) {
    const insert = getStmt('insert_macro', `
        INSERT INTO macro_snapshots (instrument, price, change_val, change_pct)
        VALUES (?, ?, ?, ?)
    `);

    const tx = getDb().transaction((data) => {
        if (data.dxy) insert.run('DXY', data.dxy.price, data.dxy.change, data.dxy.changePercent);
        if (data.tnx) insert.run('TNX', data.tnx.price, data.tnx.change, data.tnx.changePercent);
        if (data.vix) insert.run('VIX', data.vix.price, data.vix.change, data.vix.changePercent);
    });

    tx(macro);
}

function getRecentMacro(instrument, limit = 30) {
    return getStmt('get_recent_macro', `
        SELECT * FROM macro_snapshots
        WHERE instrument = ?
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(instrument, limit);
}

// ─── Sentiment Readings ─────────────────────────────────────────────────────

function insertSentimentReading(metric, value, label = null, extra = null) {
    return getStmt('insert_sentiment', `
        INSERT INTO sentiment_readings (metric, value, label, extra_json)
        VALUES (?, ?, ?, ?)
    `).run(metric, value, label, extra ? JSON.stringify(extra) : null);
}

function getRecentSentiment(metric, limit = 30) {
    return getStmt('get_recent_sentiment', `
        SELECT * FROM sentiment_readings
        WHERE metric = ?
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(metric, limit);
}

function getSentimentTrend(metric, daysBack = 7) {
    return getStmt('get_sentiment_trend', `
        SELECT value, label, recorded_at FROM sentiment_readings
        WHERE metric = ? AND recorded_at >= datetime('now', '-' || ? || ' days')
        ORDER BY recorded_at ASC
    `).all(metric, daysBack);
}

// ─── LLM Outputs ───────────────────────────────────────────────────────────

/**
 * Store an LLM-generated output for future retrieval.
 * @param {'briefing'|'recap'|'verdict'|'levels'|'summary'} outputType
 * @param {string|null} symbol
 * @param {string|null} category
 * @param {string} content - The generated text/JSON
 * @param {string|null} inputSummary - Brief description of what data was fed in
 * @param {string|null} model
 * @param {number|null} tokensUsed
 */
function insertLlmOutput(outputType, symbol, category, content, inputSummary = null, model = null, tokensUsed = null) {
    return getStmt('insert_llm', `
        INSERT INTO llm_outputs (output_type, symbol, category, content, input_summary, model, tokens_used)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(outputType, symbol, category, content, inputSummary, model, tokensUsed);
}

function getRecentLlmOutputs(outputType, symbol = null, limit = 5) {
    if (symbol) {
        return getStmt('get_llm_symbol', `
            SELECT * FROM llm_outputs
            WHERE output_type = ? AND symbol = ?
            ORDER BY recorded_at DESC
            LIMIT ?
        `).all(outputType, symbol, limit);
    }
    return getStmt('get_llm_type', `
        SELECT * FROM llm_outputs
        WHERE output_type = ?
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(outputType, limit);
}

/**
 * Get the last verdict for a symbol (for comparison / trend).
 */
function getLastVerdict(symbol) {
    return getStmt('get_last_verdict', `
        SELECT content, recorded_at FROM llm_outputs
        WHERE output_type = 'verdict' AND symbol = ?
        ORDER BY recorded_at DESC
        LIMIT 1
    `).get(symbol);
}

// ─── Economic Events ────────────────────────────────────────────────────────

function upsertEconomicEvent(event) {
    return getStmt('upsert_event', `
        INSERT INTO economic_events (event_name, event_date, event_time, impact, forecast, previous, actual, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_name, event_date) DO UPDATE SET
            event_time = excluded.event_time,
            impact = excluded.impact,
            forecast = excluded.forecast,
            previous = excluded.previous,
            actual = COALESCE(excluded.actual, economic_events.actual),
            source = excluded.source
    `).run(
        event.event || event.event_name,
        event.date || event.event_date,
        event.time || event.event_time || 'TBD',
        event.impact || 'low',
        event.forecast || event.estimate || null,
        event.previous || event.prev || null,
        event.actual || null,
        event.source || 'unknown'
    );
}

function upsertEconomicEventsBatch(events) {
    const upsert = getStmt('upsert_event', `
        INSERT INTO economic_events (event_name, event_date, event_time, impact, forecast, previous, actual, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_name, event_date) DO UPDATE SET
            event_time = excluded.event_time,
            impact = excluded.impact,
            forecast = excluded.forecast,
            previous = excluded.previous,
            actual = COALESCE(excluded.actual, economic_events.actual),
            source = excluded.source
    `);

    const tx = getDb().transaction((items) => {
        for (const e of items) {
            upsert.run(
                e.event || e.event_name,
                e.date || e.event_date,
                e.time || e.event_time || 'TBD',
                e.impact || 'low',
                e.forecast || e.estimate || null,
                e.previous || e.prev || null,
                e.actual || null,
                e.source || 'unknown'
            );
        }
    });

    tx(events);
}

function getUpcomingEvents(daysAhead = 14, impactFilter = null) {
    if (impactFilter) {
        return getStmt('get_events_impact', `
            SELECT * FROM economic_events
            WHERE event_date >= date('now') AND event_date <= date('now', '+' || ? || ' days')
              AND impact = ?
            ORDER BY event_date ASC, event_time ASC
        `).all(daysAhead, impactFilter);
    }
    return getStmt('get_events_all', `
        SELECT * FROM economic_events
        WHERE event_date >= date('now') AND event_date <= date('now', '+' || ? || ' days')
        ORDER BY event_date ASC, event_time ASC
    `).all(daysAhead);
}

function getPastEvents(daysBack = 7, impactFilter = 'high') {
    return getStmt('get_past_events', `
        SELECT * FROM economic_events
        WHERE event_date >= date('now', '-' || ? || ' days')
          AND event_date < date('now')
          AND impact = ?
        ORDER BY event_date DESC
    `).all(daysBack, impactFilter);
}

// ─── Correlation Log ────────────────────────────────────────────────────────

function insertCorrelation(symbol, macro, symbolPrice, symbolChangePct, notes = null) {
    return getStmt('insert_corr', `
        INSERT INTO correlation_log
        (symbol, dxy_price, dxy_change_pct, tnx_price, tnx_change_pct, vix_price, vix_change_pct, symbol_price, symbol_change_pct, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        symbol,
        macro?.dxy?.price ?? null, macro?.dxy?.changePercent ?? null,
        macro?.tnx?.price ?? null, macro?.tnx?.changePercent ?? null,
        macro?.vix?.price ?? null, macro?.vix?.changePercent ?? null,
        symbolPrice, symbolChangePct,
        notes
    );
}

function getCorrelationHistory(symbol, limit = 30) {
    return getStmt('get_corr_history', `
        SELECT * FROM correlation_log
        WHERE symbol = ?
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(symbol, limit);
}

// ─── Posted Content Tracking ────────────────────────────────────────────────

function isContentPosted(hash) {
    const row = getStmt('check_posted', `
        SELECT 1 FROM posted_content WHERE content_hash = ? LIMIT 1
    `).get(hash);
    return !!row;
}

function markContentPosted(type, hash, channelId = null) {
    try {
        getStmt('mark_posted', `
            INSERT OR IGNORE INTO posted_content (content_type, content_hash, channel_id)
            VALUES (?, ?, ?)
        `).run(type, hash, channelId);
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return;
        console.error('[DB] markContentPosted failed:', err.message);
    }
}

// ─── Anomaly Scanner ────────────────────────────────────────────────────────

/**
 * Insert a scan cycle record and return the scan ID.
 * @param {object} scanData - Full snapshot { quotes, macro, fearGreed, fundingRates }
 * @param {number} detectedCount
 * @param {number} postedCount
 * @returns {number} The inserted scan row ID
 */
function insertAnomalyScan(scanData, detectedCount = 0, postedCount = 0) {
    return getStmt('insert_anomaly_scan', `
        INSERT INTO anomaly_scans (scan_data_json, anomalies_detected, anomalies_posted)
        VALUES (?, ?, ?)
    `).run(JSON.stringify(scanData), detectedCount, postedCount).lastInsertRowid;
}

/**
 * Insert a detected anomaly event.
 */
function insertAnomalyEvent(scanId, anomaly, wasPosted = false) {
    return getStmt('insert_anomaly_event', `
        INSERT INTO anomaly_events (scan_id, anomaly_type, severity, anomaly_key, title, description, fields_json, was_posted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        scanId,
        anomaly.type,
        anomaly.severity,
        anomaly.key,
        anomaly.title,
        anomaly.description || null,
        anomaly.fields ? JSON.stringify(anomaly.fields) : null,
        wasPosted ? 1 : 0
    );
}

/**
 * Batch insert anomaly events within a transaction.
 */
function insertAnomalyEventsBatch(scanId, anomalies, postedKeys) {
    const insert = getStmt('insert_anomaly_event', `
        INSERT INTO anomaly_events (scan_id, anomaly_type, severity, anomaly_key, title, description, fields_json, was_posted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const postedSet = new Set(postedKeys || []);

    const tx = getDb().transaction((items) => {
        for (const a of items) {
            insert.run(
                scanId,
                a.type,
                a.severity,
                a.key,
                a.title,
                a.description || null,
                a.fields ? JSON.stringify(a.fields) : null,
                postedSet.has(a.key) ? 1 : 0
            );
        }
    });

    tx(anomalies);
}

/**
 * Get the most recent scan data (for baseline restoration on startup).
 * Returns { data, recordedAt } or null.
 */
function getLastScanData() {
    const row = getStmt('get_last_scan', `
        SELECT scan_data_json, recorded_at FROM anomaly_scans
        ORDER BY recorded_at DESC
        LIMIT 1
    `).get();
    if (!row) return null;
    try {
        return {
            data: JSON.parse(row.scan_data_json),
            recordedAt: row.recorded_at,
        };
    } catch {
        return null;
    }
}

/**
 * Get recent anomaly events for LLM context.
 */
function getRecentAnomalies(daysBack = 7, limit = 50) {
    return getStmt('get_recent_anomalies', `
        SELECT * FROM anomaly_events
        WHERE recorded_at >= datetime('now', '-' || ? || ' days')
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(daysBack, limit);
}

/**
 * Get anomaly statistics grouped by type for a time period.
 */
function getAnomalyStats(daysBack = 7) {
    return getStmt('get_anomaly_stats', `
        SELECT
            anomaly_type,
            severity,
            COUNT(*) as count,
            SUM(was_posted) as posted_count,
            MAX(recorded_at) as last_seen
        FROM anomaly_events
        WHERE recorded_at >= datetime('now', '-' || ? || ' days')
        GROUP BY anomaly_type, severity
        ORDER BY count DESC
    `).all(daysBack);
}

/**
 * Get recent anomalies for a specific symbol (extracted from anomaly_key).
 */
function getAnomaliesBySymbol(symbol, daysBack = 7, limit = 20) {
    const pattern = `%${symbol}%`;
    return getStmt('get_anomalies_by_symbol', `
        SELECT * FROM anomaly_events
        WHERE anomaly_key LIKE ? AND recorded_at >= datetime('now', '-' || ? || ' days')
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(pattern, daysBack, limit);
}

/**
 * Get scan history summary (for monitoring).
 */
function getScanHistory(limit = 20) {
    return getStmt('get_scan_history', `
        SELECT id, anomalies_detected, anomalies_posted, recorded_at
        FROM anomaly_scans
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(limit);
}

// ─── Aggregate Queries (for LLM Context) ────────────────────────────────────

/**
 * Get a compact market summary for the last N days.
 * Used to build LLM context windows.
 */
function getMarketSummary(symbol, daysBack = 7) {
    return getStmt('get_market_summary', `
        SELECT
            date(recorded_at) as day,
            AVG(price) as avg_price,
            MAX(high) as day_high,
            MIN(low) as day_low,
            -- Get the last price of each day
            (SELECT price FROM market_snapshots m2
             WHERE m2.symbol = market_snapshots.symbol
             AND date(m2.recorded_at) = date(market_snapshots.recorded_at)
             ORDER BY m2.recorded_at DESC LIMIT 1) as close_price,
            AVG(change_pct) as avg_change_pct
        FROM market_snapshots
        WHERE symbol = ? AND recorded_at >= datetime('now', '-' || ? || ' days')
        GROUP BY date(recorded_at)
        ORDER BY day ASC
    `).all(symbol, daysBack);
}

/**
 * Get sentiment trend summary for LLM context.
 */
function getSentimentSummary(daysBack = 7) {
    return getStmt('get_sentiment_summary', `
        SELECT
            metric,
            date(recorded_at) as day,
            AVG(value) as avg_value,
            MIN(value) as min_value,
            MAX(value) as max_value
        FROM sentiment_readings
        WHERE recorded_at >= datetime('now', '-' || ? || ' days')
        GROUP BY metric, date(recorded_at)
        ORDER BY day ASC
    `).all(daysBack);
}

/**
 * Get news volume and sentiment breakdown by category.
 */
function getNewsSummary(daysBack = 3) {
    return getStmt('get_news_summary', `
        SELECT
            category,
            COUNT(*) as article_count,
            AVG(sentiment_score) as avg_sentiment,
            SUM(CASE WHEN is_curated = 1 THEN 1 ELSE 0 END) as curated_count
        FROM news_articles
        WHERE recorded_at >= datetime('now', '-' || ? || ' days')
        GROUP BY category
        ORDER BY article_count DESC
    `).all(daysBack);
}

/**
 * Full-text search across stored headlines (for RAG-like retrieval).
 * Escapes SQL LIKE wildcards (%, _) in the user query to prevent table scans.
 */
function searchArticles(query, limit = 10) {
    const escaped = String(query || '').replace(/[\\%_]/g, '\\$&');
    const pattern = `%${escaped}%`;
    return getStmt('search_articles', `
        SELECT headline, summary, source, category, sentiment_label, recorded_at
        FROM news_articles
        WHERE headline LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(pattern, pattern, limit);
}

// ─── Anomaly DM Subscribers ─────────────────────────────────────────────────

/**
 * Upsert a subscriber. If active=false, effectively unsubscribes.
 * @param {string} userId - Discord user ID
 * @param {boolean} active - true to subscribe, false to unsubscribe
 * @param {string} categories - 'all' or comma-separated types e.g. 'price_spike,vix_surge'
 */
function setAnomalySubscriber(userId, active, categories = 'all') {
    return getStmt('upsert_subscriber', `
        INSERT INTO anomaly_subscribers (user_id, categories, active)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            categories = excluded.categories,
            active = excluded.active,
            subscribed_at = datetime('now')
    `).run(userId, categories, active ? 1 : 0);
}

/**
 * Get all active subscriber user IDs (and their category preferences).
 * @returns {Array<{user_id: string, categories: string}>}
 */
function getAnomalySubscribers() {
    return getStmt('get_subscribers', `
        SELECT user_id, categories FROM anomaly_subscribers WHERE active = 1
    `).all();
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Purge old data to keep the database lean. All deletes run inside a single
 * transaction so the WAL journal isn't held open across many statements.
 * Keeps 90 days of snapshots, 60 days of articles, etc.
 */
function cleanupOldData() {
    const counts = {};
    const dbi = getDb();

    const tx = dbi.transaction(() => {
        counts.snapshots = dbi.prepare(`DELETE FROM market_snapshots WHERE recorded_at < datetime('now', '-90 days')`).run().changes;
        counts.articles = dbi.prepare(`DELETE FROM news_articles WHERE recorded_at < datetime('now', '-60 days')`).run().changes;
        counts.macro = dbi.prepare(`DELETE FROM macro_snapshots WHERE recorded_at < datetime('now', '-90 days')`).run().changes;
        counts.sentiment = dbi.prepare(`DELETE FROM sentiment_readings WHERE recorded_at < datetime('now', '-90 days')`).run().changes;
        counts.llm = dbi.prepare(`DELETE FROM llm_outputs WHERE recorded_at < datetime('now', '-30 days')`).run().changes;
        counts.events = dbi.prepare(`DELETE FROM economic_events WHERE event_date < date('now', '-30 days')`).run().changes;
        counts.posted = dbi.prepare(`DELETE FROM posted_content WHERE posted_at < datetime('now', '-14 days')`).run().changes;
        counts.correlations = dbi.prepare(`DELETE FROM correlation_log WHERE recorded_at < datetime('now', '-90 days')`).run().changes;
        counts.anomalyScans = dbi.prepare(`DELETE FROM anomaly_scans WHERE recorded_at < datetime('now', '-90 days')`).run().changes;
        counts.anomalyEvents = dbi.prepare(`DELETE FROM anomaly_events WHERE recorded_at < datetime('now', '-90 days')`).run().changes;
        counts.cooldowns = dbi.prepare(`DELETE FROM cooldowns WHERE expires_at < ?`).run(Date.now()).changes;
        counts.pendingPosts = dbi.prepare(`DELETE FROM pending_posts WHERE created_at < ?`).run(Date.now() - 30 * 86400_000).changes;
        counts.replays = dbi.prepare(`DELETE FROM signal_replay WHERE captured_at < ?`).run(Date.now() - 90 * 86400_000).changes;
    });

    try {
        tx();
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total > 0) console.log(`[DB] Cleanup: purged ${total} old records`, counts);
    } catch (err) {
        console.error('[DB] Cleanup transaction failed:', err.message);
    }
}

/**
 * Write a VACUUM INTO snapshot to data/backups/. Keeps the last 7 days.
 */
function backupDatabase() {
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dest = path.join(BACKUP_DIR, `bot-${stamp}.db`);
        getDb().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
        // Rotate: keep only newest 7
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('bot-') && f.endsWith('.db'))
            .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.t - a.t);
        for (const old of files.slice(7)) {
            try { fs.unlinkSync(path.join(BACKUP_DIR, old.f)); } catch { /* ignore */ }
        }
        console.log(`[DB] Backup written: ${dest}`);
        return dest;
    } catch (err) {
        console.error('[DB] Backup failed:', err.message);
        return null;
    }
}

/**
 * Schedule daily cleanup + backup. Cleanup runs every 24h; backup runs every 24h.
 * Both wrapped in try/catch so a transient failure doesn't kill the interval.
 */
function scheduleCleanup() {
    const safeRun = (fn, label) => {
        try { fn(); }
        catch (err) { console.error(`[DB] ${label} threw:`, err.message); }
    };
    // Deferred startup runs so we don't block boot
    setTimeout(() => safeRun(cleanupOldData, 'cleanup'), 10_000);
    setTimeout(() => safeRun(backupDatabase, 'backup'), 30_000);
    // Then every 24h
    setInterval(() => safeRun(cleanupOldData, 'cleanup'), 24 * 60 * 60 * 1000);
    setInterval(() => safeRun(backupDatabase, 'backup'), 24 * 60 * 60 * 1000);
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

function closeDatabase() {
    if (db) {
        db.close();
        db = null;
        console.log('[DB] Database connection closed.');
    }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
    initDatabase,
    getDb,
    closeDatabase,
    backupDatabase,

    // Market
    insertMarketSnapshot,
    getRecentSnapshots,
    getSnapshotRange,
    getLatestSnapshot,

    // News
    insertArticle,
    insertArticlesBatch,
    isHeadlineKnown,
    getRecentArticles,
    markArticlesCurated,
    searchArticles,

    // Macro
    insertMacroSnapshot,
    insertMacroSnapshotsBatch,
    getRecentMacro,

    // Sentiment
    insertSentimentReading,
    getRecentSentiment,
    getSentimentTrend,

    // LLM
    insertLlmOutput,
    getRecentLlmOutputs,
    getLastVerdict,

    // Events
    upsertEconomicEvent,
    upsertEconomicEventsBatch,
    getUpcomingEvents,
    getPastEvents,

    // Correlations
    insertCorrelation,
    getCorrelationHistory,

    // Posted tracking
    isContentPosted,
    markContentPosted,

    // Aggregates
    getMarketSummary,
    getSentimentSummary,
    getNewsSummary,

    // Anomaly Scanner
    insertAnomalyScan,
    insertAnomalyEvent,
    insertAnomalyEventsBatch,
    getLastScanData,
    getRecentAnomalies,
    getAnomalyStats,
    getAnomaliesBySymbol,
    getScanHistory,

    // Anomaly Subscribers (DM opt-in)
    setAnomalySubscriber,
    getAnomalySubscribers,

    // Maintenance
    cleanupOldData,
};
