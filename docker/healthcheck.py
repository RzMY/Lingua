"""Authenticated, lightweight liveness probe; no model loading or downloads."""

import json
import os
import sys
from urllib.request import Request, urlopen


def main():
    port = int(os.environ.get("LINGUA_PORT", "5173"))
    token = os.environ.get("LINGUA_API_TOKEN", "").strip()
    request = Request(
        f"http://127.0.0.1:{port}/api/health?probe=0",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urlopen(request, timeout=3) as response:
            payload = json.load(response)
        if payload.get("ok") is not True or payload.get("service") != "lingua-analyze":
            raise ValueError("Unexpected health response")
    except Exception:
        # Do not expose tokens through Docker's health log.
        print("Lingua API health check failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
