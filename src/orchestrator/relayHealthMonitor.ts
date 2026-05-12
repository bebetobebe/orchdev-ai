import { RELAY_CONFIG } from '../config/relayConfig';
import { RelayHealthSnapshot } from '../types';

/**
 * Optional dependencies. Tests inject deterministic clocks and a fake fetch;
 * production passes nothing and falls back to globalThis.{fetch, setInterval, ...}.
 */
export interface RelayHealthMonitorOptions {
    /** Provider for the user's auth token (read fresh on every probe). */
    getAuthToken(): string | undefined;
    /** Probe interval in ms. <= 0 disables the timer (one-shot probes still allowed via probeNow()). */
    intervalMs: number;
    /** Per-request timeout in ms. Defaults to 8s. */
    timeoutMs?: number;
    /** Override `healthUrl` from RELAY_CONFIG. Empty string still disables the probe. */
    healthUrl?: string;
    /** Called with a fresh snapshot whenever status / message / usage changes. */
    onChange(snapshot: RelayHealthSnapshot): void;
    /** Test seam — defaults to globalThis.fetch. */
    fetchImpl?: typeof fetch;
    /** Test seam — defaults to setInterval. */
    setIntervalImpl?: typeof setInterval;
    /** Test seam — defaults to clearInterval. */
    clearIntervalImpl?: typeof clearInterval;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Periodically probes the relay's `/health` endpoint and broadcasts a status
 * snapshot to the webview. The monitor is the only place in the codebase that
 * cares about the relay's liveness; the rest of the extension treats relay
 * failures as opaque per-task errors.
 *
 * Lifecycle: start() schedules the first tick on the next loop turn (so the
 * caller can install the onChange listener first), then ticks at intervalMs.
 * stop() clears any pending timer and aborts the in-flight fetch (if any).
 *
 * The monitor is **resilient by default**: a missing token, a 0 interval,
 * an empty healthUrl, or a disabled RELAY_CONFIG all collapse to a single
 * `{ status: 'disabled' }` snapshot rather than throwing.
 */
export class RelayHealthMonitor {
    private _opts: RelayHealthMonitorOptions;
    private _snapshot: RelayHealthSnapshot = { status: 'disabled' };
    private _timer: ReturnType<typeof setInterval> | undefined;
    private _inflight: AbortController | undefined;
    private _disposed = false;
    private _started = false;

    constructor(opts: RelayHealthMonitorOptions) {
        this._opts = opts;
    }

    /** Returns the most recent snapshot. Never throws. */
    getSnapshot(): RelayHealthSnapshot {
        return this._snapshot;
    }

    /**
     * Apply new options atomically (e.g. after token rotation or interval
     * change). Restarts the timer if it was running.
     */
    updateOptions(patch: Partial<RelayHealthMonitorOptions>): void {
        this._opts = { ...this._opts, ...patch };
        if (this._started) {
            this.stop();
            this.start();
        } else if (!this._disposed) {
            // Re-evaluate disabled state without scheduling a timer.
            void this._tick();
        }
    }

    /**
     * Begin probing. If already started, this is a cheap no-op (callers that
     * want a forced refresh should call probeNow() directly).
     */
    start(): void {
        if (this._disposed) return;
        if (this._started) return;
        this._started = true;
        const intervalMs = Math.max(0, this._opts.intervalMs | 0);
        if (!this._isProbeable()) {
            // Surface the disabled state immediately so the webview pill renders.
            this._publish({ status: 'disabled' }, true);
            return;
        }
        // Kick off the first probe on a microtask so callers can install
        // their onChange listener before the snapshot fires.
        Promise.resolve().then(() => this._tick());
        if (intervalMs > 0) {
            const setIv = this._opts.setIntervalImpl ?? setInterval;
            this._timer = setIv(() => this._tick(), intervalMs);
        }
    }

    /**
     * Stop probing and abort any in-flight request. Safe to call multiple
     * times. After dispose() the monitor cannot be restarted.
     */
    stop(): void {
        if (this._timer !== undefined) {
            const clearIv = this._opts.clearIntervalImpl ?? clearInterval;
            clearIv(this._timer);
            this._timer = undefined;
        }
        this._started = false;
        if (this._inflight) {
            try { this._inflight.abort(); } catch { /* noop */ }
            this._inflight = undefined;
        }
    }

    dispose(): void {
        this._disposed = true;
        this.stop();
    }

    /**
     * Force a probe now (out-of-band). Used after token rotation so the pill
     * updates immediately rather than waiting for the next interval tick.
     */
    async probeNow(): Promise<RelayHealthSnapshot> {
        if (this._disposed) return this._snapshot;
        await this._tick();
        return this._snapshot;
    }

    // === Internals ===

    private _isProbeable(): boolean {
        if (!RELAY_CONFIG.enabled) return false;
        const url = this._effectiveUrl();
        if (!url) return false;
        const token = this._opts.getAuthToken();
        if (!token || token.length === 0) return false;
        return true;
    }

    private _effectiveUrl(): string {
        const override = this._opts.healthUrl;
        if (typeof override === 'string') return override;
        return RELAY_CONFIG.healthUrl ?? '';
    }

