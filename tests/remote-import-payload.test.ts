import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRemoteImportUrl,
    generateRemoteImportCode,
    isValidRemoteImportCode,
    remoteImportPayloadSize,
    validateRemoteImportPayload,
    REMOTE_IMPORT_CODE_LENGTH,
    REMOTE_IMPORT_PAYLOAD_MAX_BYTES,
} from '@/lib/utils/remote-import';

test('generated codes match the expected shape', () => {
    for (let i = 0; i < 50; i += 1) {
        const code = generateRemoteImportCode();
        assert.equal(code.length, REMOTE_IMPORT_CODE_LENGTH);
        assert.equal(isValidRemoteImportCode(code), true);
    }
});

test('code validation rejects malformed values', () => {
    assert.equal(isValidRemoteImportCode(''), false);
    assert.equal(isValidRemoteImportCode('ABC'), false);
    assert.equal(isValidRemoteImportCode('ABCDEF0'), false);   // 0 not in alphabet
    assert.equal(isValidRemoteImportCode('ABCDE1'), false);    // 1 not in alphabet
    assert.equal(isValidRemoteImportCode('ABCDEF'), true);
    assert.equal(isValidRemoteImportCode(123456), false);
    assert.equal(isValidRemoteImportCode(null), false);
});

test('buildRemoteImportUrl joins origin and code', () => {
    assert.equal(
        buildRemoteImportUrl('http://192.168.100.180:3000/', 'ABCDEF'),
        'http://192.168.100.180:3000/remote-import?code=ABCDEF'
    );
});

test('payload validation accepts url/file/json and trims', () => {
    assert.deepEqual(
        validateRemoteImportPayload({ type: 'url', url: ' https://example.com/a.json ', name: ' 我的订阅 ' }),
        { type: 'url', url: 'https://example.com/a.json', name: '我的订阅' }
    );
    assert.deepEqual(
        validateRemoteImportPayload({ type: 'file', content: '{"settings":{}}' }),
        { type: 'file', content: '{"settings":{}}' }
    );
    assert.deepEqual(
        validateRemoteImportPayload({ type: 'json', content: '[]' }),
        { type: 'json', content: '[]' }
    );
});

test('payload validation rejects bad shapes', () => {
    assert.equal(validateRemoteImportPayload(null), null);
    assert.equal(validateRemoteImportPayload('x'), null);
    assert.equal(validateRemoteImportPayload({ type: 'url', url: 'ftp://x/y' }), null);
    assert.equal(validateRemoteImportPayload({ type: 'url', url: '' }), null);
    assert.equal(validateRemoteImportPayload({ type: 'url', url: 'https://example.com/' + 'a'.repeat(2100) }), null);
    assert.equal(validateRemoteImportPayload({ type: 'file', content: '' }), null);
    assert.equal(validateRemoteImportPayload({ type: 'other', content: 'x' }), null);
});

test('payload size helper and max constant sanity', () => {
    assert.equal(remoteImportPayloadSize({ type: 'url', url: 'https://example.com' }), 19);
    assert.equal(remoteImportPayloadSize({ type: 'json', content: 'abc' }), 3);
    assert.ok(REMOTE_IMPORT_PAYLOAD_MAX_BYTES > 1024 * 1024);
});
