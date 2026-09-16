// ESLint config scoped to the Tampermonkey userscripts in this directory.
//
// Why this exists: these files run as browser IIFEs injected by Tampermonkey,
// not through any bundler — no eslint config existed for this folder at all,
// so linting them (editor extension or a manual `eslint` run) reported every
// GM_* API call and `unsafeWindow` as an undefined global (`no-undef`), and
// with no `/* global ... */` directive declaring them, there was nothing to
// suppress those errors correctly. This declares the real Tampermonkey API
// surface these scripts actually use (see each file's `// @grant` lines in
// its UserScript metadata block — grants and globals here should stay in
// sync), plus the standard browser globals, as proper ESLint globals.
//
// Deliberately zero external imports (no @eslint/js, no `globals` package):
// scripts/ has no node_modules of its own — these are standalone Tampermonkey
// files, not part of the npm-managed client/server apps — and reaching across
// to client/node_modules isn't how Node's ESM resolver works (it only walks
// up the directory tree, and scripts/ and client/ are siblings). Hand-rolling
// the (short) list of globals actually used avoids needing a dependency here
// at all.
//
// .mjs extension (not .js): the root package.json has no "type": "module"
// (unlike client/'s, which does) — Node resolves a plain eslint.config.js
// here as CommonJS via the nearest ancestor package.json and chokes on the
// `import` syntax below. .mjs forces ESM regardless of that, without having
// to add "type": "module" to the root package.json (which would break
// server/index.js and other root-level CJS scripts using require()).
//
// sourceType is 'script' (not 'module') — every file here is a single
// `(function () { 'use strict'; ... })()` IIFE with no import/export.

export default [
  // Backup/reference copies aren't live scripts (see CLAUDE.md's Tampermonkey
  // workflow rule) and the .txt indicator references aren't even valid as
  // standalone JS — don't lint either.
  { ignores: ['**/*_bkp.js', 'indicators/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        // Standard browser globals these scripts actually touch.
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        URLSearchParams: 'readonly',
        XMLHttpRequest: 'readonly',
        Node: 'readonly',
        HTMLElement: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        // Tampermonkey / Greasemonkey API surface actually used across these
        // scripts. Keep in sync with each file's `// @grant` lines.
        GM_xmlhttpRequest: 'readonly',
        GM_setValue: 'readonly',
        GM_getValue: 'readonly',
        GM_listValues: 'readonly',
        GM_deleteValue: 'readonly',
        GM_setClipboard: 'readonly',
        GM_openInTab: 'readonly',
        GM_addStyle: 'readonly',
        GM_registerMenuCommand: 'readonly',
        GM_info: 'readonly',
        unsafeWindow: 'readonly',
      },
    },
    rules: {
      // Core correctness rules worth having even without eslint:recommended
      // (avoided above — pulling it in requires @eslint/js, see note above).
      'no-undef': 'error',
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-fallthrough': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
]
