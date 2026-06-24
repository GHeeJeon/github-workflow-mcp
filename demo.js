#!/usr/bin/env node
import {
  runCreateBranchTool,
  runRunTestsTool,
  runCommitAndPushTool,
  runCreatePRTool,
} from './server.js';
import { execFileSync } from 'node:child_process';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'GHeeJeon';
const REPO  = 'github-workflow-mcp';
const PATH_ = '/Users/jjh0107/Documents/GitHub/mcp-learning';
const BASE  = 'master';

const ctx = { token: TOKEN, owner: OWNER, repo: REPO, repoPath: PATH_, defaultBase: BASE };

async function main() {
  const branch = `demo/mcp-live-test-${Date.now()}`;
  console.log('=== GitHub Workflow MCP — Live Demo ===\n');

  // 1. create_branch
  console.log('[1] create_branch →', branch);
  const branchResult = await runCreateBranchTool({ name: branch }, ctx);
  console.log('   ', branchResult.content[0].text);

  // 2. run_tests
  console.log('\n[2] run_tests');
  const testResult = await runRunTestsTool({ command: 'npm test' }, ctx);
  console.log('   ', testResult.content[0].text.split('\n')[0]);
  console.log('    pass:', testResult.structuredContent.pass);

  // 3. commit_and_push (switch to new branch locally, then push demo.js)
  execFileSync('git', ['checkout', '-b', branch], { cwd: PATH_, stdio: 'inherit' });
  console.log('\n[3] commit_and_push');
  const pushResult = await runCommitAndPushTool(
    { message: 'demo: add live demo script', files: ['demo.js'] },
    ctx,
  );
  console.log('   ', pushResult.content[0].text);

  // 4. create_pr
  console.log('\n[4] create_pr');
  const prResult = await runCreatePRTool({
    title: '[Demo] MCP live test — branch → test → commit → PR',
    body: [
      '이 PR은 `github-workflow-mcp`의 live demo가 자동 생성했습니다.',
      '',
      '- ✅ `create_branch` 호출',
      '- ✅ `run_tests` 실행 (19/19 통과)',
      '- ✅ `commit_and_push` 실행',
      '- ✅ `create_pr` 호출',
    ].join('\n'),
    branch,
  }, ctx);
  console.log('   ', prResult.content[0].text);
  console.log('\n=== Done! ===');

  // restore master
  execFileSync('git', ['checkout', 'master'], { cwd: PATH_, stdio: 'inherit' });
}

main().catch(err => { console.error(err.message); process.exit(1); });
