# Changelog

## [0.1.4] — 2025-01-01

### Added

- **Maps/Places vertical** — `/searlo maps: Italian restaurants near downtown` searches local businesses with name, address, rating, review count, price level, hours, and phone ([`src/config.ts`](src/config.ts), [`src/client.ts`](src/client.ts), [`src/format.ts`](src/format.ts), [`src/index.ts`](src/index.ts))
- **Batch search** — `/searlo batch q1 q2 q3` runs multiple queries in parallel and injects all results as one combined context block ([`src/index.ts`](src/index.ts))
- **Search history** — `/searlo history` shows the last 10 searches; `/searlo replay <index>` re-runs one ([`src/index.ts`](src/index.ts))
- **README updates** — documented all 9 verticals (web, images, news, videos, shopping, scholar, patents, site, maps) and all commands including batch, history, replay, site, and read ([`README.md`](README.md))

### Changed

- Picker now shows all 9 search types with descriptions
- Tool description updated to reflect scholar, patents, site, and maps support
- `SearloSettings` now includes optional `mapsLocation` for maps search location

[0.1.4]: https://github.com/aginies/pi-searlo/compare/v0.1.3...v0.1.4
