import { describe, expect, it } from "vitest";
import {
  candidateKindsForColumn,
  examplePairValues,
  exampleValuesForColumn,
  isDateLikeColumn,
} from "./heuristics";

describe("record example heuristics", () => {
  it.each([
    ["first-name", ["John", "Jon"]],
    ["forename", ["John", "Jon"]],
    ["last.name", ["Smith", "Smyth"]],
    ["surname", ["Smith", "Smyth"]],
    ["name", ["John", "Jon"]],
    ["first_name_surname_concat", ["John Smith", "Jon Smyth"]],
    ["date-of-birth", ["1990-01-01", "1990-01-02"]],
    ["event_date", ["1990-01-01", "1990-01-02"]],
    ["postcode_fake", ["SW1A 1AA", "SW1A 1AB"]],
    ["zip.code", ["10001", "10002"]],
    ["town", ["London", "London"]],
    ["home_town", ["London", "London"]],
    ["city_name", ["London", "London"]],
    ["email", ["john.smith@example.com", "john.smyth@example.com"]],
    ["email_address", ["john.smith@example.com", "john.smyth@example.com"]],
    ["e-mail", ["john.smith@example.com", "john.smyth@example.com"]],
    ["primaryEmail", ["john.smith@example.com", "john.smyth@example.com"]],
    ["occupation", ["", ""]],
  ])("provides simple examples for %s", (column, expected) => {
    expect(exampleValuesForColumn(column)).toEqual(expected);
  });

  it("builds both records and leaves unknown fields empty", () => {
    expect(examplePairValues(["first_name", "occupation"])).toEqual({
      left: { first_name: "John", occupation: "" },
      right: { first_name: "Jon", occupation: "" },
    });
  });
});

describe("type candidate heuristics", () => {
  it("tries DATE first for date-like names", () => {
    expect(isDateLikeColumn("DOB")).toBe(true);
    expect(isDateLikeColumn("created-date")).toBe(true);
    expect(candidateKindsForColumn("date_of_birth")).toEqual([
      "DATE",
      "VARCHAR",
      "DOUBLE",
      "BOOLEAN",
    ]);
  });

  it("keeps text as the conservative default for other fields", () => {
    expect(isDateLikeColumn("candidate")).toBe(false);
    expect(candidateKindsForColumn("first_name")).toEqual([
      "VARCHAR",
      "DOUBLE",
      "BOOLEAN",
      "DATE",
    ]);
  });
});
