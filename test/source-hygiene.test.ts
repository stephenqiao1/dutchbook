import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No source file may contain a raw control byte.
 *
 * This exists because the repo has now been bitten twice by the same thing: a
 * literal NUL byte written into a template literal used as a composite map key,
 * where the intended six-character escape was resolved into one byte instead.
 * It is invisible in an editor, the code behaves correctly, and every test
 * passes. The only symptoms are that grep starts treating the file as binary
 * and silently returns nothing for it, and git shows "Bin 0 -> 6044 bytes"
 * where a diff should be.
 *
 * A bug you cannot see, cannot grep for, and cannot review the diff of is worth
 * a test. Written escapes are fine — they are ordinary ASCII on disk. Raw bytes
 * are not, and this file deliberately contains no escape sequences of its own,
 * because the first draft of it reintroduced the very bug it checks for.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const SCANNED_DIRS = ['src', 'test', 'scripts'];
const SCANNED_EXTENSIONS = new Set(['.ts', '.mts', '.mjs', '.js']);

const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const FIRST_PRINTABLE = 32;

/** Tab, newline, and carriage return are the only control bytes allowed. */
const ALLOWED = new Set([TAB, LINE_FEED, CARRIAGE_RETURN]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Fixtures are recorded payloads, not source, and are not reviewed by eye.
      if (entry === 'node_modules' || entry === 'fixtures') continue;
      found.push(...sourceFiles(full));
    } else if (SCANNED_EXTENSIONS.has(extname(entry))) {
      found.push(full);
    }
  }
  return found;
}

describe('source hygiene', () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  it('finds files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('contains no raw control bytes', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const bytes = readFileSync(file);
      for (const [index, byte] of bytes.entries()) {
        if (byte >= FIRST_PRINTABLE || ALLOWED.has(byte)) continue;

        // Render the surrounding source with the offending byte marked, so the
        // failure names the line rather than just the offset.
        const context = [...bytes.subarray(Math.max(0, index - 40), index + 20)]
          .map((b) => (b >= FIRST_PRINTABLE ? String.fromCodePoint(b) : '<' + b.toString(16) + '>'))
          .join('');
        offenders.push(
          relative(ROOT, file) + ' byte ' + index + ' (0x' + byte.toString(16) + '): ' + context,
        );
        break;
      }
    }

    expect(offenders).toEqual([]);
  });
});
