// @ts-check
// Shared helpers for the Claude Code hooks in this directory.
// Hook contract (https://code.claude.com/docs/en/hooks): JSON arrives on stdin;
// a PreToolUse hook denies a call by printing a permissionDecision of "deny";
// a Stop hook keeps the session going by printing a decision of "block".
//
// Every hook fails closed: an internal error blocks the action (exit 2) instead of letting
// it through. `.claude/settings.json` also sets "onFailure": "block" on the PreToolUse hooks,
// so a hook that can't even start blocks too (Claude Code v2.1.295+).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
  if (!raw.trim()) throw new Error("no hook input on stdin");
  const input = JSON.parse(raw);
  if (typeof input !== "object" || input === null) throw new Error("hook input is not an object");
  return input;
}

/** Run a PreToolUse hook body. Any exception blocks the tool call. */
export function guarded(/** @type {() => void} */ body) {
  try {
    body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Blocked: the safe-to-merge hook hit an internal error (${message}).`);
    process.exit(2);
  }
  process.exit(0);
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

/** realpath of the deepest existing ancestor, with the rest appended. Resolves symlinks. */
function realish(/** @type {string} */ abs) {
  let head = abs;
  const tail = [];
  while (!existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) return abs;
    tail.unshift(path.basename(head));
    head = parent;
  }
  return path.join(realpathSync(head), ...tail);
}

function relTo(/** @type {string} */ root, /** @type {string} */ abs) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  return rel; // "" is the repo root itself
}

/**
 * Every repo-relative path `file` can mean: as written, resolved against `cwd`, and with
 * symlinks resolved. A symlink inside the repo pointing at a gate counts as the gate.
 * Paths outside the repo are dropped.
 */
export function repoPaths(
  /** @type {string} */ root,
  /** @type {string} */ cwd,
  /** @type {string} */ file,
) {
  const abs = path.resolve(cwd, file);
  const out = new Set();
  const lexical = relTo(root, abs);
  if (lexical !== null) out.add(lexical);
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // root doesn't exist; lexical only
  }
  const real = relTo(realRoot, realish(abs));
  if (real !== null) out.add(real);
  return [...out];
}

/** Directories and files that define the gates. An agent never changes these. */
export const GATE_DIRS = [".claude", ".github", "hooks", "node_modules"];
export const GATE_FILES = [
  "KNOWN_BUGS.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".prettierrc.json",
  ".prettierignore",
  "scripts/verify.mjs",
  "scripts/check-test-lock.mjs",
  "scripts/review.sh",
  "scripts/ci-review.sh",
  "scripts/run-reviewer.sh",
  "scripts/review-prompt.md",
  "scripts/review-schema.json",
  "scripts/agent-token.mjs",
  "scripts/agent-session.sh",
];
const GATE_ROOTS = [...GATE_DIRS, ...GATE_FILES];

/** Whether `rel` is a gate, inside one, or contains one (a parent directory, or the root). */
export function touchesGate(/** @type {string | null} */ rel) {
  if (rel === null) return false;
  if (hasGlob(rel)) return globTouches(rel, GATE_ROOTS);
  return GATE_ROOTS.some((g) => rel === g || rel.startsWith(`${g}/`) || within(g, rel));
}

/** Whether `rel` is a test file, the test directory, or contains it. */
export function touchesTests(/** @type {string | null} */ rel) {
  if (rel === null) return false;
  if (hasGlob(rel)) return /\.test\./.test(rel) || globTouches(rel, ["test"]);
  return (
    rel === "test" ||
    rel.startsWith("test/") ||
    /\.test\.[cm]?[jt]s$/.test(rel) ||
    within("test", rel)
  );
}

/** `dir` contains `target` (dir is "" for the repo root). */
function within(/** @type {string} */ target, /** @type {string} */ dir) {
  return dir === "" || dir === "." || target.startsWith(`${dir}/`);
}

function hasGlob(/** @type {string} */ p) {
  return /[*?[]/.test(p);
}

/** A glob touches a root if it could match the root, a parent of it, or something under it. */
function globTouches(/** @type {string} */ pattern, /** @type {string[]} */ roots) {
  const literal = pattern.slice(0, pattern.search(/[*?[]/)).replace(/\/[^/]*$/, "");
  const candidates = roots.flatMap((r) => {
    const parts = r.split("/");
    return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  });
  if (typeof path.matchesGlob === "function") {
    if (candidates.some((c) => path.matchesGlob(c, pattern))) return true;
  }
  // A glob inside a root (e.g. hooks/*.mjs) touches it.
  return roots.some((r) => literal === r || literal.startsWith(`${r}/`));
}

export function isEnvFile(/** @type {string | null} */ rel) {
  if (!rel) return false;
  const base = rel.split("/").pop() ?? "";
  if (base === ".env.example" || base === ".env.sample") return false;
  return base === ".env" || base === ".envrc" || base.startsWith(".env.");
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

export function git(/** @type {string} */ cwd, /** @type {string[]} */ args) {
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

export const TEST_PATHSPEC = ["test", ":(glob)**/*.test.*"];

/**
 * The test lock. On a fix/* branch, the first commit that touches test files is the
 * reproduction: a test that fails before the fix. From then on the tests are fixed, so
 * the only way to green is to change the code.
 *
 * This reads local history, so locally it's only as strong as that history. The hooks
 * block the ways an agent would rewrite it (reset, rebase, amend, ...); CI re-checks the
 * pushed branch and requires the reproduction to fail at its own commit.
 * @returns {{ fixBranch: boolean, locked: false } | { fixBranch: true, locked: true, branch: string, lockCommit: string }}
 */
export function testLock(/** @type {string} */ cwd) {
  const branch = currentBranch(cwd);
  if (!branch.startsWith("fix/")) return { fixBranch: false, locked: false };
  const base = mergeBase(cwd);
  if (!base) return { fixBranch: true, locked: false };
  let commits;
  try {
    commits = git(cwd, [
      "log",
      "--format=%H",
      "--reverse",
      `${base}..HEAD`,
      "--",
      ...TEST_PATHSPEC,
    ]);
  } catch (error) {
    throw new Error(`couldn't read the branch history for the test lock: ${String(error)}`);
  }
  const lockCommit = commits.split("\n").filter(Boolean)[0];
  return lockCommit
    ? { fixBranch: true, locked: true, branch, lockCommit }
    : { fixBranch: true, locked: false };
}

export const LOCKED_TEST_REASON =
  "Test files are locked on this branch: the failing test that reproduces the bug is " +
  "already committed. Change the code under src/ until that test passes. Do not change the test.";

export const GATE_REASON =
  "That's part of the gates (.claude/, .github/, hooks/, node_modules/, package.json and the " +
  "other config files, the verify, test-lock, review, and agent scripts, KNOWN_BUGS.md). " +
  "Agents can't change the gates; a human changes them through review.";
