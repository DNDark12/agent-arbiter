import { ROLES } from './roles.js';

// The models the judge may use, cheapest first. Aliases the session's own client resolves.
export const JUDGE_MODELS = Object.freeze(['haiku', 'sonnet', 'opus']);
// Built-in rules: the standard set every project gets, in any language; details
// belong in a project's custom rules. They can only be switched on or off. The last three are off until
// the person switches them on: commit, push and migrate are ordinary work in
// most projects and forbidden in some.
const BUILTINS = Object.freeze([
  { id: 'git.force-push', label: 'Force push', effect: 'ask' },
  { id: 'git.reset-hard', label: 'Hard reset', effect: 'ask' },
  { id: 'git.discard', label: 'Discard uncommitted work or delete branches', effect: 'ask' },
  { id: 'fs.remove', label: 'Remove files or directories', effect: 'ask' },
  { id: 'db.reset', label: 'Reset database', effect: 'ask' },
  { id: 'db.drop', label: 'Drop or empty databases, tables or schemas', effect: 'ask' },
  { id: 'package.change', label: 'Change dependencies', effect: 'ask' },
  { id: 'deploy.publish', label: 'Publish a package or deploy', effect: 'ask' },
  { id: 'exec.remote', label: 'Run code downloaded from the internet', effect: 'ask' },
  { id: 'system.sudo', label: 'Run commands as administrator', effect: 'ask' },
  { id: 'file.external', label: 'Write outside the project', effect: 'ask' },
  { id: 'file.protected', label: 'Change Claude settings or agent definitions', effect: 'ask' },
  { id: 'file.arbiter', label: 'Change Agent Arbiter data or code', effect: 'deny' },
  { id: 'git.commit', label: 'Commit', effect: 'ask', optional: true },
  { id: 'git.push', label: 'Push', effect: 'ask', optional: true },
  { id: 'db.migrate', label: 'Run database migrations or seeders', effect: 'ask', optional: true },
].map(rule => Object.freeze({ ...rule, optional: rule.optional === true, action: rule.id, target: '**', source: 'builtin' })));
const OPTIONAL = BUILTINS.filter(rule => rule.optional).map(rule => rule.id);
// bash.command matches a whole command line; every other action matches a target.
export const COMMAND_ACTION = 'bash.command';
export const ACTIONS = Object.freeze([...BUILTINS.map(rule => rule.action), 'file.write', COMMAND_ACTION]);
// jail: deny, and detain a subagent at once instead of fining it first.
export const EFFECTS = Object.freeze(['ask', 'deny', 'jail']);
const MAX_RULES = 100;
const MAX_BYTES = 128 * 1024;
const DISPLAY_SWITCHES = ['effects', 'foldAgentStrips', 'checklist', 'autoCloseChecklist', 'outputSpeed', 'progressSounds', 'checkUpdates'];

function settingsPath(ctx) {
  if (!ctx || typeof ctx.archiveRoot !== 'string' || !ctx.archiveRoot.startsWith('/') || ctx.archiveRoot.includes('\0') ||
      typeof ctx.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(ctx.projectId)) throw new Error('Invalid project preferences location');
  return `${ctx.archiveRoot.replace(/\/+$/, '')}/projects/${ctx.projectId}/preferences.json`;
}

