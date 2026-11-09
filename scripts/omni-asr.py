import json, sys, wave
import numpy as np
import sherpa_onnx

model_dir, wav_path = sys.argv[1], sys.argv[2]
rec = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(
    model=f"{model_dir}/model.int8.onnx", tokens=f"{model_dir}/tokens.txt", num_threads=int(sys.argv[3]) if len(sys.argv) > 3 else 2)
w = wave.open(wav_path)
x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
s = rec.create_stream()
s.accept_waveform(w.getframerate(), x)
rec.decode_stream(s)
print(json.dumps({"text": s.result.text.strip()}, ensure_ascii=False))
