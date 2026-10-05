/**
 * Server/client boundary (plan §4, §14): src/server/** is imported only from src/app/api/** (and from itself); no
 * secret-looking env name appears outside src/server and src/app/api; src/domain, src/server and the API routes never
 * import React Native or Expo. A grep over the tree, so a new file cannot slip past the ESLint rule by being
 * excluded from lint.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
const files = walk(SRC);
const inServer = (f: string) => rel(f).startsWith('src/server/');
const inApi = (f: string) => rel(f).startsWith('src/app/api/');
const inDomain = (f: string) => rel(f).startsWith('src/domain/');

/** Every import/require source in a file. */
function importSources(text: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]);
  return out;
}

const SECRET_NAMES = /SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY|TWILIO_AUTH_TOKEN|JOB_SECRET|RESEND_API_KEY/;
const RN_OR_EXPO = /^(react-native|expo|@expo\/)(\/|-|$)|^react-native-/;

test('the tree has source files to check', () => {
  expect(files.length).toBeGreaterThan(0);
});

test('@/server is imported only from src/app/api and src/server', () => {
  const offenders = files
    .filter((f) => !inServer(f) && !inApi(f))
    .filter((f) => importSources(fs.readFileSync(f, 'utf8')).some((s) => s === '@/server' || s.startsWith('@/server/') || /(^|\/)server(\/|$)/.test(s.replace(/^(\.\.?\/)+/, ''))))
    .map(rel);
  expect(offenders).toEqual([]);
});

test('secret-looking env names stay inside src/server and src/app/api', () => {
  const offenders = files
    .filter((f) => !inServer(f) && !inApi(f))
    .filter((f) => SECRET_NAMES.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  expect(offenders).toEqual([]);
});

test('src/domain, src/server and the API routes never import React Native or Expo', () => {
  const offenders = files
    .filter((f) => inDomain(f) || inServer(f) || inApi(f))
    .filter((f) => importSources(fs.readFileSync(f, 'utf8')).some((s) => RN_OR_EXPO.test(s)))
    .map(rel);
  expect(offenders).toEqual([]);
});
