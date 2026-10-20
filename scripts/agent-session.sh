#!/usr/bin/env bash
# Start a Claude Code session that acts on GitHub as the agent's own identity, the
# laughingman-agent GitHub App, instead of as the owner. Commits are authored by the App's
# bot user, pushes and PRs use a one-hour installation token, and the session's gh and git
# don't see the owner's stored credentials.
#
# The App has no admin role and isn't a bypass actor on any ruleset, so nothing it does can
# get past the rules on main, and it can't approve its own PRs. The owner approves.
#
# The session never sees the private key, and the shell guard blocks the usual ways of
# printing the token (echo $GH_TOKEN, printenv, env, gh auth token), so it stays out of the
# transcript.
#
# Isolation limit: this hides the owner's credentials from gh and git, but the session runs
# as the same OS user, so a determined agent could still read them from disk or the keyring.
# For hard isolation, run this in a container or as a separate OS user with no owner
# credentials at all. See docs/AGENT_IDENTITY.md.
#
# Usage: scripts/agent-session.sh [claude args...]
# Env:   AGENT_APP_ID, AGENT_APP_INSTALLATION_ID (not secret)
# The 1Password account and item are fixed below on purpose: the key only ever comes from
# the owner's personal account, never from a location set in the environment.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${AGENT_APP_ID:?set AGENT_APP_ID (see docs/AGENT_IDENTITY.md)}"
: "${AGENT_APP_INSTALLATION_ID:?set AGENT_APP_INSTALLATION_ID (see docs/AGENT_IDENTITY.md)}"
readonly OP_ACCOUNT_FIXED="my.1password.com"
readonly KEY_REF_FIXED="op://Private/laughingman-agent GitHub App/private key"
readonly slug="laughingman-agent"

# The private key goes from the vault straight into the minting process; the session only
# ever sees the short-lived token.
token="$(AGENT_APP_PRIVATE_KEY="$(op read --account "$OP_ACCOUNT_FIXED" "$KEY_REF_FIXED")" node "$here/agent-token.mjs")"
bot="${slug}[bot]"
bot_id="$(GH_TOKEN="$token" gh api "/users/${slug}%5Bbot%5D" -q .id)"

session="$(mktemp -d)"
trap 'rm -rf "$session"' EXIT
mkdir "$session/gh"
cat >"$session/gitconfig" <<GITCONFIG
[user]
	name = $bot
	email = ${bot_id}+${bot}@users.noreply.github.com
[credential "https://github.com"]
	helper =
	helper = "!f() { echo username=x-access-token; echo \"password=\$GH_TOKEN\"; }; f"
GITCONFIG

echo "Agent session as $bot. The token expires in one hour; restart this script to renew it." >&2
GH_TOKEN="$token" GH_CONFIG_DIR="$session/gh" GIT_CONFIG_GLOBAL="$session/gitconfig" \
  SAFE_TO_MERGE_AGENT="$bot" claude "$@"
