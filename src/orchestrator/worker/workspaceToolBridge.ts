import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Artifact } from '../../types';

const execFileAsync = promisify(execFile);

const DEFAULT_SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'out',
    'coverage',
    '.cache',
    '.turbo',
    '.next',
]);

const ALLOWED_HIDDEN_ROOT_DIRS = new Set([
    '.github',
    '.ai-orchestrator',
]);

const SENSITIVE_FILE_NAMES = new Set([
    '.env',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.pnpmrc',
    'id_rsa',
    'id_ed25519',
    'credentials',
    'credentials.json',
    'service-account.json',
    'serviceaccount.json',
    'firebase-adminsdk.json',
]);

const SENSITIVE_FILE_PATTERNS = [
    /^\.env\./i,
    /^secrets?(\.|$)/i,
    /\.(pem|key|p12|pfx|keystore)$/i,
];

const DEFAULT_MAX_READ_CHARS = 20_000;
const DEFAULT_MAX_WRITE_CHARS = 200_000;
const DEFAULT_MAX_LIST_RESULTS = 1_000;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const DEFAULT_MAX_COMMAND_OUTPUT_CHARS = 12_000;
const DEFAULT_MAX_BATCH_READ_FILES = 8;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

export interface WorkspaceToolRunner {
    getDefinitions(mode: WorkspaceToolMode): WorkspaceToolDefinition[];
    execute(
        name: string,
        args: Record<string, unknown>,
        mode: WorkspaceToolMode
    ): Promise<WorkspaceToolExecutionResult>;
}

export type WorkspaceToolMode = 'read' | 'write';

export interface WorkspaceToolBridgeOptions {
    workspaceRoot: string;
    maxReadChars?: number;
    maxWriteChars?: number;
    maxListResults?: number;
    maxSearchResults?: number;
    maxCommandOutputChars?: number;
    commandTimeoutMs?: number;
    allowCommandExecution?: boolean;
}

export interface WorkspaceToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
        };
    };
}

export interface WorkspaceToolExecutionResult {
    text: string;
    logs: string[];
    artifacts: Artifact[];
    modifiedFiles: string[];
}

export class WorkspaceToolBridge implements WorkspaceToolRunner {
    private readonly _workspaceRoot: string;
    private readonly _maxReadChars: number;
    private readonly _maxWriteChars: number;
    private readonly _maxListResults: number;
    private readonly _maxSearchResults: number;
    private readonly _maxCommandOutputChars: number;
    private readonly _commandTimeoutMs: number;
    private readonly _allowCommandExecution: boolean;

    constructor(options: WorkspaceToolBridgeOptions) {
        this._workspaceRoot = resolve(options.workspaceRoot);
        this._maxReadChars = options.maxReadChars ?? DEFAULT_MAX_READ_CHARS;
        this._maxWriteChars = options.maxWriteChars ?? DEFAULT_MAX_WRITE_CHARS;
        this._maxListResults = options.maxListResults ?? DEFAULT_MAX_LIST_RESULTS;
        this._maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
        this._maxCommandOutputChars = options.maxCommandOutputChars ?? DEFAULT_MAX_COMMAND_OUTPUT_CHARS;
        this._commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        this._allowCommandExecution = options.allowCommandExecution ?? false;
    }

