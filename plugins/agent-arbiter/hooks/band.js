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

const BUTTON_COLUMNS = 12;

// One bar as drawn. columns is the row's width in cells; the dim figure goes
// first when room runs short, then the track, never the pill. small: the
// one-bar band, with a short track and no figure.
export function drawRow(h, surface, row, columns, tail, small = false) {
  const Svg = svgOf(h, surface), free = columns - 4 - (tail ? BUTTON_COLUMNS : 0);
  const pillColumns = [...row.pill].length + 2, statColumns = !small && row.stat ? [...row.stat].length + 1 : 0;
  const showStat = statColumns > 0 && free - pillColumns - statColumns >= 8;
  const trackColumns = row.max ? Math.min(small ? 16 : 30, free - pillColumns - (showStat ? statColumns : 0) - 1) : 0;
  const lead = roleIcon(h, surface, row.role, 18, row.detained ? { detained: true, pulse: row.pulse } : { animate: row.waiting }, row.alt);
  let meter;
  if (Svg) {
    const drawn = pillTrackSvg({ label: row.pill, color: row.color, value: row.value, max: row.max,
      width: row.max ? Math.max(pillWidth(row.pill) + 24, Math.min(small ? 150 : 260, trackColumns * 8)) : 0 });
    meter = Svg({ source: drawn.source, alt: row.alt, width: drawn.width, height: drawn.height });
  } else {
    const cells = trackColumns >= 4 ? trackColumns : 0, done = Math.round(fraction({ value: row.value, max: row.max }) * cells);
    meter = h.Box({ flexDirection: 'row', flexShrink: 0, children: [
      ...(done ? [h.Text({ color: row.color, dimColor: true, children: '█'.repeat(done) })] : []),
      h.Text({ color: row.color, bold: true, maxLines: 1, children: ` ${row.pill} ` }),
      ...(cells - done ? [h.Text({ dimColor: true, children: '░'.repeat(cells - done) })] : []),
    ] });
  }
  return h.Box({ key: row.key, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 1, children: [
    h.Box({ flexDirection: 'row', alignItems: 'center', gap: 1, flexShrink: 1, children: [
      lead, meter,
      ...(showStat ? [h.Text({ dimColor: true, maxLines: 1, wrap: 'truncate', children: row.stat })] : []),
    ] }),
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
    const tail = h.Box({ key: 'actions', flexDirection: 'row', gap: 1, flexShrink: 0, children: [
      expanded ? icon('band-collapse', '▴', () => setBandExpanded($, ctx, false)) : icon('band-expand', '▾', () => setBandExpanded($, ctx, true)),
      icon('band-open', '↗', () => void openAtWaiting($)),
      icon('band-hide', '×', () => hideBand($, ctx)),
    ] });
    if (!expanded) {
      // The small band: the one bar that matters most, and how many more there are.
      const others = (bodyColumns ?? 80) < 22 ? 0 : rows.length - 1;
      const top = drawRow(h, e.surface, rows[0], (bodyColumns ?? 80) - BUTTON_COLUMNS - (others ? 4 : 0), undefined, true);
      return h.Box({ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 1, children: [
        h.Box({ flexDirection: 'row', alignItems: 'center', gap: 1, flexShrink: 1, children: [top,
          ...(others ? [h.Text({ dimColor: true, children: '+' + others })] : [])] }),
        tail,
      ] });
    }
    const gap = svgOf(h, e.surface) ? 1 : 0, fit = gap ? Math.floor((maxRows + 1) / 2) : maxRows;
    return h.Box({ flexDirection: 'column', gap, children: rows.slice(0, Math.max(1, fit))
      .map((row, index) => drawRow(h, e.surface, row, bodyColumns ?? 80, index === 0 ? tail : undefined)) });
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
