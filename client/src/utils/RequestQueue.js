/**
 * RequestQueue — A global queue for staggering heavy frontend API calls.
 * 
 * Purpose:
 * 1. Staggered Execution: Prevents the frontend from firing 10 simultaneous
 *    heavy SQL requests to the backend when multiple widgets mount or refresh.
 *    By staggering them (e.g. 150ms apart), the backend Node.js event loop
 *    can breathe, and the database doesn't lock up with parallel table scans.
 * 
 * 2. Promise Deduplication & Intelligent Debouncing:
 *    If 20 requests for the same key (e.g. 'fetchAnalytics') are triggered in
 *    rapid succession (e.g., dragging a slider), only the newest one is kept
 *    in the queue. Older pending requests are silently resolved with null.
 *    This completely replaces the need for arbitrary `setTimeout` debounces.
 */
class StaggeredRequestQueue {
    constructor(staggerMs = 150) {
        this.queue = [];
        this.isProcessing = false;
        // Key -> { active: boolean, item: object }
        this.tasks = new Map();
        this.staggerMs = staggerMs;
    }

    /**
     * Enqueue a promise-returning function.
     * @param {string} key - Unique identifier for the request type.
     * @param {function} fetchFn - Function returning a Promise.
     * @returns {Promise<any>}
     */
    enqueue(key, fetchFn) {
        return new Promise((resolve, reject) => {
            // Promise Deduplication / Replacement
            const existingTask = this.tasks.get(key);
            if (existingTask && !existingTask.active) {
                // If it's already in the queue but hasn't started fetching,
                // remove it from the array and resolve it silently to prevent hanging.
                this.queue = this.queue.filter(i => i.key !== key);
                try { existingTask.item.resolve(null); } catch (e) {}
            }

            const item = { key, fetchFn, resolve, reject };
            this.tasks.set(key, { active: false, item });
            
            // Push to the back of the queue
            this.queue.push(item);
            this.processNext();
        });
    }

    async processNext() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        const item = this.queue.shift();
        
        // Mark as actively fetching
        this.tasks.set(item.key, { active: true, item });
        
        try {
            await item.fetchFn();
            item.resolve();
        } catch (error) {
            item.reject(error);
        } finally {
            // Clean up tasks map if it hasn't been replaced
            const currentTask = this.tasks.get(item.key);
            if (currentTask && currentTask.item === item) {
                this.tasks.delete(item.key);
            }
            
            // Stagger before allowing the next item to process
            setTimeout(() => {
                this.isProcessing = false;
                this.processNext();
            }, this.staggerMs);
        }
    }
}

export const globalApiQueue = new StaggeredRequestQueue(150);
