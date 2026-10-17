Supertonic 3 inference adapter and Unicode preprocessing are adapted from
Supertone's MIT browser example, commit 1e9799e964ea4c0dad7cde993b65c3c813a7b373:
https://github.com/supertone-oss-archive/supertonic/blob/1e9799e964ea4c0dad7cde993b65c3c813a7b373/web/helper.js
Copyright (c) 2025 Supertone Inc. See CODE-LICENSE.

Modified for Lingua: local verified model bytes, Worker termination, flat typed arrays,
strict Unicode validation, bounded CJK chunks/durations and actual-duration cropping.

Model weights and supplied preset voices use BigScience Open RAIL-M, including
the usage restrictions in Attachment A. See MODEL-LICENSE. These are open weights
with usage restrictions, rather than OSI-licensed software. Generated pronunciation
audio is machine-synthesized. Downloading or using these models requires compliance
with the model license and its usage restrictions.

Official archived model/config/voice sources:
https://huggingface.co/supertone-oss-archive/supertonic-3/tree/aafc6e32416a594460b32413efc49d7fe4ce6d46
Compressed ONNX conversion by the sherpa-onnx maintainer:
https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/tree/cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4
The conversion's MIT notice does not replace the original model's OpenRAIL-M license.
The duration predictor and text encoder are original Float32; vector estimator and
vocoder are quantized. The shared download is about 138 MiB before ONNX runtime.

The original project is archived. All files are pinned by revision, exact size and
SHA-256. No hosted service, account, Python backend or remote synthesis is used.
