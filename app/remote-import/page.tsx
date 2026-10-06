'use client';

import { useEffect, useRef, useState } from 'react';
import {
    isValidRemoteImportCode,
    REMOTE_IMPORT_CODE_LENGTH,
    type RemoteImportPayload,
} from '@/lib/utils/remote-import';

type SubmitState = 'idle' | 'sending' | 'success' | 'expired' | 'pending' | 'error';

/**
 * 手机配对页（电视「远程导入」扫码进入）。
 * 纯提交页：只发送内容，不展示任何设置/历史数据。
 * 凭证是 URL 里的 6 位验证码，因此不经过密码门（见 PasswordGate 的路径旁路）。
 */
export default function RemoteImportPage() {
    const [code, setCode] = useState('');
    const [codeReady, setCodeReady] = useState(false);
    const [urlValue, setUrlValue] = useState('');
    const [nameValue, setNameValue] = useState('');
    const [jsonValue, setJsonValue] = useState('');
    const [state, setState] = useState<SubmitState>('idle');
    const [message, setMessage] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        // URL 只能在 hydration 后读取（SSR 无 window），故在 effect 里同步一次
        const params = new URLSearchParams(window.location.search);
        const fromUrl = (params.get('code') || '').toUpperCase();
        if (isValidRemoteImportCode(fromUrl)) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setCode(fromUrl);
        }
        setCodeReady(true);
    }, []);

    const submit = async (payload: RemoteImportPayload) => {
        if (!isValidRemoteImportCode(code)) {
            setState('error');
            setMessage('请先输入电视上显示的 6 位验证码');
            return;
        }
        setState('sending');
        setMessage('');
        try {
            const res = await fetch('/api/remote-import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, payload }),
            });
            if (res.status === 200) {
                setState('success');
                setMessage('已发送，请查看电视');
            } else if (res.status === 404 || res.status === 410) {
                setState('expired');
                setMessage('验证码已失效，请在电视上重新生成');
            } else if (res.status === 409) {
                setState('pending');
                setMessage('电视端已有待处理的导入，请稍候再试');
            } else {
                setState('error');
                setMessage('发送失败：内容格式不正确');
            }
        } catch {
            setState('error');
            setMessage('网络错误，请确认手机和电视在同一局域网后重试');
        }
    };

    const handleUrlSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const url = urlValue.trim();
        if (!/^https?:\/\//i.test(url)) {
            setState('error');
            setMessage('请输入以 http(s):// 开头的链接');
            return;
        }
        submit({ type: 'url', url, name: nameValue.trim() || undefined });
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            submit({ type: 'file', content: String(reader.result || '') });
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleJsonSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const content = jsonValue.trim();
        if (!content) {
            setState('error');
            setMessage('请粘贴 JSON 内容');
            return;
        }
        submit({ type: 'json', content });
    };

    return (
        <main className="mx-auto max-w-lg px-4 py-8 space-y-6">
            <header className="space-y-2">
                <h1 className="text-2xl font-bold text-[var(--text-color)]">远程导入到电视</h1>
                <p className="text-[var(--text-color-secondary)] text-sm">
                    手机上填写内容并发送，电视会自动导入。链接和文件都只在局域网内传输。
                </p>
            </header>

            <section className="p-4 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius-2xl)]">
                <label className="block text-sm text-[var(--text-color-secondary)] mb-2" htmlFor="pair-code">
                    电视验证码
                </label>
                <input
                    id="pair-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, REMOTE_IMPORT_CODE_LENGTH))}
                    placeholder="6 位验证码"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="off"
                    className="w-full px-4 py-3 rounded-[var(--radius-2xl)] bg-[color-mix(in_srgb,var(--glass-bg)_50%,transparent)] border border-[var(--glass-border)] text-[var(--text-color)] text-xl font-mono tracking-[0.3em] focus:outline-none focus:border-[var(--accent-color)]"
                />
                {codeReady && !isValidRemoteImportCode(code) && (
                    <p className="text-xs text-[var(--text-color-secondary)] mt-2">
                        扫码进入会自动填入；手动输入请照电视屏幕输入 6 位验证码。
                    </p>
                )}
            </section>

            <section className="p-4 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius-2xl)] space-y-3">
                <h2 className="font-semibold text-[var(--text-color)]">发送订阅链接</h2>
                <input
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    placeholder="https://example.com/sources.json"
                    inputMode="url"
                    className="w-full px-4 py-3 rounded-[var(--radius-2xl)] bg-[color-mix(in_srgb,var(--glass-bg)_50%,transparent)] border border-[var(--glass-border)] text-[var(--text-color)] focus:outline-none focus:border-[var(--accent-color)]"
                />
                <input
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    placeholder="订阅名称（可选）"
                    className="w-full px-4 py-3 rounded-[var(--radius-2xl)] bg-[color-mix(in_srgb,var(--glass-bg)_50%,transparent)] border border-[var(--glass-border)] text-[var(--text-color)] focus:outline-none focus:border-[var(--accent-color)]"
                />
                <button
                    onClick={handleUrlSubmit}
                    disabled={state === 'sending'}
                    className="w-full px-6 py-3 rounded-[var(--radius-full)] bg-[var(--accent-color)] text-white font-medium disabled:opacity-50"
                >
                    发送到电视
                </button>
            </section>

            <section className="p-4 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius-2xl)] space-y-3">
                <h2 className="font-semibold text-[var(--text-color)]">上传设置文件</h2>
                <p className="text-xs text-[var(--text-color-secondary)]">
                    选择之前导出的 JSON 备份（或源列表文件），用手机的文件选择器上传。
                </p>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileSelect}
                    className="hidden"
                />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={state === 'sending'}
                    className="w-full px-6 py-4 rounded-[var(--radius-2xl)] border-2 border-dashed border-[var(--glass-border)] text-[var(--text-color)] disabled:opacity-50"
                >
                    选择文件并发送
                </button>
            </section>

            <section className="p-4 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius-2xl)] space-y-3">
                <h2 className="font-semibold text-[var(--text-color)]">粘贴 JSON</h2>
                <textarea
                    value={jsonValue}
                    onChange={(e) => setJsonValue(e.target.value)}
                    rows={5}
                    placeholder="粘贴设置备份或源列表 JSON"
                    className="w-full px-4 py-3 rounded-[var(--radius-2xl)] bg-[color-mix(in_srgb,var(--glass-bg)_50%,transparent)] border border-[var(--glass-border)] text-[var(--text-color)] text-xs font-mono focus:outline-none focus:border-[var(--accent-color)]"
                />
                <button
                    onClick={handleJsonSubmit}
                    disabled={state === 'sending'}
                    className="w-full px-6 py-3 rounded-[var(--radius-full)] bg-[var(--accent-color)] text-white font-medium disabled:opacity-50"
                >
                    发送到电视
                </button>
            </section>

            {(state !== 'idle' && message) && (
                <div
                    className={`p-4 rounded-[var(--radius-2xl)] text-sm border ${state === 'success'
                        ? 'text-green-600 bg-green-50 dark:bg-green-900/20 border-green-100 dark:border-green-900/30'
                        : 'text-red-500 bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-900/30'
                        }`}
                >
                    {message}
                </div>
            )}
        </main>
    );
}
