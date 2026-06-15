import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDirectExecution,
  runCreateIssueTool,
  runCreateBranchTool,
  runRunTestsTool,
  runCommitAndPushTool,
  runCreatePRTool,
  runGetPRReviewSummaryTool,
  runRunWorkflowTool,
} from './server.js';

// --- isDirectExecution ---

test('isDirectExecution returns false when argv1 is null', () => {
  assert.equal(isDirectExecution(null, import.meta.url), false);
});

test('isDirectExecution returns false when invoked as a module', () => {
  assert.equal(isDirectExecution('/some/other/entry.js', import.meta.url), false);
});

// --- create_issue ---

test('runCreateIssueTool returns issue URL and number', async () => {
  const result = await runCreateIssueTool(
    { title: 'Login button broken', body: 'Clicking login does nothing.', labels: ['bug'] },
    {
      token: 'tok', owner: 'org', repo: 'repo',
      _listLabels: async () => [{ name: 'bug' }, { name: 'enhancement' }],
      _createIssue: async () => ({
        number: 3,
        html_url: 'https://github.com/org/repo/issues/3',
        title: 'Login button broken',
        labels: [{ name: 'bug' }],
      }),
    },
  );

  assert.ok(result.content[0].text.includes('#3'));
  assert.equal(result.structuredContent.number, 3);
  assert.deepEqual(result.structuredContent.labels, ['bug']);
});

test('runCreateIssueTool works without body or labels', async () => {
  const result = await runCreateIssueTool(
    { title: 'Improve docs' },
    {
      token: 'tok', owner: 'org', repo: 'repo',
      _createIssue: async (owner, repo, title, body, labels) => {
        assert.equal(body, '');
        assert.deepEqual(labels, []);
        return { number: 7, html_url: 'https://github.com/org/repo/issues/7', title, labels: [] };
      },
    },
  );

  assert.equal(result.structuredContent.number, 7);
  assert.deepEqual(result.structuredContent.labels, []);
});

test('runCreateIssueTool rejects non-existent labels and lists available ones', async () => {
  const result = await runCreateIssueTool(
    { title: 'Test', labels: ['bug', '없는라벨'] },
    {
      token: 'tok', owner: 'org', repo: 'repo',
      _listLabels: async () => [{ name: 'bug' }, { name: 'enhancement' }],
      _createIssue: async () => { throw new Error('should not be called'); },
    },
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('"없는라벨"'));
  assert.ok(result.content[0].text.includes('bug'));
  assert.ok(result.content[0].text.includes('enhancement'));
});

test('runCreateIssueTool skips label check when no labels provided', async () => {
  let labelCheckCalled = false;
  const result = await runCreateIssueTool(
    { title: 'No label issue' },
    {
      token: 'tok', owner: 'org', repo: 'repo',
      _listLabels: async () => { labelCheckCalled = true; return []; },
      _createIssue: async () => ({ number: 1, html_url: 'https://github.com/org/repo/issues/1', title: 'No label issue', labels: [] }),
    },
  );

  assert.equal(labelCheckCalled, false);
  assert.equal(result.structuredContent.number, 1);
});

test('runCreateIssueTool passes multiple labels', async () => {
  let capturedLabels;
  await runCreateIssueTool(
    { title: 'New feature', labels: ['enhancement', 'good first issue'] },
    {
      token: 'tok', owner: 'org', repo: 'repo',
      _listLabels: async () => [{ name: 'enhancement' }, { name: 'good first issue' }],
      _createIssue: async (owner, repo, title, body, labels) => {
        capturedLabels = labels;
        return { number: 9, html_url: 'https://github.com/org/repo/issues/9', title, labels: labels.map(n => ({ name: n })) };
      },
    },
  );

  assert.deepEqual(capturedLabels, ['enhancement', 'good first issue']);
});

// --- create_branch ---

test('runCreateBranchTool creates branch and returns structured content', async () => {
  const result = await runCreateBranchTool(
    { name: 'feature/login' },
    {
      token: 'tok', owner: 'org', repo: 'repo', defaultBase: 'main',
      _getBranchSha: async () => 'sha-abc',
      _createBranch: async () => {},
    },
  );

  assert.ok(result.content[0].text.includes('feature/login'));
  assert.equal(result.structuredContent.branch, 'feature/login');
  assert.equal(result.structuredContent.base, 'main');
  assert.equal(result.structuredContent.sha, 'sha-abc');
});

