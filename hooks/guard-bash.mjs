#!/usr/bin/env node
// @ts-check
// PreToolUse (Bash|Monitor|PowerShell). Defense in depth: this catches the common shortcuts
// an agent takes (pushing to main, merging, rewriting a locked branch, touching the gates,
// leaking a token). It is not the boundary. The boundary is CI with checks bound to GitHub
// Actions, the rules on main, CODEOWNERS, and the agent's separate GitHub App identity.
//
// Rather than recognize every dangerous command, it applies a conservative policy:
//   1. Commands whose name comes from an expansion, interpreters fed from stdin (pipes,
//      heredocs, here-strings, `<`, `-`, process substitution), and `source`/`.` are blocked.
//   2. A command that can write (anything not on the short read-only list) is blocked if its
//      arguments use shell expansion ($, backticks, ~, {a,b}), if a glob could reach a gate,
//      or if it names a gate (or a locked test). Destructive commands also may not name a
//      directory that contains a gate, or the repo root.
//   3. `gh api` with any method but GET, any fields, --input, or graphql; `gh alias`; and gh
//      commands it doesn't recognize (aliases, extensions) are blocked outright.
// On top of that: no pushes to main or force pushes, no history rewrites on a locked fix/*
// branch, no credentials in commands, and nothing that prints the session's tokens.
//
// What it can't see: a script file the agent writes and then runs, or values computed at
// run time and passed through variables or pipes into a command it allows. That's accepted
// risk, covered by the layers above.

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
 * @typedef {{ text: string, expand: boolean, glob: boolean }} Word
 *   expand: the word uses $, a backtick, ~, brace expansion, or a substitution outside
 *   single quotes, so its final value isn't known until the shell runs.
 * @typedef {{ words: Word[], redirects: Word[], stdin: "" | "pipe" | "heredoc" | "herestring" | "file" }} Command
 */

/** Remove heredoc bodies, so their text isn't read as commands. */
function stripHeredocs(/** @type {string} */ line) {
  const lines = line.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const delimiters = [
      ...lines[i].matchAll(/(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g),
    ];
    for (const [, dash, , delimiter] of delimiters) {
      while (i + 1 < lines.length) {
        i++;
        const body = dash ? lines[i].replace(/^\t+/, "") : lines[i];
        if (body === delimiter) break;
      }
    }
  }
  return out.join("\n");
}

/** Index of the `)` that closes the `(` before `start`, honoring quotes and nesting. */
function closing(/** @type {string} */ s, /** @type {number} */ start) {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "'") i = s.indexOf("'", i + 1) < 0 ? s.length : s.indexOf("'", i + 1);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return s.length;
}

/**
 * Split a command line into simple commands. Quotes are honored. Substitutions ($(…),
 * backticks, <(…), >(…)) mark the word that contains them as expanding, and their contents
 * are parsed and returned as commands of their own.
 * @param {string} input
 * @returns {Command[]}
 */
