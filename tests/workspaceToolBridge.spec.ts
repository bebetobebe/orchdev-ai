import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceToolBridge } from '../src/orchestrator/worker/workspaceToolBridge';

async function makeWorkspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ai-dev-orchestrator-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\nconsole.log(alpha);\n', 'utf8');
    await writeFile(join(root, 'src', 'beta.ts'), 'export const beta = 2;\n', 'utf8');
    await writeFile(join(root, '.env'), 'API_KEY=secret\n', 'utf8');
    await writeFile(join(root, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n', 'utf8');
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n', 'utf8');
    return root;
}

describe('WorkspaceToolBridge', () => {
    let root = '';

    afterEach(async () => {
        if (root) {
            await rm(root, { recursive: true, force: true });
            root = '';
        }
    });

    it('reads, writes, and replaces file content', async () => {
        root = await makeWorkspace();
        const bridge = new WorkspaceToolBridge({ workspaceRoot: root, allowCommandExecution: false });

        const read = await bridge.execute('workspace_read_file', { path: 'src/alpha.ts' }, 'write');
        expect(JSON.parse(read.text)).toMatchObject({
            ok: true,
            path: 'src/alpha.ts',
        });
        expect(JSON.parse(read.text).numberedContent).toContain('1: export const alpha = 1;');

        const replaced = await bridge.execute('workspace_replace_text', {
            path: 'src/alpha.ts',
            oldText: 'alpha = 1',
            newText: 'alpha = 42',
        }, 'write');
        expect(JSON.parse(replaced.text)).toMatchObject({
            ok: true,
            path: 'src/alpha.ts',
            replacements: 1,
        });
        expect(replaced.artifacts[0]).toMatchObject({
            type: 'file',
            name: 'src/alpha.ts',
        });
        expect(replaced.artifacts[0].content).toContain('diff --git a/src/alpha.ts b/src/alpha.ts');
        expect(replaced.artifacts[0].content).toContain('-export const alpha = 1;');
        expect(replaced.artifacts[0].content).toContain('+export const alpha = 42;');

        const fileText = await readFile(join(root, 'src', 'alpha.ts'), 'utf8');
        expect(fileText).toContain('alpha = 42');

        const written = await bridge.execute('workspace_write_file', {
            path: 'src/gamma.ts',
            content: 'export const gamma = 3;\n',
        }, 'write');
        expect(JSON.parse(written.text)).toMatchObject({
            ok: true,
            path: 'src/gamma.ts',
        });
        expect(written.artifacts[0].content).toContain('diff --git a/src/gamma.ts b/src/gamma.ts');
        expect(written.artifacts[0].content).toContain('+export const gamma = 3;');
        expect(await readFile(join(root, 'src', 'gamma.ts'), 'utf8')).toContain('gamma = 3');

        const ranged = await bridge.execute('workspace_replace_range', {
            path: 'src/gamma.ts',
            startLine: 1,
            endLine: 1,
            newText: 'export const gamma = 7;\nexport const delta = 8;',
        }, 'write');
        expect(JSON.parse(ranged.text)).toMatchObject({
            ok: true,
            path: 'src/gamma.ts',
            startLine: 1,
            endLine: 1,
        });
        expect(await readFile(join(root, 'src', 'gamma.ts'), 'utf8')).toContain('export const gamma = 7;');
        expect(await readFile(join(root, 'src', 'gamma.ts'), 'utf8')).toContain('export const delta = 8;');

        const deletedViaReplace = await bridge.execute('workspace_replace_range', {
            path: 'src/gamma.ts',
            startLine: 2,
            endLine: 2,
            newText: '',
        }, 'write');
        expect(JSON.parse(deletedViaReplace.text)).toMatchObject({
            ok: true,
            path: 'src/gamma.ts',
            insertedLines: 0,
        });
        expect(await readFile(join(root, 'src', 'gamma.ts'), 'utf8')).toBe('export const gamma = 7;\n');

        const deletedRange = await bridge.execute('workspace_delete_range', {
            path: 'src/alpha.ts',
            startLine: 2,
            endLine: 2,
        }, 'write');
        expect(JSON.parse(deletedRange.text)).toMatchObject({
            ok: true,
            path: 'src/alpha.ts',
            deletedLines: 1,
            insertedLines: 0,
        });
        expect(await readFile(join(root, 'src', 'alpha.ts'), 'utf8')).toBe('export const alpha = 42;\n');
    });

    it('lists and searches files with glob filtering', async () => {
        root = await makeWorkspace();
        const bridge = new WorkspaceToolBridge({ workspaceRoot: root });

        const list = await bridge.execute('workspace_list_files', { glob: 'src/**/*.ts' }, 'read');
        const listPayload = JSON.parse(list.text);
        expect(listPayload.files).toEqual(expect.arrayContaining(['src/alpha.ts', 'src/beta.ts']));

        const search = await bridge.execute('workspace_search_text', { query: 'console.log', glob: 'src/**/*.ts' }, 'read');
        const searchPayload = JSON.parse(search.text);
        expect(searchPayload.matches[0]).toMatchObject({
            path: 'src/alpha.ts',
            line: 2,
        });
    });

    it('reads multiple files in one safe batch', async () => {
        root = await makeWorkspace();
        const bridge = new WorkspaceToolBridge({ workspaceRoot: root, maxReadChars: 40 });

        const result = await bridge.execute('workspace_read_many_files', {
            files: [
                'src/alpha.ts',
                { path: 'src/beta.ts', startLine: 1, endLine: 1 },
                '.env',
            ],
            maxCharsPerFile: 80,
        }, 'read');

        const payload = JSON.parse(result.text);
        expect(payload).toMatchObject({
            ok: true,
            count: 3,
            maxFiles: 8,
            maxCharsPerFile: 40,
        });
        expect(payload.files[0]).toMatchObject({
            ok: true,
            path: 'src/alpha.ts',
            startLine: 1,
        });
        expect(payload.files[0].numberedContent).toContain('1: export const alpha = 1;');
        expect(payload.files[1]).toMatchObject({
            ok: true,
            path: 'src/beta.ts',
            startLine: 1,
            endLine: 1,
        });
        expect(payload.files[2]).toMatchObject({
            ok: false,
            path: '.env',
        });
        expect(payload.files[2].error).toContain('安全策略已拒绝访问');
    });

    it('only exposes command execution when enabled', async () => {
        root = await makeWorkspace();
        const readOnlyBridge = new WorkspaceToolBridge({ workspaceRoot: root, allowCommandExecution: false });
        const fullBridge = new WorkspaceToolBridge({ workspaceRoot: root, allowCommandExecution: true });

        expect(readOnlyBridge.getDefinitions('write').some(def => def.function.name === 'workspace_run_command')).toBe(false);
        expect(readOnlyBridge.getDefinitions('write').some(def => def.function.name === 'workspace_delete_range')).toBe(true);
        expect(fullBridge.getDefinitions('write').some(def => def.function.name === 'workspace_run_command')).toBe(true);
    });

    it('blocks access to sensitive files and dependency/control directories', async () => {
        root = await makeWorkspace();
        const bridge = new WorkspaceToolBridge({ workspaceRoot: root, allowCommandExecution: false });

        const envRead = await bridge.execute('workspace_read_file', { path: '.env' }, 'read');
        expect(JSON.parse(envRead.text)).toMatchObject({
            ok: false,
        });
        expect(envRead.text).toContain('安全策略已拒绝访问');

        const gitWrite = await bridge.execute('workspace_write_file', {
            path: '.git/config',
            content: 'forbidden',
        }, 'write');
        expect(JSON.parse(gitWrite.text)).toMatchObject({
            ok: false,
        });
        expect(gitWrite.text).toContain('安全策略已拒绝访问');

        const depRead = await bridge.execute('workspace_read_file', { path: 'node_modules/pkg/index.js' }, 'read');
        expect(JSON.parse(depRead.text)).toMatchObject({
            ok: false,
        });
        expect(depRead.text).toContain('安全策略已拒绝访问');

        const list = await bridge.execute('workspace_list_files', { glob: '**/*' }, 'read');
        const payload = JSON.parse(list.text);
        expect(payload.files).not.toContain('.env');
        expect(payload.files).not.toContain('.git/config');
        expect(payload.files).not.toContain('node_modules/pkg/index.js');
    });

    it('allows the self-check output directory but keeps other hidden directories blocked', async () => {
        root = await makeWorkspace();
        const bridge = new WorkspaceToolBridge({ workspaceRoot: root, allowCommandExecution: false });

        const selfCheck = await bridge.execute('workspace_write_file', {
            path: '.ai-orchestrator/self-check.md',
            content: '# 安全自检\n\n已完成。\n',
        }, 'write');

        expect(JSON.parse(selfCheck.text)).toMatchObject({
            ok: true,
            path: '.ai-orchestrator/self-check.md',
        });
        expect(selfCheck.modifiedFiles).toEqual(['.ai-orchestrator/self-check.md']);
        expect(await readFile(join(root, '.ai-orchestrator', 'self-check.md'), 'utf8')).toContain('安全自检');

        const blockedHiddenDir = await bridge.execute('workspace_write_file', {
            path: '.vscode/settings.json',
            content: '{}\n',
        }, 'write');
        expect(JSON.parse(blockedHiddenDir.text)).toMatchObject({ ok: false });
        expect(blockedHiddenDir.text).toContain('隐藏配置目录');
    });

    it('rejects oversized writes before touching the file', async () => {
        root = await makeWorkspace();
        const bridge = new WorkspaceToolBridge({ workspaceRoot: root, maxWriteChars: 10 });

        const result = await bridge.execute('workspace_write_file', {
            path: 'src/large.ts',
            content: 'export const tooLarge = true;\n',
        }, 'write');

        expect(JSON.parse(result.text)).toMatchObject({
            ok: false,
            path: 'src/large.ts',
        });
        expect(result.text).toContain('写入内容过大');
        await expect(readFile(join(root, 'src', 'large.ts'), 'utf8')).rejects.toThrow();
    });
});
