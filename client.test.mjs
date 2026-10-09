import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const MIN = 60 * 1000;

function load() {
  let plugin;
  const head = [];
  const document = {
    head: { appendChild: (tag) => head.push(tag) },
    createElement: () => { const tag = { dataset: {}, remove: () => head.splice(head.indexOf(tag), 1) }; return tag; },
  };
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (entry) => { plugin = entry.factory(() => React); } } },
    document, setInterval, clearInterval, Date,
  });
  return { plugin, head };
}
const { model } = load().plugin;

// ── Chat snapshot builders mirroring the ui-chat node shapes. ──

let seq = 0;
const T0 = 1_800_000_000_000;
/** A finished call: `out` is the result text; `err` marks a tool error. */
const done = (name, args, { out = 'ok', err = false, at = T0 + seq * 1000 } = {}) => {
  const id = 'c' + ++seq;
  return { key: id, kind: 'tool-call', data: { root: { kind: 'tool-result', callId: id, call: { name, argsRaw: JSON.stringify(args) },
    callTime: at, time: at + 500, content: [{ type: 'text', text: out }], isError: err } } };
};
const pending = (name, args, at) => {
  const id = 'c' + ++seq;
  return { key: id, kind: 'tool-call', data: { root: { phase: 'start', callId: id, name, argsRaw: JSON.stringify(args), time: at } } };
};
const bash = (command, exit = 0) => done('bash', { command, description: 'run ' + seq }, { out: exit === 0 ? 'fine' : 'boom\n[exit code: ' + exit + ']' });
const edit = (file_path, n) => done('edit', { file_path, old_string: 'a' + n, new_string: 'b' + n });
const read = (file_path) => done('read', { file_path });
const text = { key: 'm' + ++seq, kind: 'assistant-step', data: {} };

function chat(nodes, { start = T0, end } = {}) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  return {
    timeline: { turnOrder: [1, 2], turns: new Map([[2, { turn: 2, start: { time: start }, ...(end ? { end: { time: end } } : {}) }]]) },
    locations: { getTurn: (turn) => (turn === 2 ? nodes.map((node) => node.key) : ['old']) },
    nodes: { get: (key) => byKey.get(key) },
  };
}
const findings = (nodes, opts = {}) => model.analyze(model.readLatestTurn(chat(nodes, opts)), opts.now ?? T0 + 5 * MIN, opts.waiting);
const rules = (list) => Array.from(list, (f) => f.rule + ':' + f.level);

test('reads only the latest turn, skips non-tool nodes, and classifies results', () => {
  const turn = model.readLatestTurn(chat([text, bash('npm test', 1), read('/a.ts'), pending('bash', { command: 'sleep 999' }, T0)]));
  assert.equal(turn.turn, 2);
  assert.deepEqual(Array.from(turn.calls, (c) => [c.kind, c.failed, c.running]), [['command', true, false], ['read', false, false], ['command', false, true]]);
  assert.equal(turn.calls[0].exit, 1);
  assert.equal(model.readLatestTurn({}).calls.length, 0);
  assert.equal(model.exitCodeOf('x\n[Command finished with exit code 2]'), 2);
  assert.equal(model.exitCodeOf('all good'), undefined);
});

test('parsing is cached per node data, and cosmetic args do not change identity', () => {
  const node = bash('ls', 0);
  assert.equal(model.callOfNode(node), model.callOfNode(node));
  const a = model.makeCall({ id: '1', name: 'bash', argsRaw: '{"command":"ls","description":"x"}', done: true, text: '' });
  const b = model.makeCall({ id: '2', name: 'bash', argsRaw: '{"description":"y","command":"ls"}', done: true, text: '' });
  assert.equal(a.sig, b.sig);
  assert.equal(model.makeCall({ id: '3', name: 'bash', argsRaw: 'not json', done: true, text: '' }).sig, 'bash {}');
});

