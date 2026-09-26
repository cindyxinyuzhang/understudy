import { Link, Outlet } from "react-router-dom";

import { getDevUser, setDevUser } from "./lib/auth";

/**
 * Shell. The identity switcher is dev-only scaffolding: it flips the `X-Dev-User`
 * header the API honours when auth enforcement is off, which is how sharing between
 * two people is demonstrated without standing up a Supabase project.
 */
export default function App() {
  const devUser = getDevUser();

  return (
    <>
      <header className="app-header">
        <h1>
          <Link to="/" style={{ color: "inherit", textDecoration: "none" }}>
            Understudy
          </Link>
        </h1>
        <span className="muted">learn your part</span>
        <div className="spacer" />
        <label className="row muted" style={{ fontSize: 12 }}>
          signed in as
          <select
            value={devUser}
            onChange={(event) => {
              setDevUser(event.target.value);
              // Full reload: every cached query was fetched as the previous identity
              // and none of it is valid for the new one.
              window.location.reload();
            }}
          >
            <option value="alice@example.com">alice@example.com</option>
            <option value="bob@example.com">bob@example.com</option>
            <option value="carol@example.com">carol@example.com</option>
          </select>
        </label>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
