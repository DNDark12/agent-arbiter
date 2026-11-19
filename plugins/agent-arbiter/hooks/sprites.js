// TEMPORARY icon set: to be replaced by a new design (see docs/icon-redesign.md
// on the development machine). Keep the sprite(role, options) contract.
// Hand-drawn 16 × 14 sprite cells. Every role has its own silhouette, with a
// shared face palette and a role-specific ramp for clothing and equipment.
const FACE = {
  o: '#20263C', e: '#442440', f: '#E88D6B', h: '#FFD2A0', w: '#FFF1D2',
}

const SPRITES = {
  main: {
    colors: { s: '#9F5336', m: '#EBA837', l: '#FFE081', a: '#EC5869' },
    rows: [
      '....l...l...l...',
      '....lm.lml.ml...',
      '....lmlmalmml...',
      '....smmmmmmms...',
      '.....hhhhhhh....',
      '....ohhhehheho..',
      '....offhhhhffo..',
      '...mmoffeffomm..',
      '..lmmsssssssmml.',
      '..mmmlwaaawlmmm.',
      '..msmmmaammmmsm.',
      '.mssmmlmmmlmssm.',
      '.oooossmmmsoooo.',
      '.....oo...oo....',
    ],
  },
  dev: {
    colors: { s: '#9C572B', m: '#F1A43C', l: '#FFD876', a: '#A6D6E8' },
    rows: [
      '...........aa..a',
      '....llll...wa.aa',
      '...lmmmlm..aaaao',
      '..lmmmmmmm..aao.',
      '.llmlmlmlm..ao..',
      '..sssssssssao...',
      '...hhhehhhao....',
      '..ohhhehhaoh....',
      '..offfffaoml....',
      '...ommmaomml....',
      '..lsmmomsssm....',
      '..lmmsmsamsm....',
      '....smmsamm.....',
      '....oo...oo.....',
    ],
  },
  review: {
    colors: { s: '#733E70', m: '#BB689F', l: '#EDA6CF', a: '#AFE0F8' },
    rows: [
      '................',
      '....lll...mam...',
      '...lmmml.mw..m..',
      '...lmmms.a...m..',
      '..lmmssm.m...a..',
      '.lsmmmmms.mam...',
      '..ohhhehh..so...',
      '..ohhehhhaso....',
      '...offfffso.....',
      '....ommwso......',
      '...lmmsssmm.....',
      '..lmmmmslms.....',
      '...ssmmmmss.....',
      '....oo..oo......',
    ],
  },
  explore: {
    colors: { s: '#287052', m: '#50AF74', l: '#B6E58A', a: '#FF7069' },
    rows: [
      '................',
      '......l.........',
      '.....lml...lll..',
      '....lmmml.lwaml.',
      '...smlmmmslwaml.',
      '..mmmssmmm.lsl..',
      '..ohhhehho..so..',
      '.lmfhhhhfs.sso..',
      '.lmofffefomso...',
      '.smlmmmmmmms....',
      '..smlssmmms.....',
      '...mslmmsm......',
      '..ossm..smo.....',
      '..ooo...ooo.....',
    ],
  },
  'test-run': {
    colors: { s: '#3156A5', m: '#507DEE', l: '#ACCBFF', a: '#8BF6D4' },
    rows: [
      '..............a.',
      '............a...',
      '.............w..',
      '....llll....lwm.',
      '...lmmmmmm...wm.',
      '..lmlmlmlmo..wm.',
      '..moollmoo..wam.',
      '..ooaalaao..wam.',
      '...fhhhhf..waam.',
      '...offffomwaaaao',
      '..lmmssmmmsaaaao',
      '..lmmllmms..ooo.',
      '...smmmms.......',
      '...oo..oo.......',
    ],
  },
  'test-design': {
    colors: { s: '#69409D', m: '#9868DB', l: '#D6B2FF', a: '#FFC863' },
    rows: [
      '.............ew.',
      '....llll....eal.',
      '...lmmmlm..eal..',
      '..lmmmmmmmeal...',
      '.lmmmmsssehl....',
      '...hhhhhfe......',
      '..ohhehheho.....',
      '..ohhhhhfho.....',
      '...offffom......',
      '..ommmlsmmm.....',
      '..mwwwwlmmo.....',
      '..mwsswlmm......',
      '..swwwwlsm......',
      '....oo.oo.......',
    ],
  },
  security: {
    colors: { s: '#46556B', m: '#778EAA', l: '#CAD6E3', a: '#83E5F1' },
    rows: [
      '.....llll.......',
      '....lmmmml......',
      '...lmmmmmml.....',
      '...lmaammmo.....',
      '..lmssssmmmo....',
      '..loaaaoommo....',
      '..msseeessso....',
      '.llll..smmso....',
      'lwaall.smmmls...',
      'lmwaml.smmmls...',
      'lmwalssmmmmms...',
      '.lals.smmms.....',
      '..ls..smmms.....',
      '......ooo.ooo...',
    ],
  },
  db: {
    colors: { s: '#276B70', m: '#43A6AD', l: '#94E2D5', a: '#FFDD9C' },
    rows: [
      '......llll......',
      '....llmmmsll....',
      '...lmmsmmmmsl...',
      '...lssssssssl...',
      '..llmmmmmmmmsl..',
      '..lmlllllllmsl..',
      '..lmmmmmmmaaol..',
      '..lmoaaaaaaool..',
      '..lmoaaoaaoaol..',
      '..lmoaaaaaaool..',
      '..lmmoooooomsl..',
      '..lmmmmmmmsmsl..',
      '...lssssssssl...',
      '....oo....oo....',
    ],
  },
  research: {
    colors: { s: '#495299', m: '#6974BD', l: '#C1C6FF', a: '#FFDA7A' },
    rows: [
      '.......lll......',
      '.....llmmml.....',
      '..lllmmmmmmmll..',
      '.lmmmmmmmmmmmmla',
      '...sssmmmss...a.',
      '....llhhll....a.',
      '...hlweelweh..aa',
      '...hlweelweh....',
      '....hhhhhhh.....',
      '...moffffom.....',
      '..lmwa..awml....',
      '..lwaa..aawm....',
      '...ssssssss.....',
      '...oo....oo.....',
    ],
  },
  ba: {
    colors: { s: '#366783', m: '#549EC0', l: '#A6D6E5', a: '#84E8AD' },
    rows: [
      '................',
      '......llll......',
      '.....lmmmlm.....',
      '....lmmmmmm.....',
      '....ssssssss....',
      '....hhhhehh.....',
      '...ohhehhhho....',
      '.lloohhhhhfo.ll.',
      '.lawaoffffomlwa.',
      '.laawwaaaawwlwa.',
      '.lwaaawaaawalws.',
      '.sllllllllssls..',
      '...smmssmms.....',
      '...oo....oo.....',
    ],
  },
  orchestrate: {
    colors: { s: '#8F435D', m: '#CC6077', l: '#FFA8A3', a: '#FFE38A' },
    rows: [
      '...............a',
      '.....llll.....a.',
      '....lmmmmo...a..',
      '....lmllmo..a...',
      '....laaaao.a....',
      '..lmmmmmmmo.....',
      '....hhhehh......',
      '...ohhehhhho....',
      '....offffomla...',
      '....mmwaamml....',
      '...lmmwwmm......',
      '..lmsmwmsm......',
      '.lmsmssmsm......',
      '....oo..oo......',
    ],
  },
  other: {
    colors: { s: '#53658A', m: '#758DB1', l: '#B6CCE3', a: '#F2B384' },
    rows: [
      '................',
      '.......aaa......',
      '......a.........',
      '.....llmml......',
      '....lmmmmml.....',
      '...lmmhhhmmlo...',
      '...lmhhhhhmmo...',
      '..olhheehhmo....',
      '..olmhhahhmo....',
      '...lmffffmlo....',
      '...lmmwammms....',
      '....smmmms......',
      '...smmoomms.....',
      '...ooo..ooo.....',
    ],
  },
}

