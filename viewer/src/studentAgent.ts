/**
 * Optionally bake the student's agent.py at build time. If a file exists at
 * the repo root as `agent.py`, its source is inlined so the viewer can
 * auto-run it against a baseline on page load and pre-populate the launch
 * panel. Absent → null; the viewer falls back to the bundled smoke replay.
 */

const matches = import.meta.glob('../../agent.py', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function bakedStudentAgent(): string | null {
  const [first] = Object.values(matches);
  return first ?? null;
}
