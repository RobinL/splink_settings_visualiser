import type { ColumnKind, PairValues } from "./types";

const normalizeColumnName = (column: string): string[] =>
  column
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

function hasSequence(tokens: string[], sequence: string[]): boolean {
  return tokens.some((candidate, start) =>
    candidate === sequence[0] &&
    sequence.every((part, offset) => tokens[start + offset] === part),
  );
}

export function isDateLikeColumn(column: string): boolean {
  const tokens = normalizeColumnName(column);
  const compact = tokens.join("");
  return (
    tokens.includes("date") ||
    tokens.includes("dob") ||
    compact === "dateofbirth" ||
    hasSequence(tokens, ["date", "of", "birth"])
  );
}

export function candidateKindsForColumn(column: string): ColumnKind[] {
  return isDateLikeColumn(column)
    ? ["DATE", "VARCHAR", "DOUBLE", "BOOLEAN"]
    : ["VARCHAR", "DOUBLE", "BOOLEAN", "DATE"];
}

export function exampleValuesForColumn(column: string): [string, string] {
  const tokens = normalizeColumnName(column);
  const compact = tokens.join("");
  const isFirstName =
    tokens.includes("forename") ||
    compact === "firstname" ||
    hasSequence(tokens, ["first", "name"]);
  const isLastName =
    tokens.includes("surname") ||
    compact === "lastname" ||
    hasSequence(tokens, ["last", "name"]);

  if (isDateLikeColumn(column)) return ["1990-01-01", "1990-01-02"];
  if (tokens.includes("postcode") || compact.includes("postcode")) {
    return ["SW1A 1AA", "SW1A 1AB"];
  }
  if (
    tokens.includes("zip") ||
    compact.includes("zipcode") ||
    hasSequence(tokens, ["zip", "code"])
  ) {
    return ["10001", "10002"];
  }
  if (isFirstName && isLastName) return ["John Smith", "Jon Smyth"];
  if (isFirstName) return ["John", "Jon"];
  if (isLastName) return ["Smith", "Smyth"];
  if (tokens.length === 1 && tokens[0] === "name") return ["John", "Jon"];
  return ["", ""];
}

export function examplePairValues(columns: string[]): PairValues {
  const left: PairValues["left"] = {};
  const right: PairValues["right"] = {};
  for (const column of columns) {
    const [leftValue, rightValue] = exampleValuesForColumn(column);
    left[column] = leftValue;
    right[column] = rightValue;
  }
  return { left, right };
}