export function parse(input) {
  const line = stripHeredocs(input);
  /** @type {Command[]} */
  const commands = [];
  /** @type {Command[]} */
  const nested = [];
  /** @type {Word[]} */
  let words = [];
  /** @type {Word[]} */
  let redirects = [];
  /** @type {Command["stdin"]} */
  let stdin = "";
  /** @type {Word | null} */
  let word = null;
  /** @type {"" | "out" | "in" | "heredoc" | "herestring"} */
  let pending = "";
  let quote = "";
  let raw = ""; // the word's unquoted characters, for brace and tilde detection

  const cur = () => (word ??= { text: "", expand: false, glob: false });
  const endWord = () => {
    if (!word) return;
    if (/[{].*[,.].*[}]/.test(raw) || /(^|[=:])~/.test(raw)) word.expand = true;
    if (pending === "out") redirects.push(word);
    else if (pending === "in") stdin ||= "file";
    else if (pending === "heredoc") stdin = "heredoc";
    else if (pending === "herestring") stdin = "herestring";
    else if (word.text !== "{" && word.text !== "}") words.push(word);
    word = null;
    raw = "";
    pending = "";
  };
  const endCommand = (/** @type {boolean} */ pipeNext = false) => {
    endWord();
    if (words.length || redirects.length) commands.push({ words, redirects, stdin });
    words = [];
    redirects = [];
    stdin = pipeNext ? "pipe" : "";
  };
  const substitute = (/** @type {number} */ from, /** @type {string} */ marker) => {
    const end = closing(line, from);
    nested.push(...parse(line.slice(from, end)));
    const w = cur();
    w.text += marker;
    w.expand = true;
    return end;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else cur().text += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && i + 1 < line.length) cur().text += line[++i];
      else if (c === "$" && line[i + 1] === "(") i = substitute(i + 2, "$(…)");
      else if (c === "`") {
        const end = line.indexOf("`", i + 1) < 0 ? line.length : line.indexOf("`", i + 1);
        nested.push(...parse(line.slice(i + 1, end)));
        Object.assign(cur(), { expand: true }).text += "`…`";
        i = end;
      } else {
        if (c === "$") cur().expand = true;
        cur().text += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur();
    } else if (c === "\\" && i + 1 < line.length) {
      cur().text += line[++i];
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "$" && line[i + 1] === "(") {
      i = substitute(i + 2, "$(…)");
    } else if ((c === "<" || c === ">") && line[i + 1] === "(") {
      i = substitute(i + 2, `${c}(…)`);
    } else if (c === "`") {
      const end = line.indexOf("`", i + 1) < 0 ? line.length : line.indexOf("`", i + 1);
      nested.push(...parse(line.slice(i + 1, end)));
      Object.assign(cur(), { expand: true }).text += "`…`";
      i = end;
    } else if (c === "|" && line[i + 1] !== "|") {
      if (line[i + 1] === "&") i++;
      endCommand(true);
    } else if (c === "|" || c === ";" || c === "\n" || c === "(" || c === ")") {
      if (c === "|") i++;
      endCommand();
    } else if (c === "&") {
      if (line[i + 1] === ">") continue; // &> is a redirect
      if (line[i + 1] === "&") i++;
      endCommand();
    } else if (c === ">") {
      const fd = /** @type {Word | null} */ (word);
      if (fd && /^\d$/.test(fd.text) && !fd.expand) {
        word = null; // a file descriptor number, e.g. 2>
        raw = "";
      } else endWord();
      if (line[i + 1] === ">" || line[i + 1] === "|") i++;
      if (line[i + 1] === "&") {
        i++; // >&2 duplicates a descriptor; no file is written
        while (/[\d-]/.test(line[i + 1] ?? "")) i++;
        continue;
      }
      pending = "out";
    } else if (c === "<") {
      endWord();
      if (line[i + 1] === "<" && line[i + 2] === "<") {
        i += 2;
        pending = "herestring";
      } else if (line[i + 1] === "<") {
        i++;
        if (line[i + 1] === "-") i++;
        pending = "heredoc";
      } else pending = "in";
    } else {
      const w = cur();
      if (c === "$") w.expand = true;
      if (c === "*" || c === "?" || c === "[") w.glob = true;
      w.text += c;
      raw += c;
    }
  }
  endCommand();
  return [...commands, ...nested];
}

const base = (/** @type {string | undefined} */ w) => (w ?? "").split(/[\\/]/).pop() ?? "";
const texts = (/** @type {Word[]} */ ws) => ws.map((w) => w.text);
const isAssignment = (/** @type {Word} */ w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);

const INTERPRETERS = new Set(
  (
    "sh bash zsh dash ksh mksh fish csh tcsh busybox node nodejs python python2 python3 " +
    "perl ruby php lua deno bun pwsh powershell tclsh osascript"
  ).split(" "),
);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "pwsh", "powershell"]);

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
  env: { "-u": 1, "-C": 1, "--unset": 1, "--chdir": 1 },
  timeout: { "-s": 1, "-k": 1, "--signal": 1, "--kill-after": 1 },
  watch: { "-n": 1 },
});

/**
 * Peel wrappers off a command. Returns the inner words, a script string when the wrapper
 * runs one (bash -c, eval, env -S), or a reason to block.
 * @returns {{ words: Word[] } | { script: string } | { block: string }}
 */
