import { NextRequest, NextResponse } from 'next/server';

import {
    REMOTE_IMPORT_PAYLOAD_MAX_BYTES,
    isValidRemoteImportCode,
    remoteImportPayloadSize,
    validateRemoteImportPayload,
    type RemoteImportPollResponse,
} from '@/lib/utils/remote-import';
import {
    deleteEntry,
    ensureEntry,
    getEntry,
    putPayload,
    recordFailedAttempt,
    takePayload,
} from '@/lib/server/remote-import-inbox';

/**
 * 远程导入收件箱传输层。
 *
 * runtime 必须是 nodejs：收件箱保存在进程内存（globalThis）里，edge runtime
 * 按路由各自起 isolate，状态互不可见。因此该功能仅支持自托管（Docker/Node），
 * Cloudflare pages 部署不可用。
 *
 * 安全模型：6 位验证码即凭证（局域网内使用），刻意不加会话校验——否则手机端
 * 也要输入管理密码，配对就失去意义。10 分钟滑动过期 + 单次投递 + 失败次数
 * 上限 + 条目数上限，把暴露面限制在一个短窗口内。
 */
export const runtime = 'nodejs';

function codeFromRequest(request: NextRequest): string | null {
    const code = request.nextUrl.searchParams.get('code');
    return isValidRemoteImportCode(code) ? code : null;
}

export async function GET(request: NextRequest) {
    const code = codeFromRequest(request);
    if (!code) {
        return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
    }

    try {
        const entry = ensureEntry(code);
        const payload = takePayload(code);
        const response: RemoteImportPollResponse = payload
            ? { status: 'received', payload }
            : { status: 'waiting', expiresAt: entry.expiresAt };
        return NextResponse.json(response);
    } catch {
        return NextResponse.json({ error: 'inbox_full' }, { status: 503 });
    }
}

export async function POST(request: NextRequest) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    }

    const raw = body as { code?: unknown; payload?: unknown };
    if (!isValidRemoteImportCode(raw.code)) {
        return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
    }
    const code = raw.code;

    const entry = getEntry(code);
    if (!entry) {
        // 未知与过期返回同一结果，不暴露验证码是否存在
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const payload = validateRemoteImportPayload(raw.payload);
    if (!payload) {
        recordFailedAttempt(code);
        return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
    }
    if (remoteImportPayloadSize(payload) > REMOTE_IMPORT_PAYLOAD_MAX_BYTES) {
        recordFailedAttempt(code);
        return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }

    try {
        putPayload(code, payload);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'pending') {
            return NextResponse.json({ error: 'pending' }, { status: 409 });
        }
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
    const code = codeFromRequest(request);
    if (code) {
        deleteEntry(code);
    }
    return NextResponse.json({ ok: true });
}
