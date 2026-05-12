import { describe, it, expect } from 'vitest';
import {
    extractCodeBlocks,
    extractDiffs,
    extractArtifacts
} from '../src/orchestrator/worker/outputParser';

describe('extractCodeBlocks', () => {
    it('returns empty for empty or whitespace input', () => {
        expect(extractCodeBlocks('')).toEqual([]);
        expect(extractCodeBlocks('   \n\n')).toEqual([]);
    });

    it('captures a single fenced block with language tag', () => {
        const text = [
            'Here is the fn:',
            '',
            '```ts',
            'export function add(a: number, b: number) {',
            '  return a + b;',
            '}',
            '```'
        ].join('\n');

        const arts = extractCodeBlocks(text);
        expect(arts).toHaveLength(1);
        expect(arts[0].type).toBe('snippet');
        expect(arts[0].name).toBe('snippet-ts-1');
        expect(arts[0].content).toContain('export function add');
        expect(arts[0].content).toContain('return a + b');
    });

    it('numbers multiple blocks sequentially and preserves language', () => {
        const text = [
            '```ts',
            'const a = 1;',
            'const b = 2;',
            '```',
            '',
            'Then:',
            '',
            '```py',
            'def f():',
            '    pass',
            '```'
        ].join('\n');

        const arts = extractCodeBlocks(text);
        expect(arts.map(a => a.name)).toEqual(['snippet-ts-1', 'snippet-py-2']);
    });

    it('skips single-line blocks to avoid tiny echoes', () => {
        const text = '```\necho hi\n```';
        expect(extractCodeBlocks(text)).toEqual([]);
    });

    it('falls back to language "txt" when no tag is given', () => {
        const text = '```\nline one\nline two\n```';
        const arts = extractCodeBlocks(text);
        expect(arts).toHaveLength(1);
        expect(arts[0].name).toBe('snippet-txt-1');
    });

    it('handles 4-backtick openers so inner ``` survives', () => {
        const text = [
            '````md',
            'Here is inline ```ts code``` in markdown.',
            'Second line.',
            '````'
        ].join('\n');

        const arts = extractCodeBlocks(text);
        expect(arts).toHaveLength(1);
        expect(arts[0].name).toBe('snippet-md-1');
        expect(arts[0].content).toContain('```ts code```');
    });
});

describe('extractDiffs', () => {
    it('returns empty when no `diff --git` header exists', () => {
        expect(extractDiffs('just a bunch of prose')).toEqual([]);
        expect(extractDiffs('')).toEqual([]);
    });

    it('extracts a single unified diff with b-side path as name', () => {
        const text = [
            'diff --git a/src/foo.ts b/src/foo.ts',
            'index 1234..5678 100644',
            '--- a/src/foo.ts',
            '+++ b/src/foo.ts',
            '@@ -1,3 +1,4 @@',
            ' export function foo() {',
            '-  return 1;',
            '+  return 2;',
            ' }',
            '+// added'
        ].join('\n');

        const arts = extractDiffs(text);
        expect(arts).toHaveLength(1);
        expect(arts[0].type).toBe('file');
        expect(arts[0].name).toBe('src/foo.ts');
        expect(arts[0].content).toMatch(/^diff --git a\/src\/foo\.ts/);
        expect(arts[0].content).toContain('+// added');
    });

    it('splits multiple diffs and discards preamble before the first header', () => {
        const text = [
            'Applied 2 file changes:',
            'diff --git a/src/foo.ts b/src/foo.ts',
            '--- a/src/foo.ts',
            '+++ b/src/foo.ts',
            '@@ -1,1 +1,1 @@',
            '-a',
            '+b',
            'diff --git a/README.md b/README.md',
            '--- a/README.md',
            '+++ b/README.md',
            '@@ -1,1 +1,2 @@',
            ' # Project',
            '+Added line.'
        ].join('\n');

        const arts = extractDiffs(text);
        expect(arts).toHaveLength(2);
        expect(arts.map(a => a.name)).toEqual(['src/foo.ts', 'README.md']);
        // Preamble "Applied 2 file changes" must NOT leak into first diff
        expect(arts[0].content.startsWith('diff --git')).toBe(true);
    });

    it('ignores malformed diff headers', () => {
        const text = 'diff --git weird-header-no-paths\n@@ -1 +1 @@\n-a\n+b';
        expect(extractDiffs(text)).toEqual([]);
    });
});

describe('extractArtifacts', () => {
    it('returns diffs first then code blocks for mixed output', () => {
        const text = [
            '```ts',
            'const x = 1;',
            'const y = 2;',
            '```',
            '',
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new'
        ].join('\n');

        const arts = extractArtifacts(text);
        expect(arts.map(a => ({ type: a.type, name: a.name }))).toEqual([
            { type: 'file', name: 'a.ts' },
            { type: 'snippet', name: 'snippet-ts-1' }
        ]);
    });

    it('is empty for empty input', () => {
        expect(extractArtifacts('')).toEqual([]);
    });
});
