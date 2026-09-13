"""Exercise the running image over HTTP, including all six real analyzers.

Run inside a container with --network none to verify offline operation.
Only Python's standard library is required by this test client.
"""

import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE = os.environ.get("LINGUA_TEST_URL", "http://127.0.0.1:5173").rstrip("/")
TOKEN = os.environ["LINGUA_API_TOKEN"]
SAMPLES = {
    "ja": "今日はいい天気ですね。",
    "en": "Good evening. Welcome back home.",
    "es": "Buenas noches. Bienvenido a casa.",
    "fr": "Bonsoir. Bienvenue à la maison.",
    "de": "Guten Abend. Willkommen zu Hause.",
    "ko": "한국어를 공부합니다.",
}


def request(path, *, data=None, token=TOKEN, method=None, headers=None):
    fields = dict(headers or {})
    if token is not None:
        fields["Authorization"] = f"Bearer {token}"
    req = Request(BASE + path, data=data, headers=fields, method=method)
    try:
        with urlopen(req, timeout=90) as response:
            return response.status, response.headers, response.read()
    except HTTPError as error:
        return error.code, error.headers, error.read()


def main():
    deadline = time.monotonic() + 45
    while True:
        try:
            status, _, body = request("/api/health?probe=0")
            assert status == 200, (status, body)
            break
        except (URLError, ConnectionError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)

    for path in ("/", "/player.html", "/js/main.js", "/css/base.css"):
        status, _, body = request(path, token=None)
        assert status == 200 and body, path
    for path in ("/.env", "/.git/config", "/requirements.txt", "/data/index.json"):
        assert request(path, token=None)[0] == 404, path
    for token in (None, "incorrect-token"):
        assert request("/api/health", token=token)[0] == 401
        assert request("/api/analyze?lang=en&name=sample.srt",
                       token=token, data=b"invalid subtitle")[0] == 401
    status, headers, _ = request("/api/analyze", token=None, method="OPTIONS")
    assert status == 204
    assert "Authorization" in headers["Access-Control-Allow-Headers"]

    status, _, body = request("/api/health?probe=1")
    assert status == 200, body
    health = json.loads(body)
    assert health["stateless"] is True
    assert {lang["code"] for lang in health["languages"]} == set(SAMPLES)
    assert all(lang["ready"] for lang in health["languages"]), health

    for code, text in SAMPLES.items():
        subtitle = f"1\n00:00:00,000 --> 00:00:04,000\n{text}\n"
        status, _, body = request(
            f"/api/analyze?lang={code}&name=sample.srt&id=smoke-{code}",
            data=subtitle.encode("utf-8"),
            headers={"Content-Type": "text/plain; charset=utf-8"},
        )
        assert status == 200, (code, status, body)
        result = json.loads(body)
        assert result["ok"] is True, result
        track = result["track"]
        assert track["schemaVersion"] == 2 and track["lang"]["code"] == code
        assert track["hasWordTiming"] is False
        assert track["stats"]["sentences"] > 0 and track["stats"]["words"] > 0
        words = [word for sentence in track["sentences"] for word in sentence["words"]]
        assert any(word.get("read") for word in words), f"Missing pronunciation: {code}"
        print(f"PASS {code}: analysis + pronunciation ({len(words)} words)", flush=True)

    subtitle = {"language": "en", "segments": [{
        "start": 0, "end": 2, "text": "Hello world.",
        "words": [{"word": "Hello", "start": 0, "end": 1},
                  {"word": "world.", "start": 1, "end": 2}],
    }]}
    status, _, body = request(
        "/api/analyze?lang=en&name=sample.json&id=smoke-timing",
        data=json.dumps(subtitle).encode(), headers={"Content-Type": "application/json"},
    )
    assert status == 200, body
    track = json.loads(body)["track"]
    assert track["hasWordTiming"] is True
    timed = [word for sentence in track["sentences"] for word in sentence["words"]
             if "start" in word]
    assert timed and all(word["start"] <= word["end"] for word in timed)
    assert all(left["end"] <= right["start"] for left, right in zip(timed, timed[1:]))
    print("PASS static assets, authentication, CORS, six languages and word timing", flush=True)


if __name__ == "__main__":
    main()
