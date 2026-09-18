# lamejs 1.2.1

Pure JavaScript MP3 encoder, by Alex Zhukov, based on LAME.

- Upstream: https://github.com/zhuker/lamejs
- LAME: https://lame.sourceforge.net/
- Source archive: https://registry.npmjs.org/lamejs/-/lamejs-1.2.1.tgz
- License: LGPL-3.0; see COPYING.LESSER, COPYING and UPSTREAM-LICENSE.

`lame.js` contains the upstream, unminified `lame.all.js` source with one
appended ES module export of `lamejs.Mp3Encoder`. No encoder logic was changed.
It is loaded locally on demand, only when generating the ASR MP3 copy.
