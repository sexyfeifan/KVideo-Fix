import { NextRequest, NextResponse } from 'next/server';

import {
    REMOTE_IMPORT_PAYLOAD_MAX_BYTES,
    generatePairingToken,
    isValidPairingToken,
    isValidRemoteImportCode,
    remoteImportPayloadSize,
    utf8ByteLength,
    validateRemoteImportPayload,
    type RemoteImportPollResponse,
    type RemoteImportRegisterResponse,
} from '@/lib/utils/remote-import';
import {
    deleteEntry,
    isClientBlocked,
    putPayload,
    recordClientFailure,
    recordFailedAttempt,
    refreshEntry,
    registerEntry,
    takePayload,
    tryConsumeRegisterQuota,
} from '@/lib/server/remote-import-inbox';

/**
 * 远程导入收件箱传输层（所有操作都在这一个路由文件里）。
 *
 * runtime 必须是 edge：非 edge 路由会让 next-on-pages 整体中止构建（上游
 * 4.9.1 也因此移除过 /api/site-icon）。edge 按「路由文件」分配 isolate，
 * isolate 内 module/globalThis 状态在请求间保持，因此注册、投递、轮询
 * 必须落在同一个路由文件里，才能看到同一个收件箱——拆成多个路由文件会
 * 各自持有一份内存，轮询永远收不到提交。
 *
 * 自托管（Docker/Node 单进程）下这就是完整的收件箱。Cloudflare Pages 等
 * 多隔离部署同一路由会被铺开到多个 isolate，内存不互通，远程导入不可用，
 * 请改用「文件导入 / JSON 导入」；如需跨实例支持，需换成共享存储
 * （如 Upstash Redis）。
 *
 * 接口语义（POST 用 action 区分）：
 * - POST {action:'register', code}       电视端注册配对，返回取件令牌（限速）
 * - GET  ?code=&X-Pairing-Token          电视端轮询续期并取件（须出示令牌）
 * - POST {code,payload}                  手机端投递内容（猜码/坏载荷限速）
 * - DELETE ?code=&X-Pairing-Token        电视端退出时注销（须出示令牌）
 */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

/** 原始请求体上限：载荷上限 + JSON 包封（action/code/type 等）余量 */
const RAW_BODY_LIMIT = REMOTE_IMPORT_PAYLOAD_MAX_BYTES + 4096;

const TOKEN_HEADER = 'x-pairing-token';

function clientKeyFromRequest(request: NextRequest): string {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return request.headers.get('x-real-ip') || 'unknown';
}

function codeFromRequest(request: NextRequest): string | null {
    const code = request.nextUrl.searchParams.get('code');
    return isValidRemoteImportCode(code) ? code : null;
}

function tokenFromRequest(request: NextRequest): string | null {
    const token = request.headers.get(TOKEN_HEADER);
    return isValidPairingToken(token) ? token : null;
}

function jsonError(error: string, status: number): NextResponse {
    return NextResponse.json({ error }, { status });
}

export async function GET(request: NextRequest) {
    const code = codeFromRequest(request);
    const token = tokenFromRequest(request);
    if (!code || !token) {
        return jsonError('invalid_code', 400);
    }

    const entry = refreshEntry(code, token);
    if (!entry) {
        // 条目不存在 / 已过期 / 令牌不对，统一 404，不暴露条目是否存在
        return jsonError('not_found', 404);
    }

    const payload = takePayload(code, token);
    const response: RemoteImportPollResponse = payload
        ? { status: 'received', payload }
        : { status: 'waiting', expiresAt: entry.expiresAt };
    return NextResponse.json(response);
}

export async function POST(request: NextRequest) {
    const clientKey = clientKeyFromRequest(request);

    // 先按字节读入并限长，避免解析超大 JSON
    let rawBody: string;
    try {
        rawBody = await request.text();
    } catch {
        return jsonError('invalid_body', 400);
    }
    if (utf8ByteLength(rawBody) > RAW_BODY_LIMIT) {
        recordClientFailure(clientKey);
        return jsonError('payload_too_large', 413);
    }

    let body: unknown;
    try {
        body = JSON.parse(rawBody);
    } catch {
        recordClientFailure(clientKey);
        return jsonError('invalid_body', 400);
    }

    const raw = body as { action?: unknown; code?: unknown; payload?: unknown };
    if (raw.action === 'register') {
        return handleRegister(clientKey, raw.code);
    }
    return handleDeliver(clientKey, raw);
}

export async function DELETE(request: NextRequest) {
    const code = codeFromRequest(request);
    const token = tokenFromRequest(request);
    if (code && token) {
        deleteEntry(code, token);
    }
    // 无论是否删除成功都返回 ok：不暴露条目/令牌状态
    return NextResponse.json({ ok: true });
}

function handleRegister(clientKey: string, code: unknown): NextResponse {
    if (!isValidRemoteImportCode(code)) {
        return jsonError('invalid_code', 400);
    }
    if (isClientBlocked(clientKey)) {
        return jsonError('rate_limited', 429);
    }
    if (!tryConsumeRegisterQuota(clientKey)) {
        return jsonError('rate_limited', 429);
    }

    try {
        const entry = registerEntry(code, generatePairingToken());
        const response: RemoteImportRegisterResponse = {
            token: entry.token,
            expiresAt: entry.expiresAt,
        };
        return NextResponse.json(response);
    } catch {
        return jsonError('inbox_full', 503);
    }
}

function handleDeliver(clientKey: string, raw: { code?: unknown; payload?: unknown }): NextResponse {
    if (isClientBlocked(clientKey)) {
        return jsonError('rate_limited', 429);
    }

    if (!isValidRemoteImportCode(raw.code)) {
        recordClientFailure(clientKey);
        return jsonError('invalid_code', 400);
    }
    const code = raw.code;

    const payload = validateRemoteImportPayload(raw.payload);
    if (!payload) {
        recordClientFailure(clientKey);
        recordFailedAttempt(code);
        return jsonError('invalid_payload', 400);
    }
    if (remoteImportPayloadSize(payload) > REMOTE_IMPORT_PAYLOAD_MAX_BYTES) {
        recordClientFailure(clientKey);
        recordFailedAttempt(code);
        return jsonError('payload_too_large', 413);
    }

    try {
        putPayload(code, payload);
    } catch (error) {
        // putPayload 的契约：只抛带 message 的 Error（pending / not_found）
        if ((error as Error).message === 'pending') {
            return jsonError('pending', 409);
        }
        // 未知与过期返回同一结果，不暴露验证码是否存在；但计入猜码失败
        recordClientFailure(clientKey);
        return jsonError('not_found', 404);
    }

    return NextResponse.json({ ok: true });
}
