/**
 * 远程导入（第二屏配对）契约：电视端显示验证码 + 二维码，手机扫码后提交
 * 导入内容，电视端轮询取回。类型、常量与校验两端（API / 页面）共用。
 */

export type RemoteImportPayload =
    | { type: 'url'; url: string; name?: string }
    | { type: 'file'; content: string }
    | { type: 'json'; content: string };

export type RemoteImportPollResponse =
    | { status: 'waiting'; expiresAt: number }
    | { status: 'received'; payload: RemoteImportPayload };

/** 不含 0/O/1/I，避免手输歧义 */
export const REMOTE_IMPORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REMOTE_IMPORT_CODE_LENGTH = 6;
export const REMOTE_IMPORT_TTL_MS = 10 * 60 * 1000;
export const REMOTE_IMPORT_PAYLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const REMOTE_IMPORT_MAX_FAILED_ATTEMPTS = 15;
export const REMOTE_IMPORT_MAX_ENTRIES = 50;

/**
 * 生成随机验证码。用 getRandomValues 而非 randomUUID：
 * 电视 WebView 内核较老（Chrome 66–74）且页面是 http 明文源。
 */
export function generateRemoteImportCode(): string {
    const alphabet = REMOTE_IMPORT_CODE_ALPHABET;
    const bytes = new Uint8Array(REMOTE_IMPORT_CODE_LENGTH);

    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i += 1) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    let code = '';
    for (let i = 0; i < bytes.length; i += 1) {
        code += alphabet[bytes[i] % alphabet.length];
    }
    return code;
}

export function isValidRemoteImportCode(code: unknown): code is string {
    if (typeof code !== 'string' || code.length !== REMOTE_IMPORT_CODE_LENGTH) {
        return false;
    }
    for (const ch of code) {
        if (!REMOTE_IMPORT_CODE_ALPHABET.includes(ch)) {
            return false;
        }
    }
    return true;
}

export function buildRemoteImportUrl(origin: string, code: string): string {
    return `${origin.replace(/\/$/, '')}/remote-import?code=${code}`;
}

export function validateRemoteImportPayload(raw: unknown): RemoteImportPayload | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as { type?: unknown; url?: unknown; name?: unknown; content?: unknown };

    if (candidate.type === 'url') {
        if (typeof candidate.url !== 'string') return null;
        const url = candidate.url.trim();
        if (!url || url.length > 2048) return null;
        if (!/^https?:\/\//i.test(url)) return null;
        const name = typeof candidate.name === 'string' && candidate.name.trim()
            ? candidate.name.trim().slice(0, 100)
            : undefined;
        return { type: 'url', url, name };
    }

    if (candidate.type === 'file' || candidate.type === 'json') {
        if (typeof candidate.content !== 'string' || candidate.content.length === 0) return null;
        return { type: candidate.type, content: candidate.content };
    }

    return null;
}

export function remoteImportPayloadSize(payload: RemoteImportPayload): number {
    if (payload.type === 'url') return payload.url.length;
    return payload.content.length;
}
