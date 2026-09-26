"""Profiles: selecting a singer's notes, and who is allowed to touch them."""

from __future__ import annotations

from tests.conftest import as_user, run_job, upload_score


def ready_score(client, session_factory, marker=b"p"):
    body = upload_score(client, marker=marker)
    run_job(session_factory, body["job"]["id"])
    score_id = body["score"]["id"]
    doc = client.get(f"/scores/{score_id}/doc").json()["doc"]
    return score_id, doc


def test_create_profile_with_a_selection(alice, session_factory):
    score_id, doc = ready_score(alice, session_factory)
    picks = [n["id"] for n in doc["notes"] if n["partId"] == "P1"][:20]

    resp = alice.post(
        f"/scores/{score_id}/profiles",
        json={"name": "Elphaba", "color": "#e11d48", "noteIds": picks},
    )
    assert resp.status_code == 201, resp.text
    profile = resp.json()
    assert profile["name"] == "Elphaba"
    assert sorted(profile["noteIds"]) == sorted(picks)
    assert profile["authoredVersionId"] is not None


def test_note_patches_are_incremental_and_idempotent(alice, session_factory):
    score_id, doc = ready_score(alice, session_factory)
    ids = [n["id"] for n in doc["notes"]][:10]
    profile = alice.post(f"/scores/{score_id}/profiles", json={"name": "P"}).json()
    url = f"/scores/{score_id}/profiles/{profile['id']}/notes"

    alice.patch(url, json={"add": ids[:5]})
    # Re-sending the same adds (a retry after a dropped response) must not duplicate.
    body = alice.patch(url, json={"add": ids[:5]}).json()
    assert sorted(body["noteIds"]) == sorted(ids[:5])

    body = alice.patch(url, json={"add": ids[5:], "remove": ids[:2]}).json()
    assert sorted(body["noteIds"]) == sorted(ids[2:])

    # Removing something that was never there is a no-op, not an error.
    assert alice.patch(url, json={"remove": ["deadbeefcafe"]}).status_code == 200


def test_unknown_note_ids_are_rejected(alice, session_factory):
    score_id, _doc = ready_score(alice, session_factory)
    profile = alice.post(f"/scores/{score_id}/profiles", json={"name": "P"}).json()
    resp = alice.patch(
        f"/scores/{score_id}/profiles/{profile['id']}/notes", json={"add": ["not-a-real-note"]}
    )
    assert resp.status_code == 422
    assert "not in the current score version" in resp.json()["detail"]


def test_duplicate_profile_name_per_owner_is_rejected(alice, session_factory):
    score_id, _ = ready_score(alice, session_factory)
    assert alice.post(f"/scores/{score_id}/profiles", json={"name": "Glinda"}).status_code == 201
    assert alice.post(f"/scores/{score_id}/profiles", json={"name": "Glinda"}).status_code == 409


def test_profiles_are_private_unless_published(client, session_factory):
    alice = as_user(client, "alice@example.com")
    score_id, doc = ready_score(alice, session_factory)
    private = alice.post(f"/scores/{score_id}/profiles", json={"name": "Mine"}).json()
    published = alice.post(
        f"/scores/{score_id}/profiles", json={"name": "Ensemble Sopranos", "isShared": True}
    ).json()

    bob = as_user(client, "bob@example.com")
    bob.get("/scores")  # ensure bob exists in the user mirror
    alice = as_user(client, "alice@example.com")
    alice.post(f"/scores/{score_id}/shares", json={"email": "bob@example.com", "role": "viewer"})

    bob = as_user(client, "bob@example.com")
    visible = {p["id"] for p in bob.get(f"/scores/{score_id}/profiles").json()}
    assert published["id"] in visible
    assert private["id"] not in visible

    # And a viewer cannot edit Alice's published profile — it is hers, not the score's.
    assert (
        bob.patch(
            f"/scores/{score_id}/profiles/{published['id']}", json={"name": "Hijacked"}
        ).status_code
        == 403
    )


def test_a_viewer_can_still_build_their_own_profile(client, session_factory):
    alice = as_user(client, "alice@example.com")
    score_id, doc = ready_score(alice, session_factory)
    as_user(client, "bob@example.com").get("/scores")
    as_user(client, "alice@example.com").post(
        f"/scores/{score_id}/shares", json={"email": "bob@example.com", "role": "viewer"}
    )

    bob = as_user(client, "bob@example.com")
    resp = bob.post(
        f"/scores/{score_id}/profiles",
        json={"name": "Bob's part", "noteIds": [doc["notes"][0]["id"]]},
    )
    # "Viewer" means viewer of the *score*. Learning your part is not an edit to it.
    assert resp.status_code == 201
