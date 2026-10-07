#!/usr/bin/env node
// 让本地（尤其 Windows）`pages:build` 能跑通的两处依赖补丁。
// CI/Linux 不需要它们也能过；这里每次构建前都跑，保证 npm ci 之后本地依旧可用。
// 可重复运行；锚点消失（依赖升级）时只警告放行，绝不弄红构建。
//
// 补丁 1 —— @vercel/next：lambda 映射表的键来自文件系统路径，Windows 下会带上
//   反斜杠（premium\favorites、api\proxy），而路由查找用 posix 正斜杠
//   （premium/favorites），嵌套路由因此报 "Unable to find lambda for route"。
//   单段路由（favorites、premium）碰巧同名不受影响。处理：统一键为正斜杠。
//
// 补丁 2 —— vercel CLI：共享 lambda 的输出去重用 fs.symlink 建 .func 链接，
//   Windows 无开发者模式/管理员权限时 EPERM 直接炸构建。处理：symlink 失败时
//   回退为目录复制（构建产物语义不变，只是少了去重）。
//
// 补丁 3 —— @cloudflare/next-on-pages：它 spawn `npx vercel build` 并等 close 事件。
//   Windows 下不经 shell 解析不了 .cmd 垫片（ENOENT）；开 shell 后构建能跑完，
//   但 npx/cmd 包装进程在成功后仍占着 stdio，close 永远不触发、next-on-pages 挂死。
//   处理：本地存在 vercel 时直接 spawn `node vc.js build …`，绕开 npx 与 shell。
//
// 补丁 4 —— @vercel/next：getServerlessPages 用 path.join 生成 app 路由的页面键，
//   嵌套路由在 Windows 下变成 premium\favorites.js，而 prerenderRoutes 等查找表
//   用 posix 键（/premium/favorites）——嵌套路由查不到就误标 operationType
//   "Page"（应为 "ISR"），next-on-pages 因此拒绝整个构建。单段路由无分隔符
//   碰巧命中。处理：改用 posix.join，从源头保证路由键跨平台一致。
//
// 补丁 5 —— @vercel/next：getBuildTraceFile 用页面相对路径查 *.nft.json 追踪
//   文件，glob 的键是 posix、path.relative 在 Windows 下给反斜杠，嵌套路由
//   永远查不中而退回全量 nodeFileTrace（构建日志里 "Tracing entries due to
//   missing build traces" 列出全部页面就是这个）。处理：查找前归一分隔符。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const nodeModules = path.join(process.cwd(), 'node_modules');

function resolvePkgFile(pkg, subpath) {
    try {
        return require.resolve(`${pkg}/${subpath}`);
    } catch {
        const fallback = path.join(nodeModules, pkg, subpath);
        return existsSync(fallback) ? fallback : null;
    }
}

