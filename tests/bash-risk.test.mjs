import { test } from 'node:test';
import assert from 'node:assert/strict';

const parser = await import('../extension/hooks/bash-risk.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const cwd = '/project';
const analyze = command => {
  assert.equal(typeof parser.analyzeBash, 'function', 'Bash risk analyzer must be exported');
  // The risky view: optional actions and command lines are checked separately.
  const { actions, unknown } = parser.analyzeBash(command, cwd);
  return { actions, unknown };
};
const full = command => parser.analyzeBash(command, cwd);
const actions = command => analyze(command).actions;
const action = (action, target) => ({ action, target });

test('ordinary reads, build, tests, commits and normal pushes have no risky actions', () => {
  for (const command of ['pwd', 'ls -la', 'cat README.md', 'rg TODO src', 'npm test', 'npm run build',
    'npm install', 'git status', 'git diff', 'git commit -m "fix: ordinary change"', 'git push origin main']) {
    assert.deepEqual(actions(command), [], command);
    assert.equal(analyze(command).unknown, false, command);
  }
});

test('unknown commands are observable without inventing risky actions', () => {
  assert.deepEqual(analyze('my-custom-build --fast'), { actions: [], unknown: true });
  assert.deepEqual(analyze(''), { actions: [], unknown: false });
});

test('force push variants include explicit branch targets and targetless fallback', () => {
  for (const flag of ['--force', '-f', '--force-with-lease', '--force-with-lease=main:abc']) {
    assert.deepEqual(actions(`git push ${flag} origin main`), [action('git.force-push', 'main')]);
  }
  assert.deepEqual(actions('git push origin +HEAD:refs/heads/main'), [action('git.force-push', 'refs/heads/main')]);
  assert.deepEqual(actions('git push --force origin first second'), [
    action('git.force-push', 'first'), action('git.force-push', 'second')]);
  assert.deepEqual(actions('git push -f'), [action('git.force-push', '*')]);
  assert.deepEqual(actions('git push --force origin'), [action('git.force-push', '*')]);
});

test('hard reset is narrow and preserves the explicit revision', () => {
  assert.deepEqual(actions('git reset --hard'), [action('git.reset-hard', '*')]);
  assert.deepEqual(actions('git reset --hard HEAD~2'), [action('git.reset-hard', 'HEAD~2')]);
  for (const command of ['git reset --soft HEAD', 'git reset --mixed HEAD', 'git reset file', 'git push --force-if-includes origin main']) {
    assert.deepEqual(actions(command), []);
  }
});

test('literal quotes, git -C and env/sudo wrappers preserve risky commands', () => {
  assert.deepEqual(actions('env MODE=test sudo -u root git -C "/tmp/a repo" push --force origin "release/next"'),
    [action('git.force-push', 'release/next')]);
  assert.deepEqual(actions('MODE=test git -c advice.pushUpdateRejected=false push -f origin main'),
    [action('git.force-push', 'main')]);
  assert.deepEqual(actions('sudo -- rm -rf -- "../a folder"'), [action('fs.remove', '/a folder')]);
});

test('recursive forced remove catches combined and separate flags with each path', () => {
  for (const flags of ['-rf', '-fr', '-r -f', '--recursive --force', '-Rf']) {
    assert.deepEqual(actions(`rm ${flags} -- ./cache ../old`), [
      action('fs.remove', '/project/cache'), action('fs.remove', '/old')]);
  }
  assert.deepEqual(actions('rm -rf'), [action('fs.remove', '*')]);
  for (const command of ['rm cache', 'rm -f cache', 'rm -r cache', 'rmdir cache']) assert.deepEqual(actions(command), []);
});

test('composites retain all known risky actions beside unknown commands', () => {
  const result = analyze('mystery && git push -f origin main; rm -rf cache\nnpm add lodash | cat');
  assert.deepEqual(result.actions, [action('git.force-push', 'main'), action('fs.remove', '/project/cache'),
    action('package.change', 'lodash')]);
  assert.equal(result.unknown, true);
});

test('quoted text and comments do not create commands', () => {
  for (const command of ['echo "rm -rf /; git push -f origin main"', "printf '%s' 'rm -rf /'",
    'echo safe # rm -rf /', 'git commit -m "git push --force; rm -rf /"']) assert.deepEqual(actions(command), []);
  assert.deepEqual(actions('echo safe # ignored\nrm -rf cache'), [action('fs.remove', '/project/cache')]);
});

test('dynamic operands remain unknown with a wildcard risky target', () => {
  for (const command of ['rm -rf "$TARGET"', 'rm -rf $(get-path)', 'rm -rf cache/*']) {
    assert.deepEqual(analyze(command), { actions: [action('fs.remove', '*')], unknown: true });
  }
  assert.deepEqual(actions("rm -rf '$TARGET'"), [action('fs.remove', '/project/$TARGET')]);
  assert.deepEqual(actions('echo $(rm -rf /)'), []);
  assert.equal(analyze('echo $(rm -rf /)').unknown, true);
});

test('Laravel fresh/wipe and explicit database drop commands are detected', () => {
  for (const command of ['php artisan migrate:fresh --force', 'php artisan db:wipe', './artisan migrate:fresh']) {
    assert.deepEqual(actions(command), [action('db.reset', '*')]);
  }
  assert.deepEqual(actions('dropdb --if-exists app'), [action('db.drop', 'app')]);
  assert.deepEqual(actions('mysql app -e "DROP DATABASE app"'), [action('db.drop', 'app')]);
  assert.deepEqual(actions('psql app -c \'DROP TABLE IF EXISTS "old_table" CASCADE;\''), [action('db.drop', 'old_table')]);
  assert.deepEqual(actions('php artisan migrate'), []);
  assert.deepEqual(actions('echo "DROP DATABASE app"'), []);
});

test('package add and remove commands expose explicit package names', () => {
  for (const command of ['npm install lodash', 'npm add lodash', 'npm uninstall lodash', 'npm rm lodash',
    'yarn add lodash', 'yarn remove lodash', 'pnpm add lodash', 'pnpm remove lodash', 'bun add lodash',
    'bun remove lodash', 'composer require lodash', 'composer remove lodash', 'pip install lodash',
    'pip3 uninstall lodash', 'python -m pip install lodash']) {
    assert.deepEqual(actions(command), [action('package.change', 'lodash')], command);
  }
  assert.deepEqual(actions('npm install --save-dev typescript vitest'), [
    action('package.change', 'typescript'), action('package.change', 'vitest')]);
  assert.deepEqual(actions('pnpm --filter api add zod'), [action('package.change', 'zod')]);
  assert.deepEqual(actions('npm add'), [action('package.change', '*')]);
  for (const command of ['npm ci', 'yarn install', 'composer install', 'pip list', 'pnpm run test']) {
    assert.deepEqual(actions(command), [], command);
  }
});

test('literal shell redirection identifies write paths including descriptors and append', () => {
  assert.deepEqual(actions('printf hello > ./src/output.txt'), [action('file.write', '/project/src/output.txt')]);
  assert.deepEqual(actions('echo x >> "../outside file" 2> errors.log'), [
    action('file.write', '/outside file'), action('file.write', '/project/errors.log')]);
  assert.deepEqual(actions('command &> combined.log'), [action('file.write', '/project/combined.log')]);
  assert.deepEqual(actions('cat < input 2>&1'), []);
});

test('cp/mv/tee/touch expose destination writes, not source reads', () => {
  assert.deepEqual(actions('cp source ../outside'), [action('file.write', '/outside')]);
  assert.deepEqual(actions('mv -f source /tmp/target'), [action('file.write', '/tmp/target')]);
  assert.deepEqual(actions('cp -t ../outside first second'), [action('file.write', '/outside')]);
  assert.deepEqual(actions('tee -a first "../other file"'), [
    action('file.write', '/project/first'), action('file.write', '/other file')]);
  assert.deepEqual(actions('touch -r template first second'), [
    action('file.write', '/project/first'), action('file.write', '/project/second')]);
});

test('cd and git -C resolve later literal file writes against their directory', () => {
  assert.deepEqual(actions('cd /tmp && touch file; cd ../project && rm -rf cache'), [
    action('file.write', '/tmp/file'), action('fs.remove', '/project/cache')]);
  assert.deepEqual(actions('git -C /other status > report'), [action('file.write', '/project/report')]);
});

test('malformed and unsupported syntax is observable without losing previous known actions', () => {
  assert.deepEqual(analyze('git push -f origin main; echo "unterminated'), {
    actions: [action('git.force-push', 'main')], unknown: true });
  assert.equal(analyze('if arbitrary; then echo safe; fi').unknown, true);
  assert.deepEqual(actions('rm -rf -- "semi;colon"'), [action('fs.remove', '/project/semi;colon')]);
});

test('heredoc payload is opaque and does not manufacture executable risks', () => {
  assert.deepEqual(analyze("cat <<'EOF'\nrm -rf /\ngit push -f origin main\nEOF\n"), { actions: [], unknown: true });
  assert.deepEqual(actions("cat <<EOF\nrm -rf /\nEOF\nrm -rf cache"), [action('fs.remove', '/project/cache')]);
});

test('force pushes using explicit repo options and mirror retain their targets', () => {
  assert.deepEqual(actions('git push --repo origin --force main'), [action('git.force-push', 'main')]);
  assert.deepEqual(actions('git push --mirror origin'), [action('git.force-push', '*')]);
});

test('wrapper working directories affect child file operands, not shell redirects', () => {
  assert.deepEqual(actions('env -C /other touch file > report'), [
    action('file.write', '/project/report'), action('file.write', '/other/file')]);
  assert.deepEqual(actions('sudo --chdir=/other rm -rf cache'), [action('fs.remove', '/other/cache')]);
});

test('SQL string literals and comments do not manufacture drop operations', () => {
  for (const sql of ["SELECT 'DROP DATABASE app'", '-- DROP DATABASE app', '/* DROP TABLE app */ SELECT 1']) {
    assert.deepEqual(actions(`mysql -e "${sql}"`), [], sql);
  }
});

test('package option values are not additional package targets', () => {
  assert.deepEqual(actions('npm install --registry https://example.test zod'), [action('package.change', 'zod')]);
  // Installing declared requirements changes no dependency.
  assert.deepEqual(actions('pip install -r requirements.txt'), []);
});

test('container, Sail, shell and remote wrappers expose the command they run', () => {
  for (const command of ['docker compose exec app php artisan migrate:fresh', 'docker-compose exec -T app php artisan db:wipe',
    'docker exec -it story-app php artisan migrate:refresh', './vendor/bin/sail artisan migrate:reset',
    'sail exec app php artisan migrate:fresh', 'ssh deploy@prod "php artisan migrate:fresh"']) {
    assert.deepEqual(actions(command), [action('db.reset', '*')], command);
  }
  assert.deepEqual(actions('docker compose exec app composer require foo/bar'), [action('package.change', 'foo/bar')]);
  assert.deepEqual(actions('sail composer require foo/bar'), [action('package.change', 'foo/bar')]);
  assert.deepEqual(actions('bash -c "rm -rf storage"'), [action('fs.remove', '/project/storage')]);
  assert.deepEqual(actions("sh -lc 'git push --force origin main'"), [action('git.force-push', 'main')]);
  assert.deepEqual(actions('timeout 30 env A=1 rm -rf cache'), [action('fs.remove', '/project/cache')]);
  // A path inside a container or another host is not a local path.
  assert.deepEqual(actions('docker exec app rm -rf storage'), [action('fs.remove', '*')]);
  assert.deepEqual(actions('docker compose down -v'), [action('db.reset', '*')]);
  assert.deepEqual(actions('docker compose up -d'), []);
});

test('find and xargs removals are recognized with unknown operands kept as wildcards', () => {
  assert.deepEqual(actions('find storage -name "*.log" -delete'), [action('fs.remove', '/project/storage')]);
  assert.deepEqual(actions('find . -type d -name cache -exec rm -rf {} +'), [action('fs.remove', '*')]);
  assert.deepEqual(actions('find . -name x -exec rm -rf {} \\;'), [action('fs.remove', '*')]);
  assert.deepEqual(actions('ls | xargs rm -rf'), [action('fs.remove', '*')]);
  assert.deepEqual(actions('find . -name "*.js"'), []);
});

test('discarding Git work beyond hard reset is detected, ordinary Git is not', () => {
  assert.deepEqual(actions('git clean -fdx'), [action('git.discard', '/project')]);
  assert.deepEqual(actions('git clean -n'), []);
  assert.deepEqual(actions('git checkout -- src/a.js'), [action('git.discard', '/project/src/a.js')]);
  assert.deepEqual(actions('git checkout .'), [action('git.discard', '/project')]);
  assert.deepEqual(actions('git checkout feature'), []);
  assert.deepEqual(actions('git restore src'), [action('git.discard', '/project/src')]);
  assert.deepEqual(actions('git restore --staged src'), []);
  assert.deepEqual(actions('git branch -D feature'), [action('git.discard', 'feature')]);
  assert.deepEqual(actions('git stash drop'), [action('git.discard', '*')]);
  assert.deepEqual(actions('git stash'), []);
});

test('database resets beyond migrate:fresh and file truncation are detected', () => {
  for (const command of ['redis-cli FLUSHALL', 'redis-cli -n 1 flushdb', 'rails db:drop', 'python manage.py flush',
    'npx prisma migrate reset']) assert.deepEqual(actions(command), [action('db.reset', '*')], command);
  assert.deepEqual(actions('truncate -s 0 .env'), [action('file.write', '/project/.env')]);
  assert.deepEqual(actions('dd if=/dev/zero of=disk.img'), [action('file.write', '/project/disk.img')]);
});

test('commit, push and migrate are optional actions, never built-in risks', () => {
  assert.deepEqual(full('git commit -m "x"').optional, [action('git.commit', '*')]);
  assert.deepEqual(full('git push origin main').optional, [action('git.push', 'main')]);
  assert.deepEqual(full('git push').optional, [action('git.push', '*')]);
  assert.deepEqual(full('docker compose exec app php artisan migrate --force').optional, [action('db.migrate', '*')]);
  assert.deepEqual(full('php artisan migrate:status').optional, []);
  for (const command of ['git commit -m "x"', 'git push origin main', 'php artisan migrate']) assert.deepEqual(actions(command), [], command);
});

test('command lines are listed outer and unwrapped for command-pattern rules', () => {
  assert.deepEqual(full('cd api && sudo npm run deploy').commands, ['cd api', 'sudo npm run deploy', 'npm run deploy']);
  assert.deepEqual(full('docker compose exec app php artisan queue:restart').commands,
    ['docker compose exec app php artisan queue:restart', 'php artisan queue:restart']);
  assert.deepEqual(full('bash -c "terraform apply"').commands, ['bash -c terraform apply', 'terraform apply']);
});
