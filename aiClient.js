import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const IGNORE = new Set(['.git', 'node_modules', '.omc', 'dist', 'build', '.next', '__pycache__']);
const MAX_FILE_SIZE = 32_000; // chars per file to keep prompt budget reasonable
const MAX_CONTEXT_FILES = 20;

export function createAnthropicClient(apiKey) {
  return new Anthropic({ apiKey });
}

async function collectFiles(dir, base = dir, results = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return results; }

  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      await collectFiles(full, base, results);
    } else {
      results.push(rel);
    }
  }
  return results;
}

export async function buildRepoContext(repoPath) {
  const files = await collectFiles(repoPath);
  const prioritised = files
    .sort((a, b) => {
      const score = (f) =>
        f === 'package.json' ? 0 :
        f.endsWith('.json') || f.endsWith('.md') ? 1 :
        f.startsWith('src/') || f.startsWith('lib/') ? 2 : 3;
      return score(a) - score(b);
    })
    .slice(0, MAX_CONTEXT_FILES);

  const parts = [`Repository: ${repoPath}\nFiles:\n${files.map(f => `  ${f}`).join('\n')}\n`];

  for (const rel of prioritised) {
    try {
      const content = await readFile(path.join(repoPath, rel), 'utf8');
      parts.push(`--- ${rel} ---\n${content.slice(0, MAX_FILE_SIZE)}`);
    } catch { /* skip unreadable */ }
  }

  return parts.join('\n\n');
}

export async function applyFileChanges(repoPath, files) {
  for (const { path: relPath, content } of files) {
    const abs = path.join(repoPath, relPath);
    const dir = path.dirname(abs);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

const SYSTEM_PROMPT = `You are an expert software engineer. Your job is to implement code changes in a repository.

You will receive:
1. A task description
2. The current repository context (file tree + key file contents)
3. (On retries) the test failure output from the previous attempt

Respond with a JSON object (no markdown fences) with this exact shape:
{
  "explanation": "brief description of what you did",
  "files": [
    { "path": "relative/path/to/file.js", "content": "full file content here" }
  ]
}

Rules:
- Only include files you are creating or modifying
- Always write the FULL file content, not diffs or partial snippets
- Paths are relative to the repo root
- If tests are failing, fix the code to make them pass`;

export async function generateCodeChanges(client, task, repoContext, previousTestOutput = null) {
  const userContent = [
    `Task: ${task}`,
    '',
    `Repository context:\n${repoContext}`,
    previousTestOutput
      ? `\nPrevious test run FAILED. Fix the code so the tests pass.\n\nTest output:\n${previousTestOutput.slice(0, 8000)}`
      : '',
  ].join('\n').trim();

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const raw = message.content[0]?.text ?? '';
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract JSON if there are surrounding characters
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`AI response was not valid JSON:\n${raw.slice(0, 500)}`);
  }
}

export function generateBranchName(task) {
  return 'feature/' + task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50);
}
