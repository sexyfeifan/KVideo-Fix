import test from 'node:test';
import assert from 'node:assert/strict';

import {
    deleteEntry,
    ensureEntry,
    getEntry,
    putPayload,
    recordFailedAttempt,
    takePayload,
} from '@/lib/server/remote-import-inbox';
import {
    REMOTE_IMPORT_MAX_ENTRIES,
    REMOTE_IMPORT_MAX_FAILED_ATTEMPTS,
    REMOTE_IMPORT_TTL_MS,
} from '@/lib/utils/remote-import';

function resetInbox() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__kvideoRemoteImportInbox = undefined;
}

test('takePayload delivers once and clears the slot', () => {
    resetInbox();
    ensureEntry('ABCDEF');
    putPayload('ABCDEF', { type: 'json', content: '[]' });

    assert.deepEqual(takePayload('ABCDEF'), { type: 'json', content: '[]' });
    assert.equal(takePayload('ABCDEF'), null);
});

test('putPayload rejects a second payload while one is pending', () => {
    resetInbox();
    ensureEntry('PQRST2');
    putPayload('PQRST2', { type: 'url', url: 'https://example.com/a.json' });

    assert.throws(
        () => putPayload('PQRST2', { type: 'json', content: 'x' }),
        /pending/
    );
});

test('expired entries are swept', () => {
    resetInbox();
    const entry = ensureEntry('EXPIRE');
    entry.expiresAt = Date.now() - 1;

    assert.equal(getEntry('EXPIRE'), undefined);
    // 重新轮询会重新注册（register-on-poll）
    assert.ok(ensureEntry('EXPIRE'));
});

test('entries carry the documented TTL', () => {
    resetInbox();
    const entry = ensureEntry('TTL123');
    const remaining = entry.expiresAt - entry.createdAt;
    assert.ok(Math.abs(remaining - REMOTE_IMPORT_TTL_MS) < 50);
});

test('failed attempts burn the entry at the cap', () => {
    resetInbox();
    ensureEntry('BURN22');

    for (let i = 0; i < REMOTE_IMPORT_MAX_FAILED_ATTEMPTS - 1; i += 1) {
        recordFailedAttempt('BURN22');
        assert.ok(getEntry('BURN22'), `entry should survive attempt ${i + 1}`);
    }

    recordFailedAttempt('BURN22');
    assert.equal(getEntry('BURN22'), undefined);
});

test('inbox rejects new registrations beyond the entry cap', () => {
    resetInbox();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < REMOTE_IMPORT_MAX_ENTRIES; i += 1) {
        // 60 个互不相同的合法码：两位序号 + 固定后缀
        const code = alphabet[i % alphabet.length] + alphabet[Math.floor(i / alphabet.length) % alphabet.length] + 'WXYZ';
        ensureEntry(code);
    }
    assert.throws(() => ensureEntry('ZZZZZ9'), /inbox_full/);
});

test('putPayload on an unknown code raises not_found', () => {
    resetInbox();
    assert.throws(
        () => putPayload('NOSUCH1', { type: 'json', content: 'x' }),
        /not_found/
    );
});

test('deleteEntry is idempotent', () => {
    resetInbox();
    ensureEntry('DEL123');
    deleteEntry('DEL123');
    deleteEntry('DEL123');
    assert.equal(getEntry('DEL123'), undefined);
});
