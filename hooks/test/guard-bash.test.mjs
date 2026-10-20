// @ts-check
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parse } from "../guard-bash.mjs";
import { denied, makeRepo, runHook } from "./helpers.mjs";

const bash = (/** @type {string} */ cwd, /** @type {string} */ command) =>
  denied(runHook("guard-bash.mjs", { tool_name: "Bash", tool_input: { command } }, { cwd }));

describe("parse", () => {
  test("splits commands and keeps quoted words whole", () => {
    assert.deepEqual(parse(`git commit -m "push to main" && git push`), [
      { words: ["git", "commit", "-m", "push to main"], redirects: [] },
      { words: ["git", "push"], redirects: [] },
    ]);
  });

  test("collects redirect targets but not descriptor copies", () => {
    assert.deepEqual(parse("npm test 2>&1 | tee out.log > .env"), [
      { words: ["npm", "test"], redirects: [] },
      { words: ["tee", "out.log"], redirects: [".env"] },
    ]);
  });
});

describe("pushes", () => {
  const repo = makeRepo({ branch: "fix/weekend" });
  const onMain = makeRepo();

  for (const command of [
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin fix/weekend:refs/heads/main",
    "git -C . push origin main",
    "cd src && git push origin main",
    "git push -f origin fix/weekend",
    "git push --force origin fix/weekend",
    "git push --force-with-lease origin fix/weekend",
    "git push origin +fix/weekend",
    "git push --all",
  ]) {
    test(`blocks: ${command}`, () => assert.match(bash(repo, command) ?? "", /^Blocked/));
  }

  test("blocks a bare push while on main", () => {
    assert.match(bash(onMain, "git push") ?? "", /pull request/);
    assert.match(bash(onMain, "git push origin") ?? "", /pull request/);
  });

  test("blocks pushing HEAD while on main", () => {
    assert.match(bash(onMain, "git push origin HEAD") ?? "", /pull request/);
    assert.match(bash(onMain, "git push -u origin @") ?? "", /pull request/);
  });

  test("allows pushing HEAD from a feature branch", () => {
    assert.equal(bash(repo, "git push -u origin HEAD"), null);
  });

  for (const command of [
    "git push -u origin fix/weekend",
    "git push",
    "git status",
    "git log main",
    'git commit -m "push to main"',
  ]) {
    test(`allows: ${command}`, () => assert.equal(bash(repo, command), null));
  }
});

describe("merging", () => {
  const repo = makeRepo({ branch: "fix/weekend" });

  test("blocks gh pr merge", () => {
    assert.match(bash(repo, "gh pr merge 3 --squash") ?? "", /agents don't merge/);
  });

  test("blocks merging through the API", () => {
    assert.match(bash(repo, "gh api -X PUT repos/o/r/pulls/3/merge") ?? "", /agents don't merge/);
  });

  test("allows reading and opening PRs", () => {
    assert.equal(bash(repo, "gh pr view 3"), null);
    assert.equal(bash(repo, 'gh pr create --fill --title "fix: weekend due dates"'), null);
  });
});

describe("shell writes", () => {
  const unlocked = makeRepo({ branch: "fix/weekend" });
  const locked = makeRepo({ branch: "fix/weekend", testCommit: true });

  for (const command of [
    "echo '{}' > .claude/settings.json",
    "sed -i 's/deny/allow/' hooks/lib.mjs",
    "rm .github/workflows/verify.yml",
    "echo API_KEY=1 >> .env",
  ]) {
    test(`blocks: ${command}`, () => assert.match(bash(unlocked, command) ?? "", /^Blocked/));
  }

  test("blocks writes to locked tests", () => {
    assert.match(bash(locked, "sed -i 's/05/03/' test/math.test.ts") ?? "", /locked/);
    assert.match(bash(locked, "git checkout -- test/math.test.ts") ?? "", /locked/);
    assert.match(bash(locked, "echo '' > test/math.test.ts") ?? "", /locked/);
  });

  test("allows test writes before the reproduction is committed", () => {
    assert.equal(bash(unlocked, "sed -i 's/05/03/' test/math.test.ts"), null);
  });

  test("allows ordinary commands and writes outside the repo", () => {
    assert.equal(bash(locked, "npm test 2>&1 | tail -5"), null);
    assert.equal(bash(locked, "ls > /dev/null"), null);
    assert.equal(bash(locked, "sed -i 's/1/2/' src/math.ts"), null);
  });
});
