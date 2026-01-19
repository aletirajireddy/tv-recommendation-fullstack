/**
 * TimeService - The Single Source of Truth for Time
 * 
 * Rules:
 * 1. INPUT is ALWAYS UTC ISO String (e.g. "2026-01-15T21:39:54.267Z")
 * 2. OUTPUT is ALWAYS Local Time formatted string
 * 3. NO direct Date() manipulation in components
 */

const TimeService = {
    // 1. Standard Display (HH:MM:SS)
    formatTime: (isoString) => {
        if (!isoString) return '--:--:--';
        try {
            const d = new Date(isoString);
            if (isNaN(d.getTime())) return '--:--:--';
            return d.toLocaleTimeString([], {
                hour12: false, // Changed to false for 24h as per user preference often
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (e) {
            console.error("Time Error:", isoString, e);
            return "Invalid Time";
        }
    },

    // 2. Full Date Display (MMM DD, HH:MM)
    formatDateTime: (isoString) => {
        if (!isoString) return '--';
        try {
            const date = new Date(isoString);
            if (isNaN(date.getTime())) return '--';
            return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
                ', ' +
                date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        } catch (e) {
            return "Invalid Date";
        }
    },

    // 3. Relative Time (e.g. "5 mins ago")
    timeAgo: (isoString) => {
        if (!isoString) return '';
        try {
            const now = new Date();
            const past = new Date(isoString);
            if (isNaN(past.getTime())) return '';
            const diffMs = now - past;
            const diffSec = Math.floor(diffMs / 1000);

            if (diffSec < 60) return 'Just now';
            if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
            if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
            return `${Math.floor(diffSec / 86400)}d ago`;
        } catch { return ''; }
    },

    // 4. Get Current UTC (For syncing)
    now: () => new Date().toISOString()
};

export default TimeService;
