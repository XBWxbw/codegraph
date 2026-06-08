const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function normalizePath(p) { return p.replace(/\\/g, '/'); }

function collectGitFiles(repoDir, prefix, files, depth = 0) {
  if (depth > 5) return; // safety limit
  const gitOpts = { cwd: repoDir, encoding: 'utf-8', timeout: 60000, maxBuffer: 100 * 1024 * 1024, stdio: ['pipe','pipe','pipe'], windowsHide: true };

  try {
    // Tracked
    const tracked = execFileSync('git', ['ls-files', '-z', '-c', '--recurse-submodules'], gitOpts);
    for (const rel of tracked.split('\0')) {
      if (rel) files.add(normalizePath(prefix + rel));
    }
  } catch (e) { console.error('tracked failed for', repoDir, e.message); }

  try {
    // Untracked with --exclude-standard
    const untracked = execFileSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], gitOpts);
    for (const rel of untracked.split('\0')) {
      if (!rel) continue;
      if (rel.endsWith('/')) {
        const childDir = path.join(repoDir, rel);
        if (fs.existsSync(path.join(childDir, '.git'))) {
          collectGitFiles(childDir, prefix + rel, files, depth + 1);
        }
        continue;
      }
      files.add(normalizePath(prefix + rel));
    }
  } catch (e) { console.error('untracked failed for', repoDir, e.message); }

  try {
    // TMR workaround: without --exclude-standard
    const ignored = execFileSync('git', ['ls-files', '-z', '-o'], gitOpts);
    for (const rel of ignored.split('\0')) {
      if (!rel || !rel.endsWith('/')) continue;
      const childDir = path.join(repoDir, rel);
      if (fs.existsSync(path.join(childDir, '.git'))) {
        const prefixed = normalizePath(prefix + rel);
        let alreadyAdded = false;
        for (const f of files) {
          if (f.startsWith(prefixed)) { alreadyAdded = true; break; }
        }
        if (!alreadyAdded) {
          collectGitFiles(childDir, prefix + rel, files, depth + 1);
        }
      }
    }
  } catch (e) { console.error('ignored scan failed for', repoDir, e.message); }
}

const files = new Set();
console.log('Starting collection...');
collectGitFiles('G:/RedTrunk/LetsGoDevelop', '', files);

// Count by extension
const exts = {};
for (const f of files) {
  const ext = f.split('.').pop();
  exts[ext] = (exts[ext] || 0) + 1;
}
const sorted = Object.entries(exts).sort((a,b) => b[1] - a[1]);
console.log('Total files:', files.size);
console.log('By extension:');
for (const [ext, count] of sorted.slice(0, 25)) {
  console.log('  .' + ext + ':', count);
}
