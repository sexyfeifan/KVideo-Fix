import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { DELETE, GET, POST } from '../../../app/api/remote-import/route';
import {
    resetInboxStore,
    getEntry,
} from '../../../lib/server/remote-import-inbox';
import {
    REMOTE_IMPORT_CLIENT_MAX_FAILURES,
    REMOTE_IMPORT_REGISTER_MAX_PER_WINDOW,
} from '../../../lib/utils/remote-import';

const BASE = 'http://localhost/api/remote-import';

function request(path: string, init: {
    method?: string;
    token?: string;
    ip?: string;
    body?: string;
} = {}): NextRequest {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (init.token) headers.set('X-Pairing-Token', init.token);
    if (init.ip) headers.set('X-Forwarded-For', init.ip);
    return new NextRequest(BASE + path, {
        method: init.method || 'GET',
        headers,
        body: init.body,
    });
}

async function register(code: string, ip = '10.0.0.1'): Promise<string> {
    const res = await POST(request('', {
        method: 'POST',
        ip,
        body: JSON.stringify({ action: 'register', code }),
    }));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.token, 'string');
    return data.token;
}

test('register issues a token and invalid codes are rejected', async () => {
    resetInboxStore();
    const token = await register('ABCDEF');
    assert.ok(getEntry('ABCDEF'));
    assert.ok(token);

    const bad = await POST(request('', {
        method: 'POST',
        ip: '10.0.0.2',
        body: JSON.stringify({ action: 'register', code: 'ABC' }),
    }));
    assert.equal(bad.status, 400);

    const broken = await POST(request('', {
        method: 'POST',
        ip: '10.0.0.2',
        body: 'not-json',
    }));
    assert.equal(broken.status, 400);
});

test('register rate-limits per client', async () => {
    resetInboxStore();
    for (let i = 0; i < REMOTE_IMPORT_REGISTER_MAX_PER_WINDOW; i += 1) {
        const res = await POST(request('', {
            method: 'POST',
            ip: '10.0.0.3',
            body: JSON.stringify({ action: 'register', code: 'ABCDEF' }),
        }));
        assert.equal(res.status, 200);
    }
    const limited = await POST(request('', {
        method: 'POST',
        ip: '10.0.0.3',
        body: JSON.stringify({ action: 'register', code: 'ABCDEF' }),
    }));
    assert.equal(limited.status, 429);

    // 未携带 code 的注册请求不消耗注册配额
    const noCode = await POST(request('', {
        method: 'POST',
        ip: '10.0.0.4',
        body: JSON.stringify({ action: 'register' }),
    }));
    assert.equal(noCode.status, 400);
});

test('poll requires the pairing token and reports waiting/received', async () => {
    resetInboxStore();
    const token = await register('ABCDEF', '10.0.1.1');

    const noToken = await GET(request('?code=ABCDEF', { ip: '10.0.1.1' }));
    assert.equal(noToken.status, 400);

    const wrongToken = await GET(request('?code=ABCDEF', { token: 'c'.repeat(32), ip: '10.0.1.1' }));
    assert.equal(wrongToken.status, 404);

    const waiting = await GET(request('?code=ABCDEF', { token, ip: '10.0.1.1' }));
    assert.equal(waiting.status, 200);
    assert.equal((await waiting.json()).status, 'waiting');

    const delivered = await POST(request('', {
        method: 'POST',
        ip: '10.0.1.2',
        body: JSON.stringify({ code: 'ABCDEF', payload: { type: 'json', content: '[]' } }),
    }));
    assert.equal(delivered.status, 200);

    const received = await GET(request('?code=ABCDEF', { token, ip: '10.0.1.1' }));
    const data = await received.json();
    assert.equal(data.status, 'received');
    assert.deepEqual(data.payload, { type: 'json', content: '[]' });

    // 单次投递
    const again = await GET(request('?code=ABCDEF', { token, ip: '10.0.1.1' }));
    assert.equal((await again.json()).status, 'waiting');
});

