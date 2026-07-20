'use strict';
/** Access-control predicates derived from config. */
const config = require('../config');

function isAdmin(userId, roles = []) {
  if (config.access.adminUserIds.includes(userId)) return true;
  if (config.access.adminRoleId && roles.includes(config.access.adminRoleId)) return true;
  return false;
}

/** Whether this user is allowed in at all (guild-membership gate). */
function isAllowed({ isMember }) {
  if (!config.access.requireGuildMembership) return true;
  return Boolean(isMember);
}

module.exports = { isAdmin, isAllowed };
