import fs from 'fs';
import path from 'path';

/**
 * Parse a `.reposageignore` file and return an array of ignore patterns.
 * Supports simple glob matching (like .gitignore format):
 *   - Lines starting with # are comments
 *   - Blank lines are ignored
 *   - `*` matches any characters except `/`
 *   - `**` matches any characters including `/`
 *   - Trailing `/` means directory-only match
 */
function parseIgnoreFile(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

/**
 * Convert a glob pattern to a RegExp for matching file paths.
 * Handles:
 *   . -> escaped dot
 *   * -> single-segment wildcard (matches non-slash chars)
 *   ** -> zero-or-more directories pattern
 */
function globToRegex(pattern) {
  // Strategy:
  // - ** expands to (?:\/.*)? which optionally matches / + remaining path content.
  //   This MUST be placed directly after the preceding literal segment with NO extra /.
  //   For example: src/test/** -> ^src\/test(?:\/.*)?$
  //   The optional / is inside the (?:\/.*)? group, not before it.
  // - For ** at the start: handled specially in shouldIgnore (prefix check)
  let result = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '.') {
      result += '\\.';
      i++;
    } else if (pattern[i] === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // ** token -- optionally matches / + remaining path
        // The / is inside the (?:\/.*)? group, so strip trailing / from result to avoid duplication
        if (result.endsWith('/')) {
          result = result.slice(0, -1);
        }
        result += '(?:\/.*)?';
        i += 2;
      } else {
        result += '[^/]*';
        i++;
      }
    } else {
      result += pattern[i];
      i++;
    }
  }
  return new RegExp('^' + result + '$');
}

/**
 * Check if a file path should be ignored based on `.reposageignore` patterns.
 *
 * @param {string} filePath - Relative path to check (e.g., 'src/utils/helpers.js')
 * @param {string} repoRoot - Root directory of the cloned repository
 * @returns {boolean} true if the file should be ignored
 */
function shouldIgnore(filePath, repoRoot) {
  const ignoreFile = path.join(repoRoot, '.reposageignore');
  const patterns = parseIgnoreFile(ignoreFile);

  if (patterns.length === 0) return false;

  // Normalize path to forward slashes
  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const pattern of patterns) {
    let matched = false;

    // For patterns starting with **/ -- special handling for root-level match
    // e.g. **/test/** should match 'test/file.js' and 'src/test/file.js'
    // e.g. **/.git/** should match '.git/config' and 'src/.git/HEAD'
    if (pattern.startsWith('**/')) {
      // Extract the segment after **/ up to the next ** (if any)
      // e.g. **/test/** -> 'test' (from 'test/**')
      // e.g. **/.git/** -> '.git'
      const afterPrefix = pattern.slice(3); // strip leading **/
      // Find the last ** and take the segment before it
      const lastDblIdx = afterPrefix.lastIndexOf('**');
      let target = lastDblIdx >= 0 ? afterPrefix.slice(0, lastDblIdx) : afterPrefix;
      // Strip any trailing / that was before the ** (e.g. 'test/**' -> target = 'test/' -> strip to 'test')
      target = target.replace(/\/$/, '');
      // Match if path starts with 'target/' (at root or after directories)
      // or path equals 'target' (for exact directory match)
      // Match if path starts with 'target/' (at root) or contains '/target/' (nested)
      // or path equals 'target' (for exact directory match)
      if (normalizedPath.startsWith(target + '/') ||
          normalizedPath === target ||
          normalizedPath.includes('/' + target + '/')) {
        return true;
      }
    }

    const regex = globToRegex(pattern);
    if (regex.test(normalizedPath)) return true;

    // Also match just the filename against the pattern (basename check)
    const basename = path.basename(normalizedPath);
    if (regex.test(basename)) return true;

    // Check if any path segment matches a directory pattern (trailing /)
    if (pattern.endsWith('/')) {
      const dirPattern = pattern.slice(0, -1);
      const segments = normalizedPath.split('/');
      if (segments.some(seg => seg === dirPattern)) return true;
    }
  }

  return false;
}

export { parseIgnoreFile, shouldIgnore, globToRegex };
