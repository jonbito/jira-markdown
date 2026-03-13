import { describe, expect, test } from "bun:test";
import {
  buildDiscoveredUserMap,
  resolvePreferredUserLabel,
  resolveUserFromMap,
  upsertDiscoveredUsers
} from "./user-map";

describe("buildDiscoveredUserMap", () => {
  test("uses display names as preferred labels and emails as aliases", () => {
    const userMap = buildDiscoveredUserMap([
      {
        accountId: "557058:alice",
        displayName: "Alice Example",
        emailAddress: "alice@example.com"
      }
    ]);

    expect(userMap["Alice Example"]).toEqual({
      accountId: "557058:alice",
      aliases: ["alice@example.com"],
      email: "alice@example.com"
    });
  });

  test("disambiguates duplicate display names with email when available", () => {
    const userMap = buildDiscoveredUserMap([
      {
        accountId: "557058:alice-1",
        displayName: "Alice Example",
        emailAddress: "alice1@example.com"
      },
      {
        accountId: "557058:alice-2",
        displayName: "Alice Example",
        emailAddress: "alice2@example.com"
      }
    ]);

    expect(userMap["Alice Example <alice1@example.com>"]?.accountId).toBe("557058:alice-1");
    expect(userMap["Alice Example <alice2@example.com>"]?.accountId).toBe("557058:alice-2");
  });
});

describe("user map lookup", () => {
  const userMap = {
    "Alice Example": {
      accountId: "557058:alice",
      aliases: ["alice@example.com"]
    },
    "Bob Example <bob@example.com>": {
      accountId: "557058:bob",
      aliases: ["Bob Example", "bob@example.com"],
      email: "bob@example.com"
    }
  };

  test("resolves preferred labels and aliases", () => {
    expect(resolveUserFromMap(userMap, "Alice Example")?.accountId).toBe("557058:alice");
    expect(resolveUserFromMap(userMap, "alice@example.com")?.accountId).toBe("557058:alice");
    expect(resolveUserFromMap(userMap, "Bob Example")?.accountId).toBe("557058:bob");
  });

  test("resolves preferred labels from account ids", () => {
    expect(resolvePreferredUserLabel(userMap, "557058:alice")).toBe("Alice Example");
    expect(resolvePreferredUserLabel(userMap, "557058:bob")).toBe(
      "Bob Example <bob@example.com>"
    );
    expect(resolvePreferredUserLabel(userMap, "557058:missing", "Fallback User")).toBe(
      "Fallback User"
    );
  });
});

describe("upsertDiscoveredUsers", () => {
  test("adds new discovered users with a stable label", () => {
    const result = upsertDiscoveredUsers({}, [
      {
        accountId: "557058:alice",
        displayName: "Alice Example",
        emailAddress: "alice@example.com"
      }
    ]);

    expect(result.changed).toBe(true);
    expect(result.userMap["Alice Example"]).toEqual({
      accountId: "557058:alice",
      aliases: ["alice@example.com"],
      email: "alice@example.com"
    });
  });

  test("preserves existing labels while enriching aliases and email", () => {
    const result = upsertDiscoveredUsers(
      {
        "Alice Example": {
          accountId: "557058:alice"
        }
      },
      [
        {
          accountId: "557058:alice",
          displayName: "Alice Example",
          emailAddress: "alice@example.com"
        }
      ]
    );

    expect(result.changed).toBe(true);
    expect(result.userMap["Alice Example"]).toEqual({
      accountId: "557058:alice",
      aliases: ["alice@example.com"],
      email: "alice@example.com"
    });
  });

  test("falls back to a disambiguated label when a display name is already taken", () => {
    const result = upsertDiscoveredUsers(
      {
        "Alice Example": {
          accountId: "557058:alice-1"
        }
      },
      [
        {
          accountId: "557058:alice-2",
          displayName: "Alice Example",
          emailAddress: "alice2@example.com"
        }
      ]
    );

    expect(result.userMap["Alice Example <alice2@example.com>"]).toEqual({
      accountId: "557058:alice-2",
      aliases: ["Alice Example", "alice2@example.com"],
      email: "alice2@example.com"
    });
  });
});
