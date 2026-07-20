'use strict';
/**
 * The workstation command console. Parses a typed line and dispatches to a
 * handler that returns a structured, render-typed result:
 *   { ok, type, title?, data, meta? }
 * The frontend has one renderer per `type`.
 */
const bridge = require('./botBridge');
const log = require('../logger').child('console');

// ─── command registry ───────────────────────────────────────────────────────
const COMMANDS = [
  { name: 'help', usage: 'help', desc: 'List all commands', group: 'general',
    run: async () => ({ type: 'help', data: describe() }) },

  { name: 'symbols', aliases: ['watchlist', 'wl'], usage: 'symbols', desc: 'List tradable symbols', group: 'market',
    run: async () => ({ type: 'symbols', data: bridge.symbols() }) },

  { name: 'quote', aliases: ['q'], usage: 'quote <symbol>', desc: 'Live quote for a symbol', group: 'market',
    run: async ({ args }) => {
      const r = await bridge.quote(need(args[0], 'symbol'));
      return { type: 'quote', title: r.meta?.name, data: r };
    } },

  { name: 'quotes', aliases: ['board', 'markets'], usage: 'quotes', desc: 'Full watchlist quote board', group: 'market',
    run: async () => ({ type: 'quotes', data: quoteRows(await bridge.allQuotes()) }) },

  { name: 'macro', usage: 'macro', desc: 'DXY / 10Y / VIX institutional keys', group: 'market',
    run: async () => ({ type: 'macro', data: await bridge.macro() }) },

  { name: 'fear', aliases: ['fng', 'feargreed'], usage: 'fear', desc: 'Crypto Fear & Greed index', group: 'market',
    run: async () => ({ type: 'fear', data: await bridge.fearGreed() }) },

  { name: 'funding', usage: 'funding', desc: 'BTC/ETH perp funding rates', group: 'market',
    run: async () => ({ type: 'funding', data: await bridge.funding() }) },

  { name: 'news', usage: 'news [category] [--breaking]', desc: 'Curated market news (oil/metals/crypto/forex/all)', group: 'market',
    run: async ({ args, flags }) => ({ type: 'news', title: (args[0] || 'all'), data: await bridge.news(args[0] || 'all', flags.has('breaking')) }) },

  { name: 'calendar', aliases: ['cal', 'econ'], usage: 'calendar [--full]', desc: 'Economic calendar', group: 'market',
    run: async ({ flags }) => ({ type: 'calendar', data: await bridge.calendar(flags.has('full')) }) },

  { name: 'cot', usage: 'cot', desc: 'Commitment of Traders positioning', group: 'market',
    run: async () => ({ type: 'cot', data: await bridge.cot() }) },

  { name: 'analyze', aliases: ['analysis', 'ta', 'a'], usage: 'analyze <symbol>', desc: 'Technical analysis + levels', group: 'analysis',
    run: async ({ args }) => {
      const r = await bridge.analyze(need(args[0], 'symbol'));
      return { type: 'analysis', title: r.meta?.name, data: r };
    } },

  { name: 'chart', aliases: ['c', 'ch'], usage: 'chart <symbol> [--weekly]', desc: 'Candlestick chart + levels', group: 'analysis',
    run: async ({ args, flags }) => {
      const r = await bridge.chartData(need(args[0], 'symbol'), { weekly: flags.has('weekly') });
      return { type: 'chart', title: r.meta?.name, data: r };
    } },

  { name: 'levels', aliases: ['lvl'], usage: 'levels <symbol>', desc: 'Daily + weekly key levels', group: 'analysis',
    run: async ({ args }) => {
      const r = await bridge.levels(need(args[0], 'symbol'));
      return { type: 'levels', title: r.meta?.name, data: r };
    } },

  { name: 'pulse', usage: 'pulse', desc: 'Whole-market snapshot (macro + movers + sentiment)', group: 'analysis',
    run: async () => {
      const [macro, fear, funding, quotes] = await Promise.all([bridge.macro(), bridge.fearGreed(), bridge.funding(), bridge.allQuotes()]);
      const rows = quoteRows(quotes).filter((r) => r.quote);
      const movers = rows.slice().sort((x, y) => Math.abs(y.quote.changePercent || 0) - Math.abs(x.quote.changePercent || 0));
      return { type: 'pulse', data: { macro, fear, funding, movers } };
    } },

  { name: 'verdict', aliases: ['v'], usage: 'verdict <symbol>', desc: 'AI war-room verdict for a symbol', group: 'ai', ai: true,
    run: async ({ args }) => {
      const r = await bridge.verdict(need(args[0], 'symbol'));
      return { type: 'verdict', title: r.name, data: r };
    } },

  { name: 'brief', aliases: ['briefing'], usage: 'brief [category]', desc: 'AI news briefing (TLDR + curation)', group: 'ai', ai: true,
    run: async ({ args }) => ({ type: 'brief', title: (args[0] || 'all'), data: await bridge.brief(args[0] || 'all') }) },

  { name: 'ai', aliases: ['ask'], usage: 'ai <question>', desc: 'Ask the desk analyst anything', group: 'ai', ai: true,
    run: async ({ rest }) => {
      const q = need(rest, 'question');
      const answer = await bridge.chat(q);
      return { type: 'ai', data: { prompt: q, answer } };
    } },

  { name: 'clear', aliases: ['cls'], usage: 'clear', desc: 'Clear the terminal', group: 'general',
    run: async () => ({ type: 'clear', data: null }) },
];

const REGISTRY = new Map();
for (const c of COMMANDS) {
  REGISTRY.set(c.name, c);
  for (const a of c.aliases || []) REGISTRY.set(a, c);
}

function describe() {
  return COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases || [], usage: c.usage, desc: c.desc, group: c.group, ai: !!c.ai }));
}

function catalog() {
  return { commands: describe(), bridge: { available: bridge.available, ai: bridge.aiAvailable() } };
}

// ─── parse + dispatch ───────────────────────────────────────────────────────
function parse(line) {
  const trimmed = String(line || '').trim();
  const first = trimmed.split(/\s+/)[0] || '';
  const name = first.toLowerCase();
  const rest = trimmed.slice(first.length).trim();
  const flags = new Set();
  const args = [];
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('--')) flags.add(tok.slice(2).toLowerCase());
    else args.push(tok);
  }
  return { name, args, flags, rest };
}

async function dispatch(line) {
  const t0 = Date.now();
  const { name, args, flags, rest } = parse(line);
  if (!name) return { ok: true, type: 'text', data: '' };
  const cmd = REGISTRY.get(name);
  if (!cmd) return { ok: false, type: 'error', data: `unknown command: "${name}" — type "help"` };
  if (cmd.ai && !bridge.aiAvailable()) {
    return { ok: false, type: 'error', data: 'AI is not configured (set CEREBRAS_API_KEY in the bot .env)' };
  }
  try {
    const res = await cmd.run({ args, flags, rest });
    log.info({ cmd: name, ms: Date.now() - t0 }, `console: ${name}`);
    return { ok: true, cmd: cmd.name, ...res };
  } catch (e) {
    log.warn({ cmd: name, err: e.message }, `console command failed: ${name}`);
    return { ok: false, type: 'error', cmd: cmd.name, data: e.message };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────
function need(v, what) {
  if (v == null || v === '') throw new Error(`missing ${what}`);
  return v;
}
function quoteRows(quotes) {
  return Object.entries(quotes || {}).map(([symbol, v]) => ({
    symbol, name: v.name, emoji: v.emoji, category: v.category, quote: v.quote || null,
  }));
}

module.exports = { dispatch, catalog, describe };
