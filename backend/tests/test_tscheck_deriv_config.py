"""Backend coverage for the 'Backend API' acceptance criterion: GET /api/deriv/config."""


def test_deriv_config_returns_app_id_and_oauth_ready(client):
    resp = client.get("/deriv/config")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["app_id"] == "34XxijT4LuhpHEsZVPfoc"
    assert body["oauth_ready"] is True
    assert body["oauth_authorize_url"] == "https://auth.deriv.com/oauth2/auth"
    assert body["public_ws_url"].startswith("wss://")
