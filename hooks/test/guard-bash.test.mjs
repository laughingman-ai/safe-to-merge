// @ts-check
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { parse } from "../guard-bash.mjs";
import { denied, git, makeRepo, runHook } from "./helpers.mjs";

/** @param {string} root @param {string} command @param {{ cwd?: string, tool?: string }} [o] */
const bash = (root, command, { cwd = root, tool = "Bash" } = {}) =>
  denied(runHook("guard-bash.mjs", { tool_name: tool, tool_input: { command } }, { root, cwd }));

const blocks = (/** @type {string} */ root, /** @type {string} */ command, re = /^Blocked/) =>
  test(`blocks: ${command}`, () => assert.match(bash(root, command) ?? "(allowed)", re));
const allows = (/** @type {string} */ root, /** @type {string} */ command) =>
  test(`allows: ${command}`, () => assert.equal(bash(root, command), null));

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

  test("splits out subshells and command substitutions", () => {
    assert.deepEqual(
      parse("echo $(rm -rf hooks) `ls`; (cd x && ls)").map((c) => c.words),
      [["echo"], ["rm", "-rf", "hooks"], ["ls"], ["cd", "x"], ["ls"]],
    );
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
    "git push -uf origin fix/weekend",
    "git push --force origin fix/weekend",
    "git push --force-with-lease origin fix/weekend",
    "git push origin +fix/weekend",
    "git push origin :fix/weekend",
    "git push --all",
    "git push --repo origin origin main",
    "git push -o ci.skip origin main",
  ]) {
    blocks(repo, command);
  }
  for (const command of [
    "git push",
    "git push origin",
    "git push origin HEAD",
    "git push -u origin @",
  ]) {
    blocks(onMain, command, /pull request/);
  }
  for (const command of [
    "git push -u origin fix/weekend",
    "git push -u origin HEAD",
    "git push",
    "git status",
    "git log main",
    'git commit -m "push to main"',
  ]) {
    allows(repo, command);
  }
});

describe("wrappers", () => {
  const repo = makeRepo({ branch: "fix/weekend" });
  for (const command of [
    "bash -c 'git push origin main'",
    'sh -c "git push origin main"',
    "bash -lc 'cd src && git push origin main'",
    "time git push origin main",
    "nohup git push origin main &",
    "eval git push origin main",
    "env -i PATH=/usr/bin git push origin main",
    "env -u HOME git push origin main",
    "sudo -u me git push origin main",
    "timeout 30 git push origin main",
    "echo $(git push origin main)",
    "command git push origin main",
  ]) {
    blocks(repo, command);
  }

  test("blocks inline git aliases", () => {
    assert.match(bash(repo, "git -c alias.p=push p origin main") ?? "", /alias/);
  });

  test("blocks defining git aliases", () => {
    assert.match(bash(repo, "git config alias.p push") ?? "", /alias/);
  });

  test("expands existing git aliases", () => {
    git(repo, ["config", "alias.p", "push"]);
    git(repo, ["config", "alias.sp", "!git push origin main"]);
    assert.match(bash(repo, "git p origin main") ?? "", /pull request/);
    assert.match(bash(repo, "git sp") ?? "", /pull request/);
    assert.equal(bash(repo, "git p -u origin fix/weekend"), null);
  });
});

describe("merging, approving, statuses, settings", () => {
  const repo = makeRepo({ branch: "fix/weekend" });
  for (const command of [
    "gh pr merge 3 --squash",
    "gh -R o/r pr merge 2",
    "gh --repo o/r pr merge 2 --auto",
    "gh pr review 2 --approve",
    "gh api -X PUT repos/o/r/pulls/3/merge",
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
    "gh api -X POST repos/o/r/statuses/abc -f state=success -f context=review/fresh-context",
    "gh api repos/o/r/check-runs -f name=verify",
    "gh api -X POST repos/o/r/pulls/2/reviews -f event=APPROVE",
    "gh api -X PUT repos/o/r/rulesets/1 --input r.json",
    "gh secret set ANTHROPIC_API_KEY",
    "gh ruleset delete 1",
    "gh repo edit --visibility public",
    "curl -X POST -H 'Authorization: token x' https://api.github.com/repos/o/r/statuses/abc",
    "wget --post-data=x https://api.github.com/graphql",
  ]) {
    blocks(repo, command);
  }
  for (const command of [
    "gh pr view 3",
    'gh pr create --fill --title "fix: weekend due dates"',
    "gh pr checks 2",
    "gh api repos/o/r/pulls/2",
    "gh ruleset list",
  ]) {
    allows(repo, command);
  }
});

