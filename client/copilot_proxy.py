import json
import os

import requests

API_BASE = os.environ.get('API_BASE', 'http://localhost:3000/v1')
MODEL = os.environ.get('MODEL', 'gpt-4o')

def call_stream():
    url = f"{API_BASE}/chat/completions"
    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": "Hello! Can you introduce yourself briefly?"
            }
        ],
        "stream": True
    }

    with requests.post(url, json=payload, stream=True, timeout=30) as resp:
        try:
            resp.raise_for_status()
        except requests.HTTPError:
            print(f"HTTP Error {resp.status_code}: {resp.text}")
            return
        buffer = ""
        for raw_line in resp.iter_lines(decode_unicode=True):
            if raw_line is None:
                continue
            line = raw_line.strip()
            if not line:
                # empty line => end of one SSE event, process buffer
                if buffer:
                    try:
                        # some servers produce lines like "data: {...}"
                        data_line = buffer
                        if data_line.startswith("data:"):
                            data_line = data_line[len("data:"):].strip()
                        if data_line and data_line != "[DONE]":
                            obj = json.loads(data_line)
                            choices = obj.get("choices", [])
                            if choices:
                                fragment = choices[0].get("delta", {}).get("content", "")
                                if fragment:
                                    print(fragment, end="", flush=True)
                    except json.JSONDecodeError:
                        # ignore lines that are not JSON
                        pass
                buffer = ""
            # accumulate lines for this event
            # Many SSE streams send each event as a single "data: <json>" line,
            # but some may split fragments across multiple "data:" lines.
            elif line.startswith("data:"):
                # append JSON after "data:"
                buffer += (line + "\n")

        print("\n\nStream finished.")

if __name__ == "__main__":
    call_stream()