// Hooks execute in a restricted runtime: keep path operations pure and POSIX.
// Device files a redirect may target without writing a file.
const DEVICE_SINKS = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;
const basename = path => path.split('/').at(-1);
const isAbsolute = path => path.startsWith('/');
function resolve(base, path) {
  const parts = (isAbsolute(path) ? path : `${base}/${path}`).split('/');
  const result = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop();
    else result.push(part);
  }
  return `/${result.join('/')}`;
}

// A bounded literal recognizer for approval hints, not a shell interpreter or
// security boundary. Unknown syntax is reported for observation, never a risk.
function lex(command) {
  const tokens = [];
  let value = '', active = false, literal = true, unknown = false, quote = null;
  const heredocs = [];
  const skipHeredocs = position => {
    for (const { delimiter, stripTabs } of heredocs.splice(0)) {
      let found = false;
      while (position < command.length) {
        const end = command.indexOf('\n', position);
        const line = command.slice(position, end < 0 ? command.length : end);
        position = end < 0 ? command.length : end + 1;
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) { found = true; break; }
      }
      if (!found) unknown = true;
    }
    return position - 1;
  };
  const flush = () => {
    if (active) {
      if (tokens.at(-1)?.type === 'redirect' && /^\d*<<-?$/.test(tokens.at(-1).value)) {
        heredocs.push({ delimiter: value, stripTabs: tokens.at(-1).value.endsWith('-') });
        unknown = true;
      }
      tokens.push({ type: 'word', value, literal });
    }
    value = ''; active = false; literal = true;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else value += char;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      const next = command[i + 1];
      if (next === '\n') { i++; continue; }
      if (next != null && (!quote || /["\\$`]/.test(next))) { value += next; active = true; i++; continue; }
      if (next == null) unknown = true;
      value += char; active = true; continue;
    }
    if (char === '"') { active = true; quote = quote === '"' ? null : '"'; continue; }
    if (!quote && char === "'") { active = true; quote = "'"; continue; }
    if (char === '$' || char === '`') {
      active = true; literal = false; unknown = true; value += char;
      // Keep substitutions opaque so their content never becomes a literal
      // neighboring command. Deliberately do not evaluate/expand substitutions.
      if (char === '`') {
        while (++i < command.length) { value += command[i]; if (command[i] === '`') break; }
      } else if (command[i + 1] === '(' || command[i + 1] === '{') {
        const open = command[++i], close = open === '(' ? ')' : '}';
        value += open;
        let depth = 1;
        while (++i < command.length) {
          value += command[i];
          if (command[i] === open) depth++;
          if (command[i] === close && --depth === 0) break;
        }
      }
      continue;
    }
    if (quote) { value += char; continue; }
    if (/\s/.test(char)) {
      flush();
      if (char === '\n') {
        tokens.push({ type: 'separator', value: '\n' });
        if (heredocs.length) i = skipHeredocs(i + 1);
      }
      continue;
    }
    if (char === '#' && !active) {
      while (i < command.length && command[i] !== '\n') i++;
      if (i < command.length) {
        tokens.push({ type: 'separator', value: '\n' });
        if (heredocs.length) i = skipHeredocs(i + 1);
      }
      continue;
    }
    const redirect = command.slice(i).match(/^(?:\d+)?(?:&>>|&>|>>|>\||>&|>|<<<|<<-?|<&|<)/);
    if (redirect && (!active || !/^\d/.test(redirect[0]))) {
      flush(); tokens.push({ type: 'redirect', value: redirect[0] }); i += redirect[0].length - 1; continue;
    }
    if (';&|()'.includes(char)) {
      flush();
      const pair = command.slice(i, i + 2);
      const operator = ['&&', '||', ';;'].includes(pair) ? pair : char;
      if (operator.length === 2) i++;
      if (['(', ')', ';;'].includes(operator)) unknown = true;
      tokens.push({ type: 'separator', value: operator }); continue;
    }
    active = true; value += char;
    if ('*?['.includes(char) || (char === '~' && value.length === 1)) { literal = false; unknown = true; }
  }
  if (quote) unknown = true;
  flush();
  return { tokens, unknown };
}

const assignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value);
const ordinary = new Set(['pwd', 'ls', 'cat', 'rg', 'grep', 'find', 'head', 'tail', 'sed', 'awk', 'printf', 'echo',
  'true', 'false', 'test', '[', 'wc', 'sort', 'uniq', 'cut', 'date', 'sleep', 'mkdir', 'rmdir', 'chmod', 'chown',
  'node', 'npx', 'tsx', 'tsc', 'make', 'curl', 'wget', 'docker', 'go', 'cargo', 'pytest']);

