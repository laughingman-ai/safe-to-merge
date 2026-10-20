// @ts-check
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(HOOKS, "..");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Scratch repos and files made by this test file, removed when the process exits. */
const scratch = /** @type {string[]} */ ([]);

/** Remove `p` (a file or directory) when the tests finish. Returns `p`. */
export function scratchPath(/** @type {string} */ p) {
  scratch.push(p);
  return p;
}
process.on("exit", () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The environment hooks see in tests: no CI branch override, a fixed git identity. */
export function env(/** @type {Record<string, string>} */ extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const e = { ...process.env };
  delete e.GITHUB_HEAD_REF;
  delete e.CLAUDE_PROJECT_DIR;
  delete e.NODE_TEST_CONTEXT;
  return { ...e, ...GIT_ENV, ...extra };
}

/**
 * Run a hook script with `input` as its stdin JSON. `input` may be a raw string.
 * @param {string} script file name in hooks/
 * @param {object | string} input
 * @param {{ root: string, cwd?: string, env?: Record<string, string> }} options
 */
export function runHook(script, input, { root, cwd = root, env: extra = {} }) {
  const stdin = typeof input === "string" ? input : JSON.stringify({ cwd, ...input });
  const result = spawnSync("node", [path.join(HOOKS, script)], {
    cwd,
    input: stdin,
    encoding: "utf8",
    env: env({ CLAUDE_PROJECT_DIR: root, ...extra }),
  });
  const out = result.stdout.trim();
  return {
    status: result.status,
    stdout: out,
    stderr: result.stderr,
    json: out ? JSON.parse(out) : null,
  };
}

/** The deny reason from a PreToolUse result, or null when the call was allowed. */
export function denied(/** @type {ReturnType<typeof runHook>} */ result) {
  if (result.status === 2) return `exit 2: ${result.stderr}`;
  assert0(result);
  const out = result.json?.hookSpecificOutput;
  return out?.permissionDecision === "deny" ? out.permissionDecisionReason : null;
}

function assert0(/** @type {ReturnType<typeof runHook>} */ result) {
  if (result.status !== 0) throw new Error(`hook exited ${result.status}: ${result.stderr}`);
}

export function git(/** @type {string} */ cwd, /** @type {string[]} */ args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: env() }).trim();
}

const PASSING = 'import { test } from "node:test";\ntest("one is one", () => {});\n';
const FAILING = PASSING + 'test("reproduces the bug", () => {\n  throw new Error("bug");\n});\n';

/**
 * A scratch git repo with one commit on main: src/math.ts and a passing test.
 * @param {{ branch?: string, testCommit?: boolean | "passing", nodeModules?: boolean }} [options]
 *   branch: check out this branch. testCommit: commit a reproduction on it (a failing test,
 *   or "passing" for one that doesn't reproduce anything).
 */
export function makeRepo({ branch, testCommit = false, nodeModules = false } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "safe-to-merge-")));
  scratch.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  for (const sub of ["src", "test", "hooks", ".claude"]) mkdirSync(path.join(dir, sub));
  writeFileSync(path.join(dir, "src", "math.ts"), "export const one = 1;\n");
  writeFileSync(path.join(dir, "test", "math.test.ts"), PASSING);
  writeFileSync(path.join(dir, "hooks", "guard-bash.mjs"), "// gate\n");
  writeFileSync(path.join(dir, ".claude", "settings.json"), "{}\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  if (branch) git(dir, ["checkout", "-q", "-b", branch]);
  if (testCommit) {
    const body = testCommit === "passing" ? PASSING + 'test("two", () => {});\n' : FAILING;
    writeFileSync(path.join(dir, "test", "math.test.ts"), body);
    git(dir, ["commit", "-q", "-am", "test: reproduce the bug"]);
  }
  if (nodeModules) symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}
