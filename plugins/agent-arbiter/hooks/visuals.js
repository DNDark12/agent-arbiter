// Shared drawing for the band and the panel: role icons and level bars.
// Remote surfaces (desktop, mobile, editor) draw SVG; the terminal draws
// block characters and emoji. A bar is drawn only against a known total.
import { sprite, ROLE_EMOJI, SPRITE_RATIO } from './sprites.js';

export const COLORS = Object.freeze({
  review: '#F7B74E', judge: '#9A86FF', jail: '#F76E72',
  trust: '#53C891', quality: '#5C9BFF', clean: '#39BFBB',
});

// Every element table may list Svg; only the remote surfaces draw it.
export const svgOf = (h, surface) => surface !== 'terminal' && h.Svg ? h.Svg : null;

const hasRange = bar => Number.isFinite(bar.value) && Number.isFinite(bar.max) && bar.max > 0;
export const fraction = bar => hasRange(bar) ? Math.min(1, Math.max(0, bar.value / bar.max)) : 0;
const paint = color => String(color).replace(/[&"<>]/g, '');

// A flat pixel track with tick marks and a lit fill.
export function barSvg(bar, width, ticks = 4) {
  const track = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
  const end = fraction(bar) * track, color = paint(bar.color);
  const divisions = Math.max(0, Math.min(20, Math.floor(track / 6), Math.floor(ticks)));
  const parts = [`<rect y="4" width="${track}" height="12" fill="#647084"/>`, `<rect y="5" width="${track}" height="10" fill="#30394A"/>`];
  for (let i = 1; i < divisions; i++) parts.push(`<rect x="${Math.round((i * track) / divisions)}" y="8" width="1" height="4" fill="#8F9BB1"/>`);
  if (end > 0) {
    parts.push(`<rect y="5" width="${end}" height="10" fill="${color}"/>`,
      `<rect y="5" width="${end}" height="2" fill="#FFFFFF" opacity="0.34"/>`,
      `<rect y="13" width="${end}" height="2" fill="#20263C" opacity="0.33"/>`);
    if (end >= 8) parts.push(`<rect x="${end - 4}" y="7" width="3" height="2" fill="#FFFFFF" opacity="0.5"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${track}" height="20" viewBox="0 0 ${track} 20">${parts.join('')}</svg>`;
}

// Eighth blocks, so a terminal bar moves by less than a cell.
export function barText(bar, cells) {
  const count = Number.isFinite(cells) ? Math.max(0, Math.floor(cells)) : 0, progress = fraction(bar);
  if (progress === 0 || count === 0) return '░'.repeat(count);
  if (progress === 1) return '█'.repeat(count);
  const eighths = Math.min(8 * count - 1, Math.max(1, Math.round(8 * count * progress)));
  const filled = Math.floor(eighths / 8), partial = '▏▎▍▌▋▊▉'.charAt((eighths % 8) - 1);
  return '█'.repeat(filled) + partial + '░'.repeat(count - filled - partial.length);
}

// A role's citizen: an animated sprite where SVG draws, its emoji elsewhere.
export function roleIcon(h, surface, role, size, options = { animate: true }, alt = role) {
  const Svg = svgOf(h, surface);
  if (!Svg) return h.Text({ children: options.detained ? '⛓' : ROLE_EMOJI[role] ?? '•' });
  return Svg({ source: sprite(role, options), alt, width: size, height: Math.round(size * SPRITE_RATIO),
    ...(options.pulse ? { isInteractive: true } : {}) });
}

// One labelled level: label, bar, figure. The figure is native text so it
// stays readable when the bar has no room; a narrow row drops the bar first.
// metric: { key, label, figure, shortFigure?, minimalFigure?, bar: {value,max,color}|null, lead? }
export function levelRow(h, surface, metric, columns, tail) {
  const Svg = svgOf(h, surface);
  const available = columns - (tail ? 10 : 0);
  const normal = available < 27 ? metric.shortFigure ?? metric.figure : metric.figure;
  const minimal = metric.label.length + normal.length + 1 > available ? metric.minimalFigure : undefined;
  const figure = minimal ?? normal;
  const labelColumns = Math.max(12, metric.label.length);
  const trackColumns = available - labelColumns - figure.length - 3 - (metric.lead ? 3 : 0);
  const hasTrack = metric.bar !== null && minimal === undefined && trackColumns >= 4;
  const width = Math.min(420, trackColumns * 8);
  return h.Box({ key: metric.key, flexDirection: 'row', alignItems: 'center', justifyContent: tail ? 'space-between' : 'flex-start', gap: 1, children: [
    h.Box({ flexDirection: 'row', alignItems: 'center', gap: 1, flexShrink: 1, children: [
      ...(metric.lead ? [metric.lead] : []),
      h.Box({ ...(hasTrack ? { width: labelColumns } : {}), flexShrink: 1, children: [h.Text({ maxLines: 1, wrap: 'truncate', children: metric.label })] }),
      ...(hasTrack ? [Svg
        ? Svg({ source: barSvg(metric.bar, width), alt: `${metric.label} · ${figure}`, width, height: 20 })
        : h.Text({ color: metric.bar.color, maxLines: 1, children: barText(metric.bar, Math.min(36, trackColumns)) })] : []),
      h.Box({ flexShrink: 0, children: [h.Text({ dimColor: metric.bar === null && !metric.strong, tabular: true, maxLines: 1, wrap: 'truncate', children: figure })] }),
    ] }),
    ...(tail ? [tail] : []),
  ] });
}
