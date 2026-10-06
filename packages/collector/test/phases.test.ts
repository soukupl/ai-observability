import { describe, expect, it } from 'vitest';
import { attributeTime, checkKind, classify, classifyCommand, isDocumentationPath, toPhasesMs, type TimelineEntry } from '../src/analysis/phases.js';

describe('classify (tools)', () => {
  it.each([
    ['Read', {}, 'exploring'],
    ['Grep', {}, 'exploring'],
    ['Glob', {}, 'exploring'],
    ['LS', {}, 'exploring'],
    ['WebSearch', {}, 'exploring'],
    ['WebFetch', {}, 'exploring'],
    ['web_search', {}, 'exploring'],
    ['Edit', { filePaths: ['src/app.ts'] }, 'coding'],
    ['MultiEdit', { filePaths: ['src/a.ts', 'README.md'] }, 'coding'],
    ['Write', { filePaths: ['docs/guide.md'] }, 'documenting'],
    ['Edit', { filePaths: ['README.md'] }, 'documenting'],
    ['Edit', { filePaths: ['CHANGELOG'] }, 'documenting'],
    ['apply_patch', { filePaths: ['notes.txt', 'docs/x/y.ts'] }, 'documenting'],
    ['apply_patch', {}, 'coding'],
    ['NotebookEdit', { filePaths: ['a.ipynb'] }, 'coding'],
    ['Task', {}, 'delegating'],
    ['Agent', {}, 'delegating'],
    ['spawn_agent', {}, 'delegating'],
    ['mcp__github__create_issue', {}, 'other'],
    ['TodoWrite', {}, 'other'],
    ['update_plan', {}, 'other'],
    ['Bash', { command: 'npm test' }, 'testing'],
    ['shell', { command: ['bash', '-lc', 'cargo test --all'] }, 'testing'],
    ['exec_command', { command: 'pnpm tsc --noEmit' }, 'validating'],
    ['Bash', {}, 'other'],
  ] as const)('%s %j → %s', (tool, info, phase) => {
    expect(classify(tool, info)).toBe(phase);
  });
});

describe('classifyCommand (shell)', () => {
  it.each([
    ['npm test', 'testing'],
    ['npm run test -- --watch=false', 'testing'],
    ['pnpm test:unit', 'testing'],
    ['pnpm --filter ai-obs test', 'testing'],
    ['pnpm vitest run --project collector', 'testing'],
    ['npx vitest run', 'testing'],
    ['npx jest src', 'testing'],
    ['yarn test', 'testing'],
    ['bun test', 'testing'],
    ['pytest -q tests/', 'testing'],
    ['python -m pytest', 'testing'],
    ['uv run pytest', 'testing'],
    ['go test ./...', 'testing'],
    ['cargo test', 'testing'],
    ['xcodebuild -scheme App test', 'testing'],
    ['swift test', 'testing'],
    ['./gradlew test', 'testing'],
    ['mvn -q test', 'testing'],
    ['dotnet test', 'testing'],
    ['cd packages/db && CI=1 npm test', 'testing'],
    ['eslint .', 'validating'],
    ['npx tsc --noEmit', 'validating'],
    ['tsc -p .', 'validating'],
    ['pnpm typecheck', 'validating'],
    ['npm run build', 'validating'],
    ['pnpm lint', 'validating'],
    ['cargo check', 'validating'],
    ['cargo clippy -- -D warnings', 'validating'],
    ['swift build', 'validating'],
    ['go vet ./...', 'validating'],
    ['ruff check .', 'validating'],
    ['mypy src', 'validating'],
    ['next build', 'validating'],
    ['xcodebuild -scheme App build', 'validating'],
    ['cat package.json', 'exploring'],
    ['rg -n "foo" src', 'exploring'],
    ['find . -name "*.ts" | head', 'exploring'],
    ['ls -la', 'exploring'],
    ['sed -n 1,40p file.ts', 'exploring'],
    ['grep -r TODO src | wc -l', 'exploring'],
    ['sed -i "" s/a/b/ f.ts', 'coding'],
    ['git status', 'other'],
    ['git diff HEAD~1', 'other'],
    ['npm install', 'other'],
    ['pnpm add zod', 'other'],
    ['docker compose up -d', 'other'],
    ['echo hello', 'other'],
    ['npm test && npm run lint', 'testing'],
    ['FOO=1 sudo pytest', 'testing'],
  ] as const)('%s → %s', (cmd, phase) => {
    expect(classifyCommand(cmd)).toBe(phase);
  });

  it('checkKind only for test / validate commands', () => {
    expect(checkKind('npm test')).toBe('testing');
    expect(checkKind('tsc')).toBe('validating');
    expect(checkKind('ls')).toBeNull();
  });

  it('documentation paths', () => {
    expect(isDocumentationPath('docs/adr/0001.md')).toBe(true);
    expect(isDocumentationPath('packages/x/README')).toBe(true);
    expect(isDocumentationPath('C:\\repo\\doc\\a.ts')).toBe(true);
    expect(isDocumentationPath('src/readme-parser.ts')).toBe(false);
    expect(isDocumentationPath('src/index.ts')).toBe(false);
  });
});

describe('attributeTime', () => {
  const s = (x: number) => x * 1000;

  it('assigns tool time, generation before a tool call, and trailing thinking', () => {
    const t: TimelineEntry[] = [
      { at: s(0), type: 'prompt' },
      { at: s(2), type: 'output' }, // 2 s thinking
      { at: s(5), type: 'tool_call', id: 'a', phase: 'exploring' }, // 3 s generation → exploring
      { at: s(6), type: 'tool_result', id: 'a' }, // 1 s exploring
      { at: s(16), type: 'tool_call', id: 'b', phase: 'coding' }, // 10 s → coding
      { at: s(17), type: 'tool_result', id: 'b' }, // 1 s coding
      { at: s(18), type: 'tool_call', id: 'c', phase: 'testing' }, // 1 s → testing
      { at: s(48), type: 'tool_result', id: 'c' }, // 30 s testing
      { at: s(50), type: 'output' }, // 2 s thinking (final answer)
    ];
    const r = attributeTime(t, s(51)); // +1 s trailing thinking
    expect(r).toMatchObject({ thinking: s(5), exploring: s(4), coding: s(11), testing: s(31), delegating: 0 });
  });

  it('counts waiting for sub-agents as delegating, which the wire format drops', () => {
    const t: TimelineEntry[] = [
      { at: s(0), type: 'prompt' },
      { at: s(1), type: 'tool_call', id: 'x', phase: 'delegating' },
      { at: s(2), type: 'tool_call', id: 'y', phase: 'exploring' },
      { at: s(60), type: 'tool_result', id: 'y' },
      { at: s(90), type: 'tool_result', id: 'x' },
      { at: s(91), type: 'output' },
    ];
    const r = attributeTime(t);
    expect(r.delegating).toBe(s(1) + s(58) + s(30));
    expect(r.exploring).toBe(s(1));
    expect(r.thinking).toBe(s(1));
    const wire = toPhasesMs(r);
    expect(wire).toEqual({ thinking: 1000, exploring: 1000 });
    expect('delegating' in wire).toBe(false);
  });

  it('ignores out-of-order timestamps', () => {
    const r = attributeTime([
      { at: 5000, type: 'prompt' },
      { at: 4000, type: 'output' },
      { at: 6000, type: 'output' },
    ]);
    expect(r.thinking).toBe(2000);
  });
});
