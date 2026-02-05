import os
import requests
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='web', static_url_path='/static')

# Configurable API base
API_BASE = os.environ.get('API_BASE', 'http://localhost:3000/v1')
PORT = int(os.environ.get('PORT', '8080'))

# Headers that should not be forwarded from upstream
HOP_BY_HOP_HEADERS = frozenset([
    'transfer-encoding', 'connection', 'keep-alive',
    'proxy-authenticate', 'proxy-authorization', 'te',
    'trailers', 'upgrade', 'content-encoding', 'content-length'
])

def filter_headers(headers):
    """Filter out hop-by-hop headers from upstream response."""
    return [(k, v) for k, v in headers if k.lower() not in HOP_BY_HOP_HEADERS]

@app.route('/')
def index():
    return send_from_directory('web', 'index.html')

@app.route('/api/chat', methods=['POST'])
def api_chat():
    payload = request.get_json(force=True)
    # forward to the underlying API
    url = f"{API_BASE}/chat/completions"
    try:
        resp = requests.post(url, json=payload, timeout=60)
    except requests.RequestException as e:
        return jsonify({'error':'upstream request failed', 'details': str(e)}), 502

    return (resp.content, resp.status_code, filter_headers(resp.headers.items()))


@app.route('/api/models', methods=['GET'])
def api_models():
    """Fetch available models from upstream API and return them."""
    url = f"{API_BASE}/models"
    try:
        resp = requests.get(url, timeout=20)
    except requests.RequestException as e:
        return jsonify({'error':'upstream request failed', 'details': str(e)}), 502

    return (resp.content, resp.status_code, filter_headers(resp.headers.items()))

if __name__ == '__main__':
    port = PORT
    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    app.run(host='127.0.0.1', port=port, debug=debug)
