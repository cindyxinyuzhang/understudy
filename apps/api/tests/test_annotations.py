from __future__ import annotations

from tests.conftest import as_user, run_job, upload_score


def ready(client, session_factory):
    body = upload_score(client)
    run_job(session_factory, body["job"]["id"])
    sid = body["score"]["id"]
    return sid, client.get(f"/scores/{sid}/doc").json()["doc"]


def test_colouring_a_part_and_a_note(alice, session_factory):
    score_id, doc = ready(alice, session_factory)
    note_id = doc["notes"][0]["id"]

    resp = alice.put(
        f"/scores/{score_id}/annotations",
        json=[
            {
                "targetType": "part",
                "targetId": "P1",
                "kind": "color",
                "payload": {"color": "#e11d48"},
                "isShared": True,
            },
            {
                "targetType": "note",
                "targetId": note_id,
                "kind": "color",
                "payload": {"color": "#f59e0b"},
            },
            {
                "targetType": "note",
                "targetId": note_id,
                "kind": "text",
                "payload": {"text": "breathe here"},
            },
        ],
    )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) == 3


def test_upsert_replaces_rather_than_stacks(alice, session_factory):
    score_id, doc = ready(alice, session_factory)
    note_id = doc["notes"][0]["id"]
    body = [
        {
            "targetType": "note",
            "targetId": note_id,
            "kind": "color",
            "payload": {"color": "#111111"},
        }
    ]

    first = alice.put(f"/scores/{score_id}/annotations", json=body).json()
    body[0]["payload"] = {"color": "#222222"}
    second = alice.put(f"/scores/{score_id}/annotations", json=body).json()

    assert first[0]["id"] == second[0]["id"]
    assert second[0]["payload"]["color"] == "#222222"
    assert len(alice.get(f"/scores/{score_id}/annotations").json()) == 1


def test_private_annotations_stay_private(client, session_factory):
    alice = as_user(client, "alice@example.com")
    score_id, doc = ready(alice, session_factory)
    nid = doc["notes"][0]["id"]
    alice.put(
        f"/scores/{score_id}/annotations",
        json=[
            {
                "targetType": "note",
                "targetId": nid,
                "kind": "text",
                "payload": {"text": "my private cue"},
            },
            {
                "targetType": "part",
                "targetId": "P2",
                "kind": "color",
                "payload": {"color": "#0ea5e9"},
                "isShared": True,
            },
        ],
    )

    as_user(client, "bob@example.com").get("/scores")
    as_user(client, "alice@example.com").post(
        f"/scores/{score_id}/shares", json={"email": "bob@example.com", "role": "editor"}
    )

    bob_sees = as_user(client, "bob@example.com").get(f"/scores/{score_id}/annotations").json()
    assert [a["targetId"] for a in bob_sees] == ["P2"]


def test_cannot_delete_someone_elses_annotation(client, session_factory):
    alice = as_user(client, "alice@example.com")
    score_id, doc = ready(alice, session_factory)
    created = alice.put(
        f"/scores/{score_id}/annotations",
        json=[
            {
                "targetType": "part",
                "targetId": "P1",
                "kind": "color",
                "payload": {"color": "#000000"},
                "isShared": True,
            }
        ],
    ).json()[0]

    as_user(client, "bob@example.com").get("/scores")
    as_user(client, "alice@example.com").post(
        f"/scores/{score_id}/shares", json={"email": "bob@example.com", "role": "editor"}
    )
    bob = as_user(client, "bob@example.com")
    assert bob.delete(f"/scores/{score_id}/annotations/{created['id']}").status_code == 403
