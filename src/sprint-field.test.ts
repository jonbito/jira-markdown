import { describe, expect, test } from "bun:test";
import { extractSprintFrontmatterValue } from "./sprint-field";

describe("extractSprintFrontmatterValue", () => {
  test("prefers active or future sprint names when using sprintByName", () => {
    const value = extractSprintFrontmatterValue(
      [
        { id: 10, name: "Sprint 10", state: "closed" },
        { id: 11, name: "Sprint 11", state: "future" }
      ],
      "sprintByName"
    );

    expect(value).toBe("Sprint 11");
  });

  test("returns numeric sprint ids when using sprintById", () => {
    const value = extractSprintFrontmatterValue(
      [
        "[id=10,rapidViewId=1,state=CLOSED,name=Sprint 10]",
        "[id=11,rapidViewId=1,state=ACTIVE,name=Sprint 11]"
      ],
      "sprintById"
    );

    expect(value).toBe(11);
  });

  test("supports versioned sprint representations", () => {
    const value = extractSprintFrontmatterValue(
      {
        "1": ["[id=10,rapidViewId=1,state=CLOSED,name=Sprint 10]"],
        "2": [{ id: 11, name: "Sprint 11", state: "future" }]
      },
      "sprintByName"
    );

    expect(value).toBe("Sprint 11");
  });
});
