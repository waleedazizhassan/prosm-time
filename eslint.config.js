import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// PROSM Time coding standards (WP-01) - deliberately mirrors PROSM
// Platform's own eslint.config.js shape (same plugin set, same relaxed
// react/prop-types + no-unused-vars underscore convention) with
// typescript-eslint layered on top for the TS/TSX stack this product
// uses (§: "Core technology baseline: React + Vite + TypeScript").
export default tseslint.config(
  // supabase/functions/** is Deno runtime code (Deno.env, remote URL
  // imports, its own lint via deno-lint-ignore-file comments) - a
  // Node/browser-targeted config has no business validating it, same
  // reasoning dist/** is excluded as build output rather than source.
  { ignores: ["dist/**", "supabase/functions/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react-refresh/only-export-components": ["off", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  }
);
