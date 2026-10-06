'use client';

import { useEffect, useRef, useState } from 'react';
import type { SourceSubscription } from '@/lib/types';
import {
    buildRemoteImportUrl,
    generateRemoteImportCode,
    type RemoteImportPayload,
    type RemoteImportPollResponse,
} from '@/lib/utils/remote-import';
import { createSubscription, fetchTextFromUrl } from '@/lib/utils/source-import-utils';

interface RemoteImportTabProps {
    onImportFile: (content: string) => Promise<boolean> | boolean;
    onAddSubscription: (sub: SourceSubscription) => Promise<boolean> | boolean;
}

type TabStatus = 'waiting' | 'importing' | 'done' | 'error';

const POLL_INTERVAL_MS = 1500;

export function RemoteImportTab({ onImportFile, onAddSubscription }: RemoteImportTabProps) {
    // 验证码 / 配对地址只在客户端生成，避免 SSR 与 hydration 不一致
    const [code, setCode] = useState('');
    const [token, setToken] = useState('');
    const [remoteUrl, setRemoteUrl] = useState('');
    const [qrDataUrl, setQrDataUrl] = useState('');
    const [status, setStatus] = useState<TabStatus>('waiting');
    const [message, setMessage] = useState('');
    const [chooserNotice, setChooserNotice] = useState(false);
    const busyRef = useRef(false);

    // 首个验证码仅在客户端生成（SSR 阶段不渲染真实验证码）
    useEffect(() => {
        setCode(generateRemoteImportCode());
    }, []);

    // 二维码（黑码白底，任何主题下都可扫）
    useEffect(() => {
        let cancelled = false;
        setQrDataUrl('');
        if (!remoteUrl) return;

        import('qrcode')
            .then((QRCode) => QRCode.toDataURL(remoteUrl, {
                margin: 2,
                width: 360,
                color: { dark: '#000000ff', light: '#ffffffff' },
            }))
            .then((dataUrl) => {
                if (!cancelled) setQrDataUrl(dataUrl);
            })
            .catch((err) => console.error('QR generation failed:', err));

        return () => {
            cancelled = true;
        };
    }, [remoteUrl]);

    // 注册配对：服务端只在注册时创建收件箱条目，并签发取件令牌
    useEffect(() => {
        if (!code) return;
        let cancelled = false;

        setToken('');
        setRemoteUrl(buildRemoteImportUrl(window.location.origin, code));

        fetch('/api/remote-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'register', code }),
        })
            .then(async (res) => {
                if (!res.ok) {
                    if (res.status === 503) throw new Error('inbox_full');
                    throw new Error('register_failed');
                }
                return (await res.json()) as { token: string };
            })
            .then((data) => {
                if (!cancelled && data.token) {
                    setToken(data.token);
                }
            })
            .catch((err) => {
                if (cancelled) return;
                console.error('remote import register failed:', err);
                setStatus('error');
                setMessage(err instanceof Error && err.message === 'inbox_full'
                    ? '配对名额已满，请稍后点「重新生成」重试'
                    : '注册配对失败，请检查网络后点「重新生成」重试');
            });

        return () => {
            cancelled = true;
        };
    }, [code]);

    // 轮询收件箱（出示取件令牌）
    useEffect(() => {
        if (status === 'done' || !code || !token) return;
        let disposed = false;

        const dispatchPayload = async (payload: RemoteImportPayload) => {
            if (busyRef.current) return;
            busyRef.current = true;
            setStatus('importing');
            setMessage('正在导入…');

            try {
                if (payload.type === 'url') {
                    try {
                        await onAddSubscription(createSubscription(payload.name || '远程订阅', payload.url));
                        setStatus('done');
                        // 订阅导入不触发整页刷新，仅更新设置页数据
                        setMessage('订阅已添加！');
                    } catch {
                        // 不是源列表订阅链接时，按设置备份/源列表内容导入
                        let text: string;
                        try {
                            text = await fetchTextFromUrl(payload.url);
                        } catch {
                            throw new Error('url_unreachable');
                        }
                        const ok = await onImportFile(text);
                        if (!ok) throw new Error('content_unrecognized');
                        setStatus('done');
                        setMessage('导入成功！正在刷新…');
                    }
                } else {
                    const ok = await onImportFile(payload.content);
                    if (!ok) throw new Error('content_unrecognized');
                    setStatus('done');
                    setMessage('导入成功！正在刷新…');
                }
            } catch (err) {
                console.error(err);
                setStatus('error');
                const reason = err instanceof Error ? err.message : '';
                setMessage(reason === 'url_unreachable'
                    ? '导入失败：链接无法访问'
                    : '导入失败：内容无法识别');
            } finally {
                busyRef.current = false;
            }
        };

        const poll = async () => {
            if (disposed || busyRef.current) return;
            try {
                const res = await fetch(`/api/remote-import?code=${code}`, {
                    cache: 'no-store',
                    headers: { 'X-Pairing-Token': token },
                });
                if (!res.ok) {
                    if (res.status === 404 || res.status === 400) {
                        disposed = true;
                        setStatus('error');
                        setMessage('验证码已失效，请点「重新生成」');
                    } else if (res.status === 429) {
                        disposed = true;
                        setStatus('error');
                        setMessage('请求过于频繁，请稍后点「重新生成」重试');
                    }
                    // 其他状态：网络抖动，下一轮重试
                    return;
                }
                const data = (await res.json()) as RemoteImportPollResponse;
                if (data.status === 'received') {
                    await dispatchPayload(data.payload);
                }
            } catch {
                // 网络抖动：下一轮重试
            }
        };

        const timer = setInterval(poll, POLL_INTERVAL_MS);
        poll();

        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [code, token, status, onImportFile, onAddSubscription]);

    // 关闭/切换时注销验证码（best-effort，TTL 兜底）
    useEffect(() => {
        if (!code || !token) return;
        return () => {
            fetch(`/api/remote-import?code=${code}`, {
                method: 'DELETE',
                headers: { 'X-Pairing-Token': token },
            }).catch(() => undefined);
        };
    }, [code, token]);

    // 某些电视盒子没有文件选择器时，原生层会派发此事件
    useEffect(() => {
        const handler = () => setChooserNotice(true);
        window.addEventListener('kvideo-file-chooser-unavailable', handler);
        return () => window.removeEventListener('kvideo-file-chooser-unavailable', handler);
    }, []);

    const handleRegenerate = () => {
        busyRef.current = false;
        setCode(generateRemoteImportCode());
        setToken('');
        setStatus('waiting');
        setMessage('');
    };

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="p-4 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius-2xl)]">
                <p className="text-[var(--text-color-secondary)] text-sm mb-3">
                    用手机扫描二维码（或在手机浏览器打开下面的网址），在手机上粘贴订阅链接、选择文件或粘贴 JSON，电视会自动导入，无需遥控器打字。
                </p>

                <div className="flex flex-col items-center gap-3">
                    <div className="bg-white rounded-[var(--radius-2xl)] p-3 shadow-[var(--shadow-md)]">
                        {qrDataUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={qrDataUrl} alt="远程导入二维码" width={300} height={300} className="block w-[300px] h-[300px]" />
                        ) : (
                            <div className="w-[300px] h-[300px] flex items-center justify-center text-gray-400 text-sm">
                                二维码生成中…
                            </div>
                        )}
                    </div>

                    <div className="text-center">
                        <div className="text-[var(--text-color-secondary)] text-sm">验证码</div>
                        <div className="text-[var(--text-color)] text-3xl font-mono font-bold tracking-[0.3em]">
                            {code || '······'}
                        </div>
                        {remoteUrl && (
                            <div className="text-[var(--text-color-secondary)] text-xs mt-1 break-all select-all">{remoteUrl}</div>
                        )}
                    </div>
                </div>

                <div className="mt-4 flex items-center gap-3">
                    <button
                        data-focusable
                        onClick={handleRegenerate}
                        className="px-5 py-3 rounded-[var(--radius-full)] bg-[color-mix(in_srgb,var(--accent-color)_12%,transparent)] border border-[var(--glass-border)] text-[var(--text-color)] hover:bg-[color-mix(in_srgb,var(--accent-color)_20%,transparent)] transition-colors"
                    >
                        重新生成
                    </button>

                    <div className="text-sm" aria-live="polite">
                        {status === 'waiting' && (
                            <span className="text-[var(--text-color-secondary)]">等待手机提交…</span>
                        )}
                        {status === 'importing' && <span className="text-[var(--accent-color)]">{message}</span>}
                        {status === 'done' && <span className="text-green-600">{message}</span>}
                        {status === 'error' && <span className="text-red-500">{message}</span>}
                    </div>
                </div>

                <p className="text-[var(--text-color-secondary)] text-xs mt-3">
                    验证码默认 10 分钟内有效，本面板保持打开时会自动续期；若电视端重新生成了验证码，请在手机上重新提交。
                </p>

                {chooserNotice && (
                    <div className="mt-3 text-sm text-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-[var(--radius-2xl)] px-4 py-3 border border-amber-100 dark:border-amber-900/30">
                        此设备没有可用的文件管理器，「文件导入」无法打开选择器——请使用本页的远程导入。
                    </div>
                )}
            </div>
        </div>
    );
}
