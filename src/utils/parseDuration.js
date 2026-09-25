const UNITS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function parseDuration(str) {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${str}". Expected e.g. "15m", "7d".`);
  }
  return parseInt(match[1], 10) * UNITS[match[2]];
}

module.exports = parseDuration;
