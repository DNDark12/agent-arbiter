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
// track, square dots that grow denser and brighter toward the fill's end, and a
// solid pill there that names what waits (and the figure, when it fits). With
// nothing done yet the pill opens the track. A count with no known total (a
// detention) is the pill alone. Groups of dots pulse in the bar's own color
// across the filled area. Reduced motion uses a still rendering of the dots.
const PILL_HEIGHT = 20;
const DOT = 3, PITCH = 4, DOT_ROWS = 4, PULSE_GROUPS = 8;
const escapeText = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
// Close enough to the system font at 11.5px semibold to size the pill.
export const textWidth = text => [...String(text)].reduce((sum, char) => sum + (/[0-9]/.test(char) ? 6.9 : char === ' ' ? 3.3 : /[A-ZĐ]/.test(char) ? 7.6 : 6.4), 0);
export const pillWidth = label => Math.round(textWidth(label) + 22);
// The same dots every time, from a hash of their place.
const hash = n => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

export function pillTrackSvg({ label, color, value = 0, max = null, width = 240, moving = true }) {
  const fill = paint(color), pill = label ? pillWidth(label) : 0, mid = PILL_HEIGHT / 2;
  const pillShape = x => `<rect x="${x}" width="${pill}" height="${PILL_HEIGHT}" rx="${mid}" fill="${fill}"/>` +
    `<text x="${x + pill / 2}" y="${mid + 4}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, system-ui, sans-serif" font-size="11.5" font-weight="650" fill="#1B1B1B" style="font-variant-numeric: tabular-nums">${escapeText(label)}</text>`;
  const svg = (w, body) => ({ width: w, height: PILL_HEIGHT, source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${PILL_HEIGHT}" viewBox="0 0 ${w} ${PILL_HEIGHT}">${body}</svg>` });
  if (!Number.isFinite(max) || max <= 0) return svg(pill, pillShape(0));
  const track = Math.max(pill + 24, Math.round(width));
  const free = track - pill, share = fraction({ value, max });
  // One decided item must show: a started bar leaves the start by a visible step, a part-done one stops short of the end.
  const start = share > 0 ? Math.min(share < 1 ? free - Math.min(10, free / 2) : free, Math.max(Math.min(10, free / 2), Math.round(share * free))) : 0, end = start + pill;
  const top = (PILL_HEIGHT - (DOT_ROWS - 1) * PITCH - DOT) / 2;
  const parts = [`<rect width="${track}" height="${PILL_HEIGHT}" rx="${mid}" fill="#7F7F7F" fill-opacity="0.16"/>`];
  const animate = moving && start > 12;
  const pulses = Array.from({ length: PULSE_GROUPS }, () => []);
  const still = [];
  for (let x = PITCH; x < start - 2; x += PITCH) {
    const ramp = Math.pow(x / start, 1.3);
    for (let row = 0; row < DOT_ROWS; row++) {
      if (hash(x * 31 + row * 7) > 0.62 + ramp * 0.38) continue;
      const dot = `M${x} ${top + row * PITCH}h${DOT}v${DOT}h-${DOT}z`;
      still.push(dot);
      if (animate) pulses[Math.floor(x / (PITCH * 2)) % PULSE_GROUPS].push(dot);
    }
  }
  for (let i = 1; i < 4; i++) {
    const x = Math.round((i * track) / 4);
    if (x > end + 6 && x < track - 6) parts.push(`<rect x="${x}" y="6" width="1.5" height="8" rx="0.75" fill="#8F9BB1" opacity="0.55"/>`);
  }
  if (animate) {
    const wave = pulses.map((group, index) => {
      if (!group.length) return '';
      const begin = (-1.8 + index * 1.8 / PULSE_GROUPS).toFixed(2);
      return `<path d="${group.join('')}" opacity=".52"><animate attributeName="opacity" values=".32;.98;.7;.32" keyTimes="0;.3;.52;1" dur="1.8s" begin="${begin}s" repeatCount="indefinite"/></path>`;
    }).join('');
    parts.push('<style>.rest { display: none } @media (prefers-reduced-motion: reduce) { .mv { display: none } .rest { display: inline } }</style>',
      `<g class="mv" fill="${fill}">${wave}</g>`);
  }
  if (still.length) parts.push(`<path${animate ? ' class="rest"' : ''} d="${still.join('')}" fill="${fill}" opacity=".72"/>`);
  if (pill) parts.push(pillShape(start));
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

// The timeline's colours by how a run ended.
export const RUN_COLORS = Object.freeze({ running: '#9A86FF', done: '#39BFBB', stopped: '#F7B74E', unfinished: '#8F9BB1', detained: '#F76E72' });
const LANE = 10, GUTTER_HEIGHT = 22, SHOWN_LANES = 4;

// The left edge of one timeline row: the main thread as a line at the left, and
// this run as a dot on its lane, joined to the thread when it ran beside others.
// first/last: the thread starts or ends at this row. Lanes past the fourth share it.
export function timelineGutterSvg({ lane = 0, lanes = 1, color, first = false, last = false, main = false }) {
  const shown = Math.min(SHOWN_LANES, Math.max(1, lanes)), at = Math.min(lane, shown - 1);
  const width = shown * LANE + 4, x0 = 6, x = x0 + at * LANE, mid = GUTTER_HEIGHT / 2, fill = paint(color);
  const parts = [`<rect x="${x0 - 0.75}" y="${first ? mid : 0}" width="1.5" height="${first && last ? 0 : first || last ? mid : GUTTER_HEIGHT}" fill="#8F9BB1" opacity="0.55"/>`];
  if (at > 0) parts.push(`<path d="M${x0} ${mid - 6} Q${x0} ${mid} ${x0 + 6} ${mid} L${x} ${mid}" stroke="${fill}" stroke-width="1.5" fill="none" opacity="0.8"/>`);
  parts.push(main ? `<rect x="${x - 4}" y="${mid - 4}" width="8" height="8" rx="2" fill="${fill}"/>` : `<circle cx="${x}" cy="${mid}" r="3.5" fill="${fill}"/>`);
  return { width, height: GUTTER_HEIGHT, source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${GUTTER_HEIGHT}" viewBox="0 0 ${width} ${GUTTER_HEIGHT}">${parts.join('')}</svg>` };
}

// The same edge in a terminal: the thread, and a branch per lane past the first.
export function timelineGutterText({ lane = 0, lanes = 1, last = false }) {
  const shown = Math.min(SHOWN_LANES, Math.max(1, lanes)), at = Math.min(lane, shown - 1);
  return (last && at === 0 ? '└' : '├') + '─'.repeat(1 + 2 * at) + ' ';
}
