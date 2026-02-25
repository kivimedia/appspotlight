import { simpleGit } from 'simple-git';
import { readFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createLogger, getConfig } from '@appspotlight/shared';
import type { RepoMeta } from '@appspotlight/shared';

const log = createLogger('repo-reader');

// File reading priority per PRD section 4.2
const PRIORITY_FILES = [
  'README.md',
  'readme.md',
  'README',
  'package.json',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'composer.json',
];

const ENTRY_POINT_PATTERNS = [
  /^src\/(App|app|index|main)\.(tsx?|jsx?|py)$/,
  /^(App|app|index|main)\.(tsx?|jsx?|py)$/,
  /^pages\/index\.(tsx?|jsx?)$/,
  /^app\/page\.(tsx?|jsx?)$/,
  /^src\/pages\/index\.(tsx?|jsx?)$/,
];

const ROUTE_PATTERNS = [
  /routes?\.(tsx?|jsx?|py)$/,
  /router\.(tsx?|jsx?|py)$/,
  /^app\/.*\/page\.(tsx?|jsx?)$/,
  /^pages\/.*\.(tsx?|jsx?)$/,
  /^src\/routes\//,
];

const UI_COMPONENT_PATTERNS = [
  /^src\/components\/.*\.(tsx?|jsx?)$/,
  /^components\/.*\.(tsx?|jsx?)$/,
  /^src\/views\/.*\.(tsx?|jsx?)$/,
];

const SCHEMA_PATTERNS = [
  /schema\.(ts|js|prisma|sql)$/,
  /models?\.(ts|js|py)$/,
  /^prisma\/schema\.prisma$/,
  /migrations\//,
  /^supabase\/.*\.sql$/,
];

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go',
  '.vue', '.svelte', '.php', '.rb', '.java', '.kt',
  '.css', '.scss', '.html', '.sql', '.prisma',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', 'target', 'vendor', '.turbo', 'coverage',
]);

export interface RepoFiles {
  priorityFiles: FileContent[];
  entryPoints: FileContent[];
  routeFiles: FileContent[];
  uiComponents: FileContent[];
  schemaFiles: FileContent[];
  meta: RepoMeta;
  clonePath: string;
}

export interface FileContent {
  path: string;
  content: string;
  sizeBytes: number;
}

export async function cloneAndReadRepo(repoUrl: string): Promise<RepoFiles> {
  const config = getConfig();
  const clonePath = join(tmpdir(), `appspotlight-${randomUUID()}`);

  log.info(`Cloning ${repoUrl} to ${clonePath}`);
  mkdirSync(clonePath, { recursive: true });

  const git = simpleGit();

  // Embed token in the clone URL for GitHub HTTPS auth
  let cloneUrl = repoUrl;
  if (config.github.token && cloneUrl.startsWith('https://github.com/')) {
    cloneUrl = cloneUrl.replace('https://github.com/', `https://x-access-token:${config.github.token}@github.com/`);
  }

  await git.clone(cloneUrl, clonePath, [
    '--depth', '1',
    '--single-branch',
  ]);

  // Count lines of code
  const { totalLines, languages } = countCodeStats(clonePath);

  // Read package.json for homepage field
  let homepageUrl: string | null = null;
  let description: string | null = null;
  const pkgPath = join(clonePath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      homepageUrl = pkg.homepage ?? null;
      description = pkg.description ?? null;
    } catch { /* ignore */ }
  }

  // Extract repo name from URL
  const repoName = repoUrl.replace(/\.git$/, '').split('/').pop() ?? 'unknown';

  const meta: RepoMeta = {
    repoName,
    repoUrl,
    defaultBranch: 'main',
    linesOfCode: totalLines,
    languages,
    homepageUrl,
    description,
  };

  // Collect files by priority
  const allFiles = walkDir(clonePath, clonePath);

  const priorityFiles = PRIORITY_FILES
    .filter(f => existsSync(join(clonePath, f)))
    .map(f => readFile(clonePath, f))
    .filter(Boolean) as FileContent[];

  const entryPoints = matchFiles(allFiles, ENTRY_POINT_PATTERNS, clonePath, 5);
  const routeFiles = matchFiles(allFiles, ROUTE_PATTERNS, clonePath, 5);
  const uiComponents = matchFiles(allFiles, UI_COMPONENT_PATTERNS, clonePath, 10);
  const schemaFiles = matchFiles(allFiles, SCHEMA_PATTERNS, clonePath, 5);

  log.info(`Read repo: ${totalLines} LOC, ${languages.length} languages, ${allFiles.length} code files`);

  return {
    priorityFiles,
    entryPoints,
    routeFiles,
    uiComponents,
    schemaFiles,
    meta,
    clonePath,
  };
}

export function cleanupRepo(clonePath: string): void {
  try {
    rmSync(clonePath, { recursive: true, force: true });
    log.info(`Cleaned up ${clonePath}`);
  } catch (e) {
    log.warn(`Failed to cleanup ${clonePath}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function walkDir(dir: string, root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...walkDir(fullPath, root));
    } else if (CODE_EXTENSIONS.has(extname(entry))) {
      files.push(fullPath.slice(root.length + 1).replace(/\\/g, '/'));
    }
  }

  return files;
}

function matchFiles(allFiles: string[], patterns: RegExp[], root: string, limit: number): FileContent[] {
  const matched = allFiles.filter(f => patterns.some(p => p.test(f)));
  return matched
    .slice(0, limit)
    .map(f => readFile(root, f))
    .filter(Boolean) as FileContent[];
}

function readFile(root: string, relativePath: string): FileContent | null {
  const fullPath = join(root, relativePath);
  try {
    const content = readFileSync(fullPath, 'utf-8');
    // Truncate large files to ~8KB
    const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n... (truncated)' : content;
    return {
      path: relativePath,
      content: truncated,
      sizeBytes: Buffer.byteLength(content),
    };
  } catch {
    return null;
  }
}

function countCodeStats(dir: string): { totalLines: number; languages: string[] } {
  const langMap = new Map<string, number>();
  let totalLines = 0;

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (IGNORE_DIRS.has(entry)) continue;
      const fullPath = join(d, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = extname(entry);
        if (CODE_EXTENSIONS.has(ext)) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n').length;
            totalLines += lines;
            langMap.set(ext, (langMap.get(ext) ?? 0) + lines);
          } catch { /* skip binary files */ }
        }
      }
    }
  }

  walk(dir);

  const extToLang: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.vue': 'Vue', '.svelte': 'Svelte',
    '.php': 'PHP', '.rb': 'Ruby', '.java': 'Java', '.kt': 'Kotlin',
    '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML', '.sql': 'SQL', '.prisma': 'Prisma',
  };

  const languages = [...langMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ext]) => extToLang[ext] ?? ext)
    .filter((v, i, arr) => arr.indexOf(v) === i); // dedupe

  return { totalLines, languages };
}
