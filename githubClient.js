import { execFileSync, spawn } from 'node:child_process';

const GITHUB_API = 'https://api.github.com';

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function githubRequest(token, method, path, body) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: githubHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.message || 'GitHub API request failed';
    const error = new Error(`GitHub API error (${response.status}): ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export async function getDefaultBranch(owner, repo, token) {
  const data = await githubRequest(token, 'GET', `/repos/${owner}/${repo}`);
  return data.default_branch;
}

export async function getBranchSha(owner, repo, branch, token) {
  const data = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  return data.object.sha;
}

export async function createBranch(owner, repo, name, baseSha, token) {
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${name}`,
    sha: baseSha,
  });
}

export async function createPR(owner, repo, title, body, head, base, token) {
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/pulls`, {
    title,
    body,
    head,
    base,
  });
}

export async function getPRReviews(owner, repo, prNumber, token) {
  return githubRequest(token, 'GET', `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
}

export async function getPRComments(owner, repo, prNumber, token) {
  return githubRequest(token, 'GET', `/repos/${owner}/${repo}/pulls/${prNumber}/comments`);
}

const ALLOWED_TEST_COMMANDS = [
  'npm test',
  'yarn test',
  'pnpm test',
  'python -m pytest',
];

export function validateTestCommand(command) {
  if (!ALLOWED_TEST_COMMANDS.includes(command)) {
    throw new Error(
      `Command not allowed: "${command}". Allowed commands: ${ALLOWED_TEST_COMMANDS.join(', ')}`
    );
  }
}

export function runTests(command, cwd) {
  validateTestCommand(command);

  const [bin, ...args] = command.split(' ');
  return new Promise((resolve) => {
    const chunks = [];
    const proc = spawn(bin, args, { cwd, shell: false });

    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => chunks.push(d));

    proc.on('close', (code) => {
      resolve({
        pass: code === 0,
        output: Buffer.concat(chunks).toString('utf8'),
        exitCode: code,
      });
    });
  });
}

export function gitExec(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function commitAndPush(repoPath, message, files = ['.']) {
  for (const f of files) {
    gitExec(['add', f], repoPath);
  }
  gitExec(['commit', '-m', message], repoPath);
  gitExec(['push'], repoPath);
}

export function parsePRNumber(prUrl) {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) throw new Error(`Cannot parse PR number from URL: ${prUrl}`);
  return parseInt(match[1], 10);
}
