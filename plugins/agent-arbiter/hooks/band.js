// The surfaces beside the chat: a band above the prompt for what waits for the
// person, a note under each tool call Arbiter stopped to look at, and a row in
// the desktop app's right-click menu. None of them writes to the chat.
import { observationContext } from './context.js';
import { t } from './i18n.js';
import { roleOf } from './roles.js';
import { openRulesPane } from './rules-pane.js';
import { bandSnapshot, hideBand, refreshStatus, setBandExpanded, PULSE_MS } from './status.js';
import { decisionNote, sessionAsks } from './notes.js';
import { DAILY_TRIALS } from './judge.js';
import { COLORS, fraction, pillTrackSvg, pillWidth, roleIcon, svgOf } from './visuals.js';
import { timelineRow } from './history-view.js';

let lastContext = null;

async function contextOf($) {
  lastContext = await observationContext($, { recoverPreferences: true });
  return lastContext;
}

// Opens the panel at one run of a session, or at the session's timeline.
async function openAtRun($, sessionId, agentId) {
  try { await openRulesPane($, await contextOf($), 'citizens', { kind: 'run', sessionId, agentId }); }
  catch { /* The panel opens from /arbiter as well. */ }
}

// Opens the panel at what waits, or at its settings when nothing does.
async function openAtWaiting($) {
  try {
    const ctx = await contextOf($), snapshot = bandSnapshot(ctx);
    await openRulesPane($, ctx, 'settings', snapshot?.detained ? 'jail' : snapshot?.pending ? 'review' : null);
  } catch { /* The panel opens from /arbiter as well. */ }
}

// The band's bars, most urgent first. Bars that wait for the person (a
// detention, review decisions) decide whether the band shows at all and which
// bar the small band shows; the session's activity (approval asks, the judge's
// day) joins only the full list. Each bar is an icon, a meter whose pill names
// the figure, and in the full list one dim figure. A detention has no known
// total, so its meter is the pill alone.
export function bandRows(snapshot, now = Date.now(), asks = { asked: 0, allowed: 0 }) {
  const rows = [];
  if (snapshot.detained) rows.push({
    key: 'jail', waiting: true, color: COLORS.jail, pill: t('band.chipJail', { count: snapshot.detained }),
    alt: t('band.jailFigure', { count: snapshot.detained }), stat: '', value: 0, max: null,
    role: snapshot.detainee ? roleOf(snapshot.detainee) : 'other', detained: true, pulse: now - snapshot.detainedAt < PULSE_MS,
  });
  if (snapshot.pending) {
    const total = snapshot.decided + snapshot.pending;
    rows.push({
      key: 'reviews', waiting: true, color: COLORS.review, pill: t('band.chipReview', { count: snapshot.pending }),
      alt: t('band.reviewFigure', { decided: snapshot.decided, total, pending: snapshot.pending }),
      // Nothing decided yet says nothing: the pill already counts what waits.
      stat: snapshot.decided ? t('band.reviewStat', { decided: snapshot.decided, total }) : '', value: snapshot.decided, max: total, role: 'review',
    });
  }
  if (asks.asked) rows.push({
    key: 'asks', waiting: false, color: COLORS.quality, pill: t('band.chipAsks', { count: asks.asked }),
    alt: t('band.asksFigure', { asked: asks.asked, allowed: asks.allowed }), stat: t('band.asksStat', { allowed: asks.allowed }),
    value: asks.allowed, max: asks.asked, role: 'security',
  });
  if (snapshot.judgedToday) rows.push({
    key: 'judge', waiting: false, color: COLORS.judge, pill: t('band.chipJudge', { count: snapshot.judgedToday, cap: DAILY_TRIALS }),
    alt: t('band.judgeFigure', { count: snapshot.judgedToday, cap: DAILY_TRIALS }), stat: '', value: snapshot.judgedToday, max: DAILY_TRIALS, role: 'research',
  });
  return rows;
}

// Room the open and close buttons take at the end of the first row.
const BUTTON_COLUMNS = 8;
// The track takes the rest of the row; this only keeps a very wide window sane.
const MAX_TRACK_COLUMNS = 160;

// One bar as drawn. columns is the row's width in cells and the track fills
// what the pill leaves; the figure goes first when room runs short, then the
// track, never the pill. small: the one-bar band, with no figure. onPress:
// pressing the bar (icon and meter) opens or closes the band.
export function drawRow(h, surface, row, columns, tail, small = false, onPress = null, after = []) {
  const Svg = svgOf(h, surface), free = columns - 4 - (tail ? BUTTON_COLUMNS : 0);
  // The figure rides inside the pill, so one shape says what waits and how far it has come.
  const columnsOf = text => [...text].length + 2;
  const folded = !small && row.stat ? `${row.pill} · ${row.stat}` : row.pill;
  const label = folded !== row.pill && free - columnsOf(folded) >= 8 ? folded : row.pill;
  const trackColumns = row.max ? Math.min(MAX_TRACK_COLUMNS, free - columnsOf(label) - 1 - after.length * 3) : 0;
  const lead = roleIcon(h, surface, row.role, 18, row.detained ? { detained: true, pulse: row.pulse } : { animate: row.waiting }, row.alt);
  let meter;
  if (Svg) {
    const drawn = pillTrackSvg({ label, color: row.color, value: row.value, max: row.max,
      width: row.max ? Math.max(pillWidth(label) + 24, Math.round(trackColumns * 7.5)) : 0 });
    meter = Svg({ source: drawn.source, alt: row.alt, width: drawn.width, height: drawn.height });
  } else {
    const cells = trackColumns >= 4 ? trackColumns : 0, share = fraction({ value: row.value, max: row.max });
    // One decided item must show: never round a started bar back to empty, nor a part-done one to full.
    const done = share > 0 && cells ? Math.min(share < 1 ? cells - 1 : cells, Math.max(1, Math.round(share * cells))) : 0;
    meter = h.Box({ flexDirection: 'row', flexShrink: 0, children: [
      ...(done ? [h.Text({ color: row.color, dimColor: true, children: '█'.repeat(done) })] : []),
      h.Text({ color: row.color, bold: true, maxLines: 1, children: ` ${label} ` }),
      ...(cells - done ? [h.Text({ dimColor: true, children: '░'.repeat(cells - done) })] : []),
    ] });
  }
  const bar = h.Box({ flexDirection: 'row', alignItems: 'center', gap: 1, flexShrink: 1, flexGrow: 1, children: [lead, meter, ...after] });
  return h.Box({ key: row.key, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 1, children: [
    onPress ? h.Button({ key: 'band-toggle-' + row.key, plain: true, onPress, children: [bar] }) : bar,
    ...(tail ? [tail] : []),
  ] });
}

const outcomeText = outcome => t('note.' + (['approved', 'session-allow', 'refused', 'unanswered', 'denied-by-rule', 'retry-after-refusal'].includes(outcome) ? outcome : 'other'));
const ruleName = id => id.startsWith('user:') ? t('note.custom') : t('rule.' + id);

export function registerBand(on) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { bodyColumns, maxRows, hasSurvey } = e.props;
    if (hasSurvey || maxRows < 1) return next(e);
    let ctx;
    try { ctx = await contextOf($); } catch { return next(e); }
    const snapshot = bandSnapshot(ctx);
    if (!snapshot) { void refreshStatus($, ctx); return next(e); }
    if (snapshot.hidden) return next(e);
    const asks = sessionAsks(), rows = bandRows(snapshot, Date.now(), asks);
    // Shown only while something waits; the activity bars ride along when open.
    if (!rows.some(row => row.waiting)) return next(e);
    const h = $.ui.resolve(e), expanded = snapshot.expanded === true;
    const icon = (key, label, onPress) => h.Button({ key, label, plain: true, dimColor: true, onPress });
    // The bar itself opens and closes the list; only open and close stay as buttons.
    const toggle = () => setBandExpanded($, ctx, !expanded);
    const tail = h.Box({ key: 'actions', flexDirection: 'row', gap: 1, flexShrink: 0, children: [
      icon('band-open', '↗', () => void openAtWaiting($)),
      icon('band-hide', '×', () => hideBand($, ctx)),
    ] });
    if (!expanded) {
      // The small band: the one bar that matters most, and how many more there are.
      const others = (bodyColumns ?? 80) < 22 ? 0 : rows.length - 1;
      return drawRow(h, e.surface, rows[0], bodyColumns ?? 80, tail, true, toggle,
        others ? [h.Text({ key: 'others', dimColor: true, children: '+' + others })] : []);
    }
    const gap = svgOf(h, e.surface) ? 1 : 0, fit = gap ? Math.floor((maxRows + 1) / 2) : maxRows;
    const bars = rows.slice(0, Math.max(1, fit)).map((row, index) => drawRow(h, e.surface, row, bodyColumns ?? 80, index === 0 ? tail : undefined, false, toggle));
    // Under the bars, the agents this session sent, newest last, as many as the rows left allow.
    const runs = snapshot.timeline?.agents ?? [], room = maxRows - (gap ? bars.length * 2 : bars.length) - 1;
    if (!runs.length || room < 2) return h.Box({ flexDirection: 'column', gap, children: bars });
    const shown = runs.slice(-(runs.length > room - 1 ? room - 1 : room));
    const open = run => () => void openAtRun($, ctx.sessionId, run?.agentId ?? null);
    return h.Box({ flexDirection: 'column', gap, children: [...bars, h.Box({ key: 'session-runs', flexDirection: 'column', children: [
      h.Text({ dimColor: true, children: t('history.bandTitle', { count: runs.length }) }),
      ...(runs.length > shown.length ? [h.Button({ key: 'runs-more', plain: true, dimColor: true, label: t('history.more', { count: runs.length - shown.length }), onPress: open(null) })] : []),
      ...shown.map((run, index) => timelineRow(h, e.surface, run, { lanes: snapshot.timeline.lanes, last: index === shown.length - 1, onPress: open(run) })),
    ] })] });
  });

  // The rule that stopped a call, and what came of it, under that call's row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const note = decisionNote(e.props.tool_use_id);
    if (!note || e.props.isRunning) return next(e);
    const row = await next(e);
    const h = $.ui.resolve(e);
    return h.Box({ flexDirection: 'column', children: [row,
      h.Text({ dimColor: true, maxLines: 1, wrap: 'truncate', children: `⚖ ${note.ruleIds.map(ruleName).join(', ')} · ${outcomeText(note.outcome)}` })] });
  });

  // Decided at once, from what is already counted: a menu may open before a slow answer.
  on('ui.render', { component: 'ContextMenu' }, ($, e) => {
    const h = $.ui.resolve(e), snapshot = lastContext ? bandSnapshot(lastContext) : null;
    const waiting = snapshot && (snapshot.detained || snapshot.pending)
      ? t('menu.waiting', { count: snapshot.detained + snapshot.pending }) : t('menu.hint');
    return h.Box({ flexDirection: 'column', children: [
      h.Button({ key: 'arbiter-open', onPress: () => void openAtWaiting($), children: ['Agent Arbiter ', h.Text({ dimColor: true, children: waiting })] }),
    ] });
  });
}
