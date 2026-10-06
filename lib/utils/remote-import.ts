/**
 * 远程导入（第二屏配对）契约：电视端显示验证码 + 二维码，手机扫码后提交
 * 导入内容，电视端轮询取回。类型、常量与校验两端（API / 页面）共用。
 *
 * 安全模型：
 * - 6 位验证码是「投递凭证」——手机端凭它提交内容（局域网信任模型）。
 * - 32 位配对令牌是「取件凭证」——仅电视端持有，轮询/删除收件箱条目时
 *   必须出示；即使验证码泄露，第三方也无法取走或删除已提交内容。
 * - 服务端对每客户端（IP）限制注册/失败次数，对单条目限制坏载荷次数。
 */

export type RemoteImportPayload =
    | { type: 'url'; url: string; name?: string }
    | { type: 'file'; content: string }
    | { type: 'json'; content: string };

export type RemoteImportPollResponse =
    | { status: 'waiting'; expiresAt: number }
    | { status: 'received'; payload: RemoteImportPayload };

export type RemoteImportRegisterResponse = {
    token: string;
    expiresAt: number;
};

/** 不含 0/O/1/I，避免手输歧义 */
export const REMOTE_IMPORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REMOTE_IMPORT_CODE_LENGTH = 6;
/** 滑动过期：轮询会续期；10 分钟无活动后条目销毁 */
export const REMOTE_IMPORT_TTL_MS = 10 * 60 * 1000;
export const REMOTE_IMPORT_PAYLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** 单条目坏载荷上限，达到后条目销毁（轮询不会重置计数） */
export const REMOTE_IMPORT_MAX_FAILED_ATTEMPTS = 15;
export const REMOTE_IMPORT_MAX_ENTRIES = 50;
export const REMOTE_IMPORT_TOKEN_HEX_LENGTH = 32;

/** 每客户端（IP）在同一窗口内允许的注册次数 */
export const REMOTE_IMPORT_REGISTER_MAX_PER_WINDOW = 20;
/** 每客户端（IP）在同一窗口内允许的失败次数（猜码/坏载荷），达到后 429 */
export const REMOTE_IMPORT_CLIENT_MAX_FAILURES = 10;
export const REMOTE_IMPORT_CLIENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * 生成随机验证码。getRandomValues 在 http 明文源与旧 WebView
 * （Chrome 37+）上都可用，因此不再保留 Math.random 回退——弱随机
 * 会让验证码可以被预测。
 */
export function generateRemoteImportCode(): string {
    const alphabet = REMOTE_IMPORT_CODE_ALPHABET;
    const code = randomBytes(REMOTE_IMPORT_CODE_LENGTH);
    let out = '';
    for (let i = 0; i < code.length; i += 1) {
        out += alphabet[code[i] % alphabet.length];
    }
    return out;
}

/** 生成取件令牌（128 位随机，十六进制表示） */
export function generatePairingToken(): string {
    const bytes = randomBytes(REMOTE_IMPORT_TOKEN_HEX_LENGTH / 2);
    let hex = '';
    for (let i = 0; i < bytes.length; i += 1) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
    if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
        throw new Error('crypto_unavailable');
    }
    webCrypto.getRandomValues(bytes);
    return bytes;
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

const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${REMOTE_IMPORT_TOKEN_HEX_LENGTH}}$`);

export function isValidPairingToken(token: unknown): token is string {
    return typeof token === 'string' && TOKEN_PATTERN.test(token);
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

/** UTF-8 字节长度（与 REMOTE_IMPORT_PAYLOAD_MAX_BYTES 同一单位） */
export function utf8ByteLength(text: string): number {
    return new TextEncoder().encode(text).length;
}

export function remoteImportPayloadSize(payload: RemoteImportPayload): number {
    if (payload.type === 'url') return utf8ByteLength(payload.url);
    return utf8ByteLength(payload.content);
}
