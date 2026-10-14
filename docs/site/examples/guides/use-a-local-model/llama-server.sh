LLAMA_API_KEY="$LOCAL_MODEL_API_KEY" llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q6_K_XL \
  --alias qwen3.6-35b-a3b --no-mmproj --host 0.0.0.0 --port 8000 --jinja -c 65536 \
  --temp 0.6 --presence-penalty 1.0 -ctk q8_0 -ctv q8_0 -fa on \
  --ssl-key-file ~/local-model-certs/server.key --ssl-cert-file ~/local-model-certs/server.crt
