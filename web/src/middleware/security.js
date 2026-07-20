'use strict';
/** Security headers (helmet) + rate limiters. */
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const headers = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'", 'https://discord.com'],
      // Off by default: we serve over plain http on a Tailnet, and this would
      // force the browser to upgrade same-origin asset requests to https.
      // (Harmless when actually served via https + `tailscale serve`.)
      upgradeInsecureRequests: null,
    },
  },
  // We serve over http on a Tailnet by default; don't force HSTS unless https.
  hsts: false,
  crossOriginEmbedderPolicy: false,
});

const common = { standardHeaders: true, legacyHeaders: false };

// General API limiter — generous, just a runaway guard.
const apiLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 600, ...common });

// Login/OAuth — stricter, these hit Discord.
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, ...common });

// Password login — tightest (brute-force guard). Per client IP.
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 12, ...common });

// Admin API-test actions make outbound calls — keep them modest.
const testLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 60, ...common });

// Console commands can hit upstreams / the LLM — bound them.
const consoleLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 120, ...common });

module.exports = { headers, apiLimiter, authLimiter, loginLimiter, testLimiter, consoleLimiter };
