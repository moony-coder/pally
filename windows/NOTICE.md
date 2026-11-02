# Notice

**Sidekick** is a community Windows port of the MIT-licensed Mac app
[farzaa/clicky](https://github.com/farzaa/clicky). The original MIT license is
preserved verbatim in [LICENSE](./LICENSE) (Copyright (c) 2026 Farza). Keep that
LICENSE file with the source and with any redistributed build.

The Windows port adds its own Windows-specific UI and integration code. The
visual direction is original to this port: coral marker (`#ff5c8a`), dark-glass
sticky notes, a blueprint-grid explainer card, and a corner-bracket reticle.
No cream paper cards, pastel sticker graphics, commercial fonts, or the
original app's logo/marketing art are used.

Removed from earlier community builds: the hosted onboarding video, "I am
Farza" panel text, and the link to his X profile.

"Sidekick" is a **placeholder product name** chosen because the user has not
picked a name. Check trademarks before publishing or selling a build. The
`scripts/rename.js` + `brand.json` pair can rename the product in one command;
do not rename the attribution lines in this file or the original copyright in
LICENSE.

The local Whisper/Kokoro models downloaded by the app are separate works under
their own upstream licenses (sherpa-onnx, Whisper, Kokoro). They are not
included in this repository's source archive by default.
