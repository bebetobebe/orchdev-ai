/**
 * Extension-wide display strings.
 *
 * Edit this file (and the matching `package.json` fields below) before
 * publishing your white-labelled .vsix. Keeping the strings here means the
 * runtime UI (webview tab title, HTML <title>, etc.) all flips at once when
 * you change `extensionDisplayName`.
 *
 * STATIC METADATA THAT CANNOT BE READ AT RUNTIME — must be edited manually
 * in `package.json` before publishing because the VS Code marketplace and
 * activity bar render them from the manifest, not from runtime code:
 *   - `displayName`
 *   - `contributes.commands[*].title`
 *   - `contributes.viewsContainers.activitybar[*].title`
 *   - `contributes.views[*][*].name`
 *   - `contributes.configuration.title`
 *
 * See `RELAY_CONFIG.brandName` in `relayConfig.ts` for the *separate*
 * label shown on the bundled HTTP relay worker (it's intentionally a
 * different string so multi-product publishers can keep extension brand
 * and relay-worker brand distinct).
 */
export const BRAND = {
    /**
     * Title used for the webview panel tab and the in-webview <title>.
     * Should match `package.json:displayName` for a consistent look across
     * the activity bar, settings page, and the panel itself.
     */
    extensionDisplayName: 'OrchDev AI',
} as const;
