#!/usr/bin/env node
// ============================================================
// Smoke test for the esbuild-produced extension bundle.
//
// `node --check` confirms the bundle parses; this script confirms
// the bundle actually *loads* and `activate()` runs once without
// throwing under a minimal VS Code mock. Catches:
//   - tree-shaken-but-needed imports
//   - ESM ↔ CJS interop regressions in the @modelcontextprotocol/sdk graph
//   - top-level execution failures inside the bundle IIFE
//
// Run:  npm run smoke
// ============================================================

const path = require('path');
const Module = require('module');

const BUNDLE = path.resolve(__dirname, '..', 'out', 'extension.js');

// --- Minimal vscode shim (Proxy-based; behaves as anything called/extended) ---
function makeVscodeShim() {
  const disposable = { dispose() {} };

  class EventEmitter {
    constructor() { this._ls = []; this.event = (l) => (this._ls.push(l), disposable); }
    fire(v) { for (const l of this._ls) try { l(v); } catch {} }
    dispose() { this._ls.length = 0; }
  }
  class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  class ThemeIcon { constructor(id) { this.id = id; } }

  // Proxy backstop: any unknown property returns a no-op fn / empty object,
  // so we don't need to enumerate the entire VS Code API.
  const ns = (overrides = {}) => new Proxy(overrides, {
    get(t, p) {
      if (p in t) return t[p];
      // Class-like access (UpperCamelCase) → return an empty class
      if (typeof p === 'string' && /^[A-Z]/.test(p)) {
        return class {};
      }
      return () => undefined;
    },
  });

  return {
    EventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    Uri: {
      file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
      joinPath: (base, ...segs) => ({ fsPath: [base.fsPath || '', ...segs].join('/') }),
      parse: (s) => ({ fsPath: s, toString: () => s }),
    },
    commands: ns({ registerCommand: () => disposable, executeCommand: async () => undefined }),
    window: ns({
      createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
      registerWebviewPanelSerializer: () => disposable,
      registerTreeDataProvider: () => disposable,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInputBox: async () => undefined,
    }),
    workspace: ns({
      onDidChangeConfiguration: () => disposable,
      getConfiguration: () => ({ get: (_k, def) => def, update: async () => undefined, inspect: () => undefined }),
    }),
  };
}

// --- Intercept require('vscode') ---
// Build the shim once and short-circuit any require('vscode') call before
// Node tries to resolve it from disk.
const vscodeShim = makeVscodeShim();
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'vscode') return vscodeShim;
  return origLoad.call(this, request, parent, ...rest);
};

// --- Run ---
async function main() {
  let mod;
  try {
    mod = require(BUNDLE);
  } catch (e) {
    console.error('[smoke] FAIL bundle could not be loaded:', e);
    process.exit(1);
  }

  if (typeof mod.activate !== 'function' || typeof mod.deactivate !== 'function') {
    console.error('[smoke] FAIL bundle missing activate/deactivate exports. got:', Object.keys(mod));
    process.exit(1);
  }

  // Build a fake ExtensionContext shaped enough to satisfy activate()
  const memento = (() => {
    const m = new Map();
    return {
      get: (k, def) => (m.has(k) ? m.get(k) : def),
      update: async (k, v) => void m.set(k, v),
      keys: () => Array.from(m.keys()),
      setKeysForSync: () => {},
    };
  });
  const secretsStore = new Map();
  const secretsListeners = [];
  const ctx = {
    subscriptions: [],
    extensionPath: process.cwd(),
    extensionUri: { fsPath: process.cwd() },
    globalStorageUri: { fsPath: process.cwd() },
    storageUri: { fsPath: process.cwd() },
    globalState: memento(),
    workspaceState: memento(),
    secrets: {
      get: async (k) => secretsStore.get(k),
      store: async (k, v) => { secretsStore.set(k, v); secretsListeners.forEach((l) => l({ key: k })); },
      delete: async (k) => { secretsStore.delete(k); secretsListeners.forEach((l) => l({ key: k })); },
      onDidChange: (l) => { secretsListeners.push(l); return { dispose: () => {} }; },
    },
    asAbsolutePath: (p) => path.resolve(process.cwd(), p),
    extensionMode: 1, // Production
  };

  try {
    const result = mod.activate(ctx);
    if (result && typeof result.then === 'function') await result;
  } catch (e) {
    console.error('[smoke] FAIL activate() threw:', e);
    process.exit(1);
  }

  try { mod.deactivate(); } catch (e) {
    console.error('[smoke] FAIL deactivate() threw:', e);
    process.exit(1);
  }

  console.log(`[smoke] ok — bundle loaded, activate()/deactivate() ran. subscriptions registered: ${ctx.subscriptions.length}`);
}

main().catch((e) => {
  console.error('[smoke] FAIL', e);
  process.exit(1);
});
