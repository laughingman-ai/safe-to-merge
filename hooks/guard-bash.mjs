#!/usr/bin/env node
// @ts-check
// PreToolUse (Bash|Monitor|PowerShell): no pushes to main, no force pushes, no merging,
// approving, or posting statuses, no history rewrites on a locked branch, no credentials
// in commands, and no shell writes to the gates, locked tests, or .env files.
//
// Shell parsing here is deliberately simple: quotes, separators, redirects, `cd`, common
// wrappers (bash -c, env, time, nohup, eval, ...) and git aliases. It catches the ordinary
// ways an agent would do these things, not every possible one. CI (verify, check-test-lock,
// the fresh-context review), the rules on main, and a human approval are the backstop.

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  currentBranch,
  deny,
  findSecret,
  GATE_REASON,
  git,
  guarded,
  isEnvFile,
  LOCKED_TEST_REASON,
  projectDir,
  readInput,
  repoPaths,
  testLock,
  touchesGate,
  touchesTests,
} from "./lib.mjs";

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const MAX_DEPTH = 4;

/**
 * Split a command line into simple commands. Each command is a list of words plus any
 * redirect targets. Quotes are honored; `$(...)`, backticks, and parentheses split commands
 * so their contents are checked too. Heredoc bodies are not parsed (they are still scanned
 * for credentials).
 * @param {string} line
 * @returns {{ words: string[], redirects: string[] }[]}
 */
export function parse(line) {
  /** @type {{ words: string[], redirects: string[] }[]} */
  const commands = [];
  let words = /** @type {string[]} */ ([]);
  let redirects = /** @type {string[]} */ ([]);
  let word = "";
  let inWord = false;
  let quote = "";
  let redirectNext = false;

  const endWord = () => {
    if (!inWord) return;
    if (redirectNext) redirects.push(word);
    else if (word !== "{" && word !== "}") words.push(word);
    word = "";
    inWord = false;
    redirectNext = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else if (quote === '"' && c === "$" && line[i + 1] === "(") {
        // command substitution inside double quotes: check it as its own command
        endCommand();
        quote = "";
        i++;
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "$" && line[i + 1] === "(") {
      endCommand();
      i++;
    } else if ("\n;|&()`".includes(c)) {
      // `2>&1` and `&>` are redirects, not command separators.
      if (c === "&" && (line[i - 1] === ">" || line[i + 1] === ">")) continue;
      endCommand();
    } else if (c === ">") {
      const fd = inWord && /^\d$/.test(word) ? word : "";
      if (fd) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      if (line[i + 1] === ">") i++;
      if (line[i + 1] === "&") {
        i++; // `>&2` duplicates a descriptor; no file is written
        while (/\d/.test(line[i + 1] ?? "")) i++;
        continue;
      }
      redirectNext = true;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const base = (/** @type {string | undefined} */ w) => (w ?? "").split(/[\\/]/).pop() ?? "";

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"]);
/** Wrappers that run the rest of the line as a command, with how many option values they take. */
const WRAPPERS = /** @type {Record<string, Record<string, number>>} */ ({
  time: { "-f": 1, "-o": 1 },
  nohup: {},
  nice: { "-n": 1 },
  ionice: { "-c": 1, "-n": 1 },
  exec: { "-a": 1 },
  builtin: {},
  command: {},
  sudo: { "-u": 1, "-g": 1, "-h": 1, "-C": 1, "-D": 1 },
  doas: { "-u": 1 },
  stdbuf: { "-i": 1, "-o": 1, "-e": 1 },
  xargs: { "-I": 1, "-n": 1, "-P": 1, "-d": 1, "-L": 1, "-s": 1, "-a": 1, "-E": 1 },
  env: { "-u": 1, "-C": 1, "--unset": 1, "--chdir": 1 },
  timeout: { "-s": 1, "-k": 1, "--signal": 1, "--kill-after": 1 },
  watch: { "-n": 1, "-d": 0 },
});

/**
 * Peel wrappers off a command. Returns the inner command words, or a script string when
 * the wrapper runs a string (bash -c, eval, env -S).
 * @param {string[]} words
 * @returns {{ words: string[] } | { script: string }}
 */
function unwrap(words) {
  let w = words;
  for (let guard = 0; guard < 16; guard++) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    const name = base(w[0]);
    if (name === "eval") return { script: w.slice(1).join(" ") };
    if (SHELLS.has(name)) {
      const i = w.findIndex((a, j) => j > 0 && (/^-[a-zA-Z]*c$/.test(a) || a === "-Command"));
      if (i > 0 && w[i + 1] !== undefined) return { script: w[i + 1] };
      return { words: w };
    }
    const options = WRAPPERS[name];
    if (!options) return { words: w };
    let i = 1;
    while (i < w.length) {
      const a = w[i];
      if (name === "env" && (a === "-S" || a === "--split-string")) {
        return { script: w.slice(i + 1).join(" ") };
      }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) i++;
      else if (a in options) i += 1 + options[a];
      else if (a.startsWith("-") && a !== "-") i++;
      else break;
    }
    if (name === "timeout" || name === "watch") i++; // the duration / interval
    w = w.slice(i);
  }
  return { words: w };
}

/** Git global options that take a value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
/** Git commands an alias can't shadow (git ignores aliases with these names). */
const GIT_BUILTINS = new Set(
  (
    "add am apply bisect blame branch checkout cherry-pick clean clone commit config describe " +
    "diff fetch filter-branch format-patch gc grep init log merge mv notes pull push rebase " +
    "reflog remote replace reset restore revert rm show stash status submodule switch tag " +
    "update-ref worktree"
  ).split(" "),
);

/** @returns {{ dir: string, configs: string[], args: string[] }} */
function gitParts(/** @type {string[]} */ words, /** @type {string} */ cwd) {
  let dir = cwd;
  const configs = [];
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    const a = words[i];
    if (a === "-C") dir = path.resolve(dir, words[i + 1] ?? ".");
    if (a === "-c") configs.push(words[i + 1] ?? "");
    if (a.startsWith("--config-env")) configs.push(a);
    i += GIT_VALUE_OPTIONS.has(a) ? 2 : 1;
  }
  return { dir, configs, args: words.slice(i) };
}

/** Why a `git push` is not allowed, or null. */
function checkPush(/** @type {string[]} */ args, /** @type {string} */ dir) {
  /** @type {string[]} */
  const operands = [];
  /** @type {string[]} */
  const options = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) operands.push(a);
    else {
      options.push(a);
      if (["--repo", "-o", "--push-option", "--receive-pack", "--exec"].includes(a)) i++;
    }
  }
  if (
    options.some(
      (o) =>
        o === "-f" ||
        o === "--force" ||
        o.startsWith("--force-with-lease") ||
        o === "--force-if-includes" ||
        (/^-[a-zA-Z]+$/.test(o) && o.includes("f")),
    )
  ) {
    return "Blocked: force pushes rewrite shared history. Push new commits instead.";
  }
  if (options.some((o) => o === "--all" || o === "--mirror" || o === "--delete" || o === "-d")) {
    return "Blocked: push one branch at a time; no --all, --mirror, or deleting branches.";
  }
  const refspecs = operands.slice(1); // the first operand is the remote
  if (refspecs.some((r) => r.startsWith("+") || r.startsWith(":"))) {
    return "Blocked: a + refspec is a force push and :branch deletes one. Push new commits instead.";
  }
  const branch = currentBranch(dir);
  const targets = refspecs
    .map((r) => (r.includes(":") ? r.split(":").pop() : r) ?? "")
    .map((t) => (t === "HEAD" || t === "@" ? branch : t));
  const pushesProtected =
    targets.some((t) => PROTECTED_BRANCHES.has(t.replace(/^refs\/heads\//, ""))) ||
    (refspecs.length === 0 && PROTECTED_BRANCHES.has(branch));
  if (pushesProtected) {
    return (
      "Blocked: nothing goes to main except through a pull request. Push your branch and " +
      "open a PR; a human merges it once the checks and the review pass."
    );
  }
  return null;
}

/** Why a history rewrite on a locked fix/* branch is not allowed, or null. */
function checkHistory(/** @type {string[]} */ args, /** @type {string} */ dir) {
  const [sub, ...rest] = args;
  const rewrites =
    ["reset", "rebase", "filter-branch", "filter-repo", "replace", "update-ref"].includes(sub) ||
    (sub === "commit" && rest.some((a) => a === "--amend" || a.startsWith("--fixup"))) ||
    (["checkout", "switch"].includes(sub) &&
      rest.some((a) => ["-B", "-C", "--force-create"].includes(a))) ||
    (sub === "branch" && rest.some((a) => /^-[a-zA-Z]*[fDM]/.test(a) || a === "--force"));
  if (rewrites && testLock(dir).locked) {
    return (
      `Blocked: git ${sub} rewrites history on a branch whose tests are locked, which would ` +
      "unlock them. Keep the reproduction commit and add new commits on top."
    );
  }
  return null;
}

/** Why a `gh` command is not allowed, or null. */
function checkGh(/** @type {string[]} */ words) {
  /** @type {string[]} */
  const args = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i];
    if (a === "-R" || a === "--repo" || a === "--hostname") i++;
    else if (!a.startsWith("--repo=")) args.push(a);
  }
  const [sub, action] = args;
  const text = words.join(" ");
  if (sub === "pr" && action === "merge") {
    return (
      "Blocked: agents don't merge. A human merges after the checks and the fresh-context " +
      "review pass. Stop here and report that the PR is ready."
    );
  }
  if (sub === "pr" && action === "review" && args.some((a) => a === "--approve" || a === "-a")) {
    return "Blocked: agents don't approve pull requests. Approval is the human's step.";
  }
  if (sub === "api") {
    if (
      /\/pulls\/\d+\/(merge|reviews)\b|\/merges\b|\/statuses\/|\/check-(runs|suites)|\/rulesets|\/protection|\/actions\/secrets|\/environments/.test(
        text,
      ) ||
      /mergePullRequest|enablePullRequestAutoMerge|createCommitStatus|(create|update)CheckRun|(add|submit)PullRequestReview|RepositoryRuleset|BranchProtectionRule/.test(
        text,
      )
    ) {
      return (
        "Blocked: merging, approving, posting statuses or checks, and changing rules or " +
        "secrets go through people and CI, not agent API calls."
      );
    }
  }
  if (
    (sub === "secret" && action !== "list") ||
    (sub === "ruleset" && !["list", "view", "check"].includes(action ?? "")) ||
    (sub === "repo" && ["edit", "delete", "rename", "archive"].includes(action ?? "")) ||
    (sub === "workflow" && action === "disable")
  ) {
    return `Blocked: gh ${sub} ${action} changes repo settings, which is the owner's job.`;
  }
  return null;
}

/** Files a command writes, removes, renames, links, or restores from another ref. */
function writtenPaths(/** @type {string[]} */ words, /** @type {string[]} */ redirects) {
  const paths = [...redirects];
  const [cmd, ...rest] = words;
  const operands = rest.filter((a) => !a.startsWith("-"));
  const name = base(cmd);
  const optionValue = (/** @type {string[]} */ names) =>
    rest.flatMap((a, i) => {
      for (const n of names) {
        if (a === n && rest[i + 1]) return [rest[i + 1]];
        if (a.startsWith(`${n}=`)) return [a.slice(n.length + 1)];
      }
      return [];
    });

  if (["tee", "rm", "rmdir", "unlink", "truncate", "touch", "shred", "mkdir"].includes(name)) {
    paths.push(...operands);
  } else if (["chmod", "chown", "chgrp"].includes(name)) {
    paths.push(...operands.slice(1));
  } else if (name === "mv" || name === "ln") {
    paths.push(...operands); // ln: both the link and what it points at
  } else if (["cp", "install", "rsync", "scp"].includes(name)) {
    paths.push(...operands.slice(-1), ...optionValue(["-t", "--target-directory"]));
  } else if (name === "dd") {
    paths.push(...rest.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
  } else if (
    (name === "sed" || name === "perl") &&
    rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))
  ) {
    paths.push(...operands);
  } else if (name === "git") {
    const { args } = gitParts(words, ".");
    const [sub, ...gitRest] = args;
    const gitOperands = gitRest.filter((a) => !a.startsWith("-"));
    if (sub === "rm" || sub === "mv" || sub === "clean") {
      paths.push(...(gitOperands.length || sub !== "clean" ? gitOperands : ["."]));
    } else if (sub === "checkout" || sub === "restore") {
      // Restoring from the index or HEAD is harmless. Pulling files from another ref is a write.
      const source = optionValue(["-s", "--source"]);
      const dashdash = gitRest.indexOf("--");
      const plain = gitRest.filter(
        (a, i) => !a.startsWith("-") && !["-s", "--source"].includes(gitRest[i - 1] ?? ""),
      );
      let ref = source[0] ?? "";
      let files = plain;
      if (dashdash >= 0) {
        const before = gitRest.slice(0, dashdash).filter((a) => !a.startsWith("-"));
        files = gitRest.slice(dashdash + 1);
        ref ||= before.filter((a) => !source.includes(a))[0] ?? "";
      } else if (!ref && plain.length > 1) {
        [ref, ...files] = plain;
      }
      if (ref && ref !== "HEAD") paths.push(...files);
    }
  } else if (
    name === "npm" &&
    [
      "pkg",
      "set-script",
      "install",
      "i",
      "add",
      "uninstall",
      "remove",
      "rm",
      "update",
      "up",
    ].includes(rest[0] ?? "")
  ) {
    if (rest[0] === "pkg" || rest[0] === "set-script" || operands.length > 1)
      paths.push("package.json");
  }
  return paths;
}

