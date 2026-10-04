// Shown instantly on every tab switch while the server renders the page (and prefetched with each link).
export default function Loading() {
  return (
    <main aria-busy="true" className="animate-pulse space-y-4 pt-1">
      <div className="h-7 w-40 rounded bg-[var(--color-line)]" />
      <div className="card h-32" />
      <div className="card h-48" />
    </main>
  );
}
