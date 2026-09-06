import { PbfWriter } from 'pbf';

// Test-only MVT data. These grid lines and traffic values are entirely invented;
// no provider tile, road geometry, observation, or network request is used.
const EXTENT = 4096;
const KEYS = ['traffic_level', 'road_type', 'road_closure'];
const VALUES = [0, 0.25, 0.5, 0.75, 1, 'primary', 'secondary', false, true];
const zigzag = (value) => value < 0 ? -value * 2 - 1 : value * 2;

function writeValue(value, pbf) {
  if (typeof value === 'string') pbf.writeStringField(1, value);
  else if (typeof value === 'number') pbf.writeDoubleField(3, value);
  else pbf.writeBooleanField(7, value);
}

function writeFeature(index, pbf) {
  const x = 128 + (index % 8) * 448;
  const y = 128 + Math.floor(index / 8) * 448;
  // The final invented closure omits traffic_level, exercising the decoder's
  // closed-road fallback. Other features span the full 0..1 numeric range.
  const tags = index === 63 ? [] : [0, index % 5];
  tags.push(1, 5 + (index % 2), 2, index === 63 ? 8 : 7);
  pbf.writeVarintField(1, index + 1);
  pbf.writePackedVarint(2, tags);
  pbf.writeVarintField(3, 2); // MVT geometry type: LINESTRING.
  // MoveTo one point; LineTo two points, including a negative x delta.
  pbf.writePackedVarint(4, [9, zigzag(x), zigzag(y), 18,
    zigzag(96), zigzag(48), zigzag(-32), zigzag(80)]);
}

function writeLayer(_unused, pbf) {
  pbf.writeStringField(1, 'Traffic flow');
  for (let index = 0; index < 64; index++) pbf.writeMessage(2, writeFeature, index);
  for (const key of KEYS) pbf.writeStringField(3, key);
  for (const value of VALUES) pbf.writeMessage(4, writeValue, value);
  pbf.writeVarintField(5, EXTENT);
  pbf.writeVarintField(15, 2); // MVT specification version.
}

/** Return a fresh, deterministic 64-feature MVT for offline decoder tests. */
export function createSyntheticFlowTile() {
  const pbf = new PbfWriter();
  pbf.writeMessage(3, writeLayer, null);
  return pbf.finish();
}