function unwrap(/** @type {Word[]} */ words) {
  let w = words;
  for (let guard = 0; guard < 16; guard++) {
    while (w.length && isAssignment(w[0])) w = w.slice(1);
    const name = base(w[0]?.text);
    if (name === "eval") {
      if (w.slice(1).some((x) => x.expand))
        return { block: "Blocked: eval of an expansion can't be checked." };
      return { script: texts(w.slice(1)).join(" ") };
    }
    if (SHELLS.has(name)) {
      const i = w.findIndex(
        (a, j) => j > 0 && (/^-[a-zA-Z]*c$/.test(a.text) || a.text === "-Command"),
      );
      if (i > 0 && w[i + 1]) {
        if (w[i + 1].expand)
          return { block: "Blocked: a shell running an expanded string can't be checked." };
        return { script: w[i + 1].text };
      }
      return { words: w };
    }
    const options = WRAPPERS[name];
    if (!options) return { words: w };
    let i = 1;
    while (i < w.length) {
      const a = w[i].text;
      if (name === "env" && (a === "-S" || a === "--split-string")) {
        return { script: texts(w.slice(i + 1)).join(" ") };
      }
      if (name === "env" && isAssignment(w[i])) i++;
      else if (a in options) i += 1 + options[a];
      else if (a.startsWith("-") && a !== "-") i++;
      else break;
    }
    if (name === "timeout" || name === "watch") i++; // the duration / interval
    if (i >= w.length) return { words: w.slice(0, 1) }; // e.g. bare `env`: prints the environment
    w = w.slice(i);
  }
  return { words: w };
}

/** Read-only commands: they can't write without a redirect, so their arguments aren't checked. */
const READ_ONLY = new Set(
  "cat ls grep egrep fgrep rg head tail wc diff echo printf pwd true false test [ which type sleep".split(
    " ",
  ),
);
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files"]);
/** Commands that destroy or overwrite: these may not even name a directory that holds a gate. */
const DESTRUCTIVE = new Set(
  (
    "rm rmdir unlink mv cp ln install rsync scp find chmod chown chgrp sed perl awk gawk dd " +
    "truncate shred tee touch mkdir tar unzip patch"
  ).split(" "),
);
const GIT_DESTRUCTIVE = new Set([
  "rm",
  "mv",
  "clean",
  "checkout",
  "restore",
  "reset",
  "apply",
  "am",
  "stash",
]);

/** Environment variables that hold this session's credentials. */
const TOKEN_VARS =
  /\b(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|ANTHROPIC_API_KEY|AGENT_APP_PRIVATE_KEY|OP_SESSION\w*)\b/;

/** Git global options that take a value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
/** Git commands an alias can't shadow (git ignores aliases with these names). */
const GIT_BUILTINS = new Set(
  (
    "add am apply bisect blame branch checkout cherry-pick clean clone commit config describe " +
    "diff fetch filter-branch format-patch gc grep init log ls-files merge mv notes pull push " +
    "rebase reflog remote replace reset restore rev-parse revert rm show stash status " +
    "submodule switch tag update-ref worktree"
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

const GH_COMMANDS = new Set(
  (
    "pr issue repo run workflow api auth browse search status release label cache gist project " +
    "ruleset secret variable extension config org help codespace attestation gpg-key ssh-key " +
    "completion alias"
  ).split(" "),
);

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
  if (sub === undefined || sub.startsWith("-")) return null;
  if (!GH_COMMANDS.has(sub)) {
    return `Blocked: gh ${sub} isn't a gh command this guard knows, so it may be an alias or an extension.`;
  }
  if (sub === "alias")
    return "Blocked: agents don't define or use gh aliases; they hide what a command does.";
  if (sub === "extension" && !["list", "search", "browse"].includes(action ?? "")) {
    return "Blocked: gh extensions run code this guard can't see.";
  }
  if (
    sub === "auth" &&
    (action !== "status" || args.some((a) => a === "-t" || a === "--show-token"))
  ) {
    return "Blocked: gh auth commands can print or change the session's credentials.";
  }
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
    const method = args.flatMap((a, i) =>
      a === "-X" || a === "--method"
        ? [args[i + 1] ?? ""]
        : a.startsWith("--method=")
          ? [a.slice(9)]
          : a.startsWith("-X") && a.length > 2
            ? [a.slice(2)]
            : [],
    );
    const sendsData = args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)|^-[fF]./.test(a));
    if (args.includes("graphql")) return "Blocked: agents don't call the GitHub GraphQL API.";
    if (sendsData || method.some((m) => m.toUpperCase() !== "GET")) {
      return "Blocked: agents only read through gh api (GET with no fields). Writes go through gh commands the guard checks, or through people.";
    }
  }
  if (
    (sub === "secret" && action !== "list") ||
    (sub === "variable" && action !== "list") ||
    (sub === "ruleset" && !["list", "view", "check"].includes(action ?? "")) ||
    (sub === "repo" &&
      ["edit", "delete", "rename", "archive", "unarchive"].includes(action ?? "")) ||
    (sub === "workflow" && (action === "disable" || action === "enable"))
  ) {
    return `Blocked: gh ${sub} ${action} changes repo settings, which is the owner's job.`;
  }
  return null;
}

