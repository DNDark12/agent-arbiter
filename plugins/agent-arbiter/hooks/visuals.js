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

// The band's meter, after the progress tracker people liked: a soft rounded
// track, pixels gathering up to the fill's end, and a solid pill there naming
// what waits. With nothing done yet the pill opens the track. A count with no
// known total (a detention) is the pill alone. Waiting holds still: no motion.
const PILL_HEIGHT = 20;
const escapeText = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
// Close enough to the system font at 11.5px semibold to size the pill.
export const textWidth = text => [...String(text)].reduce((sum, char) => sum + (/[0-9]/.test(char) ? 6.9 : char === ' ' ? 3.3 : /[A-ZĐ]/.test(char) ? 7.6 : 6.4), 0);
export const pillWidth = label => Math.round(textWidth(label) + 22);

export function pillTrackSvg({ label, color, value = 0, max = null, width = 240 }) {
  const fill = paint(color), pill = pillWidth(label), mid = PILL_HEIGHT / 2;
  const pillShape = x => `<rect x="${x}" width="${pill}" height="${PILL_HEIGHT}" rx="${mid}" fill="${fill}"/>` +
    `<text x="${x + pill / 2}" y="${mid + 4}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, system-ui, sans-serif" font-size="11.5" font-weight="650" fill="#1B1B1B" style="font-variant-numeric: tabular-nums">${escapeText(label)}</text>`;
  const svg = (w, body) => ({ width: w, height: PILL_HEIGHT, source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${PILL_HEIGHT}" viewBox="0 0 ${w} ${PILL_HEIGHT}">${body}</svg>` });
  if (!Number.isFinite(max) || max <= 0) return svg(pill, pillShape(0));
  const track = Math.max(pill + 24, Math.round(width));
  const start = Math.round(fraction({ value, max }) * (track - pill)), end = start + pill;
  const parts = [`<rect width="${track}" height="${PILL_HEIGHT}" rx="${mid}" fill="#7F7F7F" fill-opacity="0.16"/>`];
  for (let x = 6; x < start - 2; x += 3) {
    for (let y = 4; y < PILL_HEIGHT - 4; y += 3) {
      // A scattered, fixed pattern: the same picture every time, no diagonal stripes.
      if ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 7 < 3) parts.push(`<rect x="${x}" y="${y}" width="2" height="2" fill="${fill}" opacity="${(0.2 + 0.65 * x / Math.max(1, start)).toFixed(2)}"/>`);
    }
  }
  for (let i = 1; i < 4; i++) {
    const x = Math.round((i * track) / 4);
    if (x > end + 6 && x < track - 6) parts.push(`<rect x="${x}" y="6" width="1.5" height="8" rx="0.75" fill="#8F9BB1" opacity="0.55"/>`);
  }
  parts.push(pillShape(start));
  return svg(track, parts.join(''));
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
