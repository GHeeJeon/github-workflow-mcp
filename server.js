#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  getBranchSha,
  createBranch,
  createIssue,
  createPR,
  getPRReviews,
  getPRComments,
  runTests,
  commitAndPush,
  parsePRNumber,
  validateTestCommand,
} from './githubClient.js';

import {
  createAnthropicClient,
  buildRepoContext,
  applyFileChanges,
  generateCodeChanges,
  generateBranchName,
} from './aiClient.js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to run the GitHub Workflow MCP server.`);
  return value;
}

function resolveExecutablePath(pathname) {
  try { return realpathSync(pathname); } catch { return pathname; }
}

export function isDirectExecution(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  return resolveExecutablePath(fileURLToPath(moduleUrl)) === resolveExecutablePath(argv1);
}

// --- Tool handlers (second arg is injected deps — real functions by default, mocks in tests) ---

export async function runCreateBranchTool(args, {
  token, owner, repo, defaultBase,
  _getBranchSha = getBranchSha,
  _createBranch = createBranch,
}) {
  const base = args.base || defaultBase;
  const sha = await _getBranchSha(owner, repo, base, token);
  await _createBranch(owner, repo, args.name, sha, token);
  return {
    content: [{ type: 'text', text: `Created branch "${args.name}" from "${base}".` }],
    structuredContent: { branch: args.name, base, sha },
  };
}

export async function runRunTestsTool(args, {
  repoPath,
  _runTests = runTests,
  _validateTestCommand = validateTestCommand,
}) {
  const command = args.command || 'npm test';
  _validateTestCommand(command);
  const cwd = args.cwd || repoPath;
  const result = await _runTests(command, cwd);
  const status = result.pass ? 'PASS' : 'FAIL';
  return {
    content: [{
      type: 'text',
      text: `Tests ${status} (exit ${result.exitCode}).\n\n${result.output}`,
    }],
    structuredContent: result,
  };
}

export async function runCommitAndPushTool(args, {
  repoPath,
  _commitAndPush = commitAndPush,
}) {
  _commitAndPush(repoPath, args.message, args.files);
  return {
    content: [{ type: 'text', text: `Committed and pushed: "${args.message}".` }],
    structuredContent: { message: args.message, files: args.files || ['.'] },
  };
}

export async function runCreatePRTool(args, {
  token, owner, repo, defaultBase,
  _createPR = createPR,
}) {
  const base = args.base || defaultBase;
  const pr = await _createPR(owner, repo, args.title, args.body, args.branch, base, token);
  return {
    content: [{ type: 'text', text: `Created PR #${pr.number}: ${pr.html_url}` }],
    structuredContent: { url: pr.html_url, number: pr.number, title: pr.title },
  };
}

export async function runCreateIssueTool(args, {
  token, owner, repo,
  _createIssue = createIssue,
}) {
  const issue = await _createIssue(owner, repo, args.title, args.body ?? '', args.labels ?? [], token);
  return {
    content: [{ type: 'text', text: `Created issue #${issue.number}: ${issue.html_url}` }],
    structuredContent: { url: issue.html_url, number: issue.number, title: issue.title, labels: issue.labels.map(l => l.name) },
  };
}

export async function runGetPRReviewSummaryTool(args, {
  token, owner, repo,
  _getPRReviews = getPRReviews,
  _getPRComments = getPRComments,
  _parsePRNumber = parsePRNumber,
}) {
  const prNumber = _parsePRNumber(args.pr_url);
  const [reviews, comments] = await Promise.all([
    _getPRReviews(owner, repo, prNumber, token),
    _getPRComments(owner, repo, prNumber, token),
  ]);

  const approved = reviews.filter(r => r.state === 'APPROVED').length;
  const changesRequested = reviews.filter(r => r.state === 'CHANGES_REQUESTED').length;

  const lines = [
    `PR #${prNumber} review summary:`,
    `  Approved: ${approved}`,
    `  Changes requested: ${changesRequested}`,
    `  Inline comments: ${comments.length}`,
  ];

  if (comments.length > 0) {
    lines.push('\nInline comments:');
    for (const c of comments.slice(0, 10)) {
      lines.push(`  [${c.path}:${c.line ?? '?'}] ${c.body.slice(0, 120)}`);
    }
    if (comments.length > 10) lines.push(`  ... and ${comments.length - 10} more`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { prNumber, approved, changesRequested, commentCount: comments.length, comments },
  };
}

export async function runRunWorkflowTool(args, {
  token, owner, repo, repoPath, defaultBase,
  _getBranchSha = getBranchSha,
  _createBranch = createBranch,
  _runTests = runTests,
  _commitAndPush = commitAndPush,
  _createPR = createPR,
  _buildRepoContext = buildRepoContext,
  _applyFileChanges = applyFileChanges,
  _generateCodeChanges = generateCodeChanges,
  _generateBranchName = generateBranchName,
  _anthropicClient,
}) {
  const MAX_ATTEMPTS = 3;
  const branchName = args.branch_name || _generateBranchName(args.task);
  const log = [];

  // 1. Create branch
  const sha = await _getBranchSha(owner, repo, defaultBase, token);
  await _createBranch(owner, repo, branchName, sha, token);
  log.push(`✓ Created branch: ${branchName}`);

  // 2. Code generation + test loop
  let testResult;
  let previousTestOutput = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log.push(`\n[Attempt ${attempt}/${MAX_ATTEMPTS}] Generating code...`);

    const repoContext = await _buildRepoContext(repoPath);
    const changes = await _generateCodeChanges(_anthropicClient, args.task, repoContext, previousTestOutput);

    await _applyFileChanges(repoPath, changes.files);
    log.push(`✓ Applied ${changes.files.length} file(s): ${changes.files.map(f => f.path).join(', ')}`);

    log.push('  Running tests...');
    testResult = await _runTests('npm test', repoPath);
    log.push(`  Tests: ${testResult.pass ? 'PASS ✓' : 'FAIL ✗'}`);

    if (testResult.pass) break;

    previousTestOutput = testResult.output;
    if (attempt === MAX_ATTEMPTS) {
      log.push(`\n⚠ Tests still failing after ${MAX_ATTEMPTS} attempts. Committing anyway.`);
    }
  }

  // 3. Commit and push
  _commitAndPush(repoPath, `feat: ${args.task}`, ['.']);
  log.push('\n✓ Committed and pushed');

  // 4. Create PR
  const prBody = [
    `Automated via \`run_workflow\`.`,
    '',
    `**Task:** ${args.task}`,
    '',
    `**Tests:** ${testResult.pass ? '✅ Passing' : '❌ Failing after 3 attempts'}`,
  ].join('\n');

  const pr = await _createPR(owner, repo, args.task, prBody, branchName, defaultBase, token);
  log.push(`✓ Created PR #${pr.number}: ${pr.html_url}`);

  return {
    content: [{ type: 'text', text: log.join('\n') }],
    structuredContent: {
      pr_url: pr.html_url,
      pr_number: pr.number,
      branch: branchName,
      tests_passed: testResult.pass,
    },
  };
}

