import { io } from "socket.io-client";

// Use same-origin URL — Express now serves both the React client AND Socket.IO
// on port 5173, so there is no proxy layer between the browser and the socket server.
//
// Transport order: WebSocket FIRST.
// Tailscale Serve proxies WebSocket upgrades cleanly (persistent TCP tunnel).
// Long-poll HTTP (polling) is NOT used as primary because Tailscale's HTTPS
// reverse-proxy terminates long-lived HTTP connections with 502.
// Polling is kept as a last-resort fallback only.
const SOCKET_URL = '/';

class SocketService {
    constructor() {
        this.socket = null;
    }

    connect() {
        if (this.socket) return this.socket;

        console.log(`🔌 [SocketService] Connecting to ${SOCKET_URL}...`);
        this.socket = io(SOCKET_URL, {
            transports: ['websocket', 'polling'], // WebSocket first — works through Tailscale; polling fallback only
            upgrade: true,
            reconnection: true,
            reconnectionAttempts: 15,
            reconnectionDelay: 1500,
            timeout: 20000,
        });

        this.socket.on("connect", () => {
            console.log(`✅ [SocketService] Connected! ID: ${this.socket.id}`);
        });

        this.socket.on("disconnect", (reason) => {
            console.warn(`⚠️ [SocketService] Disconnected: ${reason}`);
        });

        this.socket.on("connect_error", (err) => {
            console.error(`❌ [SocketService] Connection Error: ${err.message}`);
        });

        return this.socket;
    }

    /**
     * Subscribe to a specific event
     * @param {string} eventName
     * @param {function} callback
     */
    on(eventName, callback) {
        if (!this.socket) this.connect();
        this.socket.on(eventName, callback);
    }

    /**
     * Unsubscribe from an event.
     * Always pass the same callback reference you gave to on() — otherwise
     * socket.io removes ALL listeners for that event name.
     * @param {string}   eventName
     * @param {function} [callback] - the exact function reference passed to on()
     */
    off(eventName, callback) {
        if (this.socket) {
            if (callback) {
                this.socket.off(eventName, callback);
            } else {
                this.socket.off(eventName);
            }
        }
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }
}

// Singleton Instance
export default new SocketService();
