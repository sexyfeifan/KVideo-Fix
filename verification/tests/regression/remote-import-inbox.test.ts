import test from 'node:test';
import assert from 'node:assert/strict';

import {
    deleteEntry,
    getEntry,
    isClientBlocked,
    putPayload,
    recordClientFailure,
    recordFailedAttempt,
    refreshEntry,
    registerEntry,
    resetInboxStore,
    takePayload,
    tryConsumeRegisterQuota,
} from '../../../lib/server/remote-import-inbox';
import {
    REMOTE_IMPORT_CLIENT_MAX_FAILURES,
    REMOTE_IMPORT_CLIENT_WINDOW_MS,
    REMOTE_IMPORT_MAX_ENTRIES,
    REMOTE_IMPORT_MAX_FAILED_ATTEMPTS,
    REMOTE_IMPORT_REGISTER_MAX_PER_WINDOW,
    REMOTE_IMPORT_TTL_MS,
} from '../../../lib/utils/remote-import';

const TOKEN = 'a'.repeat(32);
const OTHER_TOKEN = 'b'.repeat(32);

test('takePayload delivers once and clears the slot', () => {
    resetInboxStore();
    registerEntry('ABCDEF', TOKEN);
    putPayload('ABCDEF', { type: 'json', content: '[]' });

    assert.deepEqual(takePayload('ABCDEF', TOKEN), { type: 'json', content: '[]' });
    assert.equal(takePayload('ABCDEF', TOKEN), null);
});

test('takePayload without the pairing token cannot steal a payload', () => {
    resetInboxStore();
    registerEntry('ABCDEF', TOKEN);
    putPayload('ABCDEF', { type: 'json', content: '[]' });

    assert.equal(takePayload('ABCDEF', OTHER_TOKEN), null);
    assert.deepEqual(takePayload('ABCDEF', TOKEN), { type: 'json', content: '[]' });
});

test('putPayload rejects a second payload while one is pending', () => {
    resetInboxStore();
    registerEntry('PQRST2', TOKEN);
    putPayload('PQRST2', { type: 'url', url: 'https://example.com/a.json' });

    assert.throws(
        () => putPayload('PQRST2', { type: 'json', content: 'x' }),
        /pending/
    );
});

test('expired entries are swept and polling does not resurrect them', () => {
    resetInboxStore();
    const entry = registerEntry('EXPIRE', TOKEN);
    entry.expiresAt = Date.now() - 1;

    assert.equal(getEntry('EXPIRE'), undefined);
    // 轮询不创建条目：过期后必须重新注册
    assert.equal(refreshEntry('EXPIRE', TOKEN), undefined);
    assert.equal(takePayload('EXPIRE', TOKEN), null);
});

test('entries carry the documented TTL and polls slide the expiry', () => {
    resetInboxStore();
    const entry = registerEntry('TTL123', TOKEN);
    assert.ok(Math.abs(entry.expiresAt - entry.createdAt - REMOTE_IMPORT_TTL_MS) < 50);

    const before = entry.expiresAt;
    entry.expiresAt = Date.now() + 1000;
    const refreshed = refreshEntry('TTL123', TOKEN);
    assert.ok(refreshed);
    assert.ok(refreshed.expiresAt >= before - 50);
});

test('refreshEntry rejects a wrong or missing token', () => {
    resetInboxStore();
    registerEntry('NEEDL1', TOKEN);

    assert.equal(refreshEntry('NEEDL1', OTHER_TOKEN), undefined);
    assert.equal(refreshEntry('NEEDL2', TOKEN), undefined);
    assert.ok(refreshEntry('NEEDL1', TOKEN));
});

test('failed attempts burn the entry at the cap and polls do not reset the counter', () => {
    resetInboxStore();
    registerEntry('BURN22', TOKEN);

    for (let i = 0; i < REMOTE_IMPORT_MAX_FAILED_ATTEMPTS - 1; i += 1) {
        recordFailedAttempt('BURN22');
        // 轮询续期不得清零失败计数（否则上限永远打不满）
        refreshEntry('BURN22', TOKEN);
        assert.ok(getEntry('BURN22'), `entry should survive attempt ${i + 1}`);
    }

    recordFailedAttempt('BURN22');
    assert.equal(getEntry('BURN22'), undefined);
});

