import {
    REMOTE_IMPORT_CLIENT_MAX_FAILURES,
    REMOTE_IMPORT_CLIENT_WINDOW_MS,
    REMOTE_IMPORT_MAX_ENTRIES,
    REMOTE_IMPORT_MAX_FAILED_ATTEMPTS,
    REMOTE_IMPORT_REGISTER_MAX_PER_WINDOW,
    REMOTE_IMPORT_TTL_MS,
    type RemoteImportPayload,
} from '@/lib/utils/remote-import';

/**
 * 远程导入收件箱（进程内存）。
 *
 * 轮询（GET）只续期、绝不创建条目——条目由电视端注册（POST register）时
 * 创建并取得取件令牌；删除与取件都必须出示令牌。失败计数不会被轮询重置。
 *
 * 状态保存在 globalThis 上。自托管（Docker/Node 单进程）下这就是完整的
 * 收件箱；多副本部署需要换成共享存储（如 Upstash Redis）。本路由声明为
 * edge runtime 以兼容 Cloudflare Pages 构建，但 edge 多隔离环境之间不共享
 * 进程内存，因此远程导入在 CF Pages 上仍不支持（见 README）。
 */

export interface InboxEntry {
    code: string;
    token: string;
    createdAt: number;
    expiresAt: number;
    lastSeenAt: number;
    payload: RemoteImportPayload | null;
    failedAttempts: number;
}

interface ClientWindow {
    windowStartedAt: number;
    count: number;
}

interface InboxStore {
    entries: Map<string, InboxEntry>;
    /** 注册次数 / 失败次数，按客户端键（IP）分别计数 */
    registerWindow: Map<string, ClientWindow>;
    failureWindow: Map<string, ClientWindow>;
}

declare global {
    var __kvideoRemoteImportInbox: InboxStore | undefined;
}

function getStore(): InboxStore {
    if (!globalThis.__kvideoRemoteImportInbox) {
        globalThis.__kvideoRemoteImportInbox = {
            entries: new Map(),
            registerWindow: new Map(),
            failureWindow: new Map(),
        };
    }
    return globalThis.__kvideoRemoteImportInbox;
}

export function sweepExpired(): void {
    const store = getStore();
    const now = Date.now();
    for (const [code, entry] of store.entries) {
        if (entry.expiresAt <= now) {
            store.entries.delete(code);
        }
    }
    for (const window of [store.registerWindow, store.failureWindow]) {
        for (const [key, client] of window) {
            if (now - client.windowStartedAt > REMOTE_IMPORT_CLIENT_WINDOW_MS) {
                window.delete(key);
            }
        }
    }
}

function bumpWindow(window: Map<string, ClientWindow>, key: string, max: number): boolean {
    const now = Date.now();
    let client = window.get(key);
    if (!client || now - client.windowStartedAt > REMOTE_IMPORT_CLIENT_WINDOW_MS) {
        client = { windowStartedAt: now, count: 0 };
        window.set(key, client);
    }
    if (client.count >= max) {
        return false;
    }
    client.count += 1;
    return true;
}

/** 每客户端注册配额；返回 false 表示本窗口内配额已用尽 */
export function tryConsumeRegisterQuota(clientKey: string): boolean {
    sweepExpired();
    return bumpWindow(getStore().registerWindow, clientKey, REMOTE_IMPORT_REGISTER_MAX_PER_WINDOW);
}

/** 记录一次猜码/坏载荷失败；返回 false 表示本客户端已被限流 */
export function recordClientFailure(clientKey: string): boolean {
    sweepExpired();
    return bumpWindow(getStore().failureWindow, clientKey, REMOTE_IMPORT_CLIENT_MAX_FAILURES);
}

/** 客户端失败次数是否已达上限（不计数） */
export function isClientBlocked(clientKey: string): boolean {
    sweepExpired();
    const client = getStore().failureWindow.get(clientKey);
    return !!client && client.count >= REMOTE_IMPORT_CLIENT_MAX_FAILURES;
}

/** 清空全部收件箱与限流状态（测试用） */
export function resetInboxStore(): void {
    globalThis.__kvideoRemoteImportInbox = undefined;
}

/**
 * 注册（或重新注册）配对条目，返回取件令牌。
 * 条目满时优先淘汰「无待取载荷、最久未活跃」的条目，保证活跃的电视端
 * 不会被历史条目挤掉；全部条目都有待取载荷时才返回 inbox_full。
 */
export function registerEntry(code: string, token: string): InboxEntry {
    sweepExpired();
    const store = getStore();
    const now = Date.now();

    const existing = store.entries.get(code);
    if (existing) {
        // 同一验证码重新注册（电视端刷新页面）：换令牌并清空旧载荷
        existing.token = token;
        existing.payload = null;
        existing.failedAttempts = 0;
        existing.createdAt = now;
        existing.expiresAt = now + REMOTE_IMPORT_TTL_MS;
        existing.lastSeenAt = now;
        return existing;
    }

    if (store.entries.size >= REMOTE_IMPORT_MAX_ENTRIES) {
        let victim: string | null = null;
        let victimLastSeen = Number.POSITIVE_INFINITY;
        for (const [otherCode, entry] of store.entries) {
            if (entry.payload) continue;
            if (entry.lastSeenAt < victimLastSeen) {
                victim = otherCode;
                victimLastSeen = entry.lastSeenAt;
            }
        }
        if (victim === null) {
            throw new Error('inbox_full');
        }
        store.entries.delete(victim);
    }

    const entry: InboxEntry = {
        code,
        token,
        createdAt: now,
        expiresAt: now + REMOTE_IMPORT_TTL_MS,
        lastSeenAt: now,
        payload: null,
        failedAttempts: 0,
    };
    store.entries.set(code, entry);
    return entry;
}

export function getEntry(code: string): InboxEntry | undefined {
    sweepExpired();
    return getStore().entries.get(code);
}

/**
 * 轮询续期：校验取件令牌并滑动 TTL。不创建条目、不重置失败计数。
 * 令牌不匹配与条目不存在同样返回 undefined，不暴露条目是否存在。
 */
export function refreshEntry(code: string, token: string): InboxEntry | undefined {
    const entry = getEntry(code);
    if (!entry || entry.token !== token) return undefined;
    const now = Date.now();
    entry.expiresAt = now + REMOTE_IMPORT_TTL_MS;
    entry.lastSeenAt = now;
    return entry;
}

export function putPayload(code: string, payload: RemoteImportPayload): void {
    const entry = getEntry(code);
    if (!entry) {
        throw new Error('not_found');
    }
    if (entry.payload) {
        throw new Error('pending');
    }
    entry.payload = payload;
    entry.expiresAt = Date.now() + REMOTE_IMPORT_TTL_MS;
}

/** 取走即清（单次投递）；必须出示取件令牌 */
export function takePayload(code: string, token: string): RemoteImportPayload | null {
    const entry = refreshEntry(code, token);
    if (!entry || !entry.payload) return null;
    const payload = entry.payload;
    entry.payload = null;
    return payload;
}

export function recordFailedAttempt(code: string): void {
    const entry = getEntry(code);
    if (!entry) return;
    entry.failedAttempts += 1;
    if (entry.failedAttempts >= REMOTE_IMPORT_MAX_FAILED_ATTEMPTS) {
        deleteEntry(code, entry.token);
    }
}

/** 删除条目；必须出示取件令牌 */
export function deleteEntry(code: string, token: string): boolean {
    const entry = getStore().entries.get(code);
    if (!entry || entry.token !== token) return false;
    return getStore().entries.delete(code);
}
