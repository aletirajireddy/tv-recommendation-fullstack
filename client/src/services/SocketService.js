import { io } from "socket.io-client";

// Use same-origin proxy URL so all traffic routes through vite preview's HTTP proxy.
// polling transport is plain HTTP (GET/POST) — works through any HTTP proxy without
// requiring a WebSocket upgrade. socket.io automatically upgrades to WebSocket once
// the session is established. This is the only transport strategy that reliably works
// via Tailscale → vite preview → Express/Socket.IO regardless of firewall rules.
const SOCKET_URL = '/';

class SocketService {
    constructor() {
        this.socket = null;
    }

    connect() {
        if (this.socket) return this.socket;

        console.log(`🔌 [SocketService] Connecting to ${SOCKET_URL}...`);
        this.socket = io(SOCKET_URL, {
            transports: ['polling', 'websocket'], // polling first (plain HTTP, proxy-safe), upgrades to WS once session is established
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
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
