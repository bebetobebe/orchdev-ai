import { Artifact } from '../../types';

/**
 * Extract fenced Markdown code blocks (```lang ... ```) from arbitrary text.
 *
 * - Matches blocks opened with 3 or more backticks so that nested ```` blocks survive.
 * - Language tag (if any) is used in the snippet name (`snippet-<lang>-<n>`).
 * - Blocks shorter than 2 lines are skipped to avoid tiny inline echoes.
 */
export function extractCodeBlocks(text: string): Artifact[] {
    if (!text) return [];
    const artifacts: Artifact[] = [];
    // Match fences of 3+ backticks; closing fence must have the same length.
    const fenceRe = /(^|\n)(`{3,})([^\n`]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
    let match: RegExpExecArray | null;
    let idx = 0;
    while ((match = fenceRe.exec(text)) !== null) {
        const lang = match[3].trim() || 'txt';
        const content = match[4];
        if (!content.trim() || content.split('\n').length < 2) continue;
        idx += 1;
        artifacts.push({
            type: 'snippet',
            name: `snippet-${lang}-${idx}`,
            content
        });
    }
    return artifacts;
}

/**
 * Extract unified-diff hunks anchored on `diff --git a/<path> b/<path>` headers.
 * Each hunk becomes a `file` artifact whose name is the b-side path and whose
 * content is the full diff text (header included). Non-diff lines between hunks
 * are discarded.
 */
export function extractDiffs(text: string): Artifact[] {
    if (!text) return [];
    const artifacts: Artifact[] = [];
    // Split on each 'diff --git ' header; first segment is pre-diff preamble.
    const parts = text.split(/(?=^diff --git )/m);
    for (const part of parts) {
        if (!part.startsWith('diff --git ')) continue;
        const firstLine = part.split('\n', 1)[0];
        // Expect: 'diff --git a/<path> b/<path>'
        const m = firstLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (!m) continue;
        artifacts.push({
            type: 'file',
            name: m[2],
            content: part.trimEnd()
        });
    }
    return artifacts;
}

/**
 * Convenience: pull both snippets and file-diffs out of one output blob.
 */
export function extractArtifacts(text: string): Artifact[] {
    return [...extractDiffs(text), ...extractCodeBlocks(text)];
}
