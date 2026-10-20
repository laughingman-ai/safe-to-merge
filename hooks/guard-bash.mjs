#!/usr/bin/env node
// @ts-check
// PreToolUse (Bash): no pushes to main, no force pushes, no merging, and no shell writes
// to the gates, locked tests, or .env files.
//
// Shell parsing here is deliberately simple. It catches the ordinary ways an agent would
// do these things; CI (verify, check-test-lock), CODEOWNERS, and the rules on main are
// the backstop for anything it misses.

import { pathToFileURL } from "node:url";

import {
  currentBranch,
  deny,
  GATE_REASON,
  isEnvFile,
  isGatePath,
  isTestPath,
  LOCKED_TEST_REASON,
  projectDir,
  readInput,
  repoPath,
  testLock,
} from "./lib.mjs";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * Split a command line into simple commands. Each command is a list of words plus any
 * redirect targets. Quotes are honored; substitutions and heredocs are not expanded.
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
    else words.push(word);
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
      else word += c;
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
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
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

/** Drop leading `VAR=value` assignments and wrappers like `sudo`, `env`, `command`. */
function stripPrefix(/** @type {string[]} */ words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === "sudo" || w === "env" || w === "command") i++;
    else break;
  }
  return words.slice(i);
}

/** The git subcommand and its arguments, skipping global options like `-C dir`. */
function gitArgs(/** @type {string[]} */ words) {
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    i += ["-C", "-c", "--git-dir", "--work-tree"].includes(words[i]) ? 2 : 1;
  }
  return words.slice(i);
}

/** Why a `git push` is not allowed, or null. */
function checkPush(/** @type {string[]} */ args, /** @type {string} */ root) {
  const options = args.slice(1).filter((a) => a.startsWith("-"));
  const operands = args.slice(1).filter((a) => !a.startsWith("-"));
  if (options.some((o) => o === "-f" || o === "--force" || o.startsWith("--force-with-lease"))) {
    return "Blocked: force pushes rewrite shared history. Push new commits instead.";
  }
  if (options.some((o) => o === "--all" || o === "--mirror")) {
    return "Blocked: push one branch at a time, never --all or --mirror.";
  }
  const refspecs = operands.slice(1); // the first operand is the remote
  if (refspecs.some((r) => r.startsWith("+"))) {
    return "Blocked: a + refspec is a force push. Push new commits instead.";
  }
  const branch = currentBranch(root);
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

/** Files a command writes, removes, or rewrites. */
function writtenPaths(/** @type {string[]} */ words, /** @type {string[]} */ redirects) {
  const paths = [...redirects];
  const [cmd, ...rest] = words;
  const operands = rest.filter((a) => !a.startsWith("-"));
  const name = (cmd ?? "").split("/").pop();
  if (name === "tee" || name === "rm" || name === "truncate" || name === "touch") {
    paths.push(...operands);
  } else if (name === "mv" || name === "cp" || name === "ln") {
    paths.push(...(name === "mv" ? operands : operands.slice(-1)));
  } else if ((name === "sed" || name === "perl") && rest.some((a) => /^-[a-z]*i/.test(a))) {
    paths.push(...operands.slice(1)); // the first operand is the script
  } else if (name === "git") {
    const [sub, ...gitRest] = gitArgs(words);
    if (["checkout", "restore", "rm", "mv"].includes(sub ?? "")) {
      paths.push(...gitRest.filter((a) => !a.startsWith("-")));
    }
  }
  return paths;
}

/** Why a command line is not allowed, or null. */
export function check(/** @type {string} */ line, /** @type {string} */ root) {
  for (const { words: raw, redirects } of parse(line)) {
    const words = stripPrefix(raw);
    const [cmd] = words;

    if (cmd === "git") {
      const args = gitArgs(words);
      if (args[0] === "push") {
        const reason = checkPush(args, root);
        if (reason) return reason;
      }
    }
    if (cmd === "gh") {
      const merging =
        (words[1] === "pr" && words[2] === "merge") ||
        (words[1] === "api" && words.some((w) => /\/pulls\/\d+\/merge\b|\/merges\b/.test(w)));
      if (merging) {
        return (
          "Blocked: agents don't merge. A human merges after the checks and the fresh-context " +
          "review pass. Stop here and report that the PR is ready."
        );
      }
    }

    for (const target of writtenPaths(words, redirects)) {
      const rel = repoPath(root, target);
      if (isGatePath(rel)) return `Blocked: ${rel}. ${GATE_REASON}`;
      if (isEnvFile(rel ?? target)) {
        return `Blocked: ${rel ?? target}. Secrets don't go in .env files in this repo.`;
      }
      if (isTestPath(rel) && testLock(root).locked) return `Blocked: ${rel}. ${LOCKED_TEST_REASON}`;
    }
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const input = readInput();
  const command = input.tool_input?.command;
  if (typeof command === "string") {
    const reason = check(command, projectDir(input));
    if (reason) deny(reason);
  }
  process.exit(0);
}
