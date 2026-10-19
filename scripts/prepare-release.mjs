/** Prepare a release from the selected main-branch commit. Safe to rerun for the same version. */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const version = process.env.RELEASE_VERSION?.trim();
const notes = process.env.RELEASE_NOTES?.trim();
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('RELEASE_VERSION must be an exact version such as 0.0.19');
}

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const parts = (value) => value.split('.').map(Number);
const compare = (a, b) => {
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
};
if (compare(version, current) < 0) throw new Error(`${version} is older than package.json version ${current}`);
if (compare(version, current) > 0) {
  execFileSync('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { stdio: 'inherit' });
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const heading = new RegExp(`^## ${version.replaceAll('.', '\\.')}($|\\s)`, 'm');
if (!heading.test(changelog)) {
  let body = notes;
  if (!body) {
    const lastTag = execFileSync('git', ['describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0'], { encoding: 'utf8' }).trim();
    const subjects = execFileSync('git', ['log', `${lastTag}..HEAD`, '--pretty=%s', '--no-merges'], { encoding: 'utf8' })
      .split('\n').map((line) => line.trim()).filter((line) => line && !/^chore: release (?:browsermcp|opencli-mcp) /.test(line));
    body = subjects.map((subject) => `- ${subject}`).join('\n');
  }
  if (!body) throw new Error(`No changes or release notes found for ${version}`);
  if (!changelog.startsWith('# Changelog\n')) throw new Error('CHANGELOG.md must start with # Changelog');
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const rest = changelog.slice('# Changelog\n'.length).trimStart();
  writeFileSync('CHANGELOG.md', `# Changelog\n\n## ${version} — ${date}\n\n${body}\n\n${rest}`);
}
console.log(`Prepared browsermcp ${version}`);
