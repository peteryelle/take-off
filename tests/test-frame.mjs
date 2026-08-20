// Gate: identity-frame <-> content-bbox-frame transform. Reproduces the exact
// real bug — a cull's own exclude box (drawn in identity frame) failing to
// suppress the same device on re-detection (content-bbox frame), with
// position drift already ruled out separately (three consecutive re-runs
// landed on identical coordinates). The content-bbox offset alone
// (this project's real page: xmin_frac 0.0321, ymin_frac 0.028) exceeded the
// per-device cull box's own half-width (0.012), guaranteeing a miss.
import { usesIdentityFrame, toIdentityXY } from '../public/lib/frame.js';

let fail = 0; const A = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };

// Real project's actual content bbox (page_id 649).
const realBBox = { xmin_frac: 0.0321, ymin_frac: 0.028, w_frac: 1, h_frac: 1 };

console.log('usesIdentityFrame:');
A(usesIdentityFrame({ xy_source: 'manual' }) === true, 'manual devices use identity frame');
A(usesIdentityFrame({ xy_source: 'symbol', symbol_via: 'llm' }) === true, 'symbol+llm uses identity frame');
A(usesIdentityFrame({ xy_source: 'symbol', symbol_via: 'vector' }) === false, 'symbol+vector uses content-bbox frame');
A(usesIdentityFrame({ xy_source: 'label' }) === false, 'label uses content-bbox frame');
A(usesIdentityFrame({ xy_source: 'leader' }) === false, 'leader uses content-bbox frame');

console.log('toIdentityXY:');
{
  // A label-sourced device at content-bbox (0.1085, 0.4287) — a real device
  // from the production page.
  const dev = { x: 0.1085, y: 0.4287, xy_source: 'label' };
  const [ix, iy] = toIdentityXY(dev, realBBox);
  A(Math.abs(ix - 0.1406) < 0.0001, `x transforms to identity frame (got ${ix})`);
  A(Math.abs(iy - 0.4007) < 0.0001, `y transforms to identity frame (got ${iy})`);
}
{
  // Manual/identity-frame devices must pass through completely unchanged —
  // applying the transform to an already-identity-frame device would be a
  // second, compounding bug.
  const dev = { x: 0.5, y: 0.5, xy_source: 'manual' };
  const [ix, iy] = toIdentityXY(dev, realBBox);
  A(ix === 0.5 && iy === 0.5, 'manual (already identity-frame) device passes through unchanged');
}
{
  // No content_bbox available -> no-op passthrough, not a crash.
  const dev = { x: 0.3, y: 0.3, xy_source: 'label' };
  const [ix, iy] = toIdentityXY(dev, null);
  A(ix === 0.3 && iy === 0.3, 'missing content_bbox degrades to passthrough, does not throw');
}
{
  const [ix, iy] = toIdentityXY({ x: null, y: 0.5, xy_source: 'label' }, realBBox);
  A(ix === null, 'null x stays null rather than producing a bogus number');
}

// ── The actual production bug, reproduced exactly ───────────────────────
console.log('production bug reproduction — exclude box vs. un-transformed device:');
{
  const CULL_PAD_FRAC = 0.012;
  // A device culled at content-bbox (0.1085, 0.4287) — its exclude box was
  // drawn by the CLIENT, which correctly transforms to identity frame first.
  const devContentFrame = { x: 0.1085, y: 0.4287, xy_source: 'label' };
  const [identityX, identityY] = toIdentityXY(devContentFrame, realBBox);
  const box = {
    x0: identityX - CULL_PAD_FRAC, x1: identityX + CULL_PAD_FRAC,
    y0: identityY - CULL_PAD_FRAC, y1: identityY + CULL_PAD_FRAC
  };

  // THE BUG: comparing the box directly against the device's raw (untransformed)
  // content-bbox coordinates — this is what pass-batch.js did before the fix.
  const rawInBox = devContentFrame.x >= box.x0 && devContentFrame.x <= box.x1
    && devContentFrame.y >= box.y0 && devContentFrame.y <= box.y1;
  A(rawInBox === false, 'BUG CONFIRMED: raw content-bbox coordinates miss the identity-frame box entirely');

  // THE FIX: transform before comparing — the box now correctly contains the
  // very device it was drawn around.
  const [checkX, checkY] = toIdentityXY(devContentFrame, realBBox);
  const transformedInBox = checkX >= box.x0 && checkX <= box.x1 && checkY >= box.y0 && checkY <= box.y1;
  A(transformedInBox === true, 'FIX CONFIRMED: transformed coordinates correctly land inside the box');
}

console.log(fail ? `\n${fail} FAILED` : '\nall PASS');
process.exit(fail ? 1 : 0);