    private async _tick(): Promise<void> {
        if (this._disposed) return;
        if (!this._isProbeable()) {
            this._publish({ status: 'disabled' });
            return;
        }
        const url = this._effectiveUrl();
        const token = this._opts.getAuthToken()!;
        const timeoutMs = this._opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const fetchImpl = this._opts.fetchImpl ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            this._publish({ status: 'unknown', message: 'global fetch unavailable' });
            return;
        }

        // Abort any previous in-flight probe so an interval tick faster than
        // the relay's response time doesn't pile up.
        if (this._inflight) {
            try { this._inflight.abort(); } catch { /* noop */ }
        }
        const controller = new AbortController();
        this._inflight = controller;
        const startedAt = Date.now();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { controller.abort(); } catch { /* noop */ }
        }, timeoutMs);

        try {
            const res = await fetchImpl(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                signal: controller.signal,
            });
            const latency = Date.now() - startedAt;
            if (res.status === 401 || res.status === 403) {
                this._publish({
                    status: 'unauthorized',
                    message: `HTTP ${res.status}`,
                    lastCheckedAt: Date.now(),
                    lastLatencyMs: latency,
                });
                return;
            }
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
                this._publish({
                    status: 'down',
                    message: `HTTP ${res.status}`,
                    lastCheckedAt: Date.now(),
                    lastLatencyMs: latency,
                });
                return;
            }
            if (!res.ok) {
                // Other 4xx — treat as degraded since the relay reachable but
                // declined to answer. The body, if any, becomes the message.
                const body = await this._safeReadText(res);
                this._publish({
                    status: 'degraded',
                    message: body ? `HTTP ${res.status}: ${this._truncate(body, 120)}` : `HTTP ${res.status}`,
                    lastCheckedAt: Date.now(),
                    lastLatencyMs: latency,
                });
                return;
            }
            const json = await this._safeReadJson(res);
            this._publish(this._snapshotFromJson(json, latency));
        } catch (err) {
            // AbortError is normal on stop()/dispose() or when a newer tick
            // cancels a stale probe. A timeout is user-visible and should
            // surface as `unknown` so the relay pill tells the truth.
            if (this._disposed || (controller.signal.aborted && !timedOut)) return;
            this._publish({
                status: 'unknown',
                message: err instanceof Error ? err.message : String(err),
                lastCheckedAt: Date.now(),
                lastLatencyMs: Date.now() - startedAt,
            });
        } finally {
            clearTimeout(timer);
            if (this._inflight === controller) {
                this._inflight = undefined;
            }
        }
    }

    private _snapshotFromJson(json: unknown, latencyMs: number): RelayHealthSnapshot {
        const now = Date.now();
        const base: RelayHealthSnapshot = {
            status: 'ok',
            lastCheckedAt: now,
            lastLatencyMs: latencyMs,
        };
        if (!json || typeof json !== 'object') return base;
        const obj = json as Record<string, unknown>;
        // The relay can explicitly say it's degraded by returning ok:false.
        if (obj.ok === false) {
            base.status = 'degraded';
        }
        if (typeof obj.message === 'string' && obj.message.length > 0) {
            base.message = this._truncate(obj.message, 200);
            // A non-empty message on an "ok" response is treated as advisory,
            // not degraded — most relays use it for "low quota" warnings.
        }
        const usage = obj.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === 'object') {
            const used = this._toNumber(usage.used);
            const limit = this._toNumber(usage.limit);
            if (used !== undefined && limit !== undefined && limit > 0) {
                base.usage = { used, limit };
                if (typeof usage.resetAt === 'string') {
                    base.usage.resetAt = usage.resetAt;
                }
                // 95%+ utilisation is automatically flagged as degraded so
                // the pill flips colour even if the relay didn't say so.
                if (base.status === 'ok' && used / limit >= 0.95) {
                    base.status = 'degraded';
                    base.message = base.message ?? 'Quota nearly exhausted';
                }
            }
        }
        return base;
    }

    private _publish(snapshot: RelayHealthSnapshot, force = false): void {
        // Skip onChange when nothing user-visible changed, to keep the
        // webview's postMessage volume low.
        if (!force && this._equalUserVisible(this._snapshot, snapshot)) {
            // Even on a no-op, refresh internal timestamps so consumers
            // calling getSnapshot() see the latest probe data.
            this._snapshot = { ...snapshot };
            return;
        }
        this._snapshot = snapshot;
        try { this._opts.onChange(snapshot); } catch { /* swallow listener errors */ }
    }

    private _equalUserVisible(a: RelayHealthSnapshot, b: RelayHealthSnapshot): boolean {
        if (a.status !== b.status) return false;
        if ((a.message ?? '') !== (b.message ?? '')) return false;
        const au = a.usage; const bu = b.usage;
        if (!au && !bu) return true;
        if (!au || !bu) return false;
        return au.used === bu.used && au.limit === bu.limit && (au.resetAt ?? '') === (bu.resetAt ?? '');
    }

    private async _safeReadJson(res: Response): Promise<unknown> {
        try { return await res.json(); } catch { return undefined; }
    }

    private async _safeReadText(res: Response): Promise<string> {
        try { return await res.text(); } catch { return ''; }
    }

    private _toNumber(v: unknown): number | undefined {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && v.length > 0) {
            const n = Number(v);
            if (Number.isFinite(n)) return n;
        }
        return undefined;
    }

    private _truncate(s: string, max: number): string {
        return s.length <= max ? s : s.substring(0, max) + '…';
    }
}