function normalizeTarget(value) {
  const path = value.replace(/\\/g, '/');
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !path.startsWith('/')) parts.push(part);
  }
  return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}` || '.';
}

const normalizeCommand = value => value.trim().replace(/\s+/g, ' ');

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project preferences');
  const mode = input.mode ?? 'enforce', hardened = input.hardened ?? false;
  const disabledRules = input.disabledRules ?? [], enabledRules = input.enabledRules ?? [], rules = input.rules ?? [];
  if (!['enforce', 'observe', 'off'].includes(mode) || typeof hardened !== 'boolean') throw new Error('Invalid project mode');
  if (!Array.isArray(disabledRules) || disabledRules.length > BUILTINS.length || disabledRules.some(id => !BUILTINS.some(rule => rule.id === id))) throw new Error('Invalid built-in rule toggle');
  if (!Array.isArray(enabledRules) || enabledRules.length > OPTIONAL.length || enabledRules.some(id => !OPTIONAL.includes(id))) throw new Error('Invalid optional rule toggle');
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error('Expected at most 100 user rules');
  const ids = new Set(BUILTINS.map(rule => rule.id));
  const validated = rules.map(rule => {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(rule.id) || ids.has(rule.id)) throw new Error('Invalid or duplicate user rule ID');
    if (!ACTIONS.includes(rule.action) || !EFFECTS.includes(rule.effect)) throw new Error('Invalid user rule action or effect');
    if (typeof rule.target !== 'string' || !rule.target.trim() || rule.target.length > 512 || /[\x00-\x1f\x7f]/.test(rule.target)) throw new Error('Invalid target pattern');
    ids.add(rule.id);
    const target = rule.action === COMMAND_ACTION ? normalizeCommand(rule.target) : normalizeTarget(rule.target.trim());
    return { id: rule.id, action: rule.action, target, effect: rule.effect };
  });
  // lessons: teach new agents what earlier ones were stopped for. roles: the
  // person's own role per agent type name, overriding the automatic one.
  // judge: review finished subagent runs with one small model call each.
  // lessonExperiment: hold lessons back from one run in five, to measure whether they help.
  // judgeModel: the model the judge and the automatic review use; haiku is the cheapest.
  const lessons = input.lessons ?? true, roles = input.roles ?? {}, judge = input.judge ?? true, lessonExperiment = input.lessonExperiment ?? false;
  const judgeModel = input.judgeModel ?? 'haiku';
  if (typeof lessons !== 'boolean' || typeof judge !== 'boolean' || typeof lessonExperiment !== 'boolean') throw new Error('Invalid lessons or judge switch');
  if (!JUDGE_MODELS.includes(judgeModel)) throw new Error('Invalid judge model');
  if (!roles || typeof roles !== 'object' || Array.isArray(roles) || Object.keys(roles).length > MAX_RULES ||
      Object.entries(roles).some(([name, role]) => !/^[A-Za-z0-9:_. -]{1,128}$/.test(name) || !ROLES.includes(role))) throw new Error('Invalid agent role');
  const display = {};
  for (const key of DISPLAY_SWITCHES) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new Error('Invalid display preference');
    display[key] = input[key];
  }
  return { mode, hardened, disabledRules: [...new Set(disabledRules)], enabledRules: [...new Set(enabledRules)], rules: validated,
    lessons, judge, judgeModel, lessonExperiment, roles: Object.fromEntries(Object.entries(roles).sort(([left], [right]) => left < right ? -1 : 1)),
    ...(input.panelPinned === true ? {panelPinned:true} : {}), ...display };
}

export async function loadProjectSettings($, ctx) {
  const path = settingsPath(ctx);
  if (!await $.fs.exists(path)) return validate({});
  // Read each time: changes made by another session must take effect immediately,
  // even when the file's size and filesystem timestamp have not changed.
  const text = await $.fs.read(path);
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw Object.assign(new Error('Project preferences exceed size limit'),{code:'ARBITER_INVALID_PREFERENCES'});
  try{return validate(JSON.parse(text));}
  catch(error){error.code='ARBITER_INVALID_PREFERENCES';throw error;}
}

export async function saveProjectSettings($, ctx, settings) {
  const path = settingsPath(ctx), value = validate(settings);
  const text = JSON.stringify(value, null, 2) + '\n';
  if (text.length > MAX_BYTES) throw new Error('Project preferences exceed size limit');
  const temporary = `${path}.${crypto.randomUUID()}.part`;
  try {
    await $.fs.write(temporary, text);
    const published = await $.process.run(['/bin/mv', '-f', temporary, path]);
    if (published.exitCode !== 0) throw new Error('Could not publish project preferences');
  } catch (error) {
    try { await $.process.run(['/bin/rm', '-f', temporary]); } catch { /* Preserve the publication failure. */ }
    throw error;
  }
  return value;
}

const LOCK_STALE_MS = 10000;
const LOCK_TRIES = 60;
async function pause($, ms) {
  try { await $.clock.sleep(ms); } catch { /* Without a clock the next try follows at once. */ }
}

// Read, edit and write the preferences under a lock shared by every session, so
// two sessions changing rules at once never lose either change. The lock is a
// hard link, created only if absent; a lock older than ten seconds is abandoned.
async function editProjectSettings($, ctx, edit, recoverInvalid=false) {
  const path = settingsPath(ctx), lock = `${path}.lock`, mine = `${lock}.${crypto.randomUUID()}`;
  await $.fs.write(mine, String(Date.now()));
  try {
    for (let attempt = 0; ; attempt += 1) {
      if ((await $.process.run(['/bin/ln', mine, lock])).exitCode === 0) break;
      let stale = false;
      try { stale = Date.now() - (await $.fs.stat(lock)).mtimeMs > LOCK_STALE_MS; } catch { continue; }
      if (stale) { await $.process.run(['/bin/rm', '-f', lock]); continue; }
      if (attempt >= LOCK_TRIES) throw new Error('Rules are being changed in another session; try again.');
      await pause($, 50);
    }
    try {
      let latest;
      try{latest=await loadProjectSettings($,ctx);}
      catch(error){if(!recoverInvalid || error.code!=='ARBITER_INVALID_PREFERENCES')throw error;latest=validate({});}
      return await saveProjectSettings($,ctx,edit(latest));
    }
    finally { await $.process.run(['/bin/rm', '-f', lock]); }
  } finally { await $.process.run(['/bin/rm', '-f', mine]); }
}

export async function updateProjectSettings($,ctx,edit){return editProjectSettings($,ctx,edit);}

// Reset only rules under the same cross-session lock. A real IO failure never
// authorizes replacing valid, unread preferences with defaults.
export async function resetProjectRules($,ctx){
  return editProjectSettings($,ctx,latest=>({...latest,disabledRules:[],enabledRules:[],rules:[]}),true);
}

function enabled(rule, settings) {
  return rule.optional ? settings.enabledRules.includes(rule.id) : !settings.disabledRules.includes(rule.id);
}

export function listRules(settings) {
  const value = validate(settings);
  return [...BUILTINS.map(rule => ({ ...rule, enabled: enabled(rule, value) })),
    ...value.rules.map(rule => ({ ...rule, source: 'user', enabled: true }))];
}

// Flip one built-in rule, whichever list holds its switch.
export function toggleBuiltin(settings, id) {
  const value = validate(settings), rule = BUILTINS.find(item => item.id === id);
  if (!rule) throw new Error('Unknown built-in rule');
  const list = rule.optional ? 'enabledRules' : 'disabledRules';
  return { ...value, [list]: value[list].includes(id) ? value[list].filter(item => item !== id) : [...value[list], id] };
}

function matches(pattern, target) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') { index += 1; expression += '(?:.*/)?'; }
      else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(normalizeTarget(target));
}

// A command pattern is literal text where * stands for any run of characters.
function matchesCommand(pattern, command) {
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}$`).test(normalizeCommand(command));
}

