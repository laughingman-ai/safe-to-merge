# Agent identity and the CI reviewer key

Two owner steps make the rules on `main` hold against an agent, not just guide it:

1. **A separate GitHub identity for the agent**, so the agent never acts with the owner's
   admin token. Without it, the agent and the owner are the same GitHub user: the admin
   bypass on the approval rule is reachable from the agent's session, and nobody else can
   approve the owner's PRs.
2. **An Anthropic API key for the CI reviewer**, so `review/fresh-context` runs in GitHub
   Actions, where a personal token can't forge it.

Until step 1 is done, the agent shares the owner's GitHub identity, so it could reach
anything the owner can, including the admin bypass on the "main: human approval" rule. The
hooks catch the common ways it might try, but they are not a boundary; the owner reviewing
what gets merged is. The owner merges every PR with that bypass until then.

## 1. The agent's GitHub App

A GitHub App gets installation tokens that last an hour, carry only the permissions you
grant, and have no role in the org, so they can't bypass rulesets. PRs it opens are
authored by `laughingman-agent[bot]`, so the owner can approve them.

### Create it (owner, in the browser)

1. Go to **github.com/organizations/laughingman-ai/settings/apps/new**.
2. **GitHub App name:** `laughingman-agent`. **Homepage URL:** `https://laughingman.ai`.
3. **Webhook:** uncheck **Active**. Nothing needs to receive events.
4. **Repository permissions.** Set exactly these and leave everything else at **No access**:

   | Permission    | Access         | Why                        |
   | ------------- | -------------- | -------------------------- |
   | Contents      | Read and write | push branches              |
   | Pull requests | Read and write | open and update PRs        |
   | Issues        | Read and write | read and comment on issues |
   | Metadata      | Read-only      | required by GitHub         |

   Check that these stay at **No access**: **Workflows** (so it can't change
   `.github/workflows`, even on a branch), **Commit statuses** and **Checks** (so it can't
   post `verify` or `review/fresh-context`), **Administration** (no settings or rulesets),
   **Secrets**, **Actions**.

5. **Organization and account permissions:** none.
6. **Where can this GitHub App be installed?** **Only on this account.**
7. Click **Create GitHub App**. Note the **App ID** at the top of the page.
8. Under **Private keys**, click **Generate a private key**. A `.pem` file downloads.

### Store the key (owner)

In 1Password, in the personal account (`my.1password.com`) only, never the work account:

1. Create an item in **Private** named `laughingman-agent GitHub App`.
2. Add a field `private key` (concealed) and paste the full contents of the `.pem`,
   including the `BEGIN` and `END` lines. Add `app id` and, after the next step,
   `installation id` as plain fields.
3. Delete the downloaded `.pem` and empty the trash.

### Install it on this repo only (owner)

1. On the App's page, **Install App**, then **laughingman-ai**.
2. Choose **Only select repositories**, then `safe-to-merge`. Install.
3. The URL now ends in `/installations/<number>`. That number is the installation ID.

Don't add the App, or any team it's in, to a ruleset's bypass list.

### Use it

```sh
export AGENT_APP_ID=<app id> AGENT_APP_INSTALLATION_ID=<installation id>
scripts/agent-session.sh
```

`scripts/agent-session.sh` reads the key from 1Password with `op read`, mints a one-hour
token with `scripts/agent-token.mjs`, and starts `claude` with `gh` and `git` pointed at
that token and the bot's name. The key itself never enters the session.

That hides the owner's credentials from `gh` and `git`, but the session still runs as the
owner's OS user. For hard isolation, run the session in a container or as a separate OS
user that has no owner credentials at all.

### Then tighten the approval rule (owner)

Once agent PRs come from the App, the owner approves them like any reviewer, and the admin
bypass on "main: human approval" is only needed for PRs the owner writes. To require an
approval on every PR, with no bypass:

```sh
gh api repos/laughingman-ai/safe-to-merge/rulesets --jq '.[] | "\(.id) \(.name)"'
gh api -X PUT repos/laughingman-ai/safe-to-merge/rulesets/<id of "main: human approval"> \
  --input - <<<'{"bypass_actors": []}'
```

## 2. The CI reviewer key

`.github/workflows/review.yml` runs the fresh-context review in GitHub Actions and needs
an Anthropic API key as the repository secret `ANTHROPIC_API_KEY`. Until it's set, the
review job fails with a message pointing here, and nothing can merge.

1. In the [Anthropic Console](https://platform.claude.com), create a workspace for this
   repo's CI (e.g. `safe-to-merge-ci`) and set a monthly **spend limit** on it. Each review
   is capped at $2 by `--max-budget-usd`, and typically costs a few cents; $25 a month is
   plenty for a demo repo.
2. Create an API key in that workspace. Use it for nothing else.
3. Save it in 1Password, personal account (`my.1password.com`) only: an item in **Private**
   named `safe-to-merge CI Anthropic key`, field `credential`.
4. Set the secret straight from the vault, so the key never appears in your shell history
   or on screen:

   ```sh
   op read --account my.1password.com "op://Private/safe-to-merge CI Anthropic key/credential" \
     | gh secret set ANTHROPIC_API_KEY --repo laughingman-ai/safe-to-merge
   ```

5. Re-run the **review** job on any open PR (or push a commit).

## After PR #2 merges

PR #2 introduced the reviewer, so `main` had none to review it with. `review.yml` has a
one-time bootstrap step that runs PR #2's own reviewer files, only for PR #2, and only if
they match pinned SHA-256 hashes. Remove it in the first commit after #2 merges: the branch
`chore/remove-review-bootstrap` deletes the bootstrap step, the `if` on the Review step,
and the "No reviewer on the base branch" step's PR-number exception. From then on every PR
into `main` is reviewed with `main`'s reviewer, and PRs into any other branch get no review
job and no key.