test('poll on an unregistered code is a plain 404', async () => {
    resetInboxStore();
    const res = await GET(request('?code=ZZZZZ9', { token: 'a'.repeat(32), ip: '10.0.2.1' }));
    assert.equal(res.status, 404);
});

test('deliver validates body, code and payload', async () => {
    resetInboxStore();
    await register('ABCDEF', '10.0.3.1');

    const brokenCode = await POST(request('', {
        method: 'POST',
        ip: '10.0.3.2',
        body: JSON.stringify({ code: 'XX', payload: { type: 'json', content: '[]' } }),
    }));
    assert.equal(brokenCode.status, 400);

    const missingCode = await POST(request('', {
        method: 'POST',
        ip: '10.0.3.2',
        body: JSON.stringify({ payload: { type: 'json', content: '[]' } }),
    }));
    assert.equal(missingCode.status, 400);

    const brokenPayload = await POST(request('', {
        method: 'POST',
        ip: '10.0.3.2',
        body: JSON.stringify({ code: 'ABCDEF', payload: { type: 'file', content: '' } }),
    }));
    assert.equal(brokenPayload.status, 400);
});

test('deliver to an unknown code is 404 and counts as a client failure', async () => {
    resetInboxStore();
    await register('ABCDEF', '10.0.4.1');

    for (let i = 0; i < REMOTE_IMPORT_CLIENT_MAX_FAILURES; i += 1) {
        const res = await POST(request('', {
            method: 'POST',
            ip: '10.0.4.2',
            body: JSON.stringify({ code: 'ZZZZZ9', payload: { type: 'json', content: '[]' } }),
        }));
        assert.equal(res.status, 404);
    }

    const limited = await POST(request('', {
        method: 'POST',
        ip: '10.0.4.2',
        body: JSON.stringify({ code: 'ABCDEF', payload: { type: 'json', content: '[]' } }),
    }));
    assert.equal(limited.status, 429);

    // 其他客户端不受影响
    const ok = await POST(request('', {
        method: 'POST',
        ip: '10.0.4.3',
        body: JSON.stringify({ code: 'ABCDEF', payload: { type: 'json', content: '[]' } }),
    }));
    assert.equal(ok.status, 200);
});

test('deliver rejects oversized payloads before they can fill the slot', async () => {
    resetInboxStore();
    await register('ABCDEF', '10.0.5.1');

    const huge = await POST(request('', {
        method: 'POST',
        ip: '10.0.5.2',
        body: JSON.stringify({
            code: 'ABCDEF',
            payload: { type: 'json', content: 'x'.repeat(6 * 1024 * 1024) },
        }),
    }));
    assert.equal(huge.status, 413);

    // 大请求被拒后仍能正常投递
    const ok = await POST(request('', {
        method: 'POST',
        ip: '10.0.5.3',
        body: JSON.stringify({ code: 'ABCDEF', payload: { type: 'json', content: '[]' } }),
    }));
    assert.equal(ok.status, 200);
});

test('deliver reports pending while a payload waits to be picked up', async () => {
    resetInboxStore();
    await register('ABCDEF', '10.0.6.1');

    const first = await POST(request('', {
        method: 'POST',
        ip: '10.0.6.2',
        body: JSON.stringify({ code: 'ABCDEF', payload: { type: 'json', content: 'a' } }),
    }));
    assert.equal(first.status, 200);

    const second = await POST(request('', {
        method: 'POST',
        ip: '10.0.6.2',
        body: JSON.stringify({ code: 'ABCDEF', payload: { type: 'json', content: 'b' } }),
    }));
    assert.equal(second.status, 409);
});

test('bad payloads burn the pairing after the cap', async () => {
    resetInboxStore();
    const token = await register('ABCDEF', '10.0.7.1');

    for (let i = 0; i < 15; i += 1) {
        const res = await POST(request('', {
            method: 'POST',
            ip: `10.0.7.${10 + i}`,
            body: JSON.stringify({ code: 'ABCDEF', payload: { type: 'file', content: '' } }),
        }));
        assert.equal(res.status, 400);
    }

    // 条目已销毁
    const after = await GET(request('?code=ABCDEF', { token, ip: '10.0.7.1' }));
    assert.equal(after.status, 404);
});

