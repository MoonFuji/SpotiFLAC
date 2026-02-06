/**
 * Helpers for reliable, concurrent downloads: retry with backoff and a fixed concurrency pool.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAYS_MS = [1000, 2000, 4000];

/** Returns true if the error looks transient (network, timeout, 5xx). */
export function isRetryableDownloadError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (lower.includes("already exists") || lower.includes("cancelled") || lower.includes("canceled")) return false;
    if (lower.includes("not found") || lower.includes("404") || lower.includes("isrc is required")) return false;
    return true;
}

/**
 * Runs fn up to maxAttempts times with exponential backoff. Does not retry if isRetryable(error) is false.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        maxAttempts?: number;
        delayMs?: (attempt: number) => number;
        isRetryable?: (error: unknown) => boolean;
    } = {}
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const getDelay = options.delayMs ?? ((attempt: number) => DEFAULT_DELAYS_MS[Math.min(attempt, DEFAULT_DELAYS_MS.length - 1)] ?? 4000);
    const isRetryable = options.isRetryable ?? isRetryableDownloadError;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            if (attempt === maxAttempts - 1 || !isRetryable(e)) throw e;
            const delay = getDelay(attempt);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastError;
}

/**
 * Runs async fn for each item with at most `concurrency` running at once. Returns results in same order as items.
 * If getAbort() returns true, workers stop taking new items (in-flight tasks still complete).
 */
export async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
    options?: { getAbort?: () => boolean }
): Promise<R[]> {
    if (items.length === 0) return [];
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    const getAbort = options?.getAbort;

    async function worker(): Promise<void> {
        while (true) {
            if (getAbort?.()) return;
            const i = nextIndex++;
            if (i >= items.length) return;
            try {
                results[i] = await fn(items[i], i);
            } catch (e) {
                throw e;
            }
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

/**
 * Returns a function that when called runs updateFn at most every intervalMs (leading edge + trailing).
 */
export function createThrottledUpdater(
    intervalMs: number,
    updateFn: () => void
): () => void {
    let lastRun = 0;
    let scheduled: ReturnType<typeof setTimeout> | null = null;

    return function schedule() {
        const now = Date.now();
        if (now - lastRun >= intervalMs) {
            lastRun = now;
            if (scheduled) {
                clearTimeout(scheduled);
                scheduled = null;
            }
            updateFn();
        } else if (!scheduled) {
            scheduled = setTimeout(() => {
                scheduled = null;
                lastRun = Date.now();
                updateFn();
            }, intervalMs - (now - lastRun));
        }
    };
}
