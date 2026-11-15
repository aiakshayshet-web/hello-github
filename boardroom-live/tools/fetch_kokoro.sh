#!/usr/bin/env bash
# Downloads the Kokoro-82M int8 model (Apache-2.0) and splits it into the 14 MB parts the worker loads.
# Run from the project root: bash tools/fetch_kokoro.sh
set -euo pipefail
cd "$(dirname "$0")/../app/kokoro"
curl -L -o kokoro-v1.0.int8.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
python3 - <<'PY'
b=open('kokoro-v1.0.int8.onnx','rb').read(); n=14*1024*1024
parts=[b[i:i+n] for i in range(0,len(b),n)]
for i,p in enumerate(parts): open(f'model.part{i}.wasm','wb').write(p)
print(len(parts),'parts,',len(b),'bytes  (worker expects PARTS=7, MODEL_BYTES=92361271)')
PY
rm kokoro-v1.0.int8.onnx
# Voices are already in app/kokoro/voices. To add more, extract from voices-v1.0.bin (npz) as raw float32 510x256:
#   https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
