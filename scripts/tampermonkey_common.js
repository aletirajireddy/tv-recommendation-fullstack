// ==UserScript==
// @name         TradingView Auto-Connect (1 Min Delay)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Watches for Session Disconnect and clicks Connect after exactly 1 minute.
// @author       Gemini
// @match        *://*.tradingview.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Set to 60000ms for a 1-minute delay
    const DELAY = 60000;
    const ROOT_ID = 'overlap-manager-root';

    function processModals() {
        const root = document.getElementById(ROOT_ID);
        if (!root) return;

        // Verify it is the specific disconnection popup
        const hasDisconnectText = root.innerText.includes("Session disconnected") ||
            root.innerText.includes("account was accessed from another browser");

        if (hasDisconnectText) {
            const buttons = root.querySelectorAll('button');
            let targetButton = null;

            for (const btn of buttons) {
                if (btn.textContent.trim() === 'Connect') {
                    targetButton = btn;
                    break;
                }
            }

            if (targetButton) {
                console.log('🕒 Disconnect detected. Waiting 1 minute before reconnecting...');

                setTimeout(() => {
                    // Final safety check: make sure the button is still on the screen
                    if (targetButton && document.contains(targetButton)) {
                        targetButton.click();
                        console.log('✅ 1 minute elapsed. Reconnect clicked.');
                    } else {
                        console.log('⚠️ Button no longer exists; perhaps manually clicked?');
                    }
                }, DELAY);
            }
        }
    }

    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            if (mutation.addedNodes.length > 0) {
                processModals();
            }
        });
    });

    // Logic to extract and copy tickers
    function copyTickersToClipboard() {
        // 1. Select the anchor tags containing the hrefs using the user's preferred selector logic
        // We target the class 'tickerName-GrtoTeat' which contains the href
        const links = document.querySelectorAll("table tr[data-rowKey] a[href]:first-of-type");

        if (links.length === 0) {
            console.log('%c No tickers found to copy.', 'color: orange');
            return;
        }

        // 2. Map the elements to the "EXCHANGE:SYMBOL" format
        const resultString = Array.from(links).map(link => {
            try {
                // Parse the URL safely
                const urlObj = new URL(link.href);

                // Extract Symbol: remove '/symbols/' and trailing slash '/'
                // Example: "/symbols/BTCUSDT.P/" -> "BTCUSDT.P"
                const symbol = urlObj.pathname.split('/symbols/')[1].replace(/\//g, '');

                // Extract Exchange
                // Example: "?exchange=BINANCE" -> "BINANCE"
                const exchange = urlObj.searchParams.get('exchange');

                if (symbol && exchange) {
                    return `${exchange}:${symbol}`;
                }
                return null;
            } catch (e) {
                console.error("Error parsing ticker URL:", link.href);
                return null;
            }
        })
            .filter(item => item !== null) // Remove any failed parses
            .join(','); // Join with commas

        // 3. Write to Clipboard
        navigator.clipboard.writeText(resultString).then(() => {
            console.log(`%c ✅ COPIED [${resultString.split(',').length}] TICKERS`, 'color: white; background: green; font-weight: bold; padding: 4px;');
            console.log(resultString);
        }).catch(err => {
            console.error('Failed to copy to clipboard: ', err);
        });
    }

    // 4. Keyboard Listener
    document.addEventListener('keydown', (e) => {
        // Check for Alt + s (case insensitive)
        if (e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault(); // Prevent default browser behavior for Alt+S
            copyTickersToClipboard();
        }
    });

    console.log("📋 Ticker Copier Ready: Press [Alt + S] to copy.");
    document.addEventListener('keydown', (e) => {
        // 🔹 Shortcut: Alt + [ -> Open/Toggle Watchlist
        if (e.altKey && e.key === '[') {
            e.preventDefault();

            // Looks for the specific toggle button on the right sidebar for the watchlist
            const watchlistBtn = document.querySelector('button[data-name="watchlist"]') || document.querySelector('button[data-name="base"]');

            if (watchlistBtn) {
                console.log('⌨️ Shortcut Alt+[ triggered: Toggling Watchlist.');
                watchlistBtn.click();
            } else {
                console.warn('⚠️ Watchlist/Base button not found on the page.');
            }
        }

        // 🔹 Shortcut: Alt + ] -> Open/Toggle Alerts
        if (e.altKey && e.key === ']') {
            e.preventDefault();

            // Looks for the specific toggle button for alerts
            const alertsBtn = document.querySelector('button[data-name="alerts"]');

            if (alertsBtn) {
                console.log('⌨️ Shortcut Alt+] triggered: Toggling Alerts.');
                alertsBtn.click();
            } else {
                console.warn('⚠️ Alerts button not found on the page.');
            }
        }
    });


    function startApp() {
        const targetNode = document.getElementById(ROOT_ID);
        if (targetNode) {
            observer.observe(targetNode, { childList: true, subtree: true });
            console.log('🚀 Observer active. Reconnect delay set to: ' + (DELAY / 1000) + 's');
        } else {
            setTimeout(startApp, 2000);
        }
    }

    startApp();
})();