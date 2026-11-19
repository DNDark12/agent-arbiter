// How a session's timeline is drawn, shared by the band and the panel: one row
// per run, a gutter for the thread and its lanes, the role's icon, the agent's
// name, and how the run went.
import { t } from './i18n.js';
import { durationText } from './history.js';
import { RUN_COLORS, roleIcon, svgOf, timelineGutterSvg, timelineGutterText } from './visuals.js';

export const runState = agent => agent.detained ? 'detained' : agent.status;
const shortModel = model => typeof model === 'string' ? model.replace(/^claude-/, '').replace(/-\d{8}$/, '') : '';

// The facts after the name, most telling first: how it ended, how long, how much it did.
export function runFacts(agent) {
  return [t('history.status.' + runState(agent)), durationText(agent.durationMs), t('history.calls', { count: agent.calls }),
    ...(agent.violations.length ? [t('history.violations', { count: agent.violations.length })] : []),
    ...(agent.quality !== null ? [t('history.quality', { value: agent.quality })] : [])].filter(Boolean).join(' · ');
}

// agent: a run from sessionTimeline, or the main thread ({ main: true, model, turns, calls }).
export function timelineRow(h, surface, agent, { lanes = 1, first = false, last = false, onPress = null, size = 18, key } = {}) {
  const Svg = svgOf(h, surface), main = agent.main === true;
  const color = main ? '#E9A23B' : RUN_COLORS[runState(agent)] ?? RUN_COLORS.done;
  let gutter;
  if (Svg) {
    const drawn = timelineGutterSvg({ lane: main ? 0 : agent.lane, lanes, color, first, last, main });
    gutter = Svg({ source: drawn.source, alt: '', width: drawn.width, height: drawn.height });
  } else gutter = h.Text({ dimColor: true, children: main ? '◆ ' : timelineGutterText({ lane: agent.lane, lanes, last }) });
  const icon = roleIcon(h, surface, main ? 'main' : agent.role, size, agent.detained ? { detained: true } : { animate: agent.status === 'running' }, main ? t('pane.agentKind.main') : t('role.' + agent.role));
  const name = main ? t('pane.agentKind.main') : agent.name;
  const facts = main ? [shortModel(agent.model), t('history.turns', { count: agent.turns }), t('history.calls', { count: agent.calls })].filter(Boolean).join(' · ')
    : [shortModel(agent.model), runFacts(agent)].filter(Boolean).join(' · ');
  const runKey = key ?? 'run:' + (agent.agentId ?? 'main');
  const title = h.Text({ bold: true, maxLines: 1, wrap: 'truncate', children: name });
  return h.Box({ key: onPress ? 'row:' + runKey : runKey, flexDirection: 'row', alignItems: 'center', gap: 1, flexShrink: 1, children: [gutter, icon,
    onPress ? h.Button({ key: runKey, plain: true, onPress, children: [title] }) : title,
    ...(main ? [] : [h.Text({ color, maxLines: 1, children: t('role.' + agent.role) })]),
    h.Text({ dimColor: true, maxLines: 1, wrap: 'truncate', children: facts })] });
}
