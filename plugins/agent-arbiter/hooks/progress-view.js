import { t } from './i18n.js';
import { approvalNotes } from './notes.js';
import { COLORS, svgOf, timelineGutterSvg, timelineGutterText } from './visuals.js';

const DAY_MS = 86400000;
const decisionColor = state => state === 'open' ? COLORS.review :
  ['dismissed', 'rejected'].includes(state) ? COLORS.jail : COLORS.trust;
const reviewer = review => review.citizen?.kind === 'main' || !review.agentId
  ? t('pane.agentKind.main') : review.citizen?.name || t('pane.agentKind.subagent');
const decisionLabel = state => t('settings.decision.' + state);
const ruleName = id => id.startsWith('user:') ? t('note.custom') : t('rule.' + id);
export const progressTitle = kind => t('band.progress.' + kind);

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
  if (kind === 'asks') return approvalNotes().reverse().map(([id, note]) => ({
    key: id, title: note.ruleIds.map(ruleName).join(' · '), status: t('note.' + note.outcome),
    color: note.outcome === 'approved' || note.outcome === 'session-allow' ? COLORS.trust : COLORS.review,
  }));
  return [];
}

export function progressGraph(h, surface, kind, items, more) {
  const Svg = svgOf(h, surface);
  const lanes = kind === 'reviews' ? 2 : 1;
  return h.Box({ key: 'progress-tree-' + kind, flexDirection: 'column', children: [
    ...items.map((item, index) => {
      const lane = item.branch ? 1 : 0, first = index === 0, last = index === items.length - 1;
      const gutter = Svg ? (() => {
        const drawn = timelineGutterSvg({ lane, lanes, color: item.color, first, last });
        return Svg({ source: drawn.source, alt: '', width: drawn.width, height: drawn.height });
      })() : h.Text({ color: item.color, children: timelineGutterText({ lane, lanes, last }) });
      return h.Box({ key: 'progress:' + item.key, flexDirection: 'row', alignItems: 'center', gap: 1, children: [
        gutter,
        h.Text({ bold: !item.branch, maxLines: 1, wrap: 'truncate', children: item.title }),
        ...(item.status ? [h.Text({ color: item.color, dimColor: true, maxLines: 1, wrap: 'truncate', children: item.status })] : []),
      ] });
    }),
    ...(!items.length && !more ? [h.Text({ dimColor: true, children: t('band.detailEmpty') })] : []),
    ...(more ? [h.Button({ key: 'band-more', label: t('band.showDetails'), plain: true, onPress: more })] : []),
  ] });
}