    getDefinitions(mode: WorkspaceToolMode): WorkspaceToolDefinition[] {
        const definitions: WorkspaceToolDefinition[] = [
            this._definition('workspace_list_files', '列出工作区中匹配 glob 的文件路径。', {
                glob: { type: 'string', description: 'VS Code 风格的 glob，例如 **/*、src/**/*.ts。' },
                limit: { type: 'number', description: '最多返回多少个结果。' },
            }, ['glob']),
            this._definition('workspace_search_text', '在工作区文件中搜索文本。', {
                query: { type: 'string', description: '要搜索的文本。' },
                glob: { type: 'string', description: '可选 glob，用于限制搜索范围。' },
                limit: { type: 'number', description: '最多返回多少条命中。' },
                caseSensitive: { type: 'boolean', description: '是否区分大小写。' },
            }, ['query']),
            this._definition('workspace_read_file', '读取工作区中的文件内容。', {
                path: { type: 'string', description: '相对工作区根目录的路径。' },
                startLine: { type: 'number', description: '可选，起始行（1-based）。' },
                endLine: { type: 'number', description: '可选，结束行（1-based）。' },
            }, ['path']),
            this._definition('workspace_read_many_files', '一次读取多个工作区文件，适合先收集相关上下文。', {
                files: {
                    type: 'array',
                    description: `最多 ${DEFAULT_MAX_BATCH_READ_FILES} 个文件。每项包含 path，可选 startLine/endLine。`,
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: '相对工作区根目录的路径。' },
                            startLine: { type: 'number', description: '可选，起始行（1-based）。' },
                            endLine: { type: 'number', description: '可选，结束行（1-based）。' },
                        },
                        required: ['path'],
                        additionalProperties: false,
                    },
                },
                maxCharsPerFile: { type: 'number', description: '可选，每个文件最多返回多少字符。' },
            }, ['files']),
        ];

        if (mode === 'write') {
            definitions.push(
                this._definition('workspace_write_file', '写入整个文件内容。', {
                    path: { type: 'string', description: '相对工作区根目录的路径。' },
                    content: { type: 'string', description: '要写入的完整文件内容。' },
                }, ['path', 'content']),
                this._definition('workspace_replace_text', '在文件中替换指定文本。', {
                    path: { type: 'string', description: '相对工作区根目录的路径。' },
                    oldText: { type: 'string', description: '要被替换的原文。' },
                    newText: { type: 'string', description: '替换后的文本。' },
                    replaceAll: { type: 'boolean', description: '是否替换全部匹配。' },
                }, ['path', 'oldText', 'newText']),
                this._definition('workspace_replace_range', '按行号替换文件中的一段内容，适合精确修改代码。', {
                    path: { type: 'string', description: '相对工作区根目录的路径。' },
                    startLine: { type: 'number', description: '起始行（1-based，包含）。' },
                    endLine: { type: 'number', description: '结束行（1-based，包含）。' },
                    newText: { type: 'string', description: '替换后的文本，可包含多行。' },
                }, ['path', 'startLine', 'endLine', 'newText']),
                this._definition('workspace_delete_range', '按行号删除文件中的一段内容。', {
                    path: { type: 'string', description: '相对工作区根目录的路径。' },
                    startLine: { type: 'number', description: '起始行（1-based，包含）。' },
                    endLine: { type: 'number', description: '结束行（1-based，包含）。' },
                }, ['path', 'startLine', 'endLine']),
            );
            if (this._allowCommandExecution) {
                definitions.push(this._definition('workspace_run_command', '在工作区根目录运行命令。', {
                    command: { type: 'string', description: '可执行文件名或路径。' },
                    args: { type: 'array', items: { type: 'string' }, description: '命令参数。' },
                    cwd: { type: 'string', description: '可选，相对工作区根目录的子目录。' },
                }, ['command']));
            }
        }

        return definitions;
    }

    async execute(
        name: string,
        args: Record<string, unknown>,
        mode: WorkspaceToolMode
    ): Promise<WorkspaceToolExecutionResult> {
        try {
            switch (name) {
                case 'workspace_list_files':
                    return await this._listFiles(args);
                case 'workspace_search_text':
                    return await this._searchText(args);
                case 'workspace_read_file':
                    return await this._readFile(args);
                case 'workspace_read_many_files':
                    return await this._readManyFiles(args);
                case 'workspace_write_file':
                    if (mode !== 'write') return this._forbidden(name);
                    return await this._writeFile(args);
                case 'workspace_replace_text':
                    if (mode !== 'write') return this._forbidden(name);
                    return await this._replaceText(args);
                case 'workspace_replace_range':
                    if (mode !== 'write') return this._forbidden(name);
                    return await this._replaceRange(args);
                case 'workspace_delete_range':
                    if (mode !== 'write') return this._forbidden(name);
                    return await this._deleteRange(args);
                case 'workspace_run_command':
                    if (mode !== 'write' || !this._allowCommandExecution) return this._forbidden(name);
                    return await this._runCommand(args);
                default:
                    throw new Error(`未知工作区工具：${name}`);
            }
        } catch (error) {
            if (error instanceof WorkspaceToolAccessError) {
                return this._okResult(JSON.stringify({ ok: false, error: error.message }, null, 2));
            }
            throw error;
        }
    }

    private _definition(
        name: string,
        description: string,
        properties: Record<string, unknown>,
        required?: string[]
    ): WorkspaceToolDefinition {
        return {
            type: 'function',
            function: {
                name,
                description,
                parameters: {
                    type: 'object',
                    properties,
                    required,
                    additionalProperties: false,
                },
            },
        };
    }

    private _forbidden(name: string): WorkspaceToolExecutionResult {
        return this._okResult(`工具 ${name} 已被当前任务模式禁用。`, [], []);
    }

    private async _listFiles(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const glob = this._stringArg(args.glob, '**/*');
        const limit = this._numberArg(args.limit) ?? this._maxListResults;
        const matcher = globToRegExp(glob);
        const files: string[] = [];

        for await (const entry of this._walkWorkspace()) {
            if (entry.isDirectory) continue;
            if (!matcher.test(entry.relativePath)) continue;
            files.push(entry.relativePath);
            if (files.length >= limit) break;
        }

        return this._okResult(JSON.stringify({
            ok: true,
            glob,
            count: files.length,
            files,
            truncated: files.length >= limit,
        }, null, 2));
    }

    private async _searchText(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const query = this._stringArg(args.query);
        const glob = this._stringArg(args.glob, '**/*');
        const limit = this._numberArg(args.limit) ?? this._maxSearchResults;
        const caseSensitive = Boolean(args.caseSensitive);
        const matcher = globToRegExp(glob);
        const needle = caseSensitive ? query : query.toLowerCase();
        const matches: Array<{ path: string; line: number; text: string }> = [];

        for await (const entry of this._walkWorkspace()) {
            if (entry.isDirectory || !matcher.test(entry.relativePath)) continue;
            const text = await this._readUtf8(entry.absolutePath);
            if (text === undefined) continue;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
                if (!haystack.includes(needle)) continue;
                matches.push({ path: entry.relativePath, line: i + 1, text: lines[i] });
                if (matches.length >= limit) break;
            }
            if (matches.length >= limit) break;
        }

        return this._okResult(JSON.stringify({
            ok: true,
            query,
            glob,
            count: matches.length,
            matches,
            truncated: matches.length >= limit,
        }, null, 2));
    }

    private async _readFile(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const relPath = this._stringArg(args.path);
        return this._okResult(JSON.stringify(
            await this._readFilePayload(relPath, this._numberArg(args.startLine), this._numberArg(args.endLine), this._maxReadChars),
            null,
            2
        ));
    }

    private async _readManyFiles(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const rawFiles = Array.isArray(args.files) ? args.files : [];
        const requested = rawFiles.slice(0, DEFAULT_MAX_BATCH_READ_FILES);
        const maxCharsPerFile = Math.max(
            1,
            Math.min(this._numberArg(args.maxCharsPerFile) ?? Math.ceil(this._maxReadChars / Math.max(1, requested.length)), this._maxReadChars)
        );
        const files: Array<Record<string, unknown>> = [];

        for (const item of requested) {
            const spec = normalizeReadFileSpec(item);
            if (!spec.path) {
                files.push({ ok: false, path: '', error: '文件路径不能为空。' });
                continue;
            }
            try {
                files.push(await this._readFilePayload(spec.path, spec.startLine, spec.endLine, maxCharsPerFile));
            } catch (error) {
                if (error instanceof WorkspaceToolAccessError) {
                    files.push({ ok: false, path: spec.path, error: error.message });
                    continue;
                }
                throw error;
            }
        }

        return this._okResult(JSON.stringify({
            ok: true,
            count: files.length,
            maxFiles: DEFAULT_MAX_BATCH_READ_FILES,
            maxCharsPerFile,
            truncatedFiles: rawFiles.length > requested.length,
            files,
        }, null, 2));
    }

    private async _readFilePayload(
        relPath: string,
        startLine: number | undefined,
        endLine: number | undefined,
        maxChars: number
    ): Promise<Record<string, unknown>> {
        const absPath = this._resolvePath(relPath);
        const text = await this._readUtf8(absPath);
        if (text === undefined) {
            return { ok: false, path: relPath, error: '文件不存在或不是文本文件。' };
        }
        const lineData = sliceLines(text, startLine, endLine);
        const content = truncateText(lineData.text, maxChars);
        return {
            ok: true,
            path: relPath,
            lineCount: lineData.lineCount,
            startLine: lineData.startLine,
            endLine: lineData.endLine,
            truncated: content.length < lineData.text.length,
            content,
            numberedContent: addLineNumbers(content, lineData.startLine),
        };
    }

    private async _writeFile(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const relPath = this._stringArg(args.path);
        const content = this._stringArg(args.content, '');
        const sizeError = this._validateWriteSize(relPath, content);
        if (sizeError) return sizeError;
        const absPath = this._resolvePath(relPath);
        const previous = await this._readUtf8(absPath);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content, 'utf8');
        const artifacts = [createUnifiedDiffArtifact(relPath, previous ?? '', content)];
        return this._okResult(JSON.stringify({
            ok: true,
            path: relPath,
            bytesWritten: Buffer.byteLength(content, 'utf8'),
            truncated: content.length > this._maxReadChars,
        }, null, 2), artifacts, [relPath]);
    }

    private async _replaceText(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const relPath = this._stringArg(args.path);
        const oldText = this._stringArg(args.oldText);
        const newText = this._stringArg(args.newText, '');
        const replaceAll = Boolean(args.replaceAll);
        const absPath = this._resolvePath(relPath);
        const current = await this._readUtf8(absPath);
        if (current === undefined) {
            return this._okResult(JSON.stringify({ ok: false, path: relPath, error: '文件不存在或不是文本文件。' }, null, 2));
        }
        if (!oldText) {
            return this._okResult(JSON.stringify({ ok: false, path: relPath, error: 'oldText 不能为空。' }, null, 2));
        }
        const occurrences = current.split(oldText).length - 1;
        if (occurrences <= 0) {
            return this._okResult(JSON.stringify({ ok: false, path: relPath, error: '未找到要替换的文本。' }, null, 2));
        }
        const updated = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
        const sizeError = this._validateWriteSize(relPath, updated);
        if (sizeError) return sizeError;
        await writeFile(absPath, updated, 'utf8');
        const artifacts = [createUnifiedDiffArtifact(relPath, current, updated)];
        return this._okResult(JSON.stringify({
            ok: true,
            path: relPath,
            replacements: replaceAll ? occurrences : 1,
            truncated: updated.length > this._maxReadChars,
        }, null, 2), artifacts, [relPath]);
    }

    private async _replaceRange(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const relPath = this._stringArg(args.path);
        const startLine = this._numberArg(args.startLine);
        const endLine = this._numberArg(args.endLine);
        const newText = this._stringArg(args.newText, '');
        return await this._replaceRangeContent(relPath, startLine, endLine, newText);
    }

    private async _deleteRange(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const relPath = this._stringArg(args.path);
        const startLine = this._numberArg(args.startLine);
        const endLine = this._numberArg(args.endLine);
        return await this._replaceRangeContent(relPath, startLine, endLine, '', { deletedLines: endLine && startLine ? endLine - startLine + 1 : undefined });
    }

    private async _replaceRangeContent(
        relPath: string,
        startLine: number | undefined,
        endLine: number | undefined,
        newText: string,
        extraPayload: Record<string, unknown> = {}
    ): Promise<WorkspaceToolExecutionResult> {
        const absPath = this._resolvePath(relPath);
        const current = await this._readUtf8(absPath);
        if (current === undefined) {
            return this._okResult(JSON.stringify({ ok: false, path: relPath, error: '文件不存在或不是文本文件。' }, null, 2));
        }

        const lines = current.split(/\r?\n/);
        const maxLine = Math.max(1, lines.length);
        if (!startLine || !endLine || startLine < 1 || endLine < startLine || endLine > maxLine) {
            return this._okResult(JSON.stringify({
                ok: false,
                path: relPath,
                error: `行号范围无效，应满足 1 <= startLine <= endLine <= ${maxLine}。`,
            }, null, 2));
        }

        const replacementLines = newText.length === 0 ? [] : newText.split(/\r?\n/);
        lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
        const updated = lines.join('\n');
        const sizeError = this._validateWriteSize(relPath, updated);
        if (sizeError) return sizeError;
        await writeFile(absPath, updated, 'utf8');
        const artifacts = [createUnifiedDiffArtifact(relPath, current, updated)];
        return this._okResult(JSON.stringify({
            ok: true,
            path: relPath,
            startLine,
            endLine,
            insertedLines: replacementLines.length,
            truncated: updated.length > this._maxReadChars,
            ...extraPayload,
        }, null, 2), artifacts, [relPath]);
    }

    private async _runCommand(args: Record<string, unknown>): Promise<WorkspaceToolExecutionResult> {
        const command = this._stringArg(args.command);
        const commandArgs = Array.isArray(args.args)
            ? args.args.filter((item): item is string => typeof item === 'string')
            : [];
        const cwdArg = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : '';
        const cwd = cwdArg ? this._resolvePath(cwdArg) : this._workspaceRoot;

        try {
            const result = await execFileAsync(command, commandArgs, {
                cwd,
                timeout: this._commandTimeoutMs,
                maxBuffer: 1024 * 1024,
                shell: false,
            });
            const stdout = truncateText(result.stdout || '', this._maxCommandOutputChars);
            const stderr = truncateText(result.stderr || '', this._maxCommandOutputChars);
            return this._okResult(JSON.stringify({
                ok: true,
                command,
                args: commandArgs,
                cwd: relative(this._workspaceRoot, cwd) || '.',
                exitCode: 0,
                stdout,
                stderr,
            }, null, 2));
        } catch (error) {
            const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
            const stdout = truncateText(err.stdout || '', this._maxCommandOutputChars);
            const stderr = truncateText(err.stderr || '', this._maxCommandOutputChars);
            return this._okResult(JSON.stringify({
                ok: false,
                command,
                args: commandArgs,
                cwd: relative(this._workspaceRoot, cwd) || '.',
                exitCode: typeof err.code === 'number' ? err.code : -1,
                stdout,
                stderr,
                error: err.message || '命令执行失败',
            }, null, 2));
        }
    }

    private _okResult(text: string, artifacts: Artifact[] = [], modifiedFiles: string[] = []): WorkspaceToolExecutionResult {
        return {
            text,
            logs: [text],
            artifacts,
            modifiedFiles,
        };
    }

    private _stringArg(value: unknown, fallback = ''): string {
        if (typeof value === 'string') return value;
        return fallback;
    }

    private _numberArg(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    private _validateWriteSize(path: string, content: string): WorkspaceToolExecutionResult | undefined {
        if (content.length <= this._maxWriteChars) return undefined;
        return this._okResult(JSON.stringify({
            ok: false,
            path,
            error: `写入内容过大（${content.length} 字符），超过当前上限 ${this._maxWriteChars} 字符。请拆分任务或缩小修改范围。`,
        }, null, 2));
    }

    private _resolvePath(relPath: string): string {
        const normalized = normalizeWorkspacePath(relPath);
        const blockReason = getBlockedWorkspacePathReason(normalized);
        if (blockReason) {
            throw new WorkspaceToolAccessError(`安全策略已拒绝访问 ${normalized || '.'}：${blockReason}`);
        }
        const abs = resolve(this._workspaceRoot, normalized);
        const rootWithSep = this._workspaceRoot.endsWith(sep) ? this._workspaceRoot : `${this._workspaceRoot}${sep}`;
        if (abs !== this._workspaceRoot && !abs.startsWith(rootWithSep)) {
            throw new WorkspaceToolAccessError(`路径越界：${relPath}`);
        }
        return abs;
    }

    private async _readUtf8(absPath: string): Promise<string | undefined> {
        try {
            const buf = await readFile(absPath);
            if (buf.includes(0)) return undefined;
            return buf.toString('utf8');
        } catch {
            return undefined;
        }
    }

    private async *_walkWorkspace(): AsyncGenerator<{ absolutePath: string; relativePath: string; isDirectory: boolean }> {
        yield* this._walkDirectory(this._workspaceRoot, '');
    }

    private async *_walkDirectory(absDir: string, relDir: string): AsyncGenerator<{ absolutePath: string; relativePath: string; isDirectory: boolean }> {
        let entries;
        try {
            entries = await readdir(absDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const relPath = relDir ? join(relDir, entry.name) : entry.name;
            const normalized = relPath.split(sep).join('/');
            if (entry.isDirectory()) {
                if (shouldSkipDirectory(entry.name, relDir)) continue;
                yield { absolutePath: join(absDir, entry.name), relativePath: normalized, isDirectory: true };
                yield* this._walkDirectory(join(absDir, entry.name), relPath);
            } else if (entry.isFile()) {
                if (shouldSkipFile(normalized)) continue;
                yield { absolutePath: join(absDir, entry.name), relativePath: normalized, isDirectory: false };
            }
        }
    }
}

class WorkspaceToolAccessError extends Error { }

function shouldSkipDirectory(name: string, parentRel: string): boolean {
    if (DEFAULT_SKIP_DIRS.has(name)) return true;
    if (name.startsWith('.') && !ALLOWED_HIDDEN_ROOT_DIRS.has(name) && parentRel.length === 0) return true;
    return false;
}

function shouldSkipFile(relativePath: string): boolean {
    return Boolean(getBlockedWorkspacePathReason(relativePath));
}

function normalizeWorkspacePath(path: string): string {
    return path.replace(/^[\\/]+/, '').trim().split(/[\\/]+/).filter(Boolean).join('/');
}

function normalizeReadFileSpec(item: unknown): { path: string; startLine?: number; endLine?: number } {
    if (typeof item === 'string') {
        return { path: item };
    }
    if (item && typeof item === 'object') {
        const candidate = item as { path?: unknown; startLine?: unknown; endLine?: unknown };
        return {
            path: typeof candidate.path === 'string' ? candidate.path : '',
            startLine: typeof candidate.startLine === 'number' && Number.isFinite(candidate.startLine) ? candidate.startLine : undefined,
            endLine: typeof candidate.endLine === 'number' && Number.isFinite(candidate.endLine) ? candidate.endLine : undefined,
        };
    }
    return { path: '' };
}

function getBlockedWorkspacePathReason(relativePath: string): string | undefined {
    if (!relativePath) return undefined;
    const parts = relativePath.split('/');
    const first = parts[0];
    if (parts.some(part => DEFAULT_SKIP_DIRS.has(part))) {
        return '该路径位于依赖、构建产物、缓存或版本控制目录内。';
    }
    if (first.startsWith('.') && !ALLOWED_HIDDEN_ROOT_DIRS.has(first) && parts.length > 1) {
        return '该路径位于隐藏配置目录内。';
    }
    const baseName = parts[parts.length - 1].toLowerCase();
    if (SENSITIVE_FILE_NAMES.has(baseName)) {
        return '该文件看起来包含密钥、令牌或本地凭据。';
    }
    if (SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(baseName))) {
        return '该文件看起来包含密钥、证书或本地凭据。';
    }
    return undefined;
}

