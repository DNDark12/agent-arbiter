// The surfaces beside the chat: a band above the prompt for what waits for the
// person, a note under each tool call Arbiter stopped to look at, and a row in
// the desktop app's right-click menu. None of them writes to the chat.
import { observationContext } from './context.js';
import { t } from './i18n.js';
import { roleOf } from './roles.js';
import { openRulesPane } from './rules-pane.js';
import { bandSnapshot, hideBand, refreshStatus, PULSE_MS } from './status.js';
import { decisionNote } from './notes.js';
import { COLORS, levelRow, roleIcon } from './visuals.js';

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

// The band's rows: detentions first, then the decisions waiting. A detention
// count has no known total, so it is a figure; the reviews have one, a bar.
export function bandRows(h, surface, snapshot, now = Date.now()) {
  const rows = [];
  if (snapshot.detained) rows.push({
    key: 'jail', label: t('band.jail'), strong: true, bar: null,
    figure: t('band.jailFigure', { count: snapshot.detained }), shortFigure: t('band.jailShort', { count: snapshot.detained }),
    lead: roleIcon(h, surface, snapshot.detainee ? roleOf(snapshot.detainee) : 'other', 18,
      { detained: true, pulse: now - snapshot.detainedAt < PULSE_MS }, t('band.jailAlt')),
  });
  if (snapshot.pending) {
    const total = snapshot.decided + snapshot.pending;
    rows.push({
      key: 'reviews', label: t('band.reviews'), bar: { value: snapshot.decided, max: total, color: COLORS.review },
      figure: t('band.reviewFigure', { decided: snapshot.decided, total, pending: snapshot.pending }),
      shortFigure: t('band.reviewShort', { decided: snapshot.decided, total, pending: snapshot.pending }),
      minimalFigure: t('band.reviewMinimal', { pending: snapshot.pending }),
    });
  }
  return rows;
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
    if (snapshot.hidden || (!snapshot.detained && !snapshot.pending)) return next(e);
    const h = $.ui.resolve(e);
    const tail = h.Box({ key: 'actions', flexDirection: 'row', gap: 1, flexShrink: 0, children: [
      h.Button({ key: 'band-open', label: t('band.open'), variant: 'primary', onPress: () => void openAtWaiting($) }),
      h.Button({ key: 'band-hide', label: '×', dimColor: true, plain: true, onPress: () => hideBand($, ctx) }),
    ] });
    return h.Box({ flexDirection: 'column', children: bandRows(h, e.surface, snapshot).slice(0, maxRows)
      .map((metric, index) => levelRow(h, e.surface, metric, bodyColumns, index === 0 ? tail : undefined)) });
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