test('delete only works with the pairing token', async () => {
    resetInboxStore();
    const token = await register('ABCDEF', '10.0.8.1');

    const wrong = await DELETE(request('?code=ABCDEF', { token: 'd'.repeat(32), ip: '10.0.8.1' }));
    assert.equal(wrong.status, 200);
    assert.ok(getEntry('ABCDEF'));

    const right = await DELETE(request('?code=ABCDEF', { token, ip: '10.0.8.1' }));
    assert.equal(right.status, 200);
    assert.equal(getEntry('ABCDEF'), undefined);
});

test('invalid query params return 400 without touching the inbox', async () => {
    resetInboxStore();
    const noCode = await GET(request('', { token: 'a'.repeat(32), ip: '10.0.9.1' }));
    assert.equal(noCode.status, 400);

    const noToken = await GET(request('?code=ABCDEF', { ip: '10.0.9.1' }));
    assert.equal(noToken.status, 400);
});

test('register reports inbox_full when every slot holds a pending payload', async () => {
    resetInboxStore();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 50; i += 1) {
        const code = alphabet[i % alphabet.length] + alphabet[Math.floor(i / alphabet.length) % alphabet.length] + 'WXYZ';
        const res = await POST(request('', {
            method: 'POST',
            ip: `pair-reg-${i}`,
            body: JSON.stringify({ action: 'register', code }),
        }));
        assert.equal(res.status, 200);
        const delivered = await POST(request('', {
            method: 'POST',
            ip: `pair-send-${i}`,
            body: JSON.stringify({ code, payload: { type: 'json', content: '[]' } }),
        }));
        assert.equal(delivered.status, 200);
    }

    const full = await POST(request('', {
        method: 'POST',
        ip: 'pair-reg-last',
        body: JSON.stringify({ action: 'register', code: 'ZZZZZ9' }),
    }));
    assert.equal(full.status, 503);
});

test('payload-level size check rejects content the raw body limit lets through', async () => {
    resetInboxStore();
    await register('ABCDEF', '10.0.11.1');

    // 5MB + 2KB：低于原始请求体上限（+4KB 余量），但载荷本身超限
    const oversize = await POST(request('', {
        method: 'POST',
        ip: '10.0.11.2',
        body: JSON.stringify({
            code: 'ABCDEF',
            payload: { type: 'json', content: 'x'.repeat(5 * 1024 * 1024 + 2048) },
        }),
    }));
    assert.equal(oversize.status, 413);
});

test('client key falls back to x-real-ip and then to a shared bucket', async () => {
    resetInboxStore();

    const viaRealIp = new NextRequest(BASE, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Real-Ip': '10.0.12.1',
        },
        body: JSON.stringify({ action: 'register', code: 'ABCDEF' }),
    });
    assert.equal((await POST(viaRealIp)).status, 200);

    const anonymous = new NextRequest(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'ZZZZZ9', payload: { type: 'json', content: '[]' } }),
    });
    assert.equal((await POST(anonymous)).status, 404);
});

test('a locked-out client cannot register either', async () => {
    resetInboxStore();
    for (let i = 0; i < REMOTE_IMPORT_CLIENT_MAX_FAILURES; i += 1) {
        await POST(request('', {
            method: 'POST',
            ip: '10.0.13.1',
            body: JSON.stringify({ code: 'ZZZZZ9', payload: { type: 'json', content: '[]' } }),
        }));
    }

    const locked = await POST(request('', {
        method: 'POST',
        ip: '10.0.13.1',
        body: JSON.stringify({ action: 'register', code: 'ABCDEF' }),
    }));
    assert.equal(locked.status, 429);
});

test('a broken body stream is reported as invalid_body', async () => {
    resetInboxStore();
    const brokenStream = new ReadableStream({
        start(controller) {
            controller.error(new Error('stream broken'));
        },
    });
    const req = new NextRequest(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.14.1' },
        body: brokenStream as unknown as BodyInit,
        duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const res = await POST(req);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_body');
});