/** Option values that are free text (commit messages, PR titles and bodies), not paths. */
function messageValues(/** @type {string[]} */ words) {
  const name = base(words[0]);
  const free = new Set();
  for (let i = 1; i < words.length; i++) {
    const a = words[i];
    const takesText =
      (name === "git" && (/^-[a-zA-Z]*m$/.test(a) || a === "--message")) ||
      (name === "gh" &&
        ["-t", "--title", "-b", "--body", "-m", "--message", "--subject"].includes(a));
    if (takesText) free.add(i + 1);
  }
  return free;
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
  /\.claude|\.github|\bhooks\b|node_modules|KNOWN_BUGS|package(-lock)?\.json|tsconfig|\.prettier|scripts\//i;
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

/** Commands that read the environment or credential stores. */
function checkLeak(/** @type {string[]} */ words, /** @type {string} */ line) {
  const name = base(words[0]);
  if (TOKEN_VARS.test(line))
    return "Blocked: this command uses the session's credentials directly.";
  if (
    name === "printenv" ||
    (name === "env" && words.length === 1) ||
    (["set", "export", "declare", "typeset"].includes(name) &&
      (words.length === 1 ||
        (name !== "set" && words.length === 2 && /^-[px]+$/.test(words[1])))) ||
    /\/proc\/[^/\s]+\/environ|\.git-credentials|\.config\/gh|hosts\.yml/.test(line) ||
    (name === "git" && words.includes("credential"))
  ) {
    return "Blocked: this command could print the session's environment or credentials into the transcript.";
  }
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
  const lockedRoot = () => testLock(root).locked;

  let here = cwd;
  for (const command of parse(line)) {
    const inner = unwrap(command.words);
    if ("block" in inner) return inner.block;
    if ("script" in inner) {
      const reason = check(inner.script, root, here, depth + 1);
      if (reason) return reason;
      continue;
    }
    const ws = inner.words;
    if (ws.length === 0) {
      // only assignments (X=1); a redirect alone (> file) still writes
      if (command.redirects.length === 0) continue;
    }
    if (ws[0]?.expand)
      return "Blocked: the command name comes from an expansion, so it can't be checked.";
    let words = texts(ws);
    const name = base(words[0]);

    const leak = checkLeak(words, line);
    if (leak) return leak;

    // 1. Interpreters fed from stdin, and sourcing files.
    if (name === "source" || name === ".") {
      return "Blocked: source runs a file in this shell, and the guard can't see what it does.";
    }
    if (
      INTERPRETERS.has(name) &&
      (command.stdin !== "" ||
        words.slice(1).some((a) => a === "-" || a === "/dev/stdin" || a === "-s") ||
        ws.slice(1).some((a) => /^[<>]\(…\)/.test(a.text)))
    ) {
      return `Blocked: ${name} reading a program from a pipe, heredoc, or stream can't be checked. Run a file, or run the commands directly.`;
    }

    if (name === "cd" || name === "pushd") {
      if (ws.slice(1).some((w) => w.expand))
        return "Blocked: cd to an expansion can't be followed.";
      const target = words[1];
      here = target && target !== "-" ? path.resolve(here, target) : process.env.HOME || here;
      continue;
    }

    let dir = here;
    let gitSub = "";
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
        if (alias) args = [...texts(parse(alias)[0]?.words ?? []), ...args.slice(1)];
      }
      words = ["git", ...args];
      gitSub = args[0] ?? "";
      if (gitSub === "push") {
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
    if (name === "xargs") {
      const rest = words.slice(1).filter((a) => !a.startsWith("-"));
      if (!READ_ONLY.has(base(rest[0]))) {
        return "Blocked: xargs runs a command on paths from its input, which the guard can't see.";
      }
    }
    if (name === "find" && words.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a))) {
      return "Blocked: find -exec runs commands the guard can't see. List the files, then act on them by name.";
    }

    if (
      name === "npm" &&
      words[1] !== undefined &&
      ![
        "ci",
        "test",
        "t",
        "run",
        "run-script",
        "exec",
        "x",
        "ls",
        "list",
        "view",
        "outdated",
        "help",
        "--version",
        "-v",
      ].includes(words[1])
    ) {
      return `Blocked: npm ${words[1]} can change package.json or package-lock.json, which are gates. Use npm ci.`;
    }
    if (name === "git" && gitSub === "clean" && !words.slice(2).some((a) => !a.startsWith("-"))) {
      return `Blocked: git clean with no path reaches the whole repo. ${GATE_REASON}`;
    }

    const inline = checkInline(words, lockedRoot);
    if (inline) return inline;

    // Redirects write, whatever the command.
    for (const r of command.redirects) {
      if (r.expand)
        return "Blocked: a redirect to an expanded path can't be checked. Write to a literal path.";
      const reason = pathReason(root, dir, r.text, true);
      if (reason) return reason;
    }

    // 2. Commands that can write.
    const readOnly =
      READ_ONLY.has(name) || (name === "git" && GIT_READ_ONLY.has(gitSub)) || words.length === 0;
    if (readOnly) continue;

    const free = messageValues(words);
    const runsGateScript =
      ["node", "bash", "sh"].includes(name) &&
      words[1] !== undefined &&
      !words[1].startsWith("-") &&
      repoPaths(root, dir, words[1]).some((rel) => touchesGate(rel, false));
    const testRunner = name === "node" && words.includes("--test");
    const destructive = DESTRUCTIVE.has(name) || (name === "git" && GIT_DESTRUCTIVE.has(gitSub));

    for (let i = 1; i < ws.length; i++) {
      const w = ws[i];
      if (free.has(i)) continue; // free text: may use $(…) and quotes freely
      if (w.expand) {
        return (
          `Blocked: ${name} can write, and "${w.text}" uses shell expansion ($, backticks, ~, ` +
          "{a,b}), so the guard can't tell what it touches. Use literal paths and single quotes."
        );
      }
      if (testRunner || (runsGateScript && i === 1)) continue;
      // A word is a path, or carries one after "=" (--output=x, of=x).
      const eq = w.text.indexOf("=");
      const values = w.text.startsWith("-") ? [] : [w.text];
      if (eq > 0) values.push(w.text.slice(eq + 1));
      for (const value of values.filter(Boolean)) {
        const reason = pathReason(root, dir, value, destructive);
        if (reason) return reason;
      }
    }
  }
  return null;
}

