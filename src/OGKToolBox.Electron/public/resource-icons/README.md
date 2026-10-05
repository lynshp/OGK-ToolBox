# Resource icons

These PNGs are the game's resource sprites, exported from the project owner's local
ONGEKI 1.50 installation at their request. Currency and common item sprites come from
the built-in UI atlases; ticket, upgrade, affection and jewel images come from their
corresponding resource bundles.

`src/player-resource-icon-manifest.json` maps resource keys to the bundled filenames.
Known item IDs and chapter/story jewel graphics use their specific images. The
family entries provide game icons for resource definitions introduced in other
installations. Gift and breakthrough resources have no editor entries.

Vite copies this directory to `dist`; Electron packages `dist` with the application.
The editor loads these images locally and does not extract textures at runtime.

The unlock icon is the game's `ItemIconSpriteTable` map icon for `UnlockItem`
(`UI_RES_Map_OpenFlower_000001`); it intentionally shares the flower ticket artwork.
An unknown item or an unspecified chapter graphic uses a family icon as a category
symbol; known IDs retain their exact variant.
