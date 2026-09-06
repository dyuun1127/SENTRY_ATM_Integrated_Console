# Test fixtures

- `synthetic-flow-tile.mjs` — a test-only, deterministic Mapbox Vector Tile
  generator using the existing `pbf` dependency. It creates 64 invented
  three-point grid polylines in the `"Traffic flow"` layer with fictional
  congestion values, road types, and a closure. Tile-local coordinates are
  projected into z12 x935 y1686 only to exercise the existing geographic bounds
  checks; they do not represent actual Austin roads or traffic observations.
  Used by `src/data/flowTiles.test.mjs` for offline decoding, cache, and abort
  tests. It performs no network requests and is never served to the app.
  This source-code fixture is covered by the repository's MIT code license.

The integrated-console source snapshot excludes the upstream
`tomtom-flow-austin-12-935-1686.pbf` capture (22,980 bytes, © TomTom).
The synthetic generator replaces it without reusing any captured tile content.
See the monorepo's `source-provenance.json` for the source-snapshot exclusions.
