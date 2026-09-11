/**
 * Shared ticker normalization — strips the exchange prefix only (keeps the
 * .P/.PRP/.PERP suffix), uppercased. Used anywhere a ticker needs to be
 * matched against a user-managed set (coin_whitelist, telegram_watchlist)
 * regardless of which exchange prefix (or lack of one) the source stream sent.
 *
 * Accepts: "XRPUSDT.P", "BINANCE:XRPUSDT.P", "xrpusdt.p"
 */
function normaliseTicker(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim().toUpperCase();
    const colonIdx = s.indexOf(':');
    if (colonIdx !== -1) s = s.slice(colonIdx + 1);
    return s || null;
}

module.exports = { normaliseTicker };
