AI Chat Web UI

Run a minimal Flask server that serves a single-page chat UI and proxies requests to your local AI API.

Setup

1. Create a virtualenv and install requirements:

   python -m venv .venv
   . .venv/bin/activate || . .\.venv\Scripts\Activate.ps1
   pip install -r requirements-web.txt

2. Start the server (optionally check and change API_BASE to your API endpoint):
   
   python server.py

3. Open http://localhost:8080 in your browser.

Notes

- The UI posts to /api/chat and expects the API at ${API_BASE}/chat/completions.
- The model selector will send the chosen model name in the request body.