function truncateText(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function sliceLines(text: string, startLine?: number, endLine?: number): { text: string; lineCount: number; startLine: number; endLine: number } {
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, Math.max(start, endLine ?? lines.length));
    return {
        text: lines.slice(start - 1, end).join('\n'),
        lineCount: lines.length,
        startLine: start,
        endLine: end,
    };
}

function addLineNumbers(text: string, startLine: number): string {
    return text
        .split(/\r?\n/)
        .map((line, index) => `${startLine + index}: ${line}`)
        .join('\n');
}

function createUnifiedDiffArtifact(path: string, oldText: string, newText: string): Artifact {
    return {
        type: 'file',
        name: path,
        content: createUnifiedDiff(path, oldText, newText),
    };
}

function createUnifiedDiff(path: string, oldText: string, newText: string): string {
    const oldLines = splitForDiff(oldText);
    const newLines = splitForDiff(newText);
    const context = 3;
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix++;
    }

    const oldChangeStart = prefix;
    const oldChangeEnd = oldLines.length - suffix;
    const newChangeStart = prefix;
    const newChangeEnd = newLines.length - suffix;
    const oldStart = Math.max(0, oldChangeStart - context);
    const newStart = Math.max(0, newChangeStart - context);
    const oldEnd = Math.min(oldLines.length, oldChangeEnd + context);
    const newEnd = Math.min(newLines.length, newChangeEnd + context);
    const oldCount = oldEnd - oldStart;
    const newCount = newEnd - newStart;
    const oldLineNo = oldCount === 0 ? 0 : oldStart + 1;
    const newLineNo = newCount === 0 ? 0 : newStart + 1;

    const rows = [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -${oldLineNo},${oldCount} +${newLineNo},${newCount} @@`,
    ];
    for (let i = oldStart; i < oldChangeStart; i++) {
        rows.push(` ${oldLines[i]}`);
    }
    for (let i = oldChangeStart; i < oldChangeEnd; i++) {
        rows.push(`-${oldLines[i]}`);
    }
    for (let i = newChangeStart; i < newChangeEnd; i++) {
        rows.push(`+${newLines[i]}`);
    }
    for (let i = oldChangeEnd; i < oldEnd; i++) {
        rows.push(` ${oldLines[i]}`);
    }
    return rows.join('\n');
}

function splitForDiff(text: string): string[] {
    if (text.length === 0) return [];
    return text.replace(/\r\n/g, '\n').split('\n');
}

function globToRegExp(glob: string): RegExp {
    let pattern = '^';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        const next = glob[i + 1];
        if (ch === '*') {
            if (next === '*') {
                if (glob[i + 2] === '/') {
                    pattern += '(?:.*/)?';
                    i += 2;
                } else {
                    pattern += '.*';
                    i += 1;
                }
            } else {
                pattern += '[^/]*';
            }
            continue;
        }
        if (ch === '?') {
            pattern += '[^/]';
            continue;
        }
        if ('\\.^$+|()[]{}'.includes(ch)) {
            pattern += `\\${ch}`;
            continue;
        }
        if (ch === '/') {
            pattern += '[\\\\/]';
            continue;
        }
        pattern += ch;
    }
    pattern += '$';
    return new RegExp(pattern);
}
