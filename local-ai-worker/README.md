# Lorenco local AI worker

Reads slips with a vision model on this computer (Ollama), for Slip Capture
"layer 3" — slips the server could not read with confidence. Temporary, until
there is budget for Claude (Ruan, 2026-11-10). Nothing is sent to an external AI
service, and this computer is not opened to the internet: the worker only makes
outgoing HTTPS requests to the app.

## How it works

1. The app reads a slip with supplier memory + Tesseract (layers 1–2).
2. Not sure? It queues a job (`local_ai_jobs`, migration 174).
3. This worker asks the app for a job (`POST /api/local-ai/claim`, own token),
   gets a downsized photo, asks Ollama, and posts the fields back.
4. The app checks the answer (a model value is only "high" when Tesseract, the
   slip text or VAT 15/115 agrees) and stores it as a new **suggestion**.
   The person still confirms and saves.

Computer off? Jobs wait and are read when it is back.

## Set up (once)

1. Ollama installed, and the model pulled: `ollama pull qwen2.5vl:3b`
2. On Render and Zeabur add the environment variable `LOCAL_AI_WORKER_TOKEN`
   (a long random value, 32+ characters — the same value on both).
3. Copy `config.example.env` to `config.env` and fill in `APP_URLS` and the same
   `LOCAL_AI_WORKER_TOKEN`.
4. PowerShell **Run as administrator** in this folder:
   `powershell -ExecutionPolicy Bypass -File .\install-task.ps1`
   — starts with Windows, with nobody logged in, restarts itself if it stops.
5. Power settings: never sleep when plugged in.

Log: `C:\ProgramData\LorencoLocalAI\worker.log`.
After changing `worker.js` or `config.env`, run `install-task.ps1` again.

## Later

- A tunnel (e.g. Cloudflare Tunnel) for live features such as chat.
- Switching to Claude: replace the Ollama call in `worker.js` — or let the app
  call Claude directly — without changing the queue or the checks.
