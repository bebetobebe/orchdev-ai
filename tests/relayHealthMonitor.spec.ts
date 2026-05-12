import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELAY_CONFIG } from '../src/config/relayConfig';
import { RelayHealthMonitor } from '../src/orchestrator/relayHealthMonitor';
import type { RelayHealthSnapshot } from '../src/types';

const ORIGINAL_RELAY = { ...RELAY_CONFIG };

interface FakeFetchCall {
    url: string;
    init: RequestInit;
}

function makeFakeFetch(responder: (call: FakeFetchCall) => Promise<Response> | Response) {
    const calls: FakeFetchCall[] = [];
    const fn = (async (url: any, init: any) => {
        const call = { url: typeof url === 'string' ? url : String(url), init: init || {} };
        calls.push(call);
        return responder(call);
    }) as unknown as typeof fetch;
    return { fn, calls };
}

function jsonResponse(body: any, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Spin enough microtask turns for the monitor's deferred first-probe to resolve. */
async function flush(turns = 5): Promise<void> {
    for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe('RelayHealthMonitor', () => {
    beforeEach(() => {
        RELAY_CONFIG.enabled = true;
        RELAY_CONFIG.healthUrl = 'https://relay.test/health';
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        Object.assign(RELAY_CONFIG, ORIGINAL_RELAY);
        vi.restoreAllMocks();
    });

    // === Disabled-state guard rails ===

    it('publishes a disabled snapshot when RELAY_CONFIG.enabled is false', async () => {
        RELAY_CONFIG.enabled = false;
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk-x',
            intervalMs: 1000,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(fake.calls).toHaveLength(0);
        // Disabled is the only snapshot emitted; publish() compresses identical
        // states so we only see it once.
        expect(seen).toEqual([{ status: 'disabled' }]);
    });

    it('publishes a disabled snapshot when healthUrl is empty', async () => {
        RELAY_CONFIG.healthUrl = '';
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk-x',
            intervalMs: 1000,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(fake.calls).toHaveLength(0);
        expect(seen[0]?.status).toBe('disabled');
    });

    it('publishes a disabled snapshot when no auth token is available', async () => {
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => undefined,
            intervalMs: 1000,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(fake.calls).toHaveLength(0);
        expect(seen[0]?.status).toBe('disabled');
    });

    it('respects an empty-string healthUrl override even when RELAY_CONFIG.healthUrl is set', async () => {
        RELAY_CONFIG.healthUrl = 'https://relay.test/health';
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk-x',
            intervalMs: 1000,
            healthUrl: '',
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(fake.calls).toHaveLength(0);
        expect(seen[0]?.status).toBe('disabled');
    });

    // === Successful response shapes ===

    it('GETs healthUrl with Bearer auth and emits an ok snapshot on 200 ok:true', async () => {
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk-secret',
            intervalMs: 0, // disable timer; rely on initial deferred probe
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0].url).toBe('https://relay.test/health');
        expect((fake.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
        expect((fake.calls[0].init.headers as Record<string, string>).Accept).toBe('application/json');
        expect(seen).toHaveLength(1);
        expect(seen[0].status).toBe('ok');
        expect(seen[0].lastCheckedAt).toBeTypeOf('number');
        expect(seen[0].lastLatencyMs).toBeTypeOf('number');
    });

    it('treats a 200 with ok:false as degraded', async () => {
        const fake = makeFakeFetch(() => jsonResponse({ ok: false, message: 'maintenance window' }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('degraded');
        expect(seen[0].message).toBe('maintenance window');
    });

    it('treats a 200 with no JSON body as ok', async () => {
        const fake = makeFakeFetch(() => new Response('hello plain', { status: 200 }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('ok');
    });

    it('parses the usage block and surfaces it to the snapshot', async () => {
        const fake = makeFakeFetch(() => jsonResponse({
            ok: true,
            usage: { used: 1234, limit: 100000, resetAt: '2026-05-01T00:00:00Z' },
        }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('ok');
        expect(seen[0].usage).toEqual({ used: 1234, limit: 100000, resetAt: '2026-05-01T00:00:00Z' });
    });

    it('flips to degraded when usage exceeds 95% utilisation', async () => {
        const fake = makeFakeFetch(() => jsonResponse({
            ok: true,
            usage: { used: 96000, limit: 100000 },
        }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('degraded');
        expect(seen[0].message).toMatch(/Quota nearly exhausted/);
    });

    it('coerces stringified numeric usage fields', async () => {
        const fake = makeFakeFetch(() => jsonResponse({
            ok: true,
            usage: { used: '500', limit: '2000' },
        }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].usage).toEqual({ used: 500, limit: 2000 });
    });

    it('drops invalid usage shapes without throwing', async () => {
        const fake = makeFakeFetch(() => jsonResponse({
            ok: true,
            usage: { used: 'oops', limit: 0 },
        }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('ok');
        expect(seen[0].usage).toBeUndefined();
    });

    // === Error response shapes ===

    it('maps 401 to unauthorized', async () => {
        const fake = makeFakeFetch(() => new Response('nope', { status: 401 }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('unauthorized');
        expect(seen[0].message).toMatch(/HTTP 401/);
    });

    it('maps 403 to unauthorized', async () => {
        const fake = makeFakeFetch(() => new Response('forbidden', { status: 403 }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('unauthorized');
    });

    it('maps 5xx, 429, and 408 to down', async () => {
        for (const code of [500, 502, 503, 408, 429]) {
            const fake = makeFakeFetch(() => new Response('boom', { status: code }));
            const seen: RelayHealthSnapshot[] = [];
            const m = new RelayHealthMonitor({
                getAuthToken: () => 'sk',
                intervalMs: 0,
                fetchImpl: fake.fn,
                onChange: snap => seen.push(snap),
            });
            m.start();
            await flush();
            expect(seen[0].status, `code=${code}`).toBe('down');
            expect(seen[0].message, `code=${code}`).toMatch(new RegExp(`HTTP ${code}`));
        }
    });

    it('maps other 4xx to degraded with the body included', async () => {
        const fake = makeFakeFetch(() => new Response('bad request body', { status: 400 }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('degraded');
        expect(seen[0].message).toMatch(/HTTP 400.*bad request body/);
    });

    it('maps a network failure to unknown', async () => {
        const fake = makeFakeFetch(() => { throw new Error('ECONNREFUSED'); });
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].status).toBe('unknown');
        expect(seen[0].message).toMatch(/ECONNREFUSED/);
    });

    it('aborts requests that exceed timeoutMs and surfaces unknown', async () => {
        const fake = makeFakeFetch((call) => new Promise((_resolve, reject) => {
            (call.init as any).signal?.addEventListener('abort', () => reject(new Error('aborted-by-timeout')));
        }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            timeoutMs: 25,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        // wait long enough for timeout to actually fire
        await new Promise(r => setTimeout(r, 60));
        expect(seen[0].status).toBe('unknown');
        expect(seen[0].message).toMatch(/aborted-by-timeout/);
    });

    // === onChange compression ===

    it('does not re-emit identical snapshots', async () => {
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        await m.probeNow();
        await m.probeNow();
        // Three probes, but only the very first triggers an onChange because
        // the user-visible fields (status/message/usage) didn't change.
        expect(seen).toHaveLength(1);
    });

    it('re-emits when the status flips', async () => {
        let i = 0;
        const fake = makeFakeFetch(() => i++ === 0
            ? jsonResponse({ ok: true })
            : new Response('boom', { status: 503 }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        await m.probeNow();
        expect(seen.map(s => s.status)).toEqual(['ok', 'down']);
    });

    it('swallows errors thrown from onChange listeners', async () => {
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: () => { throw new Error('listener-boom'); },
        });
        m.start();
        await expect(flush()).resolves.toBeUndefined();
        // Even though the listener threw, the snapshot is still stored.
        expect(m.getSnapshot().status).toBe('ok');
    });

    // === Lifecycle ===

    it('start() is idempotent and stop() can be called repeatedly', async () => {
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: () => {},
        });
        m.start();
        m.start();
        await flush();
        expect(fake.calls.length).toBe(1);
        m.stop();
        m.stop();
    });

    it('updateOptions() applies a new interval and a new token without rebuilding', async () => {
        let token = 'sk-old';
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const m = new RelayHealthMonitor({
            getAuthToken: () => token,
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: () => {},
        });
        m.start();
        await flush();
        expect((fake.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-old');
        token = 'sk-new';
        m.updateOptions({ getAuthToken: () => token });
        // Inline re-evaluation triggers a probe through the no-timer code path.
        await flush();
        expect((fake.calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-new');
    });

    it('updateOptions({ intervalMs }) restarts the timer and uses the injected scheduler', async () => {
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const setIvCalls: number[] = [];
        const clearIvCalls: unknown[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 1000,
            fetchImpl: fake.fn,
            onChange: () => {},
            setIntervalImpl: ((_cb: () => void, ms: number) => {
                setIvCalls.push(ms);
                return Symbol('timer') as unknown as ReturnType<typeof setInterval>;
            }) as typeof setInterval,
            clearIntervalImpl: ((handle: unknown) => { clearIvCalls.push(handle); }) as typeof clearInterval,
        });
        m.start();
        await flush();
        expect(setIvCalls).toEqual([1000]);
        m.updateOptions({ intervalMs: 5000 });
        expect(clearIvCalls).toHaveLength(1);
        expect(setIvCalls).toEqual([1000, 5000]);
    });

    it('dispose() prevents further start() calls and cancels in-flight requests', async () => {
        let signalDuringFetch: AbortSignal | undefined;
        const fake = makeFakeFetch((call) => new Promise((_resolve, reject) => {
            signalDuringFetch = (call.init as any).signal;
            signalDuringFetch?.addEventListener('abort', () => reject(new Error('aborted-by-dispose')));
        }));
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: () => {},
        });
        m.start();
        await Promise.resolve(); // let the probe install the AbortController
        m.dispose();
        expect(signalDuringFetch?.aborted).toBe(true);
        // After dispose, start() must not re-arm.
        m.start();
        await flush();
        expect(fake.calls).toHaveLength(1);
    });

    it('probeNow() forces an out-of-band fetch and resolves to the latest snapshot', async () => {
        let i = 0;
        const fake = makeFakeFetch(() => i++ === 0
            ? jsonResponse({ ok: true })
            : new Response('down', { status: 503 }));
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: () => {},
        });
        m.start();
        await flush();
        const snap = await m.probeNow();
        expect(snap.status).toBe('down');
        expect(m.getSnapshot().status).toBe('down');
    });

    it('joins the request body shape: GET, no body, only headers', async () => {
        const fake = makeFakeFetch(() => jsonResponse({ ok: true }));
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: () => {},
        });
        m.start();
        await flush();
        expect(fake.calls[0].init.method).toBe('GET');
        expect((fake.calls[0].init as any).body).toBeUndefined();
    });

    it('truncates absurdly long messages to keep tooltips manageable', async () => {
        const long = 'x'.repeat(500);
        const fake = makeFakeFetch(() => jsonResponse({ ok: true, message: long }));
        const seen: RelayHealthSnapshot[] = [];
        const m = new RelayHealthMonitor({
            getAuthToken: () => 'sk',
            intervalMs: 0,
            fetchImpl: fake.fn,
            onChange: snap => seen.push(snap),
        });
        m.start();
        await flush();
        expect(seen[0].message!.length).toBeLessThanOrEqual(201);
        expect(seen[0].message!.endsWith('…')).toBe(true);
    });
});
