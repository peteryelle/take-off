// reconcile.js — pure merge layer for the v2 detection contract.
// No PDF, no DOM, no network. Imported by both index.html and the multi-page pipeline.
//
// Merges three INSTANCE sources against a type CATALOG into one device record
// per physical device, carrying provenance:
//
//   label    -> xy + UIN + type, but misses unlabeled devices
//   symbol   -> xy + type, no UIN, catches the unlabeled ones
//   schedule -> UIN + type + routing, no xy, authoritative count
//
// The catalog defines what types exist and how to find them; it never places a
// device. So we reconcile three instance sources AGAINST the catalog.
//
// Output record (the only thing downstream consumes):
//   { uin, type, x, y, xy_source, sources, attributes, confidence, flags }
//
// Algorithm: SEED -> PLACE -> SNAP -> FLAG -> SCORE
//   join keys    : UIN exact (label<->schedule); proximity+type (symbol<->rest);
//                  quantized-coordinate exact (no-UIN label dedup, e.g. VA)
//   xy precedence: symbol > label > none
//   count auth   : schedule when present (per type), else label
//   nothing dropped: every unmatched item becomes a flagged device.

const famOf = (code) => (String(code).match(/^[A-Z]+/) || [String(code)])[0];

function quantKey(type, x, y, decimals) {
  const q = (v) => (v == null ? 'na' : Number(v).toFixed(decimals));
  return `coord:${type}@${q(x)},${q(y)}`;
}

/**
 * @param {Object} catalog  type -> { sources: ['schedule'|'label'|'symbol', ...], ... }
 * @param {Array}  labelInstances   [{ uin?, type, x, y, families?|codes? }]
 * @param {Array}  symbolInstances  [{ type, x, y }]
 * @param {Array}  scheduleRows     [{ uin, type, attributes? }]
 * @param {Object} opts  { snapR, coordKeyDecimals, leaderMatchR }
 * @param {Array}  leaderOverrides [{ type, at:[x,y], quantity, distance_from?:[x,y], families? }]
 *                 human-marked 1:N leaders: one marked cluster -> `quantity` devices.
 * @returns {Array} device records
 */
