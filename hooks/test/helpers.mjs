// @ts-check
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(HOOKS, "..");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** The environment hooks see in tests: no CI branch override, a fixed git identity. */
function env(/** @type {Record<string, string>} */ extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const e = { ...process.env, ...GIT_ENV, ...extra };
  delete e.GITHUB_HEAD_REF;
  return e;
}

/**
 * Run a hook script with `input` as its stdin JSON.
 * @param {string} script file name in hooks/
 * @param {object} input
 * @param {{ cwd: string, env?: Record<string, string> }} options
 */
export function runHook(script, input, { cwd, env: extra = {} }) {
  const result = spawnSync("node", [path.join(HOOKS, script)], {
    cwd,
    input: JSON.stringify({ cwd, ...input }),
    encoding: "utf8",
    env: env({ CLAUDE_PROJECT_DIR: cwd, ...extra }),
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
  const out = result.json?.hookSpecificOutput;
  return out?.permissionDecision === "deny" ? out.permissionDecisionReason : null;
}

export function git(/** @type {string} */ cwd, /** @type {string[]} */ args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: env() }).trim();
}

/**
 * A scratch git repo with one commit on main.
 * @param {{ branch?: string, testCommit?: boolean, nodeModules?: boolean }} [options]
 *   branch: check out this branch; testCommit: commit a test change on it (the reproduction).
 */
export function makeRepo({ branch, testCommit = false, nodeModules = false } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "safe-to-merge-")));
  git(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(path.join(dir, "src"));
  mkdirSync(path.join(dir, "test"));
  writeFileSync(path.join(dir, "src", "math.ts"), "export const one = 1;\n");
  writeFileSync(path.join(dir, "test", "math.test.ts"), "// tests\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  if (branch) git(dir, ["checkout", "-q", "-b", branch]);
  if (testCommit) {
    writeFileSync(path.join(dir, "test", "math.test.ts"), "// tests\n// reproduction\n");
    git(dir, ["commit", "-q", "-am", "test: reproduce the bug"]);
  }
  if (nodeModules) symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}
