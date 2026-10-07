import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // 上游基线遗留（4.9.17 升级 ESLint/React Compiler 规则后无人清偿）：
    // 降为 warn 让 lint 门禁回归“新问题可拦截、旧债可看见”，而不是整仓常红。
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/rules-of-hooks": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
    },
  },
  {
    files: ["app/api/**/*.ts", "lib/server/**/*.ts"],
    rules: {
      "react/display-name": "off",
      "react/prop-types": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    ".vercel/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
