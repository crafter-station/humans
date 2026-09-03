import { expect, it, vi } from "vitest";

import { createApp } from "../src/app";

it("initializes without generating randomness at module scope", () => {
  const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new Error("Randomness is unavailable during Worker initialization");
  });

  expect(() =>
    createApp(() => {
      throw new Error("The database is unavailable during initialization");
    }),
  ).not.toThrow();
  expect(randomUUID).not.toHaveBeenCalled();
});