test('runCreateBranchTool uses provided base branch', async () => {
  const result = await runCreateBranchTool(
    { name: 'hotfix/x', base: 'develop' },
    {
      token: 'tok', owner: 'org', repo: 'repo', defaultBase: 'main',
      _getBranchSha: async (owner, repo, base) => `sha-${base}`,
      _createBranch: async () => {},
    },
  );

  assert.equal(result.structuredContent.base, 'develop');
  assert.equal(result.structuredContent.sha, 'sha-develop');
});

// --- run_tests ---

test('runRunTestsTool returns PASS for passing tests', async () => {
  const result = await runRunTestsTool(
    { command: 'npm test' },
    {
      repoPath: '/tmp',
      _runTests: async () => ({ pass: true, output: 'All tests passed', exitCode: 0 }),
      _validateTestCommand: () => {},
    },
  );

  assert.ok(result.content[0].text.includes('PASS'));
  assert.equal(result.structuredContent.pass, true);
  assert.equal(result.structuredContent.exitCode, 0);
});

test('runRunTestsTool returns FAIL for failing tests', async () => {
  const result = await runRunTestsTool(
    { command: 'npm test' },
    {
      repoPath: '/tmp',
      _runTests: async () => ({ pass: false, output: 'AssertionError: 1 !== 2', exitCode: 1 }),
      _validateTestCommand: () => {},
    },
  );

  assert.ok(result.content[0].text.includes('FAIL'));
  assert.equal(result.structuredContent.pass, false);
  assert.ok(result.content[0].text.includes('AssertionError'));
});

test('runRunTestsTool rejects disallowed commands', async () => {
  await assert.rejects(
    () => runRunTestsTool(
      { command: 'rm -rf /' },
      {
        repoPath: '/tmp',
        _runTests: async () => {},
      },
    ),
    /not allowed/,
  );
});

test('runRunTestsTool defaults to npm test when no command provided', async () => {
  let usedCommand;
  await runRunTestsTool(
    {},
    {
      repoPath: '/tmp',
      _runTests: async (cmd) => { usedCommand = cmd; return { pass: true, output: '', exitCode: 0 }; },
      _validateTestCommand: () => {},
    },
  );
  assert.equal(usedCommand, 'npm test');
});

// --- commit_and_push ---

