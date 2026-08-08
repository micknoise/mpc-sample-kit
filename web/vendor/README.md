# Vendored dependencies

Checked in rather than installed, because the page has no build step and has to
work as plain files served from GitHub Pages. Nothing here is ours.

## SpessaSynth

The SoundFont player behind the **SoundFont** output. Apache-2.0, see
[`LICENSE-spessasynth.txt`](LICENSE-spessasynth.txt).

| File | From | Version |
|---|---|---|
| `spessasynth_lib.js` | `spessasynth_lib/dist/index.js` | 4.3.12 |
| `spessasynth_core.js` | `spessasynth_core/dist/index.js` | 4.3.16 |
| `spessasynth_processor.min.js` | `spessasynth_lib/dist/spessasynth_processor.min.js` | 4.3.12 |

- https://github.com/spessasus/spessasynth_lib
- https://github.com/spessasus/spessasynth_core

`spessasynth_lib.js` imports the bare specifier `spessasynth_core`, which the
import map in [`../index.html`](../index.html) resolves. The processor is the
AudioWorklet half and is loaded by URL at runtime, not imported.

To update:

```bash
npm install spessasynth_lib                     # in a scratch directory
sed 's|^//# sourceMappingURL=.*$||' node_modules/spessasynth_lib/dist/index.js  > web/vendor/spessasynth_lib.js
sed 's|^//# sourceMappingURL=.*$||' node_modules/spessasynth_core/dist/index.js > web/vendor/spessasynth_core.js
sed 's|^//# sourceMappingURL=.*$||' node_modules/spessasynth_lib/dist/spessasynth_processor.min.js \
                                                                               > web/vendor/spessasynth_processor.min.js
```

The `sed` strips the source-map comments, since the `.map` files are not
shipped and the browser would otherwise 404 on them with devtools open.

## The sound bank

[`../soundfonts/GeneralUser-GS.sf2`](../soundfonts/) — GeneralUser GS v2.0.3 by
S. Christian Collins, 32MB, 287 presets including 13 drum kits. Licence in
[`../soundfonts/LICENSE.txt`](../soundfonts/LICENSE.txt): free use including
commercial, redistribution and modification permitted.

Held locally rather than hot-linked at the author's explicit request — *"please
do not link directly to my download files… provide your own local copy
instead."*

Source: https://github.com/mrbumpy409/GeneralUser-GS
