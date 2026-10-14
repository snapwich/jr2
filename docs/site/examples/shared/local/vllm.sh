vllm serve Qwen/Qwen3.6-35B-A3B --served-model-name qwen3.6-35b-a3b \
  --host 0.0.0.0 --port 8000 --max-model-len 65536 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder
