import { t } from './i18n.js';
import { approvalNotes } from './notes.js';
import { runState } from './history-view.js';
import { RUN_COLORS } from './visuals.js';
import { COLORS, svgOf, textWidth, timelineGutterSvg, timelineGutterText } from './visuals.js';

const DAY_MS = 86400000;
const decisionColor = state => state === 'open' ? COLORS.review :
  ['dismissed', 'rejected'].includes(state) ? COLORS.jail : COLORS.trust;
const reviewer = review => review.citizen?.kind === 'main' || !review.agentId
  ? t('pane.agentKind.main') : review.citizen?.name || t('pane.agentKind.subagent');
const decisionLabel = state => t('settings.decision.' + state);
const ruleName = id => id.startsWith('user:') ? t('note.custom') : t('rule.' + id);
export const progressTitle = kind => t(kind === 'checklist' ? 'progress.checklist' : 'band.progress.' + kind);

export function progressItems(snapshot, kind, now = Date.now()) {
  const reviews = snapshot?.recentReviews ?? [];
  if (kind === 'reviews') {
    return [...reviews].reverse().flatMap(review => {
      const findings = review.findings
        .filter(finding => ['open', 'confirmed', 'dismissed'].includes(finding.state))
        .map(finding => ({ key: finding.ref, title: finding.claim, status: decisionLabel(finding.state), color: decisionColor(finding.state), branch: true }));
      if (['approved', 'rejected'].includes(review.exemplar.state)) findings.push({
        key: review.id + ':exemplar', title: t('pane.exemplar'), status: decisionLabel(review.exemplar.state),
        color: decisionColor(review.exemplar.state), branch: true,
      });
      if (!findings.length) return [];
      return [{ key: review.id, title: reviewer(review), color: COLORS.review }, ...findings];
    });
  }
  if (kind === 'judge') return [...reviews].reverse().filter(review => now - review.at < DAY_MS).map(review => ({
    key: review.id, title: reviewer(review), color: COLORS.judge,
    status: review.quality === null ? '' : t('score.outOf100', { value: review.quality }),
  }));
  if (kind === 'jail') return [...(snapshot?.detainedRecords ?? [])].reverse().map(record => ({
    key: record.id, title: record.citizen?.name ?? t('pane.agentKind.subagent'), color: COLORS.jail,
    status: record.ruleIds.map(ruleName).join(' · '),
  }));
  if (kind === 'asks') return [...(snapshot?.approvalNotes ?? approvalNotes())].reverse().map(([id, note]) => ({
    key: id, title: note.ruleIds.map(ruleName).join(' · '), status: t('note.' + note.outcome),
    color: note.outcome === 'approved' || note.outcome === 'session-allow' ? COLORS.trust : COLORS.review,
  }));
  return [];
}

export function progressGraph(h, surface, kind, items, columns, more) {
  const Svg = svgOf(h, surface);
  const lanes = kind === 'reviews' ? 2 : 1;
  const gutterWidth = Svg ? lanes + 1 : lanes * 2 + 1;
  const statusCells = Math.max(1, ...items.map(({status = ''}) =>
    Svg ? Math.ceil(textWidth(status) / 8) + 1 : [...status].length + 2));
  const statusWidth = Math.min(statusCells, Math.max(1, Math.floor(columns / 3)));
  return h.Box({ key: 'progress-tree-' + kind, flexDirection: 'column', children: [
    ...items.map((item, index) => {
      const lane = item.branch ? 1 : 0, first = index === 0, last = index === items.length - 1;
      const gutter = Svg ? (() => {
        const drawn = timelineGutterSvg({ lane, lanes, color: item.color, first, last });
        return Svg({ source: drawn.source, alt: item.branch ? '↳' : '●', width: drawn.width, height: drawn.height });
      })() : h.Text({ color: item.color, children: timelineGutterText({ lane, lanes, last }) });
      return h.Box({ key: 'progress:' + item.key, flexDirection: 'row', alignItems: 'center', gap: 1, children: [
        h.Box({ width: gutterWidth, flexShrink: 0, children: [gutter] }),
        h.Box({ flexDirection: 'row', alignItems: 'center', gap: 1, flexGrow: 1, flexShrink: 1, minWidth: 0,
          ...(Svg ? { paddingX: 1, ...(item.status ? { backgroundColor: item.color + '14' } : {}) } : {}),
          children: [
            h.Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, children: [
              h.Text({ bold: !item.branch, maxLines: 1, wrap: 'truncate', children: item.title }),
            ] }),
            ...(item.status ? [h.Box({ width: statusWidth, flexShrink: 0,
              alignItems: statusCells <= statusWidth ? 'flex-end' : 'stretch', children: [
                h.Text({ color: item.color, size: 'caption', maxLines: 1, wrap: 'truncate', children: item.status }),
              ] })] : []),
          ],
        }),
      ] });
    }),
    ...(!items.length && !more ? [h.Text({ dimColor: true, children: t('band.detailEmpty') })] : []),
    ...(more ? [h.Button({ key: 'band-more', label: t('band.showDetails'), plain: true, onPress: more })] : []),
  ] });
}

// The band's list under a bar: only what waits on the person, each with its
// action at hand; what is already settled folds into one row of dots.
const dot = (h, color, key) => h.Text({ key, color, children: '●' });
const severityColor = finding => finding.severity === 'high' ? COLORS.jail : COLORS.review;
const scoreColor = quality => quality >= 85 ? COLORS.trust : quality >= 70 ? COLORS.review : COLORS.jail;
const MAX_DOTS = 24;

