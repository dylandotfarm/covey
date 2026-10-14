/**
 * What makes two projects one row, with the local project in it.
 *
 * A local project has no repository, so the name the reader gave it is its
 * identity. These are the rules three clients read, so they are tested once
 * here and nowhere else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { localProjectError, localProjectId, type Project } from "@covey/protocol";
import { projectPool } from "./projects.js";

test("projectPool folds a repository by identity and base, and a local project by its name", () => {
  assert.equal(projectPool({ repositoryIdentity: "github.com/acme/api", baseBranch: undefined }), "github.com/acme/api");
  assert.equal(projectPool({ repositoryIdentity: "github.com/Acme/API", baseBranch: undefined }), "github.com/acme/api", "the case folds");
  assert.equal(projectPool({ repositoryIdentity: "github.com/acme/api", baseBranch: "feature" }), "github.com/acme/api#feature");

  // A local project on two machines is one row: the identity is the name, and
  // the title each machine holds may have been renamed on one of them.
  const here: Pick<Project, "repositoryIdentity" | "baseBranch" | "kind" | "localId"> = { repositoryIdentity: null, kind: "local", localId: "notes" };
  const there = { ...here };
  assert.equal(projectPool(here), "local:notes");
  assert.equal(projectPool(there), projectPool(here));

  // Two local projects of different names never fold, and a local project
  // never folds with a repository.
  assert.notEqual(projectPool({ repositoryIdentity: null, kind: "local", localId: "errands" }), projectPool(here));
  assert.notEqual(projectPool({ repositoryIdentity: "github.com/acme/notes", baseBranch: undefined }), projectPool(here));

  // A project with neither is a group of its own, which the caller keys by
  // machine and id — the rule a `checkout` always had.
  assert.equal(projectPool({ repositoryIdentity: null, baseBranch: undefined }), null);
  assert.equal(projectPool({ repositoryIdentity: null, kind: "local" }), null, "a local row with no identity is nobody's pool");
});

test("localProjectId is one path segment, folds the case, and is stable under a rename of the title", () => {
  assert.equal(localProjectId("Notes"), "notes");
  assert.equal(localProjectId("notes"), "notes", "the case folds, as a repository's identity does");
  assert.equal(localProjectId("  My Home Automation  "), "my-home-automation");
  assert.equal(localProjectId("a/b/c"), "a-b-c", "never a second path segment");
  assert.equal(localProjectId("../../etc"), "etc", "and never a step out of the projects directory");
  assert.equal(localProjectId("errands!!!"), "errands", "nothing trails");
  assert.equal(localProjectId("日記"), "", "a name with nothing covey can use leaves nothing");
  assert.equal(localProjectId("x".repeat(200)).length, 64, "a long name is cut to a length a filesystem takes");
  // Slugging a slug changes nothing, which is what lets the client send the
  // identity back when it adds a machine to the pool.
  assert.equal(localProjectId(localProjectId("My Notes")), localProjectId("My Notes"));
});

test("localProjectError says the same sentence the daemon would, before anything is sent", () => {
  assert.equal(localProjectError("Notes"), null);
  assert.equal(localProjectError("  "), "a local project needs a name");
  assert.match(localProjectError("日記")!, /^"日記" leaves covey no name/, "the name covey could not use is quoted, not folded into one word (#132)");
});
