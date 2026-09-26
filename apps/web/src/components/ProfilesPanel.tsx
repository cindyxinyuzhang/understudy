import type { ProfileRead } from "@understudy/api-types";
import { useState } from "react";

import {
  useCreateProfile,
  useDeleteProfile,
  useUpdateProfile,
} from "../lib/queries";
import { useViewer } from "../state/viewer";

const SWATCHES = ["#e11d48", "#0ea5e9", "#16a34a", "#f59e0b", "#a855f7", "#14b8a6"];

/**
 * The list of parts a user has built for this score, and the one clicks currently
 * apply to.
 *
 * "Active" is UI state, not server state — which profile you are editing is a property
 * of this tab, and two tabs open on the same score can sensibly be editing different
 * ones.
 */
export default function ProfilesPanel({
  scoreId,
  profiles,
  currentUserId,
}: {
  scoreId: string;
  profiles: ProfileRead[];
  currentUserId: string | null;
}) {
  const { activeProfileId, setActiveProfile, showOtherProfiles, toggleShowOtherProfiles } =
    useViewer();
  const create = useCreateProfile(scoreId);
  const update = useUpdateProfile(scoreId);
  const remove = useDeleteProfile(scoreId);
  const [draftName, setDraftName] = useState("");

  const mine = profiles.filter((p) => !currentUserId || p.ownerId === currentUserId);
  const theirs = profiles.filter((p) => currentUserId && p.ownerId !== currentUserId);

  return (
    <section className="panel stack">
      <header className="row">
        <strong>Parts</strong>
        <div className="spacer" />
        {activeProfileId && (
          <button className="ghost" onClick={() => setActiveProfile(null)}>
            Done editing
          </button>
        )}
      </header>

      {mine.length === 0 && (
        <p className="muted" style={{ margin: 0 }}>
          Create a part, then click or drag across noteheads to add them to it.
        </p>
      )}

      <ul className="profile-list">
        {mine.map((profile) => {
          const active = profile.id === activeProfileId;
          return (
            <li key={profile.id} className={active ? "profile active" : "profile"}>
              <button
                className="swatch"
                style={{ background: profile.color }}
                title="Change colour"
                onClick={() => {
                  const index = SWATCHES.indexOf(profile.color);
                  update.mutate({
                    profileId: profile.id,
                    color: SWATCHES[(index + 1) % SWATCHES.length],
                  });
                }}
              />
              <button
                className="profile-name ghost"
                onClick={() => setActiveProfile(active ? null : profile.id)}
              >
                {profile.name}
                <span className="muted"> · {profile.noteIds.length}</span>
              </button>
              <label className="muted" style={{ fontSize: 11 }} title="Visible to collaborators">
                <input
                  type="checkbox"
                  checked={profile.isShared}
                  onChange={(event) =>
                    update.mutate({ profileId: profile.id, isShared: event.target.checked })
                  }
                />
                share
              </label>
              <button
                className="ghost danger"
                title="Delete part"
                onClick={() => {
                  if (active) setActiveProfile(null);
                  remove.mutate(profile.id);
                }}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          const name = draftName.trim();
          if (!name) return;
          create.mutate(
            { name, color: SWATCHES[mine.length % SWATCHES.length]!, isShared: false, noteIds: [] },
            { onSuccess: (profile) => setActiveProfile(profile.id) },
          );
          setDraftName("");
        }}
      >
        <input
          placeholder="New part (e.g. Elphaba)"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={!draftName.trim() || create.isPending}>
          Add
        </button>
      </form>
      {create.error && <div className="error-banner">{(create.error as Error).message}</div>}

      {theirs.length > 0 && (
        <>
          <label className="row muted" style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={showOtherProfiles}
              onChange={toggleShowOtherProfiles}
            />
            Show {theirs.length} shared part{theirs.length === 1 ? "" : "s"}
          </label>
          {showOtherProfiles && (
            <ul className="profile-list muted">
              {theirs.map((profile) => (
                <li key={profile.id} className="profile">
                  <span className="swatch" style={{ background: profile.color }} />
                  <span className="profile-name">
                    {profile.name}
                    <span className="muted"> · {profile.noteIds.length}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
