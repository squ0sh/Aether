# Aether

Aether is a portable, hardware-adaptive local AI gateway. Its goal is to expose one stable local API while adapters handle the differences between local inference runtimes such as llama.cpp, Ollama, vLLM, MLX, WebLLM, and others.

## Current checkpoint: v0.2.0

Aether currently includes:

- Local HTTP API
- `/api/status`
- `/api/capabilities`
- `/api/hardware`
- Provider manager
- llama.cpp provider adapter
- Portable-runtime discovery under `runtimes/`
- System-runtime discovery through `PATH`
- Runtime executable verification using `llama-server --version`
- Provider state progression that separates discovery from verification

### Provider states

Aether does not assume that an installed runtime works.

For llama.cpp the current flow is:

`not_found -> detected -> verified`

Future checkpoints will add:

`verified -> running -> healthy -> preferred`

A runtime is only marked `available: true` after its executable successfully passes verification.

## Run Aether

```bash
npm start
```

By default Aether listens on port `8080`. You can override it:

```bash
AETHER_PORT=9000 npm start
```

## API endpoints

- `GET /api/status`
- `GET /api/capabilities`
- `GET /api/hardware`
- `GET /api/providers`
- `GET /api/providers/detect`
- `GET /api/providers/llama-cpp/status`

## Portable llama.cpp discovery

Aether currently checks these locations before searching the system `PATH`:

```text
runtimes/llama.cpp/llama-server
runtimes/llama-server
```

On Windows it also checks the `.exe` equivalents.

If a runtime is found, Aether runs a short `--version` probe with a timeout. The runtime is marked `verified` only if the process exits successfully.

## Permissioned provisioning roadmap

Aether is intended to eventually automate runtime setup intelligently, but installation is deliberately disabled at this checkpoint.

The planned flow is:

1. Detect host hardware and operating system.
2. Rank compatible inference runtimes.
3. Recommend the preferred runtime and explain why.
4. Present the exact install action to the user.
5. Require explicit permission before changing the machine.
6. Download/install the runtime.
7. Run the same verification path used for manually installed runtimes.
8. Mark the runtime available only after successful verification.
9. Fall back or repair automatically when verification fails, subject to permission.

This keeps Aether intelligent without silently modifying the host system.

## Next checkpoint

The next step is process control for llama.cpp: start a verified `llama-server`, confirm its HTTP health endpoint responds, and promote the provider to `running` / `healthy`.
