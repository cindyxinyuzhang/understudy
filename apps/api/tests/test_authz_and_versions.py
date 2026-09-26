"""Sharing, access control, and what a re-OMR does to saved work."""

from __future__ import annotations

from tests.conftest import as_user, make_pdf, run_job, upload_score


def test_a_stranger_sees_a_404_not_a_403(client, session_factory):
    alice = as_user(client, "alice@example.com")
    score_id = upload_score(alice)["score"]["id"]

    mallory = as_user(client, "mallory@example.com")
    # 404 rather than 403: a 403 confirms the ID is real, which is a small leak on
    # guessable or shared-by-accident links.
    assert mallory.get(f"/scores/{score_id}").status_code == 404
    assert mallory.get(f"/scores/{score_id}/doc").status_code == 404
    assert mallory.get(f"/scores/{score_id}/profiles").status_code == 404


def test_viewer_cannot_upload_a_new_version(client, session_factory):
    alice = as_user(client, "alice@example.com")
    score_id = upload_score(alice)["score"]["id"]
    as_user(client, "bob@example.com").get("/scores")
    as_user(client, "alice@example.com").post(
        f"/scores/{score_id}/shares", json={"email": "bob@example.com", "role": "viewer"}
    )

    bob = as_user(client, "bob@example.com")
    resp = bob.post(
        f"/scores/{score_id}/versions",
        files={"file": ("v2.pdf", make_pdf(b"v2"), "application/pdf")},
    )
    assert resp.status_code == 403
    assert bob.delete(f"/scores/{score_id}").status_code == 403


def test_editor_can_upload_a_version_but_not_manage_shares(client, session_factory):
    alice = as_user(client, "alice@example.com")
    score_id = upload_score(alice)["score"]["id"]
    as_user(client, "bob@example.com").get("/scores")
    as_user(client, "alice@example.com").post(
        f"/scores/{score_id}/shares", json={"email": "bob@example.com", "role": "editor"}
    )

    bob = as_user(client, "bob@example.com")
    assert (
        bob.post(
            f"/scores/{score_id}/versions",
            files={"file": ("v2.pdf", make_pdf(b"v2"), "application/pdf")},
        ).status_code
        == 202
    )
    assert (
        bob.post(f"/scores/{score_id}/shares", json={"email": "carol@example.com"}).status_code
        == 403
    )


def test_sharing_with_an_unknown_email_is_refused_clearly(alice):
    score_id = upload_score(alice)["score"]["id"]
    resp = alice.post(f"/scores/{score_id}/shares", json={"email": "nobody@example.com"})
    assert resp.status_code == 404
    assert "sign in once" in resp.json()["detail"]


def test_shared_scores_appear_in_the_list(client):
    alice = as_user(client, "alice@example.com")
    score_id = upload_score(alice)["score"]["id"]
    as_user(client, "bob@example.com").get("/scores")
    as_user(client, "alice@example.com").post(
        f"/scores/{score_id}/shares", json={"email": "bob@example.com", "role": "viewer"}
    )

    bob_list = as_user(client, "bob@example.com").get("/scores").json()
    assert [s["id"] for s in bob_list] == [score_id]
    assert bob_list[0]["myRole"] == "viewer"


def test_new_version_does_not_switch_the_score_out_from_under_readers(alice, session_factory):
    first = upload_score(alice, marker=b"v1")
    run_job(session_factory, first["job"]["id"])
    score_id = first["score"]["id"]
    v1_id = alice.get(f"/scores/{score_id}/doc").json()["versionId"]

    job2 = alice.post(
        f"/scores/{score_id}/versions",
        files={"file": ("v2.pdf", make_pdf(b"v2-different"), "application/pdf")},
    ).json()
    run_job(session_factory, job2["id"])

    # Still serving v1 until someone activates v2.
    assert alice.get(f"/scores/{score_id}/doc").json()["versionId"] == v1_id
    detail = alice.get(f"/scores/{score_id}").json()
    assert len(detail["versions"]) == 2
    assert [v["isCurrent"] for v in detail["versions"]] == [True, False]


def test_activating_a_version_reports_what_it_cost(alice, session_factory):
    first = upload_score(alice, marker=b"v1")
    run_job(session_factory, first["job"]["id"])
    score_id = first["score"]["id"]

    doc = alice.get(f"/scores/{score_id}/doc").json()["doc"]
    picks = [n["id"] for n in doc["notes"]][:30]
    alice.post(f"/scores/{score_id}/profiles", json={"name": "Elphaba", "noteIds": picks})

    job2 = alice.post(
        f"/scores/{score_id}/versions",
        files={"file": ("v2.pdf", make_pdf(b"completely-different"), "application/pdf")},
    ).json()
    run_job(session_factory, job2["id"])
    v2_id = job2["scoreVersionId"]

    # Dry run first — the UI shows this before asking "activate?".
    preview = alice.get(f"/scores/{score_id}/versions/{v2_id}/migration").json()
    assert preview["profiles"][0]["profileName"] == "Elphaba"
    assert preview["profiles"][0]["kept"] + preview["profiles"][0]["lost"] == 30

    report = alice.post(f"/scores/{score_id}/versions/{v2_id}/activate").json()
    assert report == preview
    assert alice.get(f"/scores/{score_id}/doc").json()["versionId"] == v2_id


def test_notes_that_survive_a_reomr_keep_their_selection(alice, session_factory):
    """The payoff of deterministic IDs: re-running OMR on the *same* content keeps
    every saved note, with no migration step at all."""
    first = upload_score(alice, marker=b"stable")
    run_job(session_factory, first["job"]["id"])
    score_id = first["score"]["id"]

    doc = alice.get(f"/scores/{score_id}/doc").json()["doc"]
    picks = [n["id"] for n in doc["notes"]][:25]
    profile = alice.post(
        f"/scores/{score_id}/profiles", json={"name": "Elphaba", "noteIds": picks}
    ).json()

    job2 = alice.post(
        f"/scores/{score_id}/versions",
        files={"file": ("v2.pdf", make_pdf(b"stable"), "application/pdf")},
    ).json()
    run_job(session_factory, job2["id"])

    report = alice.post(f"/scores/{score_id}/versions/{job2['scoreVersionId']}/activate").json()
    assert report["profiles"][0]["lost"] == 0
    assert report["notesRemoved"] == 0

    after = alice.get(f"/scores/{score_id}/profiles").json()
    assert sorted(next(p for p in after if p["id"] == profile["id"])["noteIds"]) == sorted(picks)
