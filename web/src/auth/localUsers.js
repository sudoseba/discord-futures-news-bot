'use strict';
/** Username/password verification against the WEB_USERS list (timing-safe). */
const crypto = require('crypto');
const config = require('../config');

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Equalize timing even on length mismatch.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** Returns a user object on success, or null. */
function verify(username, password) {
  const u = config.localUsers.find((x) => x.username === username);
  if (!u) {
    timingEqual(password, '\0'); // burn ~same time as a real compare
    return null;
  }
  if (!timingEqual(password, u.password)) return null;
  return { id: `local:${u.username}`, username: u.username, role: u.role, isAdmin: u.role === 'admin', isMember: true };
}

module.exports = { verify };