/** Interpreters that run inline code, with the flags that introduce it. */
const INLINE = /** @type {Record<string, string[]>} */ ({
  node: ["-e", "--eval", "-p", "--print"],
  python: ["-c"],
  python3: ["-c"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  bun: ["-e", "--eval"],
  deno: ["eval"],
});
const GATE_MENTION =
  /\.claude|\.github|\bhooks\b|node_modules|KNOWN_BUGS|package(-lock)?\.json|tsconfig|\.prettier|scripts\/(verify|check-test-lock|review|ci-review|run-reviewer|agent-)/;
const TEST_MENTION = /\btest\/|\.test\./;
const ENV_MENTION = /\.env(rc|\.|\b)(?!\.example|\.sample)/;

/** Why inline interpreter code is not allowed, or null. */
function checkInline(/** @type {string[]} */ words, /** @type {() => boolean} */ locked) {
  const flags = INLINE[base(words[0])];
  if (!flags) return null;
  const i = words.findIndex((w, j) => j > 0 && flags.includes(w));
  if (i < 0) return null;
  const code = words.slice(i + 1).join(" ");
  if (GATE_MENTION.test(code)) return `Blocked: inline code that touches the gates. ${GATE_REASON}`;
  if (ENV_MENTION.test(code)) return "Blocked: inline code that touches a .env file.";
  if (TEST_MENTION.test(code) && locked())
    return `Blocked: inline code that touches tests. ${LOCKED_TEST_REASON}`;
  return null;
}

/**
 * Why a command line is not allowed, or null.
 * @param {string} line
 * @param {string} root the repo root
 * @param {string} [cwd] where the command runs (the hook input's cwd)
 * @param {number} [depth]
 * @returns {string | null}
 */
export function check(line, root, cwd = root, depth = 0) {
  if (depth > MAX_DEPTH) return "Blocked: commands nested this deeply can't be checked.";
  const secret = findSecret(line);
  if (secret) {
    return `Blocked: this command contains what looks like ${secret}. Read credentials from the vault at run time.`;
  }
  if (
    /api\.github\.com|github\.com\/graphql|uploads\.github\.com/.test(line) &&
    !/^\s*gh\s/.test(line)
  ) {
    return "Blocked: call GitHub through gh, not curl or wget, so the guard can see what the call does.";
  }

  let here = cwd;
  for (const command of parse(line)) {
    const inner = unwrap(command.words);
    if ("script" in inner) {
      const reason = check(inner.script, root, here, depth + 1);
      if (reason) return reason;
      continue;
    }
    let words = inner.words;
    const name = base(words[0]);

    if ((name === "cd" || name === "pushd") && command.redirects.length === 0) {
      const target = words[1];
      here = target && target !== "-" ? path.resolve(here, target) : process.env.HOME || here;
      continue;
    }

    let dir = here;
    if (name === "git") {
      const parts = gitParts(words, here);
      dir = parts.dir;
      if (parts.configs.some((c) => /^alias\./i.test(c) || c.startsWith("--config-env"))) {
        return "Blocked: inline git config (-c alias.* or --config-env) can hide what a command does.";
      }
      let args = parts.args;
      if (args[0] === "config" && args.some((a) => /^alias\./i.test(a))) {
        return "Blocked: agents don't define git aliases; they can hide what a command does.";
      }
      if (args[0] && !GIT_BUILTINS.has(args[0])) {
        let alias = "";
        try {
          alias = git(dir, ["config", "--get", `alias.${args[0]}`]);
        } catch {
          // not an alias
        }
        if (alias.startsWith("!")) {
          const reason = check(
            `${alias.slice(1)} ${args.slice(1).join(" ")}`,
            root,
            dir,
            depth + 1,
          );
          if (reason) return reason;
          continue;
        }
        if (alias) args = [...(parse(alias)[0]?.words ?? []), ...args.slice(1)];
      }
      words = ["git", ...args];
      if (args[0] === "push") {
        const reason = checkPush(args, dir);
        if (reason) return reason;
      }
      const reason = checkHistory(args, dir);
      if (reason) return reason;
    }

    if (name === "gh") {
      const reason = checkGh(words);
      if (reason) return reason;
    }

    const lockedHere = () => testLock(root).locked;
    const inline = checkInline(words, lockedHere);
    if (inline) return inline;

    for (const target of writtenPaths(words, command.redirects)) {
      for (const rel of repoPaths(root, dir, target)) {
        if (touchesGate(rel)) return `Blocked: ${rel || "the repo root"}. ${GATE_REASON}`;
        if (isEnvFile(rel)) return `Blocked: ${rel}. Secrets don't go in .env files in this repo.`;
        if (touchesTests(rel) && lockedHere()) {
          return `Blocked: ${rel || "the repo root"}. ${LOCKED_TEST_REASON}`;
        }
      }
    }
  }
  return null;
}

/**
 * PowerShell syntax differs from POSIX shells, so it gets the conservative treatment: the
 * git and gh checks above, plus a block on any command that names a protected path at all.
 */
export function checkPowerShell(
  /** @type {string} */ line,
  /** @type {string} */ root,
  /** @type {string} */ cwd = root,
) {
  const reason = check(line, root, cwd);
  if (reason) return reason;
  for (const { words } of parse(line)) {
    for (const w of words.slice(1)) {
      if (w.startsWith("-")) continue;
      for (const rel of repoPaths(root, cwd, w)) {
        if (rel !== "" && touchesGate(rel)) return `Blocked: ${rel}. ${GATE_REASON}`;
        if (isEnvFile(rel)) return `Blocked: ${rel}. Secrets don't go in .env files in this repo.`;
        if (rel !== "" && touchesTests(rel) && testLock(root).locked) {
          return `Blocked: ${rel}. ${LOCKED_TEST_REASON}`;
        }
      }
    }
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  guarded(() => {
    const input = readInput();
    const command = input.tool_input?.command;
    if (typeof command !== "string") return; // e.g. a Monitor WebSocket watch
    const root = projectDir(input);
    const cwd = input.cwd || root;
    const reason =
      input.tool_name === "PowerShell"
        ? checkPowerShell(command, root, cwd)
        : check(command, root, cwd);
    if (reason) deny(reason);
  });
}