// --- Server factory ---

export function createServer(env) {
  const ctx = {
    token: env.GITHUB_TOKEN,
    owner: env.REPO_OWNER,
    repo: env.REPO_NAME,
    repoPath: env.REPO_PATH,
    defaultBase: env.DEFAULT_BASE_BRANCH || 'main',
    _anthropicClient: env.ANTHROPIC_API_KEY ? createAnthropicClient(env.ANTHROPIC_API_KEY) : null,
  };

  const server = new McpServer({
    name: 'github-workflow-mcp',
    version: '0.1.0',
  });

  server.tool(
    'create_issue',
    'Create a GitHub issue with a title, body, and optional labels.',
    {
      title: z.string().describe('Issue title'),
      body: z.string().optional().describe('Issue body (markdown supported)'),
      labels: z.array(z.string()).optional().describe('Label names to attach (e.g. ["bug", "enhancement"])'),
    },
    (args) => runCreateIssueTool(args, ctx),
  );

  server.tool(
    'create_branch',
    'Create a new GitHub branch from a base branch.',
    {
      name: z.string().describe('New branch name (e.g. "feature/login-button")'),
      base: z.string().optional().describe(`Base branch to branch from (default: ${ctx.defaultBase})`),
    },
    (args) => runCreateBranchTool(args, ctx),
  );

  server.tool(
    'run_tests',
    'Run the test suite and return pass/fail status with full output.',
    {
      command: z.enum(['npm test', 'yarn test', 'pnpm test', 'python -m pytest'])
        .optional()
        .describe('Test command (default: "npm test")'),
      cwd: z.string().optional().describe('Working directory (default: REPO_PATH env)'),
    },
    (args) => runRunTestsTool(args, ctx),
  );

  server.tool(
    'commit_and_push',
    'Stage files, create a commit, and push to the current branch.',
    {
      message: z.string().describe('Commit message'),
      files: z.array(z.string()).optional().describe('Files to stage (default: ["."] — all changes)'),
    },
    (args) => runCommitAndPushTool(args, ctx),
  );

  server.tool(
    'create_pr',
    'Open a GitHub Pull Request for the given branch.',
    {
      title: z.string().describe('PR title'),
      body: z.string().describe('PR body (markdown supported)'),
      branch: z.string().describe('Head branch to merge from'),
      base: z.string().optional().describe(`Base branch to merge into (default: ${ctx.defaultBase})`),
    },
    (args) => runCreatePRTool(args, ctx),
  );

  server.tool(
    'get_pr_review_summary',
    'Fetch and summarise all review comments for a Pull Request.',
    {
      pr_url: z.string().url().describe('Full GitHub PR URL (e.g. https://github.com/owner/repo/pull/42)'),
    },
    (args) => runGetPRReviewSummaryTool(args, ctx),
  );

  server.tool(
    'run_workflow',
    'Fully automated workflow: AI generates code, runs tests (retrying up to 3 times on failure), commits, pushes, and opens a PR. Requires ANTHROPIC_API_KEY.',
    {
      task: z.string().describe('Natural language description of the feature or fix to implement'),
      branch_name: z.string().optional().describe('Branch name (default: auto-generated from task)'),
    },
    (args) => {
      if (!ctx._anthropicClient) {
        return {
          content: [{ type: 'text', text: 'ANTHROPIC_API_KEY is not set. run_workflow requires an Anthropic API key.' }],
          isError: true,
        };
      }
      return runRunWorkflowTool(args, ctx);
    },
  );

  return server;
}

if (isDirectExecution()) {
  const env = {
    GITHUB_TOKEN: requireEnv('GITHUB_TOKEN'),
    REPO_OWNER: requireEnv('REPO_OWNER'),
    REPO_NAME: requireEnv('REPO_NAME'),
    REPO_PATH: requireEnv('REPO_PATH'),
    DEFAULT_BASE_BRANCH: process.env.DEFAULT_BASE_BRANCH,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, // optional — only needed for run_workflow
  };

  const server = createServer(env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
