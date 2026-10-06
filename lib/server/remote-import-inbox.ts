import {
    REMOTE_IMPORT_MAX_ENTRIES,
    REMOTE_IMPORT_MAX_FAILED_ATTEMPTS,
    REMOTE_IMPORT_TTL_MS,
    type RemoteImportPayload,
} from '@/lib/utils/remote-import';

/**
 * 远程导入收件箱（进程内存）。
 *
 * 仅可在 nodejs runtime 的路由里使用：edge runtime 是按路由隔离的 isolate，
 * 全局状态不共享，轮询会永远收不到提交。本部署是 Docker 单进程自托管，
 * 单例 Map 就够用；多副本部署需要换成共享存储（如 Upstash Redis）。
 */

interface InboxEntry {
    code: string;
    createdAt: number;
    expiresAt: number;
    payload: RemoteImportPayload | null;
    failedAttempts: number;
}

interface InboxStore {
    entries: Map<string, InboxEntry>;
}

declare global {
    var __kvideoRemoteImportInbox: InboxStore | undefined;
}

function getStore(): InboxStore {
    if (!globalThis.__kvideoRemoteImportInbox) {
        globalThis.__kvideoRemoteImportInbox = { entries: new Map() };
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
}

export function ensureEntry(code: string): InboxEntry {
    sweepExpired();
    const store = getStore();
    const now = Date.now();
    let entry = store.entries.get(code);
    if (!entry) {
        if (store.entries.size >= REMOTE_IMPORT_MAX_ENTRIES) {
            throw new Error('inbox_full');
        }
        entry = {
            code,
            createdAt: now,
            expiresAt: now + REMOTE_IMPORT_TTL_MS,
            payload: null,
            failedAttempts: 0,
        };
        store.entries.set(code, entry);
    }
    entry.expiresAt = now + REMOTE_IMPORT_TTL_MS;
    return entry;
}

export function getEntry(code: string): InboxEntry | undefined {
    sweepExpired();
    return getStore().entries.get(code);
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

/** 取走即清（单次投递） */
export function takePayload(code: string): RemoteImportPayload | null {
    const entry = getEntry(code);
    if (!entry || !entry.payload) return null;
    const payload = entry.payload;
    entry.payload = null;
    entry.expiresAt = Date.now() + REMOTE_IMPORT_TTL_MS;
    return payload;
}

export function recordFailedAttempt(code: string): void {
    const entry = getEntry(code);
    if (!entry) return;
    entry.failedAttempts += 1;
    if (entry.failedAttempts >= REMOTE_IMPORT_MAX_FAILED_ATTEMPTS) {
        deleteEntry(code);
    }
}

export function deleteEntry(code: string): void {
    getStore().entries.delete(code);
}