/** Why writing `target` is not allowed, or null. */
function pathReason(
  /** @type {string} */ root,
  /** @type {string} */ dir,
  /** @type {string} */ target,
  /** @type {boolean} */ ancestors,
) {
  for (const rel of repoPaths(root, dir, target)) {
    if (touchesGate(rel, ancestors)) return `Blocked: ${rel || "the repo root"}. ${GATE_REASON}`;
    if (isEnvFile(rel)) return `Blocked: ${rel}. Secrets don't go in .env files in this repo.`;
    if (touchesTests(rel, ancestors) && testLock(root).locked) {
      return `Blocked: ${rel || "the repo root"}. ${LOCKED_TEST_REASON}`;
    }
  }
  return null;
}

/**
 * PowerShell syntax differs from POSIX shells, so it gets the coarse treatment: the checks
 * above, plus a block on any command that names a protected path, runs a string
 * (Invoke-Expression, -EncodedCommand), or reads a credential variable.
 */
export function checkPowerShell(
  /** @type {string} */ line,
  /** @type {string} */ root,
  /** @type {string} */ cwd = root,
) {
  if (/\b(Invoke-Expression|iex)\b|-EncodedCommand|-enc\b|\$env:/i.test(line)) {
    return "Blocked: this PowerShell command runs a string or reads the environment, which the guard can't check.";
  }
  const reason = check(line.replace(/\$\w+/g, "x"), root, cwd);
  if (reason) return reason;
  for (const { words } of parse(line)) {
    for (const w of words.slice(1)) {
      if (w.text.startsWith("-")) continue;
      for (const rel of repoPaths(root, cwd, w.text)) {
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
