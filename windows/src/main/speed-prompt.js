'use strict';
/*
 * Re-exports prompt tuning rules from prompts.js for backwards compatibility.
 */
const { FAST_ACT_RULES, withSpeedRules, FAST_MAX_TOKENS } = require('./prompts');

module.exports = { FAST_ACT_RULES, withSpeedRules, FAST_MAX_TOKENS };
