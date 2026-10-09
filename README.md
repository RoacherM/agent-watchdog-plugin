# 🐕 Agent Watchdog

Watches the agent's current turn and warns you when it goes in circles, above the composer (`conversation.input.dock`), with a one-click nudge. A header chip (`conversation.session.header.utilities`) shows it is on duty; click it to mute the watchdog for that session.

| Rule | Fires when | Level |
|---|---|---|
| retry | the same failing call is retried 3× with no edit or other command in between | alert |
| stubborn | the same call has failed 6× in the turn, even with fixes between | warn |
| cycle | the turn ends in a repeating pattern A B A B A B (or A B C ×3) | alert |
| repeat | an identical call runs 3× with nothing changed in between (5× → alert) | warn |
| churn | a file is patched and the following command fails, 4 rounds (6 → alert) | warn |
| failStreak | the last 4 calls all failed (6 → alert) | warn |
| readStreak | 20 reads or searches in a row with no edit or command | warn |
| hung | one call has not returned for 3 min (10 → alert) | warn |
| slow | the turn has run 20 min with no file edit for 10 (45 → alert) | warn |

Normal TDD iteration (edit → test → edit → test) does not trigger any rule. Time rules pause while the session waits for you (approval, question, plan review) or while a waiting tool runs (ask_user*, subagent*, job_output, workflow*). Once a turn ends, only alerts stay visible.

Nudges: **填入输入框** appends the suggested message to your draft; **立即发送** sends it (disabled while you have a draft). A running agent reads it once its current call returns, and you can steer it from the queue. **忽略** hides that finding until it escalates.

## Development

```sh
../pnpm-with-node install
node --test                          # detectors, rendering, lifecycle
zstd -dc ~/.dsh/sessions/<dir>/<session>/session.v4.jsonl.zstd > /tmp/s.jsonl
node replay.mjs /tmp/s.jsonl         # what the watchdog would have flagged in a real session
```

## Install into the desktop app

```sh
R="/Applications/DeepSeek Harness.app/Contents/Resources/runtime"
cd ~/.dsh/profiles/desktop
DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "$R/bin/node" "$R/pnpm/bin/pnpm.mjs" add file:/Users/byronwayne/Desktop/DSH/agent-watchdog-plugin
```

Then enable `@local/dsh-agent-watchdog` in **Settings → Plugins**. Re-run `pnpm add` after each change (it installs a copy).
Rollback: disable it in Settings → Plugins, then `pnpm remove @local/dsh-agent-watchdog` in the same directory.