test('full inbox evicts the idlest entry instead of rejecting new pairings', () => {
    resetInboxStore();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codes: string[] = [];
    for (let i = 0; i < REMOTE_IMPORT_MAX_ENTRIES; i += 1) {
        const code = alphabet[i % alphabet.length] + alphabet[Math.floor(i / alphabet.length) % alphabet.length] + 'WXYZ';
        codes.push(code);
        registerEntry(code, TOKEN);
    }

    // 最后注册的条目最活跃，最先注册的最久未活跃
    const first = getEntry(codes[0]);
    const last = getEntry(codes[codes.length - 1]);
    assert.ok(first && last);
    last.lastSeenAt = Date.now();
    first.lastSeenAt = Date.now() - 60_000;

    assert.ok(registerEntry('ZZZZZ9', TOKEN));
    assert.equal(getEntry(codes[0]), undefined);
    assert.ok(getEntry(codes[codes.length - 1]));
    assert.ok(getEntry('ZZZZZ9'));
});

test('inbox refuses new registrations when every slot holds a pending payload', () => {
    resetInboxStore();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < REMOTE_IMPORT_MAX_ENTRIES; i += 1) {
        const code = alphabet[i % alphabet.length] + alphabet[Math.floor(i / alphabet.length) % alphabet.length] + 'WXYZ';
        registerEntry(code, TOKEN);
        putPayload(code, { type: 'json', content: '[]' });
    }

    assert.throws(() => registerEntry('ZZZZZ9', TOKEN), /inbox_full/);
});

test('re-registering a code rotates the token and drops stale payloads', () => {
    resetInboxStore();
    registerEntry('ROTATE', TOKEN);
    putPayload('ROTATE', { type: 'json', content: 'old' });

    const entry = registerEntry('ROTATE', OTHER_TOKEN);
    assert.equal(entry.token, OTHER_TOKEN);
    assert.equal(takePayload('ROTATE', TOKEN), null);
    assert.equal(takePayload('ROTATE', OTHER_TOKEN), null);
    assert.equal(entry.failedAttempts, 0);
});

test('putPayload on an unknown code raises not_found', () => {
    resetInboxStore();
    assert.throws(
        () => putPayload('NOSUCH1', { type: 'json', content: 'x' }),
        /not_found/
    );
});

test('recordFailedAttempt on an unknown code is a no-op', () => {
    resetInboxStore();
    recordFailedAttempt('GHOST1');
    assert.equal(getEntry('GHOST1'), undefined);
});

test('deleteEntry only removes the entry for the matching token', () => {
    resetInboxStore();
    registerEntry('DEL123', TOKEN);

    assert.equal(deleteEntry('DEL123', OTHER_TOKEN), false);
    assert.ok(getEntry('DEL123'));
    assert.equal(deleteEntry('DEL123', TOKEN), true);
    // 幂等：重复删除返回 false 而不是抛错
    assert.equal(deleteEntry('DEL123', TOKEN), false);
    assert.equal(getEntry('DEL123'), undefined);
});

test('register quota is enforced per client', () => {
    resetInboxStore();
    for (let i = 0; i < REMOTE_IMPORT_REGISTER_MAX_PER_WINDOW; i += 1) {
        assert.equal(tryConsumeRegisterQuota('10.0.0.1'), true);
    }
    assert.equal(tryConsumeRegisterQuota('10.0.0.1'), false);
    // 另一个客户端不受影响
    assert.equal(tryConsumeRegisterQuota('10.0.0.2'), true);
});

test('clients are locked out after too many failures', () => {
    resetInboxStore();
    for (let i = 0; i < REMOTE_IMPORT_CLIENT_MAX_FAILURES; i += 1) {
        assert.equal(isClientBlocked('10.0.0.9'), false);
        assert.equal(recordClientFailure('10.0.0.9'), true);
    }
    assert.equal(isClientBlocked('10.0.0.9'), true);
    assert.equal(recordClientFailure('10.0.0.9'), false);
    assert.equal(isClientBlocked('10.0.0.8'), false);
});

test('rate-limit windows expire and budgets reset', () => {
    resetInboxStore();
    for (let i = 0; i < REMOTE_IMPORT_REGISTER_MAX_PER_WINDOW; i += 1) {
        assert.equal(tryConsumeRegisterQuota('10.0.0.7'), true);
    }
    assert.equal(tryConsumeRegisterQuota('10.0.0.7'), false);

    // 把窗口时间拨回去，下一次调用应清扫过期窗口并重置配额
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (globalThis as any).__kvideoRemoteImportInbox;
    for (const client of store.registerWindow.values()) {
        client.windowStartedAt = Date.now() - 2 * REMOTE_IMPORT_CLIENT_WINDOW_MS;
    }
    for (const client of store.failureWindow.values()) {
        client.windowStartedAt = Date.now() - 2 * REMOTE_IMPORT_CLIENT_WINDOW_MS;
    }

    assert.equal(tryConsumeRegisterQuota('10.0.0.7'), true);
    assert.equal(isClientBlocked('10.0.0.9'), false);
});
