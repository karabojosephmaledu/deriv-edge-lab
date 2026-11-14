"""Backend coverage for GET /api/deriv/callback -> redirect-bridge HTML page."""


def test_deriv_callback_returns_html_bridge(client):
    resp = client.get("/deriv/callback", params={"code": "tscheck-code", "state": "tscheck-state"}, follow_redirects=False)
    assert resp.status_code == 200, resp.text
    ctype = resp.headers.get("content-type", "")
    assert "text/html" in ctype
    body = resp.text
    # Bridge page moves ?code&state into the SPA hash fragment client-side via location.search.
    assert "location.replace" in body
    assert "location.search" in body
