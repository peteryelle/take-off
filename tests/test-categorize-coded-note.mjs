// test-categorize-coded-note.mjs — locks in the categorization of every real
// note on the T-401 sheet this was built against, plus the specific
// distinction that matters most for rack_count: new vs. existing rack.
// Run: node --test tests/test-categorize-coded-note.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCodedNotes } from '../public/lib/parse-coded-notes.js';
import { categorizeCodedNote } from '../public/lib/categorize-coded-note.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const realItems = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 't401-coded-notes-textitems.json'), 'utf8')
);
const notes = parseCodedNotes(realItems);

console.log('T-401: every real note categorized (12 notes):');
{
  const expected = {
    1: 'backboard',
    2: 'rack_new',
    3: 'ground_busbar',
    4: 'cable_tray',
    5: 'wire_manager',
    6: 'camera_connection',
    7: 'access_control',
    8: 'motion_sensor',
    9: 'rack_existing',
    10: 'sleeves',
    11: 'rack_existing',
    12: 'rack_existing',
  };
  for (const n of notes) {
    const { category } = categorizeCodedNote(n.text);
    assert(category === expected[n.number], `note ${n.number} -> ${expected[n.number]} (got ${category})`);
  }

  // The distinction that actually matters for rack_count: new vs existing
  // must never collapse into the same category, or every retrofit sheet's
  // new-rack count would be inflated by its existing racks.
  const n2cat = categorizeCodedNote(notes.find((n) => n.number === 2).text).category;
  const n9cat = categorizeCodedNote(notes.find((n) => n.number === 9).text).category;
  assert(n2cat !== n9cat, `new rack (note 2, ${n2cat}) and existing rack (note 9, ${n9cat}) are different categories`);
}

console.log('Edge cases:');
{
  assert(categorizeCodedNote('').category === null, 'empty text -> null, not a throw');
  assert(categorizeCodedNote(null).category === null, 'null input -> null, not a throw');
  assert(categorizeCodedNote('SOME TOTALLY UNRELATED NOTE ABOUT PAINT COLOR.').category === null,
    'a note matching no known pattern -> null, never a forced/guessed category');

  // A note mentioning both "existing" and "rack" must resolve as existing,
  // not accidentally match the new-rack rule because some other word in the
  // same sentence (e.g. a different item being provided) also appears.
  const mixed = categorizeCodedNote('EXISTING RACK TO REMAIN. PROVIDE NEW CABLE TRAY ABOVE IT.');
  assert(mixed.category === 'rack_existing', `a note with both "existing rack" and "provide" (for a different item) resolves as rack_existing (got ${mixed.category})`);

  assert(categorizeCodedNote('provide 24" x 30" 45ru 4-post equipment rack.').category === 'rack_new',
    'categorization is case-insensitive');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
