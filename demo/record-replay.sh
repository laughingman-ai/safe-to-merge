#!/usr/bin/env bash
# Record `npm run replay` as the animated terminal in demo/replay.svg (shown in the README).
# Needs uv (for asciinema 2.4.0) and npx (for svg-term-cli 2.1.1); neither is a project
# dependency. Re-run after anything that changes the replay's output.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# asciinema needs a terminal; `script` provides one when this runs from a pipe or an agent.
script -qec "stty cols 100 rows 32; cd '$repo' && uvx --quiet asciinema@2.4.0 rec --overwrite -q \
  --cols 100 --rows 32 -c 'REPLAY_PAUSE=1.2 npm run -s replay' '$tmp/raw.cast'" /dev/null >/dev/null

# Type the command at the start, hold the last frame for 6 seconds, and drop the recording
# machine's timestamp and environment from the header.
node - "$tmp/raw.cast" "$tmp/replay.cast" <<'EOF'
const fs = require("node:fs");
const [header, ...lines] = fs.readFileSync(process.argv[2], "utf8").trim().split("\n");
const { version, width, height } = JSON.parse(header);
const events = lines.map((l) => JSON.parse(l));
const out = [[0.4, "o", "\x1b[32m$\x1b[0m "]];
let t = 0.9;
for (const c of "npm run replay") out.push([t, "o", c]), (t += 0.07);
out.push([t + 0.4, "o", "\r\n"]);
const shift = t + 0.8 - events[0][0];
for (const [time, type, data] of events) out.push([time + shift, type, data]);
out.push([out.at(-1)[0] + 6, "o", "\x1b[0m"]);
const round = ([time, type, data]) => JSON.stringify([Math.round(time * 1000) / 1000, type, data]);
const env = { TERM: "xterm-256color" };
fs.writeFileSync(process.argv[3], [JSON.stringify({ version, width, height, env }), ...out.map(round)].join("\n") + "\n");
EOF

npx -y svg-term-cli@2.1.1 --in "$tmp/replay.cast" --out "$repo/demo/replay.svg" \
  --window --no-cursor --padding 18 2>/dev/null
echo "Wrote demo/replay.svg"
