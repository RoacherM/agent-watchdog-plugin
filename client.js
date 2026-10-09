window.__ModuleLoader__.load({
  id: '@local/dsh-agent-watchdog',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'local-agent-watchdog';
    const MINUTE = 60 * 1000;

    // ── Tool calls: one normalized record per chat tool-call node. ──

    const COMMAND_TOOLS = new Set(['bash', 'pwsh']);
    const EDIT_TOOLS = new Set(['write', 'edit']);
    const READ_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'web_fetch', 'web_search']);
    /** Tools whose long runtime is expected: they wait on the user, a subagent, a job, or a workflow. */
    const WAITING_TOOL = /ask_user|subagent|job_output|workflow|^wait/;
    /** Arguments that describe a call without changing what it does. */
    const COSMETIC_ARGS = new Set(['description', 'justification', 'timeoutMs', 'timeout', 'run_in_background', 'sandbox_permissions']);

    function parseArgs(raw) {
      if (typeof raw !== 'string' || raw === '') return {};
      try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    }
    function stable(value) {
      if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
      if (value !== null && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
      }
      return JSON.stringify(value) ?? 'null';
    }
    function textOf(content) {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n');
    }
    /** DSH bash appends `[exit code: N]` on a nonzero exit; the persistent shell reports `[Command finished with exit code N]`. */
    function exitCodeOf(text) {
      const match = /\[exit code: (-?\d+)\]|\[Command finished with exit code (-?\d+)\]/.exec(text);
      return match === null ? undefined : Number(match[1] ?? match[2]);
    }
    function kindOf(name, args) {
      if (COMMAND_TOOLS.has(name)) return 'command';
      if (EDIT_TOOLS.has(name)) return 'edit';
      if (name === 'str_replace_editor') return args.command === 'view' ? 'read' : 'edit';
      if (READ_TOOLS.has(name)) return 'read';
      return 'other';
    }
    const shorten = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

    function makeCall({ id, name, argsRaw, time, endTime, done, text, isError }) {
      const args = parseArgs(argsRaw);
      const kind = kindOf(name, args);
      const essential = {};
      for (const key of Object.keys(args)) if (!COSMETIC_ARGS.has(key)) essential[key] = args[key];
      const command = kind === 'command' && typeof args.command === 'string' ? args.command.trim().replace(/\s+/g, ' ') : undefined;
      const rawPath = args.file_path ?? args.path ?? args.filePath;
      const path = (kind === 'edit' || kind === 'read') && typeof rawPath === 'string' ? rawPath : undefined;
      const pattern = typeof args.pattern === 'string' ? args.pattern : typeof args.query === 'string' ? args.query : typeof args.url === 'string' ? args.url : undefined;
      const exit = done ? exitCodeOf(text) : undefined;
      return {
        id, name, kind, command, path,
        sig: name + ' ' + stable(essential),
        label: shorten(command ?? (path !== undefined ? name + ' ' + path : pattern !== undefined ? name + ' ' + pattern : name), 90),
        time, endTime, running: !done, exit,
        failed: done && (isError === true || (exit !== undefined && exit !== 0)),
      };
    }

    // Node data objects are replaced, never mutated, so a WeakMap keeps parsing to once per update.
    const callCache = new WeakMap();
    function callOfNode(node) {
      if (node == null || node.kind !== 'tool-call' || node.data == null) return null;
      const cached = callCache.get(node.data);
      if (cached !== undefined) return cached;
      const root = node.data.root;
      let call = null;
      if (root != null && root.kind === 'tool-result') {
        call = makeCall({ id: String(root.callId), name: root.call?.name ?? '', argsRaw: root.call?.argsRaw,
          time: root.callTime ?? root.time, endTime: root.time, done: true, text: textOf(root.content), isError: root.isError });
      } else if (root != null && root.phase === 'start') {
        call = makeCall({ id: String(root.callId), name: root.name ?? '', argsRaw: root.argsRaw, time: root.time, done: false });
      }
      callCache.set(node.data, call);
      return call;
    }

    const EMPTY_TURN = Object.freeze({ turn: undefined, startTime: undefined, endTime: undefined, calls: Object.freeze([]) });
    /** Latest turn of a chat snapshot: its tool calls in chat order plus its start/end times. */
    function readLatestTurn(chat) {
      const turnOrder = chat?.timeline?.turnOrder;
      if (!turnOrder || turnOrder.length === 0 || typeof chat.locations?.getTurn !== 'function') return EMPTY_TURN;
      const turn = turnOrder[turnOrder.length - 1];
      const calls = [];
      for (const key of chat.locations.getTurn(turn)) {
        const call = callOfNode(chat.nodes.get(key));
        if (call !== null) calls.push(call);
      }
      const info = chat.timeline.turns?.get?.(turn);
      return { turn, startTime: info?.start?.time, endTime: info?.end?.time, calls };
    }
    function sameTurn(a, b) {
      if (a.turn !== b.turn || a.startTime !== b.startTime || a.endTime !== b.endTime || a.calls.length !== b.calls.length) return false;
      return a.calls.every((call, index) => call === b.calls[index]);
    }

    // ── Detectors: pure functions from a turn to findings. ──

    const LEVEL_RANK = { alert: 2, warn: 1 };

    /** Calls that can change what a later identical call returns. */
    const mayChangeState = (call) => call.kind === 'edit' || call.kind === 'command';

    /** Longest run of matching calls with no other state-changing call between neighbours. */
    function streakWithoutChanges(calls, match) {
      let best = 0, streak = 0, changedSince = false;
      for (const call of calls) {
        if (!match(call)) { if (mayChangeState(call)) changedSince = true; continue; }
        streak = streak === 0 || changedSince ? 1 : streak + 1;
        changedSince = false;
        best = Math.max(best, streak);
      }
      return best;
    }

    /**
     * @param waiting - the session awaits the user (approval, question, plan review), so the clock is not the agent's.
     */
    function analyze(turn, now, waiting = false) {
      const findings = [];
      const done = turn.calls.filter((call) => !call.running);
      const add = (finding) => findings.push({ ...finding, id: turn.turn + ':' + finding.rule + ':' + (finding.key ?? '') });

      // 1. The same failing call retried with nothing changed in between.
      const bySig = new Map();
      for (const call of done) bySig.set(call.sig, [...(bySig.get(call.sig) ?? []), call]);
      const flaggedSigs = new Set();
      for (const [sig, group] of bySig) {
        const failures = group.filter((call) => call.failed);
        const retries = streakWithoutChanges(done, (call) => call.sig === sig && call.failed);
        if (retries >= 3) {
          add({ rule: 'retry', key: sig, level: 'alert', count: retries, subject: group[0].label });
          flaggedSigs.add(sig);
        } else if (failures.length >= 6) {
          add({ rule: 'stubborn', key: sig, level: 'warn', count: failures.length, subject: group[0].label });
          flaggedSigs.add(sig);
        }
      }

      // 2. A short cycle of different calls (A B A B A B, or A B C ×3) at the end of the turn.
      for (const period of [2, 3]) {
        const tail = done.slice(-period * 3);
        if (tail.length < period * 3) continue;
        const cyclic = tail.every((call, index) => index < period || call.sig === tail[index - period].sig);
        const distinct = new Set(tail.slice(0, period).map((call) => call.sig)).size;
        if (cyclic && distinct === period) {
          tail.forEach((call) => flaggedSigs.add(call.sig));
          add({ rule: 'cycle', key: String(period), level: 'alert', count: period, subject: tail.slice(0, period).map((call) => call.label).join(' → ') });
          break;
        }
      }

      // 3. An identical call repeated with nothing changed in between (its result cannot differ).
      for (const [sig, group] of bySig) {
        if (flaggedSigs.has(sig)) continue;
        const repeats = streakWithoutChanges(done, (call) => call.sig === sig);
        if (repeats >= 3) add({ rule: 'repeat', key: sig, level: repeats >= 5 ? 'alert' : 'warn', count: repeats, subject: group[0].label });
      }

      // 4. The same file patched again and again while the check after each patch keeps failing.
      const churn = new Map();
      let lastEditedPath;
      for (const call of done) {
        if (call.kind === 'edit' && call.path !== undefined) { lastEditedPath = call.path; continue; }
        if (call.kind === 'command' && lastEditedPath !== undefined) {
          if (call.failed) churn.set(lastEditedPath, (churn.get(lastEditedPath) ?? 0) + 1);
          lastEditedPath = undefined;
        }
      }
      for (const [path, rounds] of churn) {
        if (rounds >= 4) add({ rule: 'churn', key: path, level: rounds >= 6 ? 'alert' : 'warn', count: rounds, subject: path });
      }

      // 5. Everything lately fails, whatever it is.
      let failStreak = 0;
      for (let i = done.length - 1; i >= 0 && done[i].failed; i--) failStreak += 1;
      if (failStreak >= 4) add({ rule: 'failStreak', level: failStreak >= 6 ? 'alert' : 'warn', count: failStreak, subject: done[done.length - 1].label });

      // Waiting on the user or on a delegated call (subagent, question tool) is not the agent stalling.
      const delegated = turn.calls.some((call) => call.running && WAITING_TOOL.test(call.name));
      if (turn.endTime === undefined && !waiting) {
        // 6. Only looking, never acting.
        let reads = 0;
        for (let i = done.length - 1; i >= 0 && done[i].kind === 'read'; i--) reads += 1;
        if (reads >= 20) add({ rule: 'readStreak', level: 'warn', count: reads, subject: done[done.length - 1].label });

        // 7. A single call that has not returned for minutes.
        for (const call of turn.calls) {
          if (!call.running || WAITING_TOOL.test(call.name) || typeof call.time !== 'number') continue;
          const minutes = Math.floor((now - call.time) / MINUTE);
          if (minutes >= 3) add({ rule: 'hung', key: call.id, level: minutes >= 10 ? 'alert' : 'warn', count: minutes, minutes, subject: call.label });
        }

        // 8. A long turn with no file changes lately.
        if (typeof turn.startTime === 'number') {
          const minutes = Math.floor((now - turn.startTime) / MINUTE);
          const lastEdit = done.filter((call) => call.kind === 'edit').reduce((latest, call) => Math.max(latest, call.endTime ?? call.time ?? 0), turn.startTime);
          const idle = Math.floor((now - lastEdit) / MINUTE);
          const hung = findings.some((finding) => finding.rule === 'hung');
          if (!delegated && !hung && minutes >= 20 && idle >= 10) add({ rule: 'slow', level: minutes >= 45 ? 'alert' : 'warn', count: minutes, minutes, idle, subject: '' });
        }
      }

      return findings.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    }

    const model = { parseArgs, exitCodeOf, makeCall, callOfNode, readLatestTurn, analyze };

    // ── Copy ──

    const zh = {
      name: '看门狗', guarding: '看门狗值守中', muted: '看门狗已静音（点击恢复）', mute: '点击静音本会话的看门狗',
      more: '还有 {n} 项', less: '收起', fill: '填入输入框', send: '立即发送', ignore: '忽略',
      sendBusy: '输入框里有草稿，先清空或用“填入输入框”', sent: '已发送，Agent 会在当前操作结束后读到',
      'title.retry': '原地重试：同一操作连续失败 {count} 次，中间没改任何东西',
      'title.stubborn': '反复失败：同一操作已失败 {count} 次',
      'title.repeat': '重复操作：完全相同的调用连续 {count} 次',
      'title.cycle': '疑似死循环：在同一组操作里打转',
      'title.churn': '修来修去：这个文件改了 {count} 轮，改完检查仍失败',
      'title.failStreak': '连续失败：最近 {count} 个操作全部失败',
      'title.readStreak': '只看不做：连续 {count} 次查看或搜索',
      'title.hung': '疑似卡住：这个操作已运行 {minutes} 分钟',
      'title.slow': '进展缓慢：本轮已 {minutes} 分钟，最近 {idle} 分钟没有改文件',
      'hint.hung': '可能是启动了不会退出的服务或在等待输入。纠偏消息要等它返回才会被读到，必要时直接点停止。',
      'nudge.retry': '停一下。你已经把 `{subject}` 原地重试了 {count} 次，每次都失败，中间没有做任何修改，结果不会变。请先完整阅读错误输出，说明你判断的根因，然后换一种方法。',
      'nudge.stubborn': '`{subject}` 已经失败 {count} 次了。请暂停修改，列出目前尝试过的方案和每次失败的原因，找出共同点，提出新的假设后再继续。如果缺少信息，直接问我。',
      'nudge.repeat': '你已经连续 {count} 次执行完全相同的 `{subject}`，期间没有任何改动，结果不会变。请直接使用已有结果继续推进。',
      'nudge.cycle': '你似乎陷入了循环，一直在重复同一组操作：{subject}。请停下来，说明你想达成什么、卡在哪里，然后换一个思路。',
      'nudge.churn': '`{subject}` 已经改了 {count} 轮，每次改完检查都还失败。请停止零碎修补：先完整阅读这个文件和相关报错，整体说明问题所在，再一次改对。',
      'nudge.failStreak': '最近连续 {count} 个操作都失败了。请先停下，检查前提是否成立（工作目录、路径、依赖、权限、环境变量），确认后再继续。',
      'nudge.readStreak': '你已经连续查看或搜索了 {count} 次还没动手。请根据目前掌握的信息给出结论或开始修改；如果还缺关键信息，说明具体缺什么。',
      'nudge.hung': '`{subject}` 运行了 {minutes} 分钟还没结束，很可能卡住了。长驻进程请改为后台运行，其他命令请加超时，不要在前台等待。',
      'nudge.slow': '这一轮已经进行了 {minutes} 分钟，最近 {idle} 分钟没有改动任何文件。请简要汇报：已经完成了什么、正卡在哪里、下一步打算怎么做。',
    };
    const en = {
      name: 'Watchdog', guarding: 'Watchdog on duty', muted: 'Watchdog muted (click to resume)', mute: 'Click to mute the watchdog for this session',
      more: '{n} more', less: 'Show less', fill: 'Put in composer', send: 'Send now', ignore: 'Ignore',
      sendBusy: 'The composer has a draft; clear it or use "Put in composer"', sent: 'Sent. The agent reads it once the current operation returns',
      'title.retry': 'Retrying in place: the same call failed {count} times with nothing changed',
      'title.stubborn': 'Keeps failing: the same call failed {count} times',
      'title.repeat': 'Repeating itself: an identical call {count} times in a row',
      'title.cycle': 'Possible loop: cycling through the same calls',
      'title.churn': 'Patch churn: this file was patched {count} times and the check still fails',
      'title.failStreak': 'Failure streak: the last {count} calls all failed',
      'title.readStreak': 'All reading, no doing: {count} reads or searches in a row',
      'title.hung': 'Possibly stuck: this call has been running for {minutes} min',
      'title.slow': 'Slow progress: {minutes} min this turn, no file changes for {idle} min',
      'hint.hung': 'It may have started a server that never exits or be waiting for input. Nudges are read only after it returns; stop it if needed.',
      'nudge.retry': 'Stop. You have retried `{subject}` {count} times with no changes in between and it failed every time, so it will not start working. Read the full error output, state the root cause you suspect, then try a different approach.',
      'nudge.stubborn': '`{subject}` has failed {count} times. Pause the edits, list what you tried and why each attempt failed, find what they have in common, and form a new hypothesis before continuing. Ask me if you are missing information.',
      'nudge.repeat': 'You ran the identical `{subject}` {count} times in a row with nothing changed, so the result cannot differ. Use the result you already have and move on.',
      'nudge.cycle': 'You seem to be in a loop, repeating the same calls: {subject}. Stop, explain what you are trying to achieve and where you are stuck, then change approach.',
      'nudge.churn': 'You have patched `{subject}` {count} times and the check still fails after each patch. Stop patching piecemeal: read the whole file and the related errors, explain the underlying problem, then fix it in one go.',
      'nudge.failStreak': 'The last {count} calls all failed. Stop and verify your assumptions (working directory, paths, dependencies, permissions, environment) before continuing.',
      'nudge.readStreak': 'You have read or searched {count} times in a row without acting. Draw a conclusion or start editing with what you know; if something essential is missing, say exactly what.',
      'nudge.hung': '`{subject}` has been running for {minutes} minutes and is probably stuck. Run long-lived processes in the background and give other commands a timeout instead of waiting in the foreground.',
      'nudge.slow': 'This turn has run for {minutes} minutes with no file changes in the last {idle}. Briefly report what is done, where you are stuck, and what you will do next.',
    };
    const fill = (template, params) => template.replace(/\{(\w+)\}/g, (all, key) => (params[key] === undefined ? all : String(params[key])));

    const css = `
      .awd-dock { border:1px solid var(--dsw-alias-border-l2); border-left:3px solid var(--awd-accent); border-radius:12px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:13px; overflow:hidden; }
      .awd-item { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; padding:10px 12px; }
      .awd-item + .awd-item { border-top:1px solid var(--dsw-alias-border-l1); }
      .awd-dot { width:8px; height:8px; margin-top:6px; border-radius:50%; background:var(--awd-accent); }
      .awd-alert { --awd-accent:var(--dsw-alias-state-error-primary, #e5484d); }
      .awd-warn { --awd-accent:var(--dsw-alias-state-warning-primary, #f5a623); }
      .awd-ok { --awd-accent:var(--dsw-alias-state-success-primary, #30a46c); }
      .awd-title { font-weight:600; line-height:20px; }
      .awd-subject { grid-column:2; margin:0; color:var(--dsw-alias-label-secondary); font:12px/18px ui-monospace, SFMono-Regular, Menlo, monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .awd-hint { grid-column:2; margin:0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
      .awd-actions { grid-column:2; display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:4px; }
      .awd-actions button, .awd-more { padding:3px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; }
      .awd-actions button:hover:not(:disabled), .awd-more:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .awd-actions button:disabled { opacity:.45; cursor:not-allowed; }
      .awd-actions .awd-primary { border-color:var(--awd-accent); color:var(--awd-accent); }
      .awd-actions .awd-quiet { border-color:transparent; color:var(--dsw-alias-label-tertiary); }
      .awd-note { color:var(--dsw-alias-label-tertiary); font-size:12px; }
      .awd-footer { display:flex; justify-content:flex-end; padding:0 12px 8px; }
      .awd-more { border-color:transparent; color:var(--dsw-alias-label-secondary); }
      .awd-chip { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 8px; border:none; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; flex:none; }
      .awd-chip:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .awd-chip:focus-visible, .awd-actions button:focus-visible, .awd-more:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
      .awd-chip .awd-dot { margin-top:0; }
      .awd-chip.awd-ok .awd-dot { animation:awd-breathe 2.4s ease-in-out infinite; }
      .awd-chip.awd-muted { opacity:.55; }
      .awd-chip.awd-muted .awd-dot { background:var(--dsw-alias-label-tertiary); }
      .awd-count { min-width:16px; padding:0 4px; border-radius:8px; background:var(--awd-accent); color:#fff; font-size:11px; line-height:16px; text-align:center; }
      @keyframes awd-breathe { 0%, 100% { opacity:1; } 50% { opacity:.35; } }
      @media (prefers-reduced-motion: reduce) { .awd-chip .awd-dot { animation:none !important; } }
    `;

    return {
      inject: ['slots', 'locale'],
      model,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'watchdog: dictionaries');
        const bound = ctx.locale.bind(NS);

        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = '@local/dsh-agent-watchdog';
          tag.textContent = css;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, 'watchdog: styles');

        // Per-session UI choices shared by the header chip and the dock; in memory for the page's lifetime.
        const listeners = new Set();
        const sessions = new Map();
        let version = 0;
        const prefs = {
          get: (sessionId) => sessions.get(sessionId) ?? { muted: false, expanded: false, handled: new Set() },
          update(sessionId, change) {
            const current = prefs.get(sessionId);
            sessions.set(sessionId, { ...current, ...change(current) });
            version += 1;
            listeners.forEach((listener) => listener());
          },
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          version: () => version,
        };

        function useWatch(props) {
          const { sessionId, useChat, useSessionStatus } = props;
          React.useSyncExternalStore(prefs.subscribe, prefs.version, prefs.version);
          const key = String(sessionId);
          const running = useSessionStatus((s) => (sessionId === undefined ? false : s.get(sessionId)?.running === true));
          const waiting = useSessionStatus((s) => (sessionId === undefined ? false : s.get(sessionId)?.pendingInteraction !== undefined));
          const previous = React.useRef(EMPTY_TURN);
          const turn = useChat((chat) => {
            const next = readLatestTurn(chat);
            if (sameTurn(previous.current, next)) return previous.current;
            previous.current = next;
            return next;
          });
          // Time-based rules need a clock; tick only while the agent works. The re-render also re-reads the chat.
          const [now, setNow] = React.useState(() => Date.now());
          React.useEffect(() => {
            setNow(Date.now());
            if (!running) return undefined;
            const id = setInterval(() => setNow(Date.now()), 5000);
            return () => clearInterval(id);
          }, [running]);
          const findings = React.useMemo(() => analyze(turn, now, waiting), [turn, now, waiting]);
          const pref = prefs.get(key);
          // A finished turn only keeps its alerts; handled or ignored findings stay hidden unless they escalate.
          const visible = findings.filter((f) => (running || f.level === 'alert') && !pref.handled.has(f.id + '#' + f.level));
          return { key, running, visible, pref };
        }

        function WatchdogDock(props) {
          const t = typeof props.t === 'function' ? props.t : bound;
          const { key, visible, pref } = useWatch(props);
          const draft = typeof props.useInput === 'function' ? props.useInput((s) => (typeof s?.draft === 'string' ? s.draft : '')) : '';
          const [sentId, setSentId] = React.useState(null);
          if (pref.muted || visible.length === 0) return null;

          const actions = props.inputActions;
          const hasDraft = draft.trim() !== '';
          const handle = (finding) => prefs.update(key, (p) => ({ handled: new Set([...p.handled, finding.id + '#' + finding.level]) }));
          const shown = pref.expanded ? visible : visible.slice(0, 1);
          const top = visible[0];

          return h('div', { className: 'awd-dock awd-' + top.level, role: 'region', 'aria-label': t('name') },
            shown.map((finding) => {
              const params = { ...finding, subject: finding.subject };
              const nudge = fill(t('nudge.' + finding.rule), params);
              return h('div', { key: finding.id, className: 'awd-item awd-' + finding.level },
                h('span', { className: 'awd-dot', 'aria-hidden': true }),
                h('span', { className: 'awd-title', role: finding.level === 'alert' ? 'alert' : undefined }, '🐕 ' + fill(t('title.' + finding.rule), params)),
                finding.subject ? h('p', { className: 'awd-subject', title: finding.subject }, finding.subject) : null,
                finding.rule === 'hung' ? h('p', { className: 'awd-hint' }, t('hint.hung')) : null,
                h('div', { className: 'awd-actions' },
                  h('button', {
                    type: 'button', disabled: actions === undefined,
                    onClick: () => actions.setDraft(hasDraft ? draft.replace(/\s+$/, '') + '\n\n' + nudge : nudge),
                  }, t('fill')),
                  h('button', {
                    type: 'button', className: 'awd-primary', disabled: actions === undefined || hasDraft,
                    title: hasDraft ? t('sendBusy') : nudge,
                    onClick: () => { actions.setDraft(nudge); actions.submit(); setSentId(finding.id); handle(finding); },
                  }, t('send')),
                  h('button', { type: 'button', className: 'awd-quiet', onClick: () => handle(finding) }, t('ignore')),
                  sentId === finding.id ? h('span', { className: 'awd-note', role: 'status' }, t('sent')) : null));
            }),
            visible.length > 1
              ? h('div', { className: 'awd-footer' }, h('button', {
                type: 'button', className: 'awd-more', 'aria-expanded': pref.expanded,
                onClick: () => prefs.update(key, (p) => ({ expanded: !p.expanded })),
              }, pref.expanded ? t('less') : fill(t('more'), { n: visible.length - 1 })))
              : null);
        }

        function WatchdogChip(props) {
          const t = typeof props.t === 'function' ? props.t : bound;
          const { key, running, visible, pref } = useWatch(props);
          if (!running && visible.length === 0 && !pref.muted) return null;
          const level = pref.muted ? 'muted' : visible.length > 0 ? visible[0].level : 'ok';
          const label = pref.muted ? t('muted') : visible.length > 0 ? fill(t('title.' + visible[0].rule), visible[0]) : t('guarding');
          return h('button', {
            type: 'button', className: 'awd-chip awd-' + level, 'aria-pressed': pref.muted,
            title: pref.muted ? label : label + ' · ' + t('mute'), 'aria-label': label,
            onClick: () => prefs.update(key, (p) => ({ muted: !p.muted })),
          },
            h('span', { className: 'awd-dot', 'aria-hidden': true }),
            h('span', null, t('name')),
            !pref.muted && visible.length > 0 ? h('span', { className: 'awd-count' }, String(visible.length)) : null);
        }

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'agent-watchdog', order: -10, locale: NS, label: () => bound('name'),
        }, WatchdogDock));

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities', id: 'agent-watchdog', order: -30, locale: NS, label: () => bound('name'),
        }, WatchdogChip));
      },
    };
  },
});
