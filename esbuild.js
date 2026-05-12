// ============================================================
// Production bundler for the VS Code extension entry point.
//
// Why bundle? VS Code loads `package.json:main` (= ./out/extension.js)
// at activation. Without bundling we'd have to ship the entire
// `node_modules/` tree (~117 MB, ~2600 files) inside the .vsix.
// With esbuild we collapse all runtime imports into a single
// minified file (~few hundred KB) and only `vscode` (provided
// by the host) stays external.
//
// Outputs:
//   - out/extension.js           (CJS bundle, entry point)
// Usage:
//   node esbuild.js              # one-shot dev bundle (sourcemaps, no minify)
//   node esbuild.js --production # minified, no sourcemaps  (used by `vscode:prepublish`)
//   node esbuild.js --watch      # watch mode for `npm run watch`
// ============================================================

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  format: 'cjs',
  platform: 'node',
  // VS Code 1.85 ships Node 18.x runtime. Match that to avoid
  // emitting syntax newer than what the host can run.
  target: 'node18',
  // The only thing the host provides at runtime; everything else
  // (including @modelcontextprotocol/sdk and its deps) gets bundled.
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  // Required because @modelcontextprotocol/sdk publishes ESM with
  // conditional exports; esbuild needs `mainFields` set so it
  // resolves the right entry point when bundling for CJS output.
  mainFields: ['module', 'main'],
  // The SDK is ESM; esbuild transpiles it down to CJS, but some
  // packages in the dep graph (e.g. eventsource-parser) use
  // top-level await / dynamic import. Suppress the warnings for
  // ones that are safe to ignore in bundled output.
  logLevel: 'info',
  logOverride: {
    'package.json': 'silent',
  },
  plugins: [
    {
      name: 'build-status',
      setup(build) {
        build.onStart(() => {
          if (watch) console.log('[bundle] rebuild started…');
        });
        build.onEnd((result) => {
          for (const err of result.errors) {
            const where = err.location
              ? ` at ${err.location.file}:${err.location.line}:${err.location.column}`
              : '';
            console.error(`[bundle]  ${err.text}${where}`);
          }
          for (const warn of result.warnings) {
            const where = warn.location
              ? ` at ${warn.location.file}:${warn.location.line}:${warn.location.column}`
              : '';
            console.warn(`[bundle]  ${warn.text}${where}`);
          }
          if (result.errors.length === 0) {
            console.log(`[bundle] ok (${production ? 'production' : 'development'})`);
          }
        });
      },
    },
  ],
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[bundle] watching src/ for changes (Ctrl+C to stop)');
  } else {
    await esbuild.build(buildOptions);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