// Prefix commands that run the rest of their line as another command.
const PREFIXES = ['env', 'sudo', 'command', 'exec', 'nohup', 'time', 'nice', 'timeout', 'stdbuf'];
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const DOCKER_GLOBAL_VALUE = new Set(['-H', '--host', '-c', '--context', '--config', '-l', '--log-level']);
const COMPOSE_GLOBAL_VALUE = new Set(['-f', '--file', '-p', '--project-name', '--profile', '--env-file',
  '--project-directory', '--ansi', '--progress', '--parallel']);
const CONTAINER_VALUE = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--detach-keys',
  '-v', '--volume', '-p', '--publish', '--name', '--network', '--entrypoint', '-m', '--memory', '--cpus',
  '-l', '--label', '--mount', '--platform', '-h', '--hostname', '--add-host', '--index', '--pull',
  '--cap-add', '--cap-drop']);
const SSH_VALUE = new Set([...'bcDEeFIiJLlmOopQRSWw'].map(letter => `-${letter}`));
const XARGS_VALUE = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs',
  '--replace', '--delimiter', '--arg-file', '--max-lines', '--max-chars']);
const SAIL_PASSTHROUGH = new Set(['composer', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'node', 'php', 'mysql',
  'mariadb', 'psql', 'redis', 'redis-cli', 'bash', 'sh']);
const MAX_DEPTH = 4;
const MAX_COMMANDS = 64;

function unwrap(words, directory) {
  let index = 0;
  while (assignment(words[index] ?? { value: '' })) index++;
  while (words[index]) {
    const name = basename(words[index].value);
    if (!PREFIXES.includes(name)) break;
    index++;
    while (words[index]) {
      const arg = words[index].value;
      if (assignment(words[index])) { index++; continue; }
      if (arg === '--') { index++; break; }
      if (!arg.startsWith('-')) break;
      index++;
      if (['env', 'sudo'].includes(name) && arg.startsWith('--chdir=')) {
        directory = words[index - 1].literal && directory ? resolve(directory, arg.slice(8)) : null;
      }
      if ((name === 'env' && ['-C', '--chdir'].includes(arg)) ||
          (name === 'sudo' && ['-D', '--chdir'].includes(arg))) {
        directory = words[index]?.literal && directory ? resolve(directory, words[index].value) : null;
      }
      if ((name === 'sudo' && ['-u', '-g', '-h', '-p', '-C', '-D', '-T', '--user', '--group', '--host', '--prompt', '--chdir'].includes(arg)) ||
          (name === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(arg)) ||
          (name === 'nice' && ['-n', '--adjustment'].includes(arg)) ||
          (name === 'timeout' && ['-k', '--kill-after', '-s', '--signal'].includes(arg))) index++;
    }
    // timeout takes its duration before the wrapped command.
    if (name === 'timeout' && words[index]) index++;
  }
  return { words: words.slice(index), directory };
}

function operands(words, takesValue = []) {
  const result = [];
  let options = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i], arg = word.value;
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-')) {
      if (takesValue.includes(arg)) i++;
      continue;
    }
    result.push(word);
  }
  return result;
}

