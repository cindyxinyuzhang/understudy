"""Upload -> recognise -> render, and the failure modes around it."""

from __future__ import annotations

import pytest

from tests.conftest import make_pdf, run_job, upload_score


def test_upload_creates_pending_score_and_queues_one_job(alice, enqueued):
    body = upload_score(alice)
    assert body["score"]["status"] == "pending"
    assert body["job"]["status"] == "queued"
    assert len(enqueued) == 1


def test_doc_is_unavailable_until_the_job_finishes(alice):
    body = upload_score(alice)
    resp = alice.get(f"/scores/{body['score']['id']}/doc")
    # 409, not 404: the score exists, it is just not ready. The client shows a spinner
    # for one and an error for the other.
    assert resp.status_code == 409


def test_full_pipeline_produces_a_renderable_document(alice, session_factory, storage):
    body = upload_score(alice)
    run_job(session_factory, body["job"]["id"])

    doc_resp = alice.get(f"/scores/{body['score']['id']}/doc")
    assert doc_resp.status_code == 200, doc_resp.text
    payload = doc_resp.json()

    doc = payload["doc"]
    assert doc["schemaVersion"] == 1
    assert len(doc["parts"]) == 3
    assert doc["notes"], "engine produced no notes"
    assert len(payload["pageUrls"]) == len(doc["pages"])

    # Every page referenced by the document was actually uploaded.
    for page in doc["pages"]:
        assert page["imageKey"] in storage.objects

    # Every note is addressable and positioned on a real page.
    ids = {n["id"] for n in doc["notes"]}
    assert len(ids) == len(doc["notes"]), "duplicate note ids"
    for note in doc["notes"]:
        assert 0 <= note["page"] < len(doc["pages"])
        x, y, w, h = note["bbox"]
        assert 0 <= x < 1 and 0 <= y < 1 and w > 0 and h > 0


def test_recognition_is_deterministic_for_the_same_pdf(alice, session_factory):
    first = upload_score(alice, title="A", marker=b"identical")
    second = upload_score(alice, title="B", marker=b"identical")
    run_job(session_factory, first["job"]["id"])
    run_job(session_factory, second["job"]["id"])

    a = alice.get(f"/scores/{first['score']['id']}/doc").json()["doc"]
    b = alice.get(f"/scores/{second['score']['id']}/doc").json()["doc"]
    assert [n["id"] for n in a["notes"]] == [n["id"] for n in b["notes"]]


def test_rerunning_a_finished_job_is_a_noop(alice, session_factory):
    body = upload_score(alice)
    run_job(session_factory, body["job"]["id"])
    before = alice.get(f"/scores/{body['score']['id']}/doc").json()

    # At-least-once delivery: the queue can hand us the same job twice.
    run_job(session_factory, body["job"]["id"])
    after = alice.get(f"/scores/{body['score']['id']}/doc").json()
    assert before == after


def test_same_upload_reuses_the_job(alice, enqueued):
    """Idempotency-Key collapses a double-submit onto one job."""
    files = {"file": ("s.pdf", make_pdf(b"dup"), "application/pdf")}
    data = {"title": "Popular"}
    headers = {"Idempotency-Key": "client-generated-123"}

    first = alice.post("/scores", files=files, data=data, headers=headers).json()
    second = alice.post(
        "/scores",
        files={"file": ("s.pdf", make_pdf(b"dup"), "application/pdf")},
        data=data,
        headers=headers,
    ).json()
    assert first["job"]["id"] == second["job"]["id"]


def test_job_failure_retries_then_gives_up(alice, session_factory, monkeypatch):
    body = upload_score(alice)
    job_id = body["job"]["id"]

    import app.worker.tasks as tasks

    class Exploding:
        name, version = "exploding", "0"

        def run(self, pdf_bytes, progress):
            raise RuntimeError("model weights not found")

    monkeypatch.setattr(tasks, "get_engine", lambda _name: Exploding())

    for attempt in range(1, 4):
        if attempt < 3:
            run_job(session_factory, job_id)
        else:
            with pytest.raises(RuntimeError):
                run_job(session_factory, job_id)
        job = alice.get(f"/jobs/{job_id}").json()
        assert job["attempts"] == attempt

    assert job["status"] == "failed"
    assert "model weights not found" in job["error"]

    # A failed version must not become the score anyone opens.
    assert alice.get(f"/scores/{body['score']['id']}/doc").status_code == 409


def test_rejects_non_pdf_and_empty_uploads(alice):
    assert (
        alice.post(
            "/scores", files={"file": ("x.png", b"\x89PNG\r\n", "image/png")}, data={"title": "T"}
        ).status_code
        == 415
    )
    assert (
        alice.post(
            "/scores", files={"file": ("x.pdf", b"", "application/pdf")}, data={"title": "T"}
        ).status_code
        == 400
    )
