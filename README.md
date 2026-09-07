# Aether

Aether is an early-stage portable, hardware-adaptive local AI gateway. The goal is one stable API with interchangeable adapters for local and remote inference systems.

## Current milestone: Aether Zero

Implemented:

- Local Node.js API server
- `/api/status`
- `/api/capabilities`
- `/api/hardware`
- Provider manager
- llama.cpp adapter contract
- llama.cpp executable discovery from portable `runtimes/` paths or the system `PATH`
- `/api/providers`
- `/api/providers/detect`

Not implemented yet:

- Starting/stopping llama.cpp
- Model discovery/loading
- Chat proxying/streaming
- Ollama, vLLM, MLX, WebLLM adapters
- GPU verification and backend benchmarking

## Run

Requires Node.js with ES module support.

```bash
npm start
```

Then open:

- `http://localhost:8080/api/status`
- `http://localhost:8080/api/capabilities`
- `http://localhost:8080/api/hardware`
- `http://localhost:8080/api/providers`
- `http://localhost:8080/api/providers/detect`

Use another port with:

```bash
AETHER_PORT=9090 npm start
```

## Architecture

```text
Client
  -> Aether API
      -> Provider Manager
          -> Adapter
              -> Inference backend/runtime
                  -> Hardware
```

Aether owns the stable interface. Adapters own backend-specific differences.
