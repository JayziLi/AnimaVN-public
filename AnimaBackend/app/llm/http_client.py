import httpx


def make_http_client() -> httpx.AsyncClient:
    """Honors HTTP(S)_PROXY for remote hosts, but never proxies loopback
    addresses — otherwise local services (Ollama, LM Studio) break when a
    system proxy like Clash is running.
    """
    no_proxy = httpx.AsyncHTTPTransport()
    return httpx.AsyncClient(
        mounts={
            "all://127.0.0.1": no_proxy,
            "all://localhost": no_proxy,
            "all://[::1]": no_proxy,
        }
    )