const patches = [
    {
        name: '@vercel/next lambda key separators',
        file: resolvePkgFile('@vercel/next', 'dist/index.js'),
        marker: 'KVideo-Fix: normalize Windows separators in lambda map keys',
        anchor:
            '  const prerenderRoute = onPrerenderRoute({\n' +
            '    appDir,\n' +
            '    pagesDir,\n' +
            '    pageLambdaMap: {},',
        transform: (source, anchor, marker) => source.replace(anchor, [
            `  // ${marker}`,
            '  // Windows fs paths leak backslashes into the lambda map keys (premium\\favorites),',
            '  // while route lookups use posix slashes (premium/favorites); nested routes then',
            '  // die with "Unable to find lambda for route". Normalize the keys once.',
            '  for (const lambdaKey of Object.keys(lambdas)) {',
            '    const normalizedKey = lambdaKey.split("\\\\").join("/");',
            '    if (normalizedKey !== lambdaKey) {',
            '      if (!lambdas[normalizedKey]) {',
            '        lambdas[normalizedKey] = lambdas[lambdaKey];',
            '      }',
            '      delete lambdas[lambdaKey];',
            '    }',
            '  }',
            '',
        ].join('\n') + anchor),
    },
    {
        name: 'vercel writeFunctionSymlink copy fallback',
        file: resolvePkgFile('vercel', 'dist/index.js'),
        marker: 'KVideo-Fix: symlink copy fallback',
        anchor:
            '  await import_fs_extra12.default.mkdirp(destDir);\n' +
            '  await import_fs_extra12.default.symlink(target, dest);\n' +
            '  return true;\n' +
            '}',
        transform: (source, anchor, marker) => source.replace(anchor, [
            '  await import_fs_extra12.default.mkdirp(destDir);',
            `  // ${marker}`,
            '  // Creating symlinks needs Developer Mode/admin on Windows (EPERM);',
            '  // fall back to a plain copy — same build output, just not deduplicated.',
            '  try {',
            '    await import_fs_extra12.default.symlink(target, dest);',
            '  } catch (symlinkError) {',
            "    if (symlinkError && (symlinkError.code === 'EPERM' || symlinkError.code === 'EACCES' || symlinkError.code === 'ENOTSUP')) {",
            '      await import_fs_extra12.default.copy(targetDest, dest, { overwrite: true, errorOnExist: false, dereference: true });',
            '    } else {',
            '      throw symlinkError;',
            '    }',
            '  }',
            '  return true;',
            '}',
        ].join('\n')),
    },
    {
        name: 'next-on-pages direct local vercel spawn',
        file: resolvePkgFile('@cloudflare/next-on-pages', 'dist/index.js'),
        marker: 'KVideo-Fix: direct local vercel spawn',
        // 历史手补丁形态（无条件 shell / 条件 shell）先归一成未补丁形态
        normalize: (source) => source
            .replace(
                'import_child_process2.spawn)(spawnCmd.cmd, spawnCmd.cmdArgs, { shell: true })',
                'import_child_process2.spawn)(spawnCmd.cmd, spawnCmd.cmdArgs)'
            )
            .replace(
                'import_child_process2.spawn)(spawnCmd.cmd, spawnCmd.cmdArgs, { shell: process.platform === "win32" }); // KVideo-Fix: shell for npx vercel spawn',
                'import_child_process2.spawn)(spawnCmd.cmd, spawnCmd.cmdArgs);'
            ),
        anchor:
            '  return (0, import_child_process2.spawn)(spawnCmd.cmd, spawnCmd.cmdArgs);\n' +
            '}',
        transform: (source, anchor, marker) => source.replace(anchor, [
            `  // ${marker}`,
            '  // npx + shell on Windows cannot resolve .cmd shims, and even when it runs,',
            "  // wrapper processes keep stdio open after a successful build so the caller's",
            '  // waitForProcessToClose never resolves. Invoke the local vercel entry directly.',
            '  try {',
            '    const localVcJs = require("path").join(process.cwd(), "node_modules", "vercel", "dist", "vc.js");',
            '    if (require("fs").existsSync(localVcJs)) {',
            '      return (0, import_child_process2.spawn)(process.execPath, [localVcJs, "build", ...additionalArgs]);',
            '    }',
            '  } catch {',
            '  }',
            '  return (0, import_child_process2.spawn)(spawnCmd.cmd, spawnCmd.cmdArgs);',
            '}',
        ].join('\n')),
    },
    {
        name: '@vercel/next posix join for app route keys',
        file: resolvePkgFile('@vercel/next', 'dist/index.js'),
        marker: 'KVideo-Fix: posix join for normalized app path keys',
        anchor:
            '      const normalizedPath = `${import_path3.default.join(\n' +
            '        ".",\n' +
            '        normalizedEntry === "/" ? "/index" : normalizedEntry\n' +
            '      )}.js`;',
        transform: (source, anchor, marker) => source.replace(anchor, [
            `      // ${marker}`,
            '      // path.join on Windows keys nested routes as premium\\favorites.js while',
            '      // lookup tables (prerenderRoutes, appBuildTraces, lambda maps) use posix',
            '      // keys — nested routes miss and get mislabeled "Page" instead of "ISR".',
            '      // posix.join keeps every generated route key platform-safe.',
            '      const normalizedPath = `${import_path3.default.posix.join(',
            '        ".",',
            '        normalizedEntry === "/" ? "/index" : normalizedEntry',
            '      )}.js`;',
        ].join('\n')),
    },
    {
        name: '@vercel/next trace file lookup separators',
        file: resolvePkgFile('@vercel/next', 'dist/index.js'),
        marker: 'KVideo-Fix: normalize separators in trace file lookups',
        anchor:
            '    const getBuildTraceFile = (page) => {\n' +
            '      return pageBuildTraces[page + ".nft.json"] || appBuildTraces[page + ".nft.json"];\n' +
            '    };',
        transform: (source, anchor, marker) => source.replace(anchor, [
            '    const getBuildTraceFile = (page) => {',
            `      // ${marker}`,
            '      // path.relative yields premium\\favorites\\page.js on Windows while glob',
            '      // keys are posix, so nested routes always miss their .nft.json traces',
            '      // and fall back to tracing every entry from scratch.',
            '      const normalizedPage = page.split("\\\\").join("/");',
            '      return pageBuildTraces[normalizedPage + ".nft.json"] || appBuildTraces[normalizedPage + ".nft.json"];',
            '    };',
        ].join('\n')),
    },
];

let failures = 0;

for (const patch of patches) {
    const label = `[patch-vercel-build-win] ${patch.name}`;
    if (!patch.file) {
        console.warn(`${label}: package file not found, skipping`);
        continue;
    }
    let source = readFileSync(patch.file, 'utf8');
    if (source.includes(patch.marker)) {
        console.log(`${label}: already applied`);
        continue;
    }
    if (patch.normalize) {
        const normalized = patch.normalize(source);
        if (normalized !== source) {
            writeFileSync(patch.file, normalized);
            source = normalized;
        }
    }
    const count = source.split(patch.anchor).length - 1;
    if (count !== 1) {
        console.warn(`${label}: expected 1 anchor, found ${count}; dependency version probably changed — skipping`);
        failures += 1;
        continue;
    }
    writeFileSync(patch.file, patch.transform(source, patch.anchor, patch.marker));
    console.log(`${label}: applied`);
}

if (failures === patches.length) {
    console.warn('[patch-vercel-build-win] no patch applied — local Windows pages:build may fail (CI/Linux is unaffected)');
}
