# Shelf Goblin catalog contract

This public package owns the serializable catalog, reader-context, and inspector
types, plus pure identity, edition, audio-coverage, series, and recommendation
behavior. It has no network, database, browser-storage, account, or private-evidence
dependencies.

The reader app uses this workspace directly. Its `src/lib` modules re-export the
package so existing application imports remain compatible. The private data
producer installs a released, versioned package archive with lockfile integrity;
it never imports a sibling application checkout.

## Build and release

From the application checkout:

```sh
npm run build --workspace @shelfgoblin/catalog-contract
npm pack --workspace @shelfgoblin/catalog-contract
```

Packing includes compiled ESM JavaScript and declarations under `dist/`. Source
maps refer to package source filenames and contain no private data. Publish the
archive as an immutable public GitHub release asset, then update the producer's
exact archive URL and lockfile together. Do not replace an existing release asset
in place. Bump the package version whenever a published contract or behavior
changes; breaking consumers requires a major version.

The exported subpaths are `catalog`, `series`, `edition`, `audio-coverage`,
`reader-context`, `catalog-health`, and `recommend`. Existing app tests exercise
these through the compatibility re-exports, and producer tests exercise the same
compiled implementation through the installed package.

The package deliberately preserves the existing `catalog` / `recommend` module
cycle. Recommendation code reads catalog constants inside function calls, not
during module initialization.
