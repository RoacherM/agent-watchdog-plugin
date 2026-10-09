// Replays DSH session logs through the watchdog, event by event, to review what it would have flagged.
// Usage: node replay.mjs <session.jsonl>...   (decompress session.v4.jsonl.zstd first: zstd -dc file > x.jsonl)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let plugin;
vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: (entry) => { plugin = entry.factory(() => ({})); } } }, Date,
});
const { readLatestTurn, analyze } = plugin.model;

let total = 0;
for (const file of process.argv.slice(2)) {
  const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const turns = new Map(); // turn → { start, end, keys: [], nodes: Map }
  const fired = new Map();
  const callTurn = new Map();
  let clock;
  const check = (now) => {
    if (turns.size === 0) return;
    const latest = Math.max(...turns.keys());
    const t = turns.get(latest);
    const chat = {
      timeline: { turnOrder: [...turns.keys()].sort((a, b) => a - b), turns: new Map([[latest, { start: { time: t.start }, ...(t.end ? { end: { time: t.end } } : {}) }]]) },
      locations: { getTurn: (n) => (n === latest ? t.keys : []) },
      nodes: { get: (key) => t.nodes.get(key) },
    };
    for (const finding of analyze(readLatestTurn(chat), now)) {
      const id = finding.id + '#' + finding.level;
      if (!fired.has(id)) fired.set(id, { at: new Date(now).toISOString().slice(11, 19), ...finding });
    }
  };
  for (const event of events) {
    if (typeof event.time !== 'number') continue;
    // The live plugin re-checks every 5s while the agent runs; replay the clock at 30s steps between events.
    for (clock ??= event.time; clock + 30000 < event.time; clock += 30000) check(clock + 30000);
    clock = event.time;
    const turnOf = (n) => { if (!turns.has(n)) turns.set(n, { start: event.time, end: undefined, keys: [], nodes: new Map() }); return turns.get(n); };
    const data = event.data ?? {};
    if (event.type === 'turn/start') turnOf(data.turn).start = event.time;
    else if (event.type === 'turn/end') turnOf(data.turn).end = event.time;
    else if (event.type === 'tool/call') {
      const t = turnOf(data.turn);
      const key = String(data.callId);
      callTurn.set(key, data.turn);
      t.keys.push(key);
      t.nodes.set(key, { key, kind: 'tool-call', data: { root: { phase: 'start', callId: key, name: data.name, argsRaw: data.arguments, time: event.time } } });
    } else if (event.type === 'tool/result') {
      const key = String(data.message?.source?.callId);
      const t = turns.get(callTurn.get(key) ?? data.turn);
      const start = t?.nodes.get(key)?.data.root;
      if (!t || !start) continue;
      t.nodes.set(key, { key, kind: 'tool-call', data: { root: { kind: 'tool-result', callId: key, call: { name: start.name, argsRaw: start.argsRaw },
        callTime: start.time, time: event.time, content: data.message.content, isError: data.message.isError === true } } });
    } else continue;
    check(event.time);
  }
  const calls = events.filter((e) => e.type === 'tool/call').length;
  console.log(`\n${file}: ${events.length} events, ${calls} tool calls, ${turns.size} turns → ${fired.size} findings`);
  for (const f of fired.values()) console.log(`  ${f.at} turn ${f.id.split(':')[0]} ${f.level.padEnd(5)} ${f.rule.padEnd(10)} ×${f.count}  ${f.subject.slice(0, 80)}`);
  total += fired.size;
}
console.log(`\ntotal findings: ${total}`);
