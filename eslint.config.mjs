import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "reports/**"
    ]
  },

  js.configs.recommended,

  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],

      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true
      }]
    }
  },

  {
    files: [
      "electron/renderer/**/*.js",
      "public/**/*.js",
      "src/ui/**/*.js",
      "src/ui/**/*.mjs"
    ],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  {
    files: ["src/ui/**/*.{js,mjs}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error"
    }
  },

  {
    files: ["src/**/*.{js,mjs,cjs}"],
    ignores: ["src/ui/**", "src/contracts/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^(?:(?:\\.\\./)+electron(?:/|$)|(?:\\.\\.?/)+ui(?:/|$)|(?:@rel-ai/desktop|rel-ai-mcp-launcher)(?:/|$))",
          message: "Core/runtime modules must not depend on Electron or UI internals."
        }]
      }]
    }
  },

  {
    files: ["src/contracts/**/*.{js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^(?:\\.\\./)+|^(?:@rel-ai/(?:core|ui|desktop|repository-intelligence)|rel-ai-mcp-launcher)(?:/|$)",
          message: "Contracts are the lowest-level boundary and must not import higher-level packages."
        }]
      }]
    }
  },

  {
    files: ["src/ui/**/*.{js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^(?:(?:\\.\\./)+electron(?:/|$)|(?:@rel-ai/desktop|rel-ai-mcp-launcher)(?:/|$))",
          message: "UI modules must use shared contracts/bridges, not Electron internals."
        }]
      }]
    }
  },

  {
    files: ["electron/**/*.{js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^(?:\\.\\./)+src/ui(?:/|$)|^@rel-ai/ui(?:/|$)",
          message: "Desktop integration must not import dashboard UI internals."
        }]
      }]
    }
  },

  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs"
    }
  }
];