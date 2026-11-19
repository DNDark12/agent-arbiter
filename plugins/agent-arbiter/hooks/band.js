// The surfaces beside the chat: a band above the prompt for what waits for the
// person, a note under each tool call Arbiter stopped to look at, and a row in
// the desktop app's right-click menu. None of them writes to the chat.
import { observationContext } from './context.js';
import { t } from './i18n.js';
import { roleOf } from './roles.js';
import { openRulesPane } from './rules-pane.js';
import { bandSnapshot, hideBand, refreshStatus, selectBandProgress, setBandExpanded, PULSE_MS } from './status.js';
import { decisionNote, sessionAsks } from './notes.js';
import { DAILY_TRIALS } from './judge.js';
import { COLORS, fraction, pillTrackSvg, pillWidth, roleIcon, svgOf } from './visuals.js';
import { progressGraph, progressItems, progressTitle } from './progress-view.js';

let lastContext = null;

async function contextOf($) {
  lastContext = await observationContext($, { recoverPreferences: true });
  return lastContext;
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
// day) joins only the full list. The name stays left of the track and the
// count is in the pill. A detention shows a count without a total.
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

// Reserve the same room for the action group in every expanded row.
const BUTTON_COLUMNS = 12;
// The track takes the rest of the row; this only keeps a very wide window sane.
const MAX_TRACK_COLUMNS = 160;
const columnsOf = text => [...text].length + 2;

function bandLabel(row, free, small) {
  const folded = !small && row.stat ? `${row.pill} · ${row.stat}` : row.pill;
  return free - columnsOf(folded) >= 8 ? folded : row.pill;
}

// One bar as drawn. columns is the row's width in cells and the track fills
// what the pill leaves; the figure goes first when room runs short, then the
// track, never the pill. small: the one-bar band, with no figure.
export function drawRow(h, surface, row, columns, tail, small = false, onPress = null, labelColumns = null) {
  const Svg = svgOf(h, surface), free = columns - 4 - (tail || labelColumns ? BUTTON_COLUMNS : 0);
  const spaceForTrack = label => row.max ? Math.min(MAX_TRACK_COLUMNS, free - (labelColumns ?? columnsOf(label)) - 1) : 0;
  const meterLabel = progressTitle(row.key);
  const ratio = onPress && row.max ? `${row.value}/${row.max}` : '';
  const badge = Svg && ratio && spaceForTrack(meterLabel) * 7.5 >= pillWidth(ratio) + 24 ? ratio : '';
  const label = ratio ? (badge ? meterLabel : `${meterLabel} · ${ratio}`) : bandLabel(row, free, small);
  const trackColumns = spaceForTrack(label);
  const lead = roleIcon(h, surface, row.role, 18, row.detained ? { detained: true, pulse: row.pulse } : { animate: row.waiting }, row.alt);
  const labelText = h.Text({ color: row.color, bold: true, maxLines: 1, children: ` ${label} ` });
  const content = [lead];
  if (Svg) {
    if (onPress) content.push(labelColumns ? h.Box({ key: 'label-' + row.key, width: labelColumns, flexShrink: 0, children: [labelText] }) : labelText);
    if (!onPress || trackColumns >= 4) {
      const trackLabel = onPress ? badge : label;
      const width = onPress ? trackColumns * 7.5 : Math.max(pillWidth(label) + 24, trackColumns * 7.5);
      const drawn = pillTrackSvg({ label: trackLabel, color: row.color, value: row.value, max: row.max, width });
      content.push(Svg({ source: drawn.source, alt: row.alt, width: drawn.width, height: drawn.height,
        ...(row.value > 0 && row.max > 0 ? { isInteractive: true } : {}) }));
    }
    // Desktop keeps native buttons at their content width. A Client covers
    // the artwork without drawing another label or covering the action buttons.
    if (onPress) content.push(h.Box({ key: 'band-hit-' + row.key, position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
      flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center',
      children: [surface === 'desktop' && h.Client
        ? h.Client({ key: 'band-toggle-' + row.key, module: './band-hit.js', width: '100%', height: '100%' })
        : h.Button({ key: 'band-toggle-' + row.key, label: '⠀', plain: true, onPress })] }));
  } else {
    const cells = trackColumns >= 4 ? trackColumns : 0, share = fraction({ value: row.value, max: row.max });
    // One decided item must show: never round a started bar back to empty, nor a part-done one to full.
    const done = share > 0 && cells ? Math.min(share < 1 ? cells - 1 : cells, Math.max(1, Math.round(share * cells))) : 0;
    const meter = [
      ...(done ? [h.Text({ color: row.color, dimColor: true, children: '█'.repeat(done) })] : []),
      labelText,
      ...(cells - done ? [h.Text({ dimColor: true, children: '░'.repeat(cells - done) })] : []),
    ];
    if (onPress) content[0] = h.Button({ key: 'band-toggle-' + row.key, label: row.alt, plain: true, onPress,
      children: [lead, ' ', ...meter] });
    else content.push(h.Box({ flexDirection: 'row', flexShrink: 0, children: meter }));
  }
  const bar = h.Box({ position: 'relative', flexDirection: 'row', alignItems: 'center', gap: 1, flexShrink: 1, flexGrow: 1, children: content });
  return h.Box({ key: row.key, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 1, children: [
    bar,
    ...(tail ? [tail] : []),
  ] });
}

const outcomeText = outcome => t('note.' + (['approved', 'session-allow', 'refused', 'unanswered', 'denied-by-rule', 'retry-after-refusal'].includes(outcome) ? outcome : 'other'));
const ruleName = id => id.startsWith('user:') ? t('note.custom') : t('rule.' + id);

export function registerBand(on) {
  on('ui.message', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.element.startsWith('band-toggle-') || e.data !== 'toggle') return next(e);
    const ctx = await contextOf($), snapshot = bandSnapshot(ctx);
    const key = e.element.slice('band-toggle-'.length);
    if (snapshot && !snapshot.hidden && bandRows(snapshot, Date.now(), sessionAsks()).some(row => row.key === key)) selectBandProgress($, ctx, key);
    return {};
  });
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
    const selected = rows.find(row => row.key === snapshot.selected);
    const icon = (key, label, onPress) => h.Button({ key, label, plain: true, dimColor: true, onPress });
    const showDetails = () => void openRulesPane($, ctx, 'progress', { kind: 'progress', key: selected.key });
    const tail = h.Box({ key: 'actions', flexDirection: 'row', gap: 1, flexShrink: 0, children: [
      ...(rows.length > 1 ? [icon('band-list', '≡', () => setBandExpanded($, ctx, Boolean(selected) || !expanded))] : []),
      icon('band-open', '↗', selected ? showDetails : () => void openAtWaiting($)),
      icon('band-hide', '×', () => hideBand($, ctx)),
    ] });
    const gap = svgOf(h, e.surface) ? 1 : 0, fit = gap ? Math.floor((maxRows + 1) / 2) : maxRows;
    const columns = bodyColumns ?? 80, visible = selected ? [selected] : rows.slice(0, expanded ? Math.max(1, fit) : 1);
    const free = columns - 4 - BUTTON_COLUMNS;
    const widestLabel = Math.max(...visible.map(row => columnsOf(row.max ? progressTitle(row.key) : row.pill)));
    const labelColumns = gap && visible.length > 1 && free - widestLabel >= 14 ? widestLabel : null;
    const bars = visible.map((row, index) => drawRow(h, e.surface, row, columns, index === 0 ? tail : undefined, !expanded,
      () => selectBandProgress($, ctx, row.key), labelColumns));
    const room = maxRows - 1;
    if (!selected || room < 1) return h.Box({ flexDirection: 'column', gap, children: bars });
    const items = progressItems(snapshot, selected.key), more = items.length > room;
    return h.Box({ flexDirection: 'column', children: [...bars,
      progressGraph(h, e.surface, selected.key, items.slice(0, more ? room - 1 : room), more ? showDetails : null),
    ] });
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