export const ROLE_EMOJI = {
  main: '👑', dev: '🛠', review: '🔍', explore: '🧭', 'test-run': '🧪', 'test-design': '✏️',
  security: '🛡', db: '🗄', research: '🎓', ba: '📐', orchestrate: '🎩', other: '•',
}

export const ROLES = Object.keys(SPRITES)

// options.animate: idle life, a one-pixel bob, a blink and a glint on the
//   role's prop; reduced-motion settings stop it either way.
// options.detained: behind bars, standing still.
// options.pulse: a detention that just happened, the bars flash three times.

// One pixel of headroom above the grid, so the bob never clips the hat.
export const SPRITE_RATIO = 15 / 16

// Each role keeps its own rhythm, so a row of citizens never moves in step.
const rhythm = role => [...role].reduce((sum, char) => sum + char.charCodeAt(0), 0)

const MOTION = seed => `<style>
@media (prefers-reduced-motion: no-preference) {
  .body { animation: bob 1.6s steps(1) infinite; animation-delay: -${(seed % 16) / 10}s }
  .eye { animation: blink 4.4s steps(1) infinite; animation-delay: -${(seed % 44) / 10}s }
  .prop { animation: glint 2.6s steps(1) infinite; animation-delay: -${(seed % 26) / 10}s }
}
@keyframes bob { 0% { transform: translateY(0) } 50% { transform: translateY(-1px) } }
@keyframes blink { 0%, 91% { opacity: 1 } 92%, 96% { opacity: 0 } }
@keyframes glint { 0%, 55% { opacity: 1 } 62% { opacity: 0.4 } 70% { opacity: 1 } }
</style>`

const ALARM = `<style>
@media (prefers-reduced-motion: no-preference) { .jail { animation: alarm 0.4s steps(1) 3 } }
@keyframes alarm { 0% { fill: #F76E72 } 50% { fill: #20263C } }
</style>`

export function sprite(role, options = {}) {
  const asset = Object.prototype.hasOwnProperty.call(SPRITES, role)
    ? SPRITES[role]
    : SPRITES.other
  const palette = { ...FACE, ...asset.colors }
  const cells = []
  asset.rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const cell = row.charAt(x)
      let end = x + 1
      while (row[end] === cell) end++
      const fill = palette[cell]
      // Eyes sit on the face rows; the accent colour is the role's prop.
      const part = cell === 'e' && y >= 5 && y <= 8 ? ' class="eye"' : cell === 'a' ? ' class="prop"' : ''
      if (fill) cells.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${fill}"${part}/>`)
      x = end
    }
  })
  const moving = options.animate === true && options.detained !== true
  const bars = options.detained
    ? '<g class="jail" fill="#20263C" opacity="0.9"><rect x="0" y="-1" width="16" height="1"/><rect x="0" y="13" width="16" height="1"/>' +
      [1, 5, 9, 13].map(x => `<rect x="${x}" y="-1" width="1.4" height="15"/>`).join('') + '</g>'
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1 16 15" shape-rendering="crispEdges">` +
    `${moving ? MOTION(rhythm(role)) : ''}${options.detained && options.pulse ? ALARM : ''}<g class="body">${cells.join('')}</g>${bars}</svg>`
}
