import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { fetchSubmissionTimes } from "../src/submissions";

// Real submission times: read once per submitted assignment (GET only), a few per run, again after a re-submission.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.lms_items, jarvis.submissions cascade`;
});

const assignment = (id: string, status: string, due: string) =>
  t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, title, sort_at)
        values ('assignment', ${id}, ${id}, ${t.sql.json({ sourceId: id, submissionStatus: status } as never)}, ${id}, ${due})`;

describe("fetchSubmissionTimes", () => {
  it("reads submitted ones only, newest first, within the budget, and not again", async () => {
    await assignment("a1", "submitted", "2026-09-20T18:29:00Z");
    await assignment("a2", "submitted_late", "2026-09-25T18:29:00Z");
    await assignment("a3", "not_submitted", "2026-09-30T18:29:00Z");
    const paths: string[] = [];
    const client = {
      get: async <T,>(p: string) => {
        paths.push(p);
        return { data: { submission: { status: "submitted", submittedAt: "2026-09-25T20:00:00Z", grade: p.includes("a2") ? { score: 8, max: 10 } : null } } } as T;
      },
    };
    expect(await fetchSubmissionTimes(t.sql, client, 1)).toEqual({ fetched: 1, pending: 1 });
    expect(paths).toEqual(["/assignments/a2/submissions"]);
    expect(await fetchSubmissionTimes(t.sql, client)).toEqual({ fetched: 1, pending: 0 });
    expect(await fetchSubmissionTimes(t.sql, client)).toEqual({ fetched: 0, pending: 0 });
    const rows = await t.sql`select assignment_id, status, submitted_at, grade from jarvis.submissions order by assignment_id`;
    expect(rows.map((r) => [r.assignment_id, r.status, new Date(r.submitted_at as string).toISOString(), r.grade])).toEqual([
      ["a1", "submitted", "2026-09-25T20:00:00.000Z", null],
      ["a2", "submitted_late", "2026-09-25T20:00:00.000Z", { score: 8, max: 10 }],
    ]);
  });

  it("tolerates a missing submission body", async () => {
    await assignment("a1", "submitted", "2026-09-20T18:29:00Z");
    const client = { get: async <T,>() => ({ data: { submission: null } }) as T };
    expect(await fetchSubmissionTimes(t.sql, client)).toEqual({ fetched: 1, pending: 0 });
    const [r] = await t.sql`select submitted_at from jarvis.submissions`;
    expect(r!.submitted_at).toBeNull();
  });
});