test('retrying the same failing command with nothing changed is an alert', () => {
  const list = findings([bash('npm test', 1), read('/log'), bash('npm test', 1), bash('npm test', 1)]);
  assert.deepEqual(rules(list), ['retry:alert']);
  assert.equal(list[0].count, 3);
  assert.equal(list[0].subject, 'npm test');
});

test('normal TDD iteration (edit → test → edit → test) is not flagged', () => {
  const list = findings([bash('npm test', 1), edit('/a.ts', 1), bash('npm test', 1), edit('/a.ts', 2), bash('npm test', 1), edit('/a.ts', 3), bash('npm test', 0)]);
  assert.deepEqual(rules(list), []);
});

test('a state-changing command between retries resets the retry streak', () => {
  const list = findings([bash('npm test', 1), bash('npm install', 0), bash('npm test', 1), bash('npm i -D vitest', 0), bash('npm test', 1)]);
  assert.deepEqual(rules(list), []);
});

test('a command that keeps failing across many fixes is a warning', () => {
  const nodes = [];
  for (let i = 0; i < 6; i++) nodes.push(edit('/f' + i + '.ts', i), bash('npm test', 1));
  assert.deepEqual(rules(findings(nodes)), ['stubborn:warn']);
});

test('patch churn on one file while the check keeps failing', () => {
  const nodes = [];
  for (let i = 0; i < 4; i++) nodes.push(edit('/src/app.ts', i), bash('npm run build -- --n=' + i, 2));
  assert.deepEqual(rules(findings(nodes)), ['churn:warn']);
  for (let i = 4; i < 6; i++) nodes.push(edit('/src/app.ts', i), bash('npm run build -- --n=' + i, 2));
  assert.deepEqual(rules(findings(nodes)).filter((r) => r.startsWith('churn')), ['churn:alert']);
});

test('identical reads with nothing changed escalate; a cycle is reported once, not per member', () => {
  assert.deepEqual(rules(findings([read('/a'), read('/a'), read('/a')])), ['repeat:warn']);
  assert.deepEqual(rules(findings([read('/a'), read('/a'), read('/a'), read('/a'), read('/a')])), ['repeat:alert']);
  const loop = findings([read('/a'), read('/b'), read('/a'), read('/b'), read('/a'), read('/b')]);
  assert.deepEqual(rules(loop), ['cycle:alert']);
  assert.equal(loop[0].subject, 'read /a → read /b');
});

test('a streak of assorted failures', () => {
  const list = findings([bash('a', 1), done('edit', { file_path: '/x', old_string: 'q', new_string: 'w' }, { err: true, out: 'old_string not found' }), bash('b', 127), bash('c', 1)]);
  assert.deepEqual(rules(list), ['failStreak:warn']);
});

test('time rules only apply to a running turn: hung call and slow progress', () => {
  const running = findings([bash('ls', 0), pending('bash', { command: 'npm run dev' }, T0 + MIN)], { now: T0 + 5 * MIN });
  assert.deepEqual(rules(running), ['hung:warn']);
  assert.equal(running[0].minutes, 4);
  assert.deepEqual(rules(findings([pending('bash', { command: 'npm run dev' }, T0)], { now: T0 + 11 * MIN })), ['hung:alert']);
  assert.deepEqual(rules(findings([pending('ask_user_question', {}, T0)], { now: T0 + 30 * MIN })), []);
  assert.deepEqual(rules(findings([pending('subagent', {}, T0)], { now: T0 + 30 * MIN })), []);
  // Seen in a real log: an inspect query waiting on a page that never answered, for two hours.
  assert.deepEqual(rules(findings([pending('cordis_inspect_query', { target: 'client' }, T0)], { now: T0 + 4 * MIN })), ['hung:warn']);
  const slow = findings([edit('/a', 1), read('/b')], { now: T0 + 25 * MIN });
  assert.deepEqual(rules(slow), ['slow:warn']);
  assert.deepEqual(rules(findings([edit('/a', 1)], { now: T0 + 25 * MIN, end: T0 + 24 * MIN })), []);
  assert.deepEqual(rules(findings([edit('/a', 1), read('/b')], { now: T0 + 25 * MIN, waiting: true })), []);
  assert.deepEqual(rules(findings([pending('bash', { command: 'npm run dev' }, T0)], { now: T0 + 11 * MIN, waiting: true })), []);
});

test('twenty reads in a row with no action', () => {
  const nodes = [];
  for (let i = 0; i < 20; i++) nodes.push(read('/f' + i));
  assert.deepEqual(rules(findings(nodes)), ['readStreak:warn']);
});

// ── Plugin lifecycle and rendering ──

function mount() {
  const { plugin, head } = load();
  const disposers = [], dictionaries = new Map(), views = new Map();
  plugin.apply({
    effect: (fn) => disposers.push(fn()),
    locale: { register: (ns, d) => { dictionaries.set(ns, d); return () => dictionaries.delete(ns); }, bind: (ns) => (k) => dictionaries.get(ns).zh[k] },
    slots: { inject: (name, fn) => fn(), register: (options, view) => views.set(options.name, { options, view }) },
  });
  const t = (k) => dictionaries.get('local-agent-watchdog').zh[k];
  const render = (slot, nodes, { running = true, draft = '', actions = { setDraft() {}, submit() {} } } = {}) => renderToStaticMarkup(
    React.createElement(views.get(slot).view, {
      sessionId: 's1', t, inputActions: actions,
      useSessionStatus: (sel) => sel(new Map([['s1', { running }]])),
      useChat: (sel) => sel(chat(nodes)),
      useInput: (sel) => sel({ draft }),
    }));
  return { head, disposers, dictionaries, views, render };
}

test('registers a composer dock entry and a header chip, and disposes styles and copy', () => {
  const m = mount();
  assert.deepEqual([...m.views.keys()], ['conversation.input.dock', 'conversation.session.header.utilities']);
  assert.equal(m.views.get('conversation.input.dock').options.id, 'agent-watchdog');
  const { zh, en } = m.dictionaries.get('local-agent-watchdog');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.equal(m.head.length, 1);
  m.disposers.forEach((dispose) => dispose());
  assert.equal(m.head.length, 0);
  assert.equal(m.dictionaries.size, 0);
});

test('dock stays empty when healthy and shows the finding with nudge actions when not', () => {
  const m = mount();
  assert.equal(m.render('conversation.input.dock', [bash('ls', 0)]), '');
  const html = m.render('conversation.input.dock', [bash('npm test', 1), bash('npm test', 1), bash('npm test', 1)]);
  assert.match(html, /原地重试：同一操作连续失败 3 次/);
  assert.match(html, /<p class="awd-subject"[^>]*>npm test<\/p>/);
  assert.match(html, />填入输入框<.*>立即发送<.*>忽略</);
  assert.doesNotMatch(html, /disabled/);
});

test('send is disabled while the composer holds a draft; a finished turn keeps only alerts', () => {
  const m = mount();
  const failing = [bash('npm test', 1), bash('npm test', 1), bash('npm test', 1)];
  assert.match(m.render('conversation.input.dock', failing, { draft: 'my half-written thought' }), /class="awd-primary" disabled=""/);
  const warnOnly = [read('/a'), read('/a'), read('/a')];
  assert.notEqual(m.render('conversation.input.dock', warnOnly, { running: true }), '');
  assert.equal(m.render('conversation.input.dock', warnOnly, { running: false }), '');
  assert.notEqual(m.render('conversation.input.dock', failing, { running: false }), '');
});

test('header chip: on duty while running, counts findings, hidden when idle and clean', () => {
  const m = mount();
  assert.match(m.render('conversation.session.header.utilities', [bash('ls', 0)]), /awd-chip awd-ok.*看门狗/);
  assert.match(m.render('conversation.session.header.utilities', [bash('x', 1), bash('x', 1), bash('x', 1)]), /awd-chip awd-alert.*awd-count">1</);
  assert.equal(m.render('conversation.session.header.utilities', [bash('ls', 0)], { running: false }), '');
});
