import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetRemoteLocation, readRemoteLocation, rememberRemoteLocation } from "../src/lib/remoteLocations";
import type { ConnectionProfile } from "../src/lib/types";

const profile: ConnectionProfile = {
  id: "generated-profile", host: "example.invalid", port: 22, username: "tester", name: "test",
  authMethod: "password", privateKeyPath: null, remotePath: ".",
};
const key = "fileworker.remote.last-path.v1:generated-profile";
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("location data contains endpoint metadata and path only, never authentication fields", () => {
  rememberRemoteLocation({ ...profile, secret: "must-not-persist" } as ConnectionProfile, "/work/logs");
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ endpoint: ["example.invalid", 22, "tester"], path: "/work/logs" });
  expect(readRemoteLocation({ ...profile, authMethod: "privateKeyContent" })).toBe("/work/logs");
  expect(readRemoteLocation({ ...profile, username: "other" })).toBeNull();
  expect(readRemoteLocation({ ...profile, port: 2222 })).toBeNull();
});
it("corrupt remembered locations are ignored and never silently replaced", () => {
  for (const value of ["invalid-json", '{"path":17}', '{"endpoint":[],"path":"/wrong"}']) {
    localStorage.setItem(key, value);
    expect(readRemoteLocation(profile)).toBeNull();
    rememberRemoteLocation(profile, "/new");
    expect(localStorage.getItem(key)).toBe(value);
  }
});
it("deleting one location leaves all other storage intact", () => {
  rememberRemoteLocation(profile, "/work");
  localStorage.setItem("unrelated", "keep");
  rememberRemoteLocation({ ...profile, id: "other" }, "/other");
  forgetRemoteLocation(profile.id);
  expect(readRemoteLocation(profile)).toBeNull();
  expect(readRemoteLocation({ ...profile, id: "other" })).toBe("/other");
  expect(localStorage.getItem("unrelated")).toBe("keep");
});
it("unavailable storage never prevents navigation", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  expect(readRemoteLocation(profile)).toBeNull();
  expect(() => rememberRemoteLocation(profile, "/work")).not.toThrow();
});
it("invalid and overlong paths are not persisted", () => {
  for (const path of ["relative", "/bad\npath", `/${"x".repeat(32_768)}`]) {
    rememberRemoteLocation(profile, path);
    expect(localStorage.getItem(key)).toBeNull();
  }
});
