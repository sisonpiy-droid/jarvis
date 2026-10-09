import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { cleanedCsv, cleanTable, parseCsv, readTable, readXlsx } from "../src/clean-data";
import { call, calls, say, scripted } from "./scripted";
import { chat } from "../src/jarvis";

// "It cleans a pile of documents and flags every row it wasn't sure about."

const CSV = [
  "Name,Email,Phone,Joined,Amount,City",
  '  asha  rao ,ASHA@Gmail.com,+91 98765 43210,03/04/2026,"₹1,20,000",MUMBAI',
  "Vikram Shah,vikram@gmial.com,9876543211,25/12/2025,Rs. 5000,pune",
  ",,,,,",
  "Meera Nair,meera@x,98765,31/02/2026,12k,Chennai",
  "Asha Rao,asha@gmail.com,9876543210,2026-04-03,120000,Mumbai",
  "Asha Rao,asha@gmail.com,9876543210,2026-04-03,120000,Mumbai",
  "Ravi Kumar,N/A,098765 43212,5 Oct 2026,300,delhi",
  "Dev Patel,dev@x.in,9876543213,45300,(250),Surat",
  "Anita Das,anita@x.in,9876543214,7/8/26,10,Kolkata",
  "Kiran Roy,asha@gmail.com,9876543215,01/02/2026,10,Goa",
].join("\n");

describe("cleanTable", () => {
  const r = cleanTable(parseCsv(CSV));
  const row = (n: number) => r.rows.find((x) => x.row === n)!;

  it("fixes what is safe: spacing, case, email, phone, date and number formats", () => {
    expect(row(2).cells).toEqual(["Asha Rao", "asha@gmail.com", "9876543210", "2026-04-03", "120000", "Mumbai"]);
    expect(row(3).cells).toEqual(["Vikram Shah", "vikram@gmial.com", "9876543211", "2025-12-25", "5000", "Pune"]);
    expect(row(8).cells).toEqual(["Ravi Kumar", "", "9876543212", "2026-10-05", "300", "Delhi"]);
    expect(row(9).cells.slice(3, 5)).toEqual(["2024-01-09", "-250"]); // an Excel date serial, an accounting negative
  });

  it("removes only blank rows and exact duplicates, and counts them", () => {
    expect([r.rowsIn, r.blankRemoved]).toEqual([10, 1]);
    expect(r.duplicatesRemoved).toEqual([{ row: 6, sameAs: 2 }, { row: 7, sameAs: 2 }]);
    expect(r.rows.map((x) => x.row)).toEqual([2, 3, 5, 8, 9, 10, 11]);
  });

  it("flags every cell it isn't sure about, with the reason — and leaves the value as it was", () => {
    expect(row(5).flags).toEqual([
      'Email: "meera@x" is not a valid email',
      'Phone: "98765" has 5 digits (expected 10)',
      'Joined: "31/02/2026" is not a date I can read',
      'Amount: "12k" is not a plain number',
    ]);
    expect(row(5).cells.slice(1)).toEqual(["meera@x", "98765", "31/02/2026", "12k", "Chennai"]);
    expect(row(3).flags).toEqual(['Email: "vikram@gmial.com" — domain looks misspelled']);
    expect(row(8).flags).toEqual(["Email: missing"]);
    expect(row(10).flags).toEqual(['Joined: "7/8/26" two-digit year read as 2026']);
    expect(row(2).flags).toEqual(["possible duplicate of row 11 (same Email, other values differ)"]);
    expect(row(11).flags).toEqual(["possible duplicate of row 2 (same Email, other values differ)"]);
    expect(row(9).flags).toEqual([]);
  });

  it("flags ambiguous dates when the column gives no way to tell, and not when it does", () => {
    const amb = cleanTable(parseCsv("Name,Joined\nA,03/04/2026\nB,2026-01-02"));
    expect(amb.rows.map((x) => x.cells[1])).toEqual(["2026-04-03", "2026-01-02"]);
    expect(amb.rows[0]!.flags).toEqual(['Joined: "03/04/2026" is ambiguous (3 Apr or 4 Mar) — read as day first']);
    expect(cleanTable(parseCsv("Name,Joined\nA,03/04/2026\nB,25/12/2026")).rows[0]!.flags).toEqual([]); // 25/12 proves day-first
  });

  it("writes the file with the original row number and a 'needs review' column", () => {
    const csv = cleanedCsv(cleanTable(parseCsv("Name,Joined\nA,03/04/2026\nB,2026-01-02")));
    expect(csv.startsWith("﻿row,Name,Joined,needs review\r\n2,A,2026-04-03,")).toBe(true);
    expect(csv).toContain('"Joined: ""03/04/2026"" is ambiguous');
    expect(csv).toContain("\r\n3,B,2026-01-02,");
  });
});

describe("reading files", () => {
  it("parses quotes, semicolons and tabs", () => {
    expect(parseCsv('a;b\n"x;1";"he said ""hi"""')).toEqual([["a", "b"], ["x;1", 'he said "hi"']]);
    expect(parseCsv("a\tb\r\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("reads the first sheet of an .xlsx, keeping empty cells in place", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>42</v></c><c r="B2" t="s"><v>2</v></c></row></sheetData></worksheet>';
    const strings = "<sst><si><t>Name</t></si><si><t>Total</t></si><si><t>R&amp;D</t></si></sst>";
    const bytes = zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet), "xl/sharedStrings.xml": strToU8(strings) });
    expect(readXlsx(bytes)).toEqual([["Name", "", "Total"], ["42", "R&D"]]);
    expect(readTable(bytes, "pile.xlsx")).not.toBeNull();
    expect(readTable(new Uint8Array(), "notes.pdf")).toBeNull();
  });
});

describe("clean_data in chat", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => t?.close());
  beforeEach(async () => {
    await t.sql`truncate jarvis.chat_messages restart identity cascade`;
  });

  it("cleans a shared CSV, sends the file back, and gives the model the flagged rows to report", async () => {
    const sent: Array<{ name: string; mime?: string; text: string }> = [];
    const tools = (await import("../src/tools")).jarvisTools(t.sql, () => new Date(), {
      readFile: async (id) => (id === "f1" ? { bytes: new TextEncoder().encode(CSV), name: "leads.csv" } : null),
      sendFile: async (bytes, name, _cap, mime) => (sent.push({ name, ...(mime ? { mime } : {}), text: new TextDecoder().decode(bytes) }), "sent"),
    });
    const { model, requests } = scripted(calls(call("clean_data", { file_id: "f1" })), say("Cleaned 7 of 10 rows; 6 rows need a look: rows 2, 3, 5, 8, 10, 11."));
    const res = await chat({ sql: t.sql, model, channel: "telegram", tools, situation: false }, "📎 Shared file: leads.csv (file_id: f1)\nclean this up");
    expect(res.text).toContain("need a look");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: "leads-cleaned.csv", mime: "text/csv" });
    expect(sent[0]!.text).toContain("needs review");
    const result = JSON.stringify(requests[1]!.messages.at(-1));
    expect(result).toContain('"flagged_rows":6');
    expect(result).toContain("Never guess the right value");
    // Not offered when the surface can't read or deliver files.
    expect((await import("../src/tools")).jarvisTools(t.sql).some((x) => x.name === "clean_data")).toBe(false);
  });
});
