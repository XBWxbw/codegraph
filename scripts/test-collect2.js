const { buildDefaultIgnore, isSourceFile } = require('../dist/extraction/index.js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function normalizePath(p) { return p.replace(/\\/g, '/'); }

function collectGitFiles(repoDir, prefix, files, depth) {
  if (depth > 5) return;
  const gitOpts = { cwd: repoDir, encoding: 'utf-8', timeout: 60000, maxBuffer: 100*1024*1024, stdio: ['pipe','pipe','pipe'], windowsHide: true };
  try {
    const tracked = execFileSync('git', ['ls-files', '-z', '-c', '--recurse-submodules'], gitOpts);
    for (const rel of tracked.split('\0')) { if (rel) files.add(normalizePath(prefix + rel)); }
  } catch(e) { console.error('tracked fail:', repoDir, e.message); }
  try {
    const untracked = execFileSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], gitOpts);
    for (const rel of untracked.split('\0')) {
      if (!rel) continue;
      if (rel.endsWith('/')) {
        const childDir = path.join(repoDir, rel);
        if (fs.existsSync(path.join(childDir, '.git'))) collectGitFiles(childDir, prefix + rel, files, depth+1);
        continue;
      }
      files.add(normalizePath(prefix + rel));
    }
  } catch(e) { console.error('untracked fail:', repoDir, e.message); }
  try {
    const ignored = execFileSync('git', ['ls-files', '-z', '-o'], gitOpts);
    for (const rel of ignored.split('\0')) {
      if (!rel || !rel.endsWith('/')) continue;
      const childDir = path.join(repoDir, rel);
      if (fs.existsSync(path.join(childDir, '.git'))) {
        const prefixed = normalizePath(prefix + rel);
        let alreadyAdded = false;
        for (const f of files) { if (f.startsWith(prefixed)) { alreadyAdded = true; break; } }
        if (!alreadyAdded) collectGitFiles(childDir, prefix + rel, files, depth+1);
      }
    }
  } catch(e) { console.error('ignored fail:', repoDir, e.message); }
}

const files = new Set();
console.log('Collecting git files...');
collectGitFiles('G:/RedTrunk/LetsGoDevelop', '', files, 0);

// Apply buildDefaultIgnore
const ig = buildDefaultIgnore('G:/RedTrunk/LetsGoDevelop');
const filtered = [...files].filter(f => !ig.ignores(f));
console.log('Before ignore filter:', files.size);
console.log('After ignore filter:', filtered.length);

// Now apply isSourceFile
const sourceFiles = filtered.filter(f => isSourceFile(f));
console.log('After isSourceFile filter:', sourceFiles.length);

// Count source files by ext
const exts = {};
for (const f of sourceFiles) {
  const ext = f.split('.').pop();
  exts[ext] = (exts[ext] || 0) + 1;
}
const sorted = Object.entries(exts).sort((a,b) => b[1] - a[1]);
for (const [ext, count] of sorted) {
  console.log('  .' + ext + ':', count);
}
