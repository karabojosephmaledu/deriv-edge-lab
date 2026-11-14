"""Backend coverage for AI router owner-gating (routers/ai.py, lib/owner.py).

Per SPEC: GET /api/ai/access and POST /api/ai/coach require `Authorization: Bearer <deriv token>`;
401 without a token, 403 for a non-owner / bogus token (identity check against Deriv fails).
"""


def test_ai_access_without_token_returns_401(client):
    resp = client.get("/ai/access")
    assert resp.status_code == 401, resp.text


def test_ai_access_with_bogus_token_returns_403(client):
    resp = client.get("/ai/access", headers={"Authorization": "Bearer bogus"})
    assert resp.status_code == 403, resp.text


def test_ai_coach_without_token_returns_401(client):
    resp = client.post("/ai/coach", json={})
    assert resp.status_code == 401, resp.text
