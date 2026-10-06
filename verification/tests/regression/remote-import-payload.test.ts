import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRemoteImportUrl,
    generatePairingToken,
    generateRemoteImportCode,
    isValidPairingToken,
    isValidRemoteImportCode,
    remoteImportPayloadSize,
    utf8ByteLength,
    validateRemoteImportPayload,
    REMOTE_IMPORT_CODE_LENGTH,
    REMOTE_IMPORT_PAYLOAD_MAX_BYTES,
    REMOTE_IMPORT_TOKEN_HEX_LENGTH,
} from '../../../lib/utils/remote-import';

test('generated codes match the expected shape', () => {
    for (let i = 0; i < 50; i += 1) {
        const code = generateRemoteImportCode();
        assert.equal(code.length, REMOTE_IMPORT_CODE_LENGTH);
        assert.equal(isValidRemoteImportCode(code), true);
    }
});

test('generated codes are not predictable by a crippled Math.random', () => {
    const original = Math.random;
    // 即便页面把 Math.random 污染成常量，验证码仍然随机
    Math.random = () => 0;
    try {
        const codes = new Set<string>();
        for (let i = 0; i < 20; i += 1) {
            codes.add(generateRemoteImportCode());
        }
        assert.ok(codes.size > 1);
    } finally {
        Math.random = original;
    }
});

test('code generation refuses to fall back to weak randomness', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
        assert.throws(() => generateRemoteImportCode(), /crypto_unavailable/);
    } finally {
        if (descriptor) {
            Object.defineProperty(globalThis, 'crypto', descriptor);
        }
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

test('pairing tokens are 128-bit hex and strictly validated', () => {
    for (let i = 0; i < 10; i += 1) {
        const token = generatePairingToken();
        assert.equal(token.length, REMOTE_IMPORT_TOKEN_HEX_LENGTH);
        assert.equal(isValidPairingToken(token), true);
    }
    assert.equal(isValidPairingToken('short'), false);
    assert.equal(isValidPairingToken('g'.repeat(REMOTE_IMPORT_TOKEN_HEX_LENGTH)), false);
    assert.equal(isValidPairingToken('A'.repeat(REMOTE_IMPORT_TOKEN_HEX_LENGTH)), false); // 仅小写十六进制
    assert.equal(isValidPairingToken(null), false);
});

test('buildRemoteImportUrl joins origin and code', () => {
    assert.equal(
        buildRemoteImportUrl('http://192.168.1.10:3000/', 'ABCDEF'),
        'http://192.168.1.10:3000/remote-import?code=ABCDEF'
    );
});

test('payload validation accepts url/file/json and trims', () => {
    assert.deepEqual(
        validateRemoteImportPayload({ type: 'url', url: ' https://example.com/a.json ', name: ' 我的订阅 ' }),
        { type: 'url', url: 'https://example.com/a.json', name: '我的订阅' }
    );
    assert.deepEqual(
        validateRemoteImportPayload({ type: 'url', url: 'https://example.com/a.json', name: '   ' }),
        { type: 'url', url: 'https://example.com/a.json', name: undefined }
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
    assert.equal(validateRemoteImportPayload({ type: 'url', url: 42 }), null);
    assert.equal(validateRemoteImportPayload({ type: 'url', url: 'https://example.com/' + 'a'.repeat(2100) }), null);
    assert.equal(validateRemoteImportPayload({ type: 'file', content: '' }), null);
    assert.equal(validateRemoteImportPayload({ type: 'file', content: 5 }), null);
    assert.equal(validateRemoteImportPayload({ type: 'other', content: 'x' }), null);
});

test('payload size counts UTF-8 bytes, not UTF-16 code units', () => {
    assert.equal(utf8ByteLength('abc'), 3);
    assert.equal(utf8ByteLength('中文'), 6);
    assert.equal(remoteImportPayloadSize({ type: 'url', url: 'https://example.com' }), 19);
    assert.equal(remoteImportPayloadSize({ type: 'json', content: '中文' }), 6);
    assert.equal(remoteImportPayloadSize({ type: 'file', content: '😀' }), 4);
    assert.ok(REMOTE_IMPORT_PAYLOAD_MAX_BYTES > 1024 * 1024);
});
