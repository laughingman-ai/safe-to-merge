// @ts-check
// Shared helpers for the Claude Code hooks in this directory.
// Hook contract (https://code.claude.com/docs/en/hooks): JSON arrives on stdin;
// a PreToolUse hook denies a call by printing a permissionDecision of "deny";
// a Stop hook keeps the session going by printing a decision of "block".

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} HookInput
 * @property {string} [hook_event_name]
 * @property {string} [cwd]
 * @property {string} [tool_name]
 * @property {Record<string, any>} [tool_input]
 * @property {boolean} [stop_hook_active]
 */

/** @returns {HookInput} */
export function readInput() {
  const raw = readFileSync(0, "utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

/** The repo root the session runs in. */
export function projectDir(/** @type {HookInput} */ input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

/** Deny a tool call and tell the agent why. */
export function deny(/** @type {string} */ reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
  process.exit(0);
}

/** Path relative to the repo root, with forward slashes. Outside the repo returns null. */
export function repoPath(/** @type {string} */ root, /** @type {string} */ file) {
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
  if (rel === "" || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

/** Files that define the gates. An agent never edits these; a human does, through review. */
export function isGatePath(/** @type {string | null} */ rel) {
  if (!rel) return false;
  return (
    rel.startsWith(".claude/") ||
    rel.startsWith("hooks/") ||
    rel.startsWith(".github/") ||
    rel === "scripts/verify.mjs" ||
    rel === "scripts/check-test-lock.mjs" ||
    rel.startsWith("scripts/review") ||
    rel === "scripts/run-reviewer.sh" ||
    rel === "KNOWN_BUGS.md"
  );
}

export function isTestPath(/** @type {string | null} */ rel) {
  if (!rel) return false;
  return rel.startsWith("test/") || /\.test\.[cm]?[jt]s$/.test(rel);
}

export function isEnvFile(/** @type {string | null} */ rel) {
  if (!rel) return false;
  const base = rel.split("/").pop() ?? "";
  if (base === ".env.example" || base === ".env.sample") return false;
  return base === ".env" || base.startsWith(".env.");
}

/** Patterns for credentials that should never be written into the repo. */
const SECRET_PATTERNS = [
  { name: "an AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "an OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  {
    name: "a GitHub token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/,
  },
  { name: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "a private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

/** The kind of secret found in `text`, or null. */
export function findSecret(/** @type {string} */ text) {
  for (const { name, re } of SECRET_PATTERNS) if (re.test(text)) return name;
  return null;
}

function git(/** @type {string} */ cwd, /** @type {string[]} */ args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function currentBranch(/** @type {string} */ cwd) {
  try {
    return process.env.GITHUB_HEAD_REF || git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return "";
  }
}

function mergeBase(/** @type {string} */ cwd) {
  for (const base of ["main", "origin/main"]) {
    try {
      return git(cwd, ["merge-base", "HEAD", base]);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The test lock. On a fix/* branch, the first commit that touches test files is the
 * reproduction: a test that fails before the fix. From then on the tests are fixed, so
 * the only way to green is to change the code.
 * @returns {{ locked: false } | { locked: true, branch: string, lockCommit: string }}
 */
export function testLock(/** @type {string} */ cwd) {
  const branch = currentBranch(cwd);
  if (!branch.startsWith("fix/")) return { locked: false };
  const base = mergeBase(cwd);
  if (!base) return { locked: false };
  const commits = git(cwd, [
    "log",
    "--format=%H",
    "--reverse",
    `${base}..HEAD`,
    "--",
    "test",
    ":(glob)**/*.test.*",
  ]);
  const lockCommit = commits.split("\n").filter(Boolean)[0];
  return lockCommit ? { locked: true, branch, lockCommit } : { locked: false };
}

export const LOCKED_TEST_REASON =
  "Test files are locked on this branch: the failing test that reproduces the bug is " +
  "already committed. Change the code under src/ until that test passes. Do not change the test.";

export const GATE_REASON =
  "That file is part of the gates (.claude/, hooks/, .github/, the verify, test-lock, and " +
  "review scripts, KNOWN_BUGS.md). Agents can't change the gates; a human changes them through review.";