describe("deleting or moving the gates", () => {
  const repo = makeRepo({ branch: "feat/x" });
  for (const command of [
    "rm -rf hooks",
    "rm -rf .claude",
    "rm -rf ./hooks/",
    "rm -rf *",
    "rm -rf .",
    "git rm -r hooks",
    "mv .claude .c",
    "cd hooks && rm guard-bash.mjs",
    "echo '{}' > .claude/settings.json",
    "sed -i 's/deny/allow/' hooks/lib.mjs",
    "sed --in-place 's/deny/allow/' hooks/lib.mjs",
    "rm .github/workflows/verify.yml",
    "cp /tmp/x.json .claude/settings.json",
    "cp -t hooks /tmp/x.mjs",
    "dd if=/dev/null of=hooks/guard-bash.mjs",
    "ln -s .claude/settings.json s.json",
    "npm pkg set scripts.verify='echo VERIFY PASSED'",
    "npm install left-pad",
    "rm -rf node_modules",
    "node -e \"require('fs').rmSync('hooks', {recursive: true})\"",
    "python3 -c \"import shutil; shutil.rmtree('.claude')\"",
    "echo '{}' > tsconfig.json",
    "echo x >> KNOWN_BUGS.md",
  ]) {
    blocks(repo, command, /gates/);
  }

  test("resolves paths against the session's cwd", () => {
    const hooks = path.join(repo, "hooks");
    assert.match(bash(repo, "rm guard-bash.mjs", { cwd: hooks }) ?? "", /gates/);
    assert.match(bash(repo, "rm -rf ../.claude", { cwd: path.join(repo, "src") }) ?? "", /gates/);
  });

  test("a symlink to a gate counts as the gate", () => {
    symlinkSync(path.join(repo, ".claude", "settings.json"), path.join(repo, "s.json"));
    assert.match(bash(repo, "echo '{}' > s.json") ?? "", /gates/);
  });

  for (const command of [
    "rm -rf dist",
    "rm *.log",
    "echo hi > notes.txt",
    "git checkout .",
    "git checkout -- src/math.ts",
    "ls > /dev/null",
    "npm ci",
    "npm test 2>&1 | tail -5",
    "node -e 'console.log(1)'",
  ]) {
    allows(repo, command);
  }
});

describe("secrets and .env", () => {
  const repo = makeRepo();
  const key = "AKIA" + "Q".repeat(16);
  blocks(repo, `echo ${key} > config.txt`, /AWS access key/);
  blocks(repo, `cat > src/aws.ts <<'EOF'\nexport const key = "${key}";\nEOF`, /AWS access key/);
  blocks(repo, "echo API_KEY=1 >> .env", /\.env/);
  blocks(repo, "echo 'export A=1' > .envrc", /\.env/);
  allows(repo, "echo A= > .env.example");
});

describe("the test lock", () => {
  const unlocked = makeRepo({ branch: "fix/weekend" });
  const locked = makeRepo({ branch: "fix/weekend", testCommit: true });

  for (const command of [
    "sed -i 's/05/03/' test/math.test.ts",
    "echo '' > test/math.test.ts",
    "git checkout main -- test",
    "git checkout main -- test/math.test.ts",
    "git restore --source main test",
    "git restore --source=main test/math.test.ts",
    "rm -rf test",
    "node -e \"require('fs').writeFileSync('test/math.test.ts', '')\"",
  ]) {
    blocks(locked, command, /locked/);
  }
  for (const command of [
    "git reset --soft HEAD~1",
    "git reset --hard main",
    "git rebase -i main",
    "git commit --amend --no-edit",
    "git commit --fixup HEAD",
    "git filter-branch --tree-filter 'rm test/math.test.ts' HEAD",
    "git filter-repo --path test --invert-paths",
    "git update-ref refs/heads/fix/weekend main",
    "git checkout -B fix/weekend main",
    "git switch -C fix/weekend main",
    "git branch -f fix/weekend main",
  ]) {
    blocks(locked, command, /rewrites history/);
  }

  test("history commands are fine before the reproduction is committed", () => {
    assert.equal(bash(unlocked, "git reset --soft HEAD~1"), null);
    assert.equal(bash(unlocked, "sed -i 's/05/03/' test/math.test.ts"), null);
  });

  test("code stays editable on a locked branch", () => {
    assert.equal(bash(locked, "sed -i 's/1/2/' src/math.ts"), null);
    assert.equal(bash(locked, "git checkout -- test/math.test.ts"), null);
  });
});

describe("other shell tools", () => {
  const repo = makeRepo();

  test("Monitor commands get the same checks", () => {
    assert.match(bash(repo, "git push origin main", { tool: "Monitor" }) ?? "", /pull request/);
  });

  test("a Monitor WebSocket watch has no command and is allowed", () => {
    const result = runHook(
      "guard-bash.mjs",
      { tool_name: "Monitor", tool_input: { ws: { url: "wss://x" } } },
      { root: repo },
    );
    assert.equal(denied(result), null);
  });

  test("PowerShell commands that name a gate are blocked", () => {
    assert.match(bash(repo, "Remove-Item -Recurse hooks", { tool: "PowerShell" }) ?? "", /gates/);
    assert.match(
      bash(repo, "Set-Content .claude/settings.json '{}'", { tool: "PowerShell" }) ?? "",
      /gates/,
    );
    assert.match(bash(repo, "git push origin main", { tool: "PowerShell" }) ?? "", /pull request/);
    assert.equal(bash(repo, "Get-ChildItem src", { tool: "PowerShell" }), null);
  });
});

describe("failing closed", () => {
  const repo = makeRepo();

  test("bad input blocks with exit 2", () => {
    const result = runHook("guard-bash.mjs", "{not json", { root: repo });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /internal error/);
  });

  test("empty input blocks with exit 2", () => {
    assert.equal(runHook("guard-bash.mjs", "", { root: repo }).status, 2);
  });
});