export function reconcile(catalog = {}, labelInstances = [], symbolInstances = [], scheduleRows = [], opts = {}, leaderOverrides = []) {
  const snapR = opts.snapR ?? 0.02;                 // symbol->device snap radius (same units as xy)
  const coordDecimals = opts.coordKeyDecimals ?? 4; // no-UIN label collapse granularity
  const leaderMatchR2 = (opts.leaderMatchR ?? 0.02) ** 2; // marked-cluster match radius, squared

  const scheduleActive = (type) => {
    const c = catalog[type];
    return !!(c && Array.isArray(c.sources) && c.sources.includes('schedule'));
  };

  const devices = [];
  const keyIndex = new Map(); // UIN (exact) or quantized-coord key -> device
  let synth = 0;

  const rec = (uin, type, extra = {}) => Object.assign(
    { uin, type, x: null, y: null, xy_source: 'none', sources: [], attributes: {}, confidence: 'low', flags: [] },
    extra
  );
  const addSource = (d, s) => { if (!d.sources.includes(s)) d.sources.push(s); };
  const mergeFamilies = (d, inst) => {
    const fams = inst.families || (inst.codes ? inst.codes.map(famOf) : []);
    const codes = inst.codes || [];
    if (fams.length) {
      const set = new Set(d.attributes.families || []);
      fams.forEach((f) => set.add(f));
      d.attributes.families = [...set];
    }
    if (codes.length) {                              // full tokens incl. detail # (DV1/DD3/N2)
      const cset = new Set(d.attributes.codes || []);
      codes.forEach((c) => cset.add(c));
      d.attributes.codes = [...cset];
    }
  };

  // 1. SEED from schedule (authoritative count when present), keyed by UIN.
  for (const row of scheduleRows) {
    const d = rec(row.uin, row.type, { attributes: { ...(row.attributes || {}) } });
    addSource(d, 'schedule');
    devices.push(d);
    keyIndex.set(row.uin, d);
  }

  // 2. PLACE labels.
  for (const lab of labelInstances) {
    const u = lab.uin;
    if (u && keyIndex.has(u)) {                       // label joins a scheduled/known device by UIN
      const d = keyIndex.get(u);
      if (d.type !== lab.type) { d.flags.push('type_conflict'); }
      d.x = lab.x; d.y = lab.y; d.xy_source = 'label';
      addSource(d, 'label'); mergeFamilies(d, lab);
    } else if (u) {                                   // labeled, no matching device
      const d = rec(u, lab.type, { x: lab.x, y: lab.y, xy_source: 'label', sources: ['label'] });
      if (scheduleActive(lab.type)) d.flags.push('not_in_schedule');
      mergeFamilies(d, lab);
      devices.push(d); keyIndex.set(u, d);
    } else {                                          // no UIN (VA / label-only) -> exact-coordinate collapse
      const ckey = quantKey(lab.type, lab.x, lab.y, coordDecimals);
      if (keyIndex.has(ckey)) {                        // duplicate pair: same point, same type -> fold in
        const d = keyIndex.get(ckey);
        addSource(d, 'label'); mergeFamilies(d, lab);
      } else {
        const d = rec(`_lab${synth++}`, lab.type, { x: lab.x, y: lab.y, xy_source: 'label', sources: ['label'] });
        mergeFamilies(d, lab);
        devices.push(d); keyIndex.set(ckey, d);
      }
    }
  }

  // 3. SNAP symbols (symbol xy wins), in three tiers of decreasing evidence:
  //    T1 proximity  - fold onto the nearest PLACED same-type device within snapR.
  //    T2 adopt      - else place an UNPLACED same-type schedule device (x==null):
  //                    the glyph supplies the coordinate the schedule row lacked.
  //                    The glyph->UIN binding is by type only (no xy to match on),
  //                    so flag placement_inferred and SCORE caps it at medium.
  //    T3 surface    - else a genuinely unlabeled device (no_uin).
  //    Tier order is per-symbol: T1 only misses when nothing placed is in range, so a
  //    glyph that should corroborate a labeled device is never consumed placing a row.
  for (const s of symbolInstances) {
    let best = null, bestD = snapR * snapR;
    for (const d of devices) {
      if (d.type !== s.type || d.x == null) continue;
      // T1 corroborates a LABELED/SCHEDULED device. A device whose only evidence is
      // a prior symbol is itself a bare glyph (a T3 synthetic) — folding onto it would
      // merge two genuinely distinct unlabeled instances, so it is not a snap target.
      if (d.sources.length === 1 && d.sources[0] === 'symbol') continue;
      const dd = (d.x - s.x) ** 2 + (d.y - s.y) ** 2;
      if (dd <= bestD) { bestD = dd; best = d; }
    }
    if (best) {                                       // T1
      best.x = s.x; best.y = s.y; best.xy_source = 'symbol';
      addSource(best, 'symbol');
    } else {
      const adopt = devices.find(                     // T2
        (d) => d.type === s.type && d.x == null && d.sources.includes('schedule')
      );
      if (adopt) {
        adopt.x = s.x; adopt.y = s.y; adopt.xy_source = 'symbol';
        addSource(adopt, 'symbol');
        adopt.flags.push('placement_inferred');
      } else {                                        // T3
        const d = rec(`_sym${synth++}`, s.type, { x: s.x, y: s.y, xy_source: 'symbol', sources: ['symbol'] });
        d.flags.push('no_uin');
        devices.push(d);
      }
    }
  }

  // 3.5 LEADER EXPAND — human-marked 1:N leaders. `at` only LOCATES the cluster;
  // the group's position defaults to the matched base device's own x/y (the primary
  // text anchor, e.g. the N2 token), per the estimator workflow. An explicit
  // distance_from overrides that; if nothing matched, fall back to the marked point.
  // The base plus quantity-1 synthetic siblings share the base's families; count
  // changes here by design; every member is flagged leader_expanded.
  for (const ov of leaderOverrides) {
    const at = ov.at;
    if (!Array.isArray(at) || at.length < 2) continue;
    const qty = Math.max(1, Math.floor(ov.quantity ?? 1));
    const [ax, ay] = at;

    let base = null, bestD = leaderMatchR2;
    for (const d of devices) {
      if (d.type !== ov.type || d.x == null) continue;
      const dd = (d.x - ax) ** 2 + (d.y - ay) ** 2;
      if (dd <= bestD) { bestD = dd; base = d; }
    }
    const override = (Array.isArray(ov.distance_from) && ov.distance_from.length >= 2) ? ov.distance_from : null;
    const [rx, ry] = override || (base ? [base.x, base.y] : at);   // anchor x/y by default
    const groupKey = `leader:${ov.type}@${ax.toFixed(coordDecimals)},${ay.toFixed(coordDecimals)}`;
    const famSeed = base ? (base.attributes.families || []) : (ov.families || []);
    const codeSeed = base ? (base.attributes.codes || []) : [];

    if (base) {
      base.x = rx; base.y = ry; base.xy_source = 'leader';
      addSource(base, 'leader');
      base.flags.push('leader_expanded');
      base.attributes.leader_group = groupKey;
      base.attributes.leader_qty = qty;
    }
    for (let k = (base ? 1 : 0); k < qty; k++) {        // base is the 1st of the group
      const d = rec(`_lead${synth++}`, ov.type, {
        x: rx, y: ry, xy_source: 'leader', sources: ['leader'],
        attributes: { families: [...famSeed], codes: [...codeSeed], leader_group: groupKey, leader_qty: qty }
      });
      d.flags.push('leader_expanded');
      if (!base) d.flags.push('leader_unmatched');
      devices.push(d);
    }
  }

  // 4. FLAG leftovers + 5. SCORE by source agreement.
  for (const d of devices) {
    if (d.sources.includes('schedule') && d.x == null) d.flags.push('needs_placement');
    if (d.flags.includes('type_conflict')) {
      d.confidence = 'low';
    } else if (d.flags.includes('placement_inferred') || d.flags.includes('leader_expanded')) {
      d.confidence = 'medium';   // count is asserted/inferred, but the position is approximate
    } else {
      d.confidence = new Set(d.sources).size >= 2 ? 'high' : 'medium';
    }
    // Synthetic ids are internal join handles only; expose uin=null for genuinely unlabeled devices.
    if (typeof d.uin === 'string' && d.uin.startsWith('_')) d.uin = null;
  }

  return devices;
}

export default reconcile;
