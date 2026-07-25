/**
 * Slice 0: the shell only.
 *
 * The job list, create form, status control and error handling arrive in
 * slices 5–9, each with its own spec. What this proves today is that the
 * container builds, nginx serves it, and Playwright can drive it.
 */
export function App() {
  return (
    <main className="app">
      <header className="app__header">
        <h1>Job Management Dashboard</h1>
        <p className="app__subtitle">Monitor and manage computational jobs.</p>
      </header>
    </main>
  );
}
