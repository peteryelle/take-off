// public/lib/categorize-coded-note.js — maps a coded note's verbatim text to
// a stable rollup category. No PDF, no DOM, no network.
//
// Why this exists, separate from the note number itself: coded-note
// numbering is sheet-local (parse-coded-notes.js's own file header already
// establishes this — never assume "note 2 = rack" beyond the one sheet it
// was read from). rack_count and similar rollups on tr_schedule_rows need
// something stable to group by ACROSS sheets, regardless of what number a
// given AE happened to assign. That's `category` here, not
// coded_note_number.
//
// Verified against all 12 real notes on an actual T-401 sheet (Gainesville
// EHRM) — including the distinction that actually matters for rack_count:
// note 2 ("PROVIDE 24" X 30" 45RU 4-POST EQUIPMENT RACK...") is a NEW rack;
// notes 9, 11, 12 ("EXISTING NETWORK RACK... TO REMAIN", "EXISTING RACK TO
// BE SHIFTED...") are EXISTING racks, not new ones. Conflating those would
// have inflated every existing-building retrofit sheet's new-rack count.
//
// Never guesses past what a rule actually matches: a note that doesn't fit
// any known pattern gets category: null, not a wrong or forced category —
// same "flag, don't guess" reflex as the rest of this pipeline.

// RACK is special-cased first: existing-vs-new is a two-part condition (the
// word RACK plus a determiner elsewhere in the sentence), not a single
// keyword race, and the two are mutually exclusive by design.
const RACK_RULES = [
  { category: 'rack_existing', test: (t) => /\bRACK\b/.test(t) && /EXISTING/.test(t) },
  { category: 'rack_new',      test: (t) => /\bRACK\b/.test(t) && /PROVIDE/.test(t) },
];

// Everything else: single keyword per category, picked by WHICHEVER
// KEYWORD APPEARS EARLIEST in the text, not by a fixed rule-priority order.
// A fixed order breaks on a real case: note 10 ("PROVIDE 4" SLEEVES WITH
// BUSHING... COORDINATE EXACT LOCATION OF SLEEVES WITH CABLE TRAY...")
// mentions "CABLE TRAY" only as a coordination reference well after its
// actual subject, "SLEEVES" -- a fixed priority list checking cable_tray
// before sleeves categorized it wrong. The earliest-mentioned keyword is
// the note's real subject; a later mention is just a cross-reference to
// something else in the room.
const KEYWORD_RULES = [
  { category: 'backboard',     pattern: /BACKBOARD/ },
  { category: 'ground_busbar', pattern: /GROUND\s*BUS\s*BAR/ },
  { category: 'cable_tray',    pattern: /CABLE\s*TRAY/ },
  { category: 'wire_manager',  pattern: /WIRE\s*MANAGER/ },
  { category: 'camera_connection', pattern: /\bSSTV\b|CAMERA/ },
  { category: 'access_control', pattern: /ACCESS\s*CONTROL/ },
  { category: 'motion_sensor', pattern: /MOTION\s*SENSOR|INTRUSION\s*DETECTION/ },
  { category: 'sleeves',       pattern: /\bSLEEVES?\b/ },
];

/**
 * @param {string} noteText  verbatim coded-note text (as parse-coded-notes.js
 *   returns it — case doesn't matter, this normalizes internally)
 * @returns {{ category: string|null, rule: string|null }}
 *   category: a stable rollup key, or null if nothing matched -- never a
 *     guessed/forced category.
 */
export function categorizeCodedNote(noteText) {
  const t = String(noteText || '').toUpperCase();
  if (!t.trim()) return { category: null, rule: null };

  for (const rule of RACK_RULES) {
    if (rule.test(t)) return { category: rule.category, rule: rule.category };
  }

  let best = null, bestIndex = Infinity;
  for (const rule of KEYWORD_RULES) {
    const m = t.match(rule.pattern);
    if (m && m.index < bestIndex) { bestIndex = m.index; best = rule.category; }
  }
  return { category: best, rule: best };
}

export default categorizeCodedNote;