function applies(rule, action) {
  if (action?.action !== rule.action) return false;
  const target = typeof action.target === 'string' ? action.target : '';
  if (rule.action === COMMAND_ACTION) return matchesCommand(rule.target, target);
  return matches(rule.target, target) ||
    (typeof action.relativeTarget === 'string' && matches(rule.target, action.relativeTarget));
}

// effect is what the gate does: allow, ask, or deny. severe marks a jail rule.
// matched lists the classified actions some enabled rule applies to.
export function matchRules(actions, settings) {
  if (!Array.isArray(actions)) throw new Error('Expected classified actions');
  const rules = listRules(settings).filter(rule => rule.enabled && actions.some(action => applies(rule, action)));
  const blocking = rules.filter(rule => rule.effect !== 'ask');
  const decisive = blocking.length ? blocking : rules;
  return { effect: blocking.length ? 'deny' : rules.length ? 'ask' : 'allow', rules,
    severe: rules.some(rule => rule.effect === 'jail'),
    matched: actions.filter(action => decisive.some(rule => applies(rule, action))) };
}

export function createUserRule(settings, rule) {
  const value=validate(settings);
  return validate({...value,rules:[...value.rules,rule]});
}
function editableRule(settings,id,expected) {
  const value=validate(settings),rule=value.rules.find(item=>item.id===id);
  if(!rule)throw new Error('Custom rule no longer exists; reopen the list.');
  if(expected && ['id','action','target','effect'].some(field=>rule[field]!==expected[field]))throw new Error('Custom rule changed in another view; reopen it before saving.');
  return {value,rule};
}
export function updateUserRule(settings,id,changes,expected) {
  const {value,rule}=editableRule(settings,id,expected);
  return validate({...value,rules:value.rules.map(item=>item.id===id?{...rule,...changes,id}:item)});
}
export function deleteUserRule(settings,id,expected) {
  const {value}=editableRule(settings,id,expected);
  return {...value,rules:value.rules.filter(rule=>rule.id!==id)};
}
