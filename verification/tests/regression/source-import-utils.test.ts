import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchTextFromUrl, isExternalUrl } from '../../../lib/utils/source-import-utils';

interface FetchCall {
    url: string;
    headers: Record<string, string>;
}

function withWindow<T>(host: string, run: () => T): T {
    const g = globalThis as { window?: unknown };
    const previous = g.window;
    g.window = { location: { host, href: `http://${host}/` } };
    try {
        return run();
    } finally {
        if (previous === undefined) {
            delete g.window;
        } else {
            g.window = previous;
        }
    }
}

function stubFetch(handler: (url: string) => Response | Promise<Response>): FetchCall[] {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({
            url,
            headers: (init?.headers || {}) as Record<string, string>,
        });
        return handler(url);
    }) as typeof fetch;
    return calls;
}

test('isExternalUrl is false when there is no window (SSR)', () => {
    assert.equal(isExternalUrl('https://example.com/a.json'), false);
});

test('isExternalUrl compares parsed hosts, not substrings', () => {
    withWindow('tv.local:3000', () => {
        assert.equal(isExternalUrl('https://example.com/a.json'), true);
        assert.equal(isExternalUrl('http://tv.local:3000/api/x'), false);
        assert.equal(isExternalUrl('/api/x'), false);
        // 外部 URL 里恰好包含本机 host 字符串，不能被误判为内部
        assert.equal(isExternalUrl('https://evil.example/?next=tv.local:3000'), true);
        assert.equal(isExternalUrl('not a url'), false);
        // 无法解析的 URL 按内部处理（不走代理回退）
        assert.equal(isExternalUrl('http://[invalid'), false);
    });
});

test('fetchTextFromUrl returns text for internal URLs without proxy', async () => {
    const original = globalThis.fetch;
    const calls = stubFetch(() => new Response('hello', { status: 200 }));
    try {
        const text = await withWindow('tv.local:3000', () => fetchTextFromUrl('http://tv.local:3000/api/x'));
        assert.equal(text, 'hello');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'http://tv.local:3000/api/x');
    } finally {
        globalThis.fetch = original;
    }
});

test('external URLs fall back to the proxy on a non-ok direct response', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push(url);
        if (url.startsWith('/api/proxy')) {
            return new Response('via-proxy', { status: 200 });
        }
        return new Response('nope', { status: 403 });
    }) as typeof fetch;
    try {
        const text = await withWindow('tv.local:3000', () => fetchTextFromUrl('https://example.com/a.json'));
        assert.equal(text, 'via-proxy');
        assert.equal(calls.length, 2);
        assert.match(calls[1], /^\/api\/proxy\?url=/);
    } finally {
        globalThis.fetch = original;
    }
});

test('external URLs fall back to the proxy when direct fetch throws', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/proxy')) {
            return new Response('recovered', { status: 200 });
        }
        throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    try {
        const text = await withWindow('tv.local:3000', () => fetchTextFromUrl('https://example.com/a.json'));
        assert.equal(text, 'recovered');
    } finally {
        globalThis.fetch = original;
    }
});

test('internal URL failures are not retried through the proxy', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
        throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    try {
        await withWindow('tv.local:3000', () =>
            assert.rejects(fetchTextFromUrl('http://tv.local:3000/api/x'), /Failed to fetch/));
    } finally {
        globalThis.fetch = original;
    }
});

test('a failing proxy fallback surfaces the status', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        return new Response('x', {
            status: url.startsWith('/api/proxy') ? 502 : 500,
            statusText: 'Bad Gateway',
        });
    }) as typeof fetch;
    try {
        await withWindow('tv.local:3000', () =>
            assert.rejects(fetchTextFromUrl('https://example.com/a.json'), /获取失败: 502/));
    } finally {
        globalThis.fetch = original;
    }
});
