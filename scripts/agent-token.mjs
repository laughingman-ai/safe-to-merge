#!/usr/bin/env node
// @ts-check
// Mint a GitHub App installation token for the agent identity and print it to stdout.
// The token lasts one hour, is scoped to this repository, and carries only the permissions
// below. It can push branches (including workflow changes), open PRs, and comment. It can't
// merge past the rules on main, approve its own PRs, post statuses or checks, or change
// settings. It may push workflow changes because both workflows run on pull_request_target
// (a PR's edits to them don't run before merge), and the reviewer's API key is a secret of
// the `reviewer` environment, which only main can use. A workflow a PR adds can't read it.
//
// Env: AGENT_APP_ID, AGENT_APP_INSTALLATION_ID, AGENT_APP_PRIVATE_KEY (PEM text, injected
// from the vault by scripts/agent-session.sh; never stored in a file).
// Optional: AGENT_REPO (default laughingman-ai/safe-to-merge).

import { createSign } from "node:crypto";

const appId = process.env.AGENT_APP_ID;
const installationId = process.env.AGENT_APP_INSTALLATION_ID;
const privateKey = process.env.AGENT_APP_PRIVATE_KEY;
const repo = process.env.AGENT_REPO ?? "laughingman-ai/safe-to-merge";
if (!appId || !installationId || !privateKey) {
  console.error("agent-token: set AGENT_APP_ID, AGENT_APP_INSTALLATION_ID, AGENT_APP_PRIVATE_KEY");
  process.exit(1);
}

/** The permissions the token asks for. Never more than the App was granted. */
export const PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  workflows: "write",
  metadata: "read",
};

const b64url = (/** @type {string | Buffer} */ v) => Buffer.from(v).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
const jwt = `${header}.${payload}.${b64url(signature)}`;

const response = await fetch(
  `https://api.github.com/app/installations/${installationId}/access_tokens`,
  {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions: PERMISSIONS }),
  },
);
if (!response.ok) {
  console.error(`agent-token: GitHub returned ${response.status}: ${await response.text()}`);
  process.exit(1);
}
const { token } = /** @type {{ token: string }} */ (await response.json());
process.stdout.write(token);