test('runCommitAndPushTool calls commitAndPush and returns success', async () => {
  const calls = [];
  const result = await runCommitAndPushTool(
    { message: 'feat: add login', files: ['src/login.js'] },
    {
      repoPath: '/repo',
      _commitAndPush: (...args) => calls.push(args),
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/repo');
  assert.equal(calls[0][1], 'feat: add login');
  assert.deepEqual(calls[0][2], ['src/login.js']);
  assert.ok(result.content[0].text.includes('feat: add login'));
});

test('runCommitAndPushTool defaults files to ["."]', async () => {
  const calls = [];
  const result = await runCommitAndPushTool(
    { message: 'chore: update' },
    {
      repoPath: '/repo',
      _commitAndPush: (...args) => calls.push(args),
    },
  );

  assert.equal(result.structuredContent.files[0], '.');
});

// --- create_pr ---

test('runCreatePRTool returns PR URL and number', async () => {
  const result = await runCreatePRTool(
    { title: 'Add login', body: 'Adds login feature', branch: 'feature/login' },
    {
      token: 'tok', owner: 'org', repo: 'repo', defaultBase: 'main',
      _createPR: async () => ({ number: 42, html_url: 'https://github.com/org/repo/pull/42', title: 'Add login' }),
    },
  );

  assert.ok(result.content[0].text.includes('#42'));
  assert.equal(result.structuredContent.number, 42);
  assert.equal(result.structuredContent.url, 'https://github.com/org/repo/pull/42');
});

test('runCreatePRTool uses custom base branch', async () => {
  let capturedBase;
  await runCreatePRTool(
    { title: 'fix', body: 'fix', branch: 'hotfix/x', base: 'develop' },
    {
      token: 'tok', owner: 'org', repo: 'repo', defaultBase: 'main',
      _createPR: async (owner, repo, title, body, branch, base) => {
        capturedBase = base;
        return { number: 1, html_url: 'https://github.com/org/repo/pull/1', title: 'fix' };
      },
    },
  );
  assert.equal(capturedBase, 'develop');
});

// --- get_pr_review_summary ---

test('runGetPRReviewSummaryTool returns review counts', async () => {
  const result = await runGetPRReviewSummaryTool(
    { pr_url: 'https://github.com/org/repo/pull/7' },
    {
      token: 'tok', owner: 'org', repo: 'repo',
      _getPRReviews: async () => [
        { state: 'APPROVED' },
        { state: 'CHANGES_REQUESTED' },
      ],
      _getPRComments: async () => [
        { path: 'src/login.js', line: 10, body: 'Consider using const.' },
      ],
      _parsePRNumber: (url) => 7,
    },
  );

  assert.ok(result.content[0].text.includes('Approved: 1'));
  assert.ok(result.content[0].text.includes('Changes requested: 1'));
  assert.equal(result.structuredContent.approved, 1);
  assert.equal(result.structuredContent.changesRequested, 1);
  assert.equal(result.structuredContent.commentCount, 1);
});

// --- run_workflow ---

function makeWorkflowCtx(overrides = {}) {
  return {
    token: 'tok', owner: 'org', repo: 'repo',
    repoPath: '/repo', defaultBase: 'main',
    _anthropicClient: {},
    _getBranchSha: async () => 'sha-main',
    _createBranch: async () => {},
    _buildRepoContext: async () => 'repo context',
    _generateCodeChanges: async () => ({ files: [{ path: 'src/foo.js', content: 'export const x = 1;' }], explanation: 'done' }),
    _applyFileChanges: async () => {},
    _runTests: async () => ({ pass: true, output: 'ok', exitCode: 0 }),
    _commitAndPush: () => {},
    _createPR: async () => ({ number: 5, html_url: 'https://github.com/org/repo/pull/5', title: 'task' }),
    _generateBranchName: (task) => `feature/${task.replace(/\s+/g, '-')}`,
    ...overrides,
  };
}

test('runRunWorkflowTool completes full workflow and returns PR URL', async () => {
  const result = await runRunWorkflowTool({ task: 'add greeting function' }, makeWorkflowCtx());

  assert.ok(result.structuredContent.pr_url.includes('/pull/5'));
  assert.equal(result.structuredContent.tests_passed, true);
  assert.equal(result.structuredContent.pr_number, 5);
});

test('runRunWorkflowTool uses provided branch_name', async () => {
  let createdBranch;
  const ctx = makeWorkflowCtx({
    _createBranch: async (owner, repo, name) => { createdBranch = name; },
  });

  await runRunWorkflowTool({ task: 'fix bug', branch_name: 'hotfix/my-bug' }, ctx);
  assert.equal(createdBranch, 'hotfix/my-bug');
});

test('runRunWorkflowTool retries up to 3 times when tests fail then pass', async () => {
  let attempt = 0;
  const ctx = makeWorkflowCtx({
    _runTests: async () => {
      attempt++;
      return attempt < 3
        ? { pass: false, output: 'test error', exitCode: 1 }
        : { pass: true, output: 'ok', exitCode: 0 };
    },
  });

  const result = await runRunWorkflowTool({ task: 'add feature' }, ctx);
  assert.equal(result.structuredContent.tests_passed, true);
  assert.equal(attempt, 3);
});

test('runRunWorkflowTool proceeds after max attempts even if tests fail', async () => {
  const ctx = makeWorkflowCtx({
    _runTests: async () => ({ pass: false, output: 'always fails', exitCode: 1 }),
  });

  const result = await runRunWorkflowTool({ task: 'broken feature' }, ctx);
  assert.equal(result.structuredContent.tests_passed, false);
  assert.ok(result.content[0].text.includes('PR'));
});

test('runRunWorkflowTool passes previous test output to code generator on retry', async () => {
  const receivedErrors = [];
  let callCount = 0;

  const ctx = makeWorkflowCtx({
    _generateCodeChanges: async (client, task, context, previousError) => {
      receivedErrors.push(previousError);
      return { files: [{ path: 'src/x.js', content: '' }], explanation: '' };
    },
    _runTests: async () => {
      callCount++;
      return callCount === 1
        ? { pass: false, output: 'first failure', exitCode: 1 }
        : { pass: true, output: 'ok', exitCode: 0 };
    },
  });

  await runRunWorkflowTool({ task: 'fix' }, ctx);

  assert.equal(receivedErrors[0], null); // first attempt: no previous error
  assert.equal(receivedErrors[1], 'first failure'); // second attempt: receives previous output
});

test('runGetPRReviewSummaryTool handles zero reviews', async () => {
  const result = await runGetPRReviewSummaryTool(
    { pr_url: 'https://github.com/org/repo/pull/1' },
    {
      token: 'tok', owner: 'org', repo: 'repo',
      _getPRReviews: async () => [],
      _getPRComments: async () => [],
      _parsePRNumber: () => 1,
    },
  );

  assert.equal(result.structuredContent.approved, 0);
  assert.equal(result.structuredContent.changesRequested, 0);
  assert.equal(result.structuredContent.commentCount, 0);
});
