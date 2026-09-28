# ICC fixtures

`FOGRA28L.txt` is Fogra characterisation data from the [ICC registry](https://registry.color.org/cmyk-registry/chardata/FOGRA28L.txt), copied byte for byte with SHA-256 `724a8b74a1b3f6195a8c175f09f28266e8c4d3b9152ec1b64fb26905991526f0`. Fogra is the source and [permits redistribution of unmodified data with attribution](https://fogra.org/en/downloads/work-tools/characterisation-data). These fixtures do not imply Fogra certification or endorsement.

`fogra28l.icc` is generated from that data with ArgyllCMS `colprof -qm -nc -S sRGB.icm -l 300 -k r`, after replacing the file's `ISO28178` opening line with a CTI3 header containing `DEVICE_CLASS "OUTPUT"` and `COLOR_REP "CMYK_LAB"` for the generator. It is a test profile generated from Fogra characterisation data FOGRA28, not a Fogra reference profile. SHA-256: `0f3c24a7821d3da3a2f99ef5d7274914adfbd1b3152a8dbc38065f3b7a5dfd88`.

`fogra28l-v4.icc` is a resampled v4 derivative of the generated profile, using the mAB/mBA pipeline. SHA-256: `130df49474b3ceeaaf7bc95d82cfb788883df003ae45501518c406e9836921dd`.

`synthetic-cmyk.icc` is generated from the analytic CMYK model in `synth.py`. Its ink responses and tone value increase are chosen values rather than measured data. SHA-256: `a54aeafff02b2673fecc2aa1d17e17f7dcd91fadf94b5be966a7b116da318f4d`.

`sRGB.icm` comes from ArgyllCMS `ref/`; its embedded copyright tag says Graeme W. Gill released it into the public domain. SHA-256: `1c5f1948454f34199b8a497611b6a25d23d542f93a6939cee5da86f20845328a`.

`sRGB-v4.icc` and `DisplayP3-v4.icc` come from [Compact ICC Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles) at commit `bdd84663061bc4ae95ca70decff54f581e27f702` under [CC0 1.0](https://github.com/saucecontrol/Compact-ICC-Profiles/blob/bdd84663061bc4ae95ca70decff54f581e27f702/license). Their SHA-256 values are `c56e1685d888f5edb92fe07f2750f387f8fe8e91b32ff8fb0b56bfbbb9458353` and `cb51de38e482ee974c0c76b9689e16aad04bad16e226fed2f30c842d15ff3a3d` respectively.