function dotRow(h, key, dots, figure, more) {
  const shown = dots.slice(-MAX_DOTS);
  return h.Box({ key, flexDirection: 'row', alignItems: 'center', gap: 1, children: [
    h.Box({ flexDirection: 'row', flexShrink: 0, children: shown.map((color, index) => dot(h, color, key + ':' + index)) }),
    ...(dots.length > shown.length ? [h.Text({ dimColor: true, children: '+' + (dots.length - shown.length) })] : []),
    h.Text({ dimColor: true, maxLines: 1, wrap: 'truncate', children: figure }),
    ...(more ? [h.Box({ flexGrow: 1 }), more] : []),
  ] });
}

function waitingRow(h, key, color, title, detail, buttons) {
  return h.Box({ key, flexDirection: 'row', alignItems: 'center', gap: 1, children: [
    dot(h, color, key + ':dot'),
    h.Box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, gap: 1, children: [
      h.Text({ maxLines: 1, wrap: 'truncate', children: title }),
      ...(detail ? [h.Text({ dimColor: true, maxLines: 1, wrap: 'truncate', children: detail })] : []),
    ] }),
    h.Box({ flexDirection: 'row', flexShrink: 0, gap: 1, children: buttons }),
  ] });
}

// What the list of one bar holds: rows that wait, and the dots of what is settled.
export function bandDetailModel(snapshot, kind, now = Date.now()) {
  const reviews = [...(snapshot?.recentReviews ?? [])].reverse();
  if (kind === 'reviews') {
    const waiting = reviews.flatMap(review => review.findings.filter(finding => finding.state === 'open')
      .map(finding => ({ ref: finding.ref, title: finding.claim, color: severityColor(finding) })));
    const settled = reviews.slice().reverse().flatMap(review => [
      ...review.findings.filter(finding => ['confirmed', 'dismissed'].includes(finding.state)).map(finding => decisionColor(finding.state)),
      ...(['approved', 'rejected'].includes(review.exemplar.state) ? [decisionColor(review.exemplar.state)] : []),
    ]);
    return { waiting, settled, figure: settled.length ? t('band.settled', { count: settled.length }) : '' };
  }
  if (kind === 'jail') return { waiting: [...(snapshot?.detainedRecords ?? [])].reverse().map(record => ({
    ref: record.id, title: record.citizen?.name ?? t('pane.agentKind.subagent'), detail: record.ruleIds.map(ruleName).join(' · '), color: COLORS.jail,
  })), settled: [], figure: '' };
  if (kind === 'asks') {
    const notes = (snapshot?.approvalNotes ?? approvalNotes()).map(([, note]) => note.outcome);
    const allowed = notes.filter(outcome => outcome === 'approved' || outcome === 'session-allow').length;
    return { waiting: [], settled: notes.map(outcome => outcome === 'approved' || outcome === 'session-allow' ? COLORS.trust : COLORS.jail),
      figure: notes.length ? t('band.asksSplit', { allowed, refused: notes.length - allowed }) : '' };
  }
  if (kind === 'judge') {
    const scored = reviews.slice().reverse().filter(review => now - review.at < DAY_MS && review.quality !== null);
    const average = scored.length ? Math.round(scored.reduce((sum, review) => sum + review.quality, 0) / scored.length) : null;
    return { waiting: [], settled: scored.map(review => scoreColor(review.quality)),
      figure: average === null ? '' : t('band.scoreAverage', { value: average }) };
  }
  if (kind === 'agents') {
    const agents = snapshot?.agents ?? [], colorOf = agent => RUN_COLORS[runState(agent)] ?? RUN_COLORS.done;
    return { waiting: agents.filter(agent => agent.status === 'running').map(agent => ({ ref: agent.agentId, title: agent.name, color: colorOf(agent) })),
      settled: agents.filter(agent => agent.status !== 'running').map(colorOf), figure: '' };
  }
  return { waiting: [], settled: [], figure: '' };
}

// actions: { decide(ref, decision), release(id), busy: Set of refs, more: () => void }.
export function bandDetail(h, kind, model, room, actions) {
  const button = (key, label, onPress, color) => h.Button({ key, label, plain: true, ...(color ? { color } : { dimColor: true }), onPress });
  const settledRow = model.settled.length || model.figure ? 1 : 0;
  const fit = Math.max(0, room - settledRow), shown = model.waiting.slice(0, fit), hidden = model.waiting.length - shown.length;
  const more = hidden > 0 ? button('band-more', t('band.moreWaiting', { count: hidden }), actions.more) : null;
  const rows = shown.map(item => {
    const busy = actions.busy.has(item.ref);
    const buttons = busy ? [h.Text({ key: 'busy', dimColor: true, children: '…' })] : kind === 'jail'
      ? [button('release:' + item.ref, t('band.release'), () => actions.release(item.ref), COLORS.trust)]
      : [button('confirm:' + item.ref, '✓', () => actions.decide(item.ref, 'confirmed'), COLORS.trust),
        button('dismiss:' + item.ref, '✕', () => actions.decide(item.ref, 'dismissed'), COLORS.jail)];
    return waitingRow(h, 'wait:' + item.ref, item.color, item.title, item.detail, buttons);
  });
  if (settledRow) rows.push(dotRow(h, 'settled-' + kind, model.settled, model.figure, more));
  else if (more) rows.push(more);
  if (!rows.length) rows.push(h.Text({ key: 'empty', dimColor: true, children: t('band.detailEmpty') }));
  return h.Box({ key: 'progress-tree-' + kind, flexDirection: 'column', paddingLeft: 3, children: rows });
}