function skipOptions(words, index, valued) {
  while (words[index] && words[index].value.startsWith('-') && words[index].value !== '--') {
    if (valued.has(words[index].value)) index++;
    index++;
  }
  if (words[index]?.value === '--') index++;
  return index;
}

// actions: operations a built-in rule asks about. optional: operations only a
// rule the person switched on cares about (commit, push, migrate). commands:
// each recognized command line, outer and unwrapped, for command-pattern rules.
export function analyzeBash(command, cwd = '/') {
  return analyze(command, cwd, 0);
}

function analyze(command, cwd, depth) {
  if (typeof command !== 'string') return { actions: [], unknown: true, optional: [], commands: [] };
  const parsed = lex(command);
  const result = { actions: [], unknown: parsed.unknown, optional: [], commands: [] };
  let directory = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : null;
  if (!directory) result.unknown = true;
  const target = (word, path, base) => word?.literal && word.value ?
    (path ? (base ? resolve(base, word.value) : '*') : word.value) : '*';
  const add = (action, word, path = false, base = directory) => {
    result.actions.push({ action, target: target(word, path, base) });
  };
  const optional = (action, word) => { result.optional.push({ action, target: target(word, false, null) }); };
  const note = text => { if (text && result.commands.length < MAX_COMMANDS && !result.commands.includes(text)) result.commands.push(text); };
  const merge = inner => {
    result.actions.push(...inner.actions); result.optional.push(...inner.optional);
    for (const text of inner.commands) note(text);
    if (inner.unknown) result.unknown = true;
  };
  const literalWord = value => ({ type: 'word', value, literal: true });

  // Classify one command given as words. base is the directory its relative
  // paths resolve against; null when it runs in a container or another host.
  const run = (input, base, level, top = false) => {
    if (level > MAX_DEPTH) { result.unknown = true; return; }
    const unwrapped = unwrap(input, base);
    const args = [...unwrapped.words], childDirectory = unwrapped.directory;
    note(input.map(word => word.value).join(' '));
    if (args.length !== input.length) note(args.map(word => word.value).join(' '));
    const first = args.shift();
    if (!first) return;
    if (!first.literal) { result.unknown = true; return; }
    const name = basename(first.value);
    const values = args.map(word => word.value);
    if (name === 'cd') {
      if (!top) return;
      if (args.length === 1 && args[0].literal && directory) directory = resolve(directory, args[0].value);
      else { directory = null; result.unknown = true; }
      return;
    }
    if (name === 'git') {
      let i = 0;
      while (args[i]?.value.startsWith('-')) {
        const option = args[i++].value;
        if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(option)) i++;
      }
      const subcommand = args[i++]?.value, rest = args.slice(i);
      const flags = rest.filter(word => word.value.startsWith('-')).map(word => word.value);
      if (subcommand === 'commit') optional('git.commit');
      if (subcommand === 'push') {
        const refs = operands(rest, ['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
        const hasRepo = rest.some(word => /^--repo(?:=|$)/.test(word.value));
        const branches = refs.slice(hasRepo ? 0 : 1);
        const force = rest.some(word => word.value === '--mirror') || rest.some(word => /^(?:--force(?:=|$)|--force-with-lease(?:=|$)|-[^-]*f)/.test(word.value)) ||
          branches.some(word => word.value.startsWith('+'));
        const named = word => ({ ...word, value: word.value.replace(/^\+/, '').split(':').at(-1) });
        if (force) {
          if (!branches.length) add('git.force-push');
          for (const word of branches) add('git.force-push', named(word));
        }
        if (!branches.length) optional('git.push');
        for (const word of branches) optional('git.push', named(word));
      }
      if (subcommand === 'reset' && rest.some(word => word.value === '--hard')) add('git.reset-hard', operands(rest)[0]);
      if (subcommand === 'clean' && flags.some(flag => flag === '--force' || /^-[^-]*f/.test(flag)) &&
          !flags.some(flag => flag === '--dry-run' || /^-[^-]*n/.test(flag))) {
        const paths = operands(rest, ['-e', '--exclude']);
        if (!paths.length) add('git.discard', literalWord('.'), true, childDirectory);
        for (const word of paths) add('git.discard', word, true, childDirectory);
      }
      if (subcommand === 'checkout') {
        const dash = rest.findIndex(word => word.value === '--');
        const after = dash >= 0 ? rest.slice(dash + 1) : [];
        const plain = operands(rest);
        for (const word of after) add('git.discard', word, true, childDirectory);
        if (!after.length && (flags.some(flag => ['-f', '--force'].includes(flag)) ||
            (plain.length === 1 && plain[0].value === '.'))) {
          add('git.discard', plain.find(word => word.value === '.') ?? literalWord('.'), true, childDirectory);
        }
      }
      if (subcommand === 'restore' && (!flags.some(flag => ['--staged', '-S'].includes(flag)) ||
          flags.some(flag => ['--worktree', '-W'].includes(flag)))) {
        const paths = operands(rest, ['-s', '--source']);
        if (!paths.length) add('git.discard');
        for (const word of paths) add('git.discard', word, true, childDirectory);
      }
      if (subcommand === 'branch' && (flags.some(flag => /^-[^-]*D/.test(flag)) ||
          (flags.includes('--delete') && flags.includes('--force')))) {
        const names = operands(rest);
        if (!names.length) add('git.discard');
        for (const word of names) add('git.discard', word);
      }
      if (subcommand === 'stash' && ['drop', 'clear'].includes(rest[0]?.value)) add('git.discard');
      return;
    }
    if (name === 'rm') {
      const options = values.slice(0, values.indexOf('--') < 0 ? values.length : values.indexOf('--'));
      const recursive = options.some(flag => flag === '--recursive' || /^-[^-]*[rR]/.test(flag));
      const force = options.some(flag => flag === '--force' || /^-[^-]*f/.test(flag));
      if (recursive && force) {
        const paths = operands(args);
        if (!paths.length) add('fs.remove');
        for (const word of paths) add('fs.remove', word, true, childDirectory);
      }
      return;
    }
    if (name === 'find') {
      let i = 0;
      while (['-H', '-L', '-P'].includes(args[i]?.value)) i++;
      const roots = [];
      while (args[i] && !/^[-(!]/.test(args[i].value)) roots.push(args[i++]);
      const expression = args.slice(i);
      if (expression.some(word => word.value === '-delete')) {
        if (!roots.length) add('fs.remove', literalWord('.'), true, childDirectory);
        for (const word of roots) add('fs.remove', word, true, childDirectory);
      }
      for (let k = 0; k < expression.length; k++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(expression[k].value)) continue;
        const inner = [];
        for (k++; expression[k] && ![';', '+'].includes(expression[k].value); k++) {
          inner.push(expression[k].value === '{}' ? { ...expression[k], literal: false } : expression[k]);
        }
        if (inner.length) run(inner, childDirectory, level + 1);
      }
      return;
    }
    if (name === 'xargs') {
      result.unknown = true;
      const inner = args.slice(skipOptions(args, 0, XARGS_VALUE));
      // The piped operands are unknown: stand in one non-literal operand for them.
      if (inner.length) run([...inner, { type: 'word', value: '{}', literal: false }], childDirectory, level + 1);
      return;
    }
    if (SHELLS.has(name)) {
      const flag = args.findIndex(word => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.value));
      const script = flag >= 0 ? args[flag + 1] : null;
      if (script?.literal) merge(analyze(script.value, childDirectory, level + 1));
      else result.unknown = true;
      return;
    }
    if (name === 'ssh') {
      result.unknown = true;
      const remote = args.slice(skipOptions(args, 0, SSH_VALUE) + 1);
      if (remote.length && remote.every(word => word.literal)) {
        merge(analyze(remote.map(word => word.value).join(' '), null, level + 1));
      }
      return;
    }
    if (['docker', 'docker-compose', 'podman'].includes(name)) {
      let i = 0, compose = name === 'docker-compose';
      if (!compose) {
        i = skipOptions(args, 0, DOCKER_GLOBAL_VALUE);
        if (args[i]?.value === 'compose') { compose = true; i++; }
      }
      if (compose) i = skipOptions(args, i, COMPOSE_GLOBAL_VALUE);
      const subcommand = args[i]?.value;
      if (['exec', 'run'].includes(subcommand)) {
        // After its options comes the container, service or image, then the command.
        const inner = args.slice(skipOptions(args, i + 1, CONTAINER_VALUE) + 1);
        if (inner.length) run(inner, null, level + 1);
      } else if (compose && subcommand === 'down' && values.some(value => ['-v', '--volumes'].includes(value))) {
        add('db.reset');
      }
      return;
    }
    if (name === 'sail') {
      const subcommand = values[0];
      if (['artisan', 'art'].includes(subcommand)) run([literalWord('php'), literalWord('artisan'), ...args.slice(1)], null, level + 1);
      else if (['exec', 'run'].includes(subcommand)) {
        const inner = args.slice(skipOptions(args, 1, CONTAINER_VALUE) + 1);
        if (inner.length) run(inner, null, level + 1);
      } else if (subcommand === 'down' && values.some(value => ['-v', '--volumes'].includes(value))) add('db.reset');
      else if (SAIL_PASSTHROUGH.has(subcommand)) {
        run([subcommand === 'redis' ? literalWord('redis-cli') : args[0], ...args.slice(1)], null, level + 1);
      }
      return;
    }
    if (['npx', 'bunx'].includes(name)) {
      // Keep npx itself ordinary: only a recognized inner command adds anything.
      const before = result.unknown;
      const inner = args.slice(skipOptions(args, 0, new Set(['-p', '--package', '-c', '--call'])));
      if (inner.length) run(inner, childDirectory, level + 1);
      result.unknown = before;
      return;
    }
    if (['cp', 'mv', 'tee', 'touch'].includes(name)) {
      const destinations = operands(args, name === 'touch' ? ['-r', '--reference', '-d', '--date', '-t', '--time'] : ['-t', '--target-directory']);
      if (['cp', 'mv'].includes(name)) {
        const optionIndex = values.findIndex(value => ['-t', '--target-directory'].includes(value));
        const inline = args.find(word => word.value.startsWith('--target-directory='));
        const destination = optionIndex >= 0 ? args[optionIndex + 1] : inline ?
          { ...inline, value: inline.value.slice('--target-directory='.length) } : destinations.at(-1);
        if (destination) add('file.write', destination, true, childDirectory);
      } else for (const word of destinations) add('file.write', word, true, childDirectory);
      return;
    }
    if (name === 'truncate') {
      for (const word of operands(args, ['-s', '--size', '-r', '--reference'])) add('file.write', word, true, childDirectory);
      return;
    }
    if (name === 'dd') {
      for (const word of args) {
        if (word.value.startsWith('of=')) add('file.write', { ...word, value: word.value.slice(3) }, true, childDirectory);
      }
      return;
    }
    if ((name === 'php' && values[0] && basename(values[0]) === 'artisan') || name === 'artisan') {
      if (values.some(value => ['migrate:fresh', 'db:wipe', 'migrate:refresh', 'migrate:reset'].includes(value))) add('db.reset');
      else if (values.some(value => ['migrate', 'migrate:rollback', 'db:seed'].includes(value))) optional('db.migrate');
      return;
    }
    if (['rails', 'rake'].includes(name)) {
      if (values.some(value => ['db:drop', 'db:reset', 'db:schema:load', 'db:migrate:reset'].includes(value))) add('db.reset');
      else if (values.some(value => ['db:migrate', 'db:rollback', 'db:seed'].includes(value))) optional('db.migrate');
      return;
    }
    if (['python', 'python3'].includes(name) && values[0] && basename(values[0]) === 'manage.py') {
      if (values[1] === 'flush') add('db.reset');
      else if (values[1] === 'migrate') optional('db.migrate');
      return;
    }
    if (name === 'prisma') {
      if ((values[0] === 'migrate' && values[1] === 'reset') || values.includes('--force-reset')) add('db.reset');
      else if (values[0] === 'migrate' || (values[0] === 'db' && values[1] === 'push')) optional('db.migrate');
      return;
    }
    if (name === 'redis-cli') {
      if (values.some(value => /^flush(?:all|db)$/i.test(value))) add('db.reset');
      return;
    }
    if (name === 'dropdb') {
      add('db.drop', operands(args, ['-h', '--host', '-p', '--port', '-U', '--username', '--maintenance-db'])[0]);
      return;
    }
    if (['mysql', 'mariadb', 'psql', 'sqlite3'].includes(name)) {
      const sql = [];
      for (let i = 0; i < args.length; i++) {
        if (['-e', '--execute', '-c', '--command'].includes(args[i].value)) sql.push(args[++i]);
        else if (/^(?:--execute|--command)=/.test(args[i].value)) sql.push({ ...args[i], value: args[i].value.replace(/^[^=]*=/, '') });
      }
      if (name === 'sqlite3' && args.length > 1) sql.push(args.at(-1));
      for (const word of sql.filter(Boolean)) {
        if (!word.literal) { result.unknown = true; continue; }
        const pattern = /\bDROP\s+(?:DATABASE|TABLE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w.-]+))/gi;
        const statement = word.value.replace(/'(?:''|\\.|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
        for (const match of statement.matchAll(pattern)) add('db.drop', { value: match[1] ?? match[2] ?? match[3] ?? match[4], literal: true });
      }
      return;
    }
    let manager = name, packageArgs = args;
    if (['python', 'python3'].includes(name) && values[0] === '-m' && values[1] === 'pip') {
      manager = 'pip'; packageArgs = args.slice(2);
    }
    if (['npm', 'yarn', 'pnpm', 'bun', 'composer', 'pip', 'pip3'].includes(manager)) {
      const commandArgs = operands(packageArgs, ['--filter', '-F', '--prefix', '--cwd', '-C', '--dir', '--working-dir', '--registry', '--cache', '--userconfig', '--index-url', '--extra-index-url', '-r', '--requirement', '-c', '--constraint', '--target', '--python']);
      const verb = commandArgs.shift()?.value;
      const verbs = manager === 'composer' ? ['require', 'remove'] :
        ['add', 'install', 'i', 'uninstall', 'remove', 'rm', 'un', 'r'];
      if (verbs.includes(verb)) {
        const packages = commandArgs;
        // Installing what the project already declares changes no dependency.
        const declaredInstall = ['install', 'i'].includes(verb) && !packages.length;
        if (!declaredInstall) {
          if (!packages.length) add('package.change');
          for (const word of packages) add('package.change', word);
        }
      }
      return;
    }
    if (!ordinary.has(name)) result.unknown = true;
  };

  const classify = segment => {
    const words = [];
    for (let i = 0; i < segment.length; i++) {
      const token = segment[i];
      if (token.type !== 'redirect') { words.push(token); continue; }
      const destination = segment[++i];
      if (!destination || destination.type !== 'word') { result.unknown = true; continue; }
      // Output thrown away or sent to the terminal writes no file.
      const sink = destination.literal && DEVICE_SINKS.test(destination.value);
      if (token.value.includes('>') && !token.value.endsWith('>&') && !sink) add('file.write', destination, true);
      if (token.value.includes('<<')) result.unknown = true;
    }
    if (words.length) run(words, directory, depth, true);
  };
  let segment = [];
  for (const token of parsed.tokens) {
    if (token.type === 'separator') { classify(segment); segment = []; }
    else segment.push(token);
  }
  classify(segment);
  return result;
}
