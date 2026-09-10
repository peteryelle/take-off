// test-parse-coded-notes.mjs — Step: extracting a sheet's CODED NOTES legend
// to populate the confidence-map ADD dropdown with that sheet's own
// vocabulary, not a fixed taxonomy.
//
// Uses real text extracted from an actual T-401 sheet (Gainesville EHRM),
// not a hand-built fixture -- three real bugs only showed up against real
// data, all fixed and locked in here:
//   1. A note's own body text can render a hair before its own number
//      marker's y (sub-pixel glyph-height difference) -- misattributed to
//      the PREVIOUS note without a small epsilon on the boundary.
//   2. The sheet's own right-margin grid-reference letters (A-F) sit in the
//      same x-range as the legend, further down the page -- swept into
//      whichever note's y-window they fell inside without an x-bound on the
//      legend column's own width.
//   3. The LAST note has no next-note marker to bound it -- without a cap,
//      its window ran to Infinity and pulled in the scale bar, title block,
//      and page-border numbers below it.
//
// Run: node --test tests/test-parse-coded-notes.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCodedNotes } from '../public/lib/parse-coded-notes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const realItems = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 't401-coded-notes-textitems.json'), 'utf8')
);

console.log('T-401 CODED NOTES legend (real sheet):');
{
  const notes = parseCodedNotes(realItems);

  assert(notes.length === 12, `all 12 real notes found (got ${notes.length})`);
  assert(notes.every((n, i) => n.number === i + 1), 'notes numbered 1-12 in order, no gaps or dupes');

  const n2 = notes.find((n) => n.number === 2);
  assert(n2?.text === 'PROVIDE 24" X 30" 45RU 4-POST EQUIPMENT RACK. REFER TO SHEET T-501 FOR RACK DETAILS.',
    `note 2 (rack) exact text match (got ${JSON.stringify(n2?.text)})`);

  const n4 = notes.find((n) => n.number === 4);
  assert(n4?.text === 'PROVIDE 18"W X 4"H BASKET STYLE CABLE TRAY. MOUNT CABLE TRAY AT 8\' AFF TO BOTTOM OF TRAY.',
    'note 4 has no trailing garbage (the sub-pixel-boundary + margin-letter bugs both landed here)');
  assert(!/\bB\b/.test(n4?.text ?? ''), 'note 4 does not contain the stray margin letter "B"');

  const n12 = notes.find((n) => n.number === 12);
  assert(n12 && !/GAINESVILLE|Project|Checked|Drawn|TDB|CVM/.test(n12.text),
    'note 12 (the open-ended last note) does not sweep in the title block below it');
  assert(n12?.text.endsWith('ADDITIONAL INFORMATION.'), 'note 12 ends cleanly at its own real content');

  // Every note text should be genuinely distinguishable -- a spot check that
  // rack (note 2) and existing-rack (notes 9/11/12) read as different things,
  // which matters for whatever categorizes these for rollup counting later.
  assert(/PROVIDE.*RACK/.test(notes.find((n) => n.number === 2).text), 'note 2 reads as a NEW rack (PROVIDE...)');
  assert(/EXISTING.*RACK/.test(notes.find((n) => n.number === 9).text), 'note 9 reads as an EXISTING rack, not a new one');
}

console.log('Edge cases:');
{
  assert(parseCodedNotes([]).length === 0, 'empty page -> [] (not a throw)');
  assert(parseCodedNotes([{ str: 'RANDOM TEXT', cx_norm: 0.5, cy_norm: 0.5 }]).length === 0,
    'no "CODED NOTES" title on the page -> [] (not a guess)');

  const singleNote = [
    { str: 'CODED NOTES:', cx_norm: 0.85, cy_norm: 0.10 },
    { str: '1', cx_norm: 0.85, cy_norm: 0.12 },
    { str: 'PROVIDE A THING.', cx_norm: 0.87, cy_norm: 0.12 },
  ];
  const r = parseCodedNotes(singleNote);
  assert(r.length === 1 && r[0].number === 1 && r[0].text === 'PROVIDE A THING.',
    'a single-note legend (no next-note to bound it) still parses cleanly with the fallback cap');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
