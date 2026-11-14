"""Backend coverage for POST /api/deriv/token validation and error paths.

Per SPEC: {code, code_verifier(43-128), redirect_uri(*/api/deriv/callback)} -> {access_token, expires_in};
400 with Deriv's error on a bad/bogus code; 422 on invalid body (e.g. short verifier);
400 when redirect_uri does not end with /api/deriv/callback.
"""

VALID_VERIFIER = "tscheck-" + "a" * 40  # 48 chars, within 43-128 range


def test_token_bogus_code_returns_400_with_detail(client):
    resp = client.post(
        "/deriv/token",
        json={
            "code": "tscheck-bogus-code",
            "code_verifier": VALID_VERIFIER,
            "redirect_uri": "https://example.com/api/deriv/callback",
        },
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert "detail" in body and body["detail"]


def test_token_short_verifier_returns_422(client):
    resp = client.post(
        "/deriv/token",
        json={
            "code": "tscheck-bogus-code",
            "code_verifier": "tooshort",
            "redirect_uri": "https://example.com/api/deriv/callback",
        },
    )
    assert resp.status_code == 422, resp.text


def test_token_bad_redirect_uri_returns_400(client):
    resp = client.post(
        "/deriv/token",
        json={
            "code": "tscheck-bogus-code",
            "code_verifier": VALID_VERIFIER,
            "redirect_uri": "https://example.com/not-the-callback",
        },
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert "detail" in body and body["detail"]
