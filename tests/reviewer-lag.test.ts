import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { drop } from "@mswjs/data";
import dotenv from "dotenv";
import { isUserReviewerLagged } from "../src/handlers/start/helpers/check-assignments";
import { Context } from "../src/types/context";
import { db } from "./__mocks__/db";
import issueTemplate from "./__mocks__/issue-template";
import { server } from "./__mocks__/node";
import { createContext } from "./utils";

dotenv.config();

type Issue = Context<"issue_comment.created">["payload"]["issue"];
type PayloadSender = Context["payload"]["sender"];

const checkAssignmentsPath = "../src/handlers/start/helpers/check-assignments";
const issueUtilsPath = "../src/utils/issue";
const userLimitUtilsPath = "../src/utils/get-user-task-limit-and-role";
const assignmentPeriodsPath = "../src/utils/get-assignment-periods";

const REVIEW_DELAY_TOLERANCE = "3 Days";
const PR_ONE_URL = "https://github.com/owner/repo/pull/1";
const PR_ONE = { html_url: PR_ONE_URL, number: 1 };
// 5 days in the past — beyond any tolerance
const OLD_DATE = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
// 1 minute in the past — within any reasonable tolerance
const RECENT_DATE = new Date(Date.now() - 60 * 1000).toISOString();

function buildThreadsResult(threads: Array<{ isResolved: boolean; authorLogin: string; updatedAt: string }>) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: threads.map((t) => ({
            isResolved: t.isResolved,
            comments: {
              nodes: [{ author: { login: t.authorLogin }, updatedAt: t.updatedAt }],
            },
          })),
        },
      },
    },
  };
}

function makeMinimalContext(graphqlFn: jest.Mock): Context {
  return {
    octokit: { graphql: graphqlFn },
    config: { reviewDelayTolerance: REVIEW_DELAY_TOLERANCE },
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn(), ok: jest.fn() },
  } as unknown as Context;
}

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  jest.restoreAllMocks();
});
afterAll(() => server.close());

describe("isUserReviewerLagged", () => {
  it("returns false when there are no pending PRs", async () => {
    const graphqlFn = jest.fn() as jest.Mock;
    const ctx = makeMinimalContext(graphqlFn);
    expect(await isUserReviewerLagged(ctx, "alice", [], REVIEW_DELAY_TOLERANCE)).toBe(false);
    expect(graphqlFn).not.toHaveBeenCalled();
  });

  it("returns false when a PR has only resolved threads", async () => {
    const graphqlFn = jest.fn().mockResolvedValue(buildThreadsResult([{ isResolved: true, authorLogin: "alice", updatedAt: OLD_DATE }])) as jest.Mock;
    const ctx = makeMinimalContext(graphqlFn);
    expect(await isUserReviewerLagged(ctx, "alice", [PR_ONE], REVIEW_DELAY_TOLERANCE)).toBe(false);
  });

  it("returns false when the reviewer — not the user — last commented on an unresolved thread", async () => {
    const graphqlFn = jest.fn().mockResolvedValue(buildThreadsResult([{ isResolved: false, authorLogin: "reviewer", updatedAt: OLD_DATE }])) as jest.Mock;
    const ctx = makeMinimalContext(graphqlFn);
    expect(await isUserReviewerLagged(ctx, "alice", [PR_ONE], REVIEW_DELAY_TOLERANCE)).toBe(false);
  });

  it("returns false when user last commented but within the tolerance window", async () => {
    const graphqlFn = jest.fn().mockResolvedValue(buildThreadsResult([{ isResolved: false, authorLogin: "alice", updatedAt: RECENT_DATE }])) as jest.Mock;
    const ctx = makeMinimalContext(graphqlFn);
    expect(await isUserReviewerLagged(ctx, "alice", [PR_ONE], REVIEW_DELAY_TOLERANCE)).toBe(false);
  });

  it("returns true when user is last commenter on all unresolved threads and beyond the tolerance", async () => {
    const graphqlFn = jest.fn().mockResolvedValue(
      buildThreadsResult([
        { isResolved: false, authorLogin: "alice", updatedAt: OLD_DATE },
        { isResolved: false, authorLogin: "alice", updatedAt: OLD_DATE },
        { isResolved: true, authorLogin: "reviewer", updatedAt: OLD_DATE },
      ])
    ) as jest.Mock;
    const ctx = makeMinimalContext(graphqlFn);
    expect(await isUserReviewerLagged(ctx, "alice", [PR_ONE], REVIEW_DELAY_TOLERANCE)).toBe(true);
  });

  it("returns false when user is lagged on one PR but not on another", async () => {
    const graphqlFn = jest
      .fn()
      .mockResolvedValueOnce(buildThreadsResult([{ isResolved: false, authorLogin: "alice", updatedAt: OLD_DATE }]))
      .mockResolvedValueOnce(buildThreadsResult([{ isResolved: false, authorLogin: "reviewer", updatedAt: OLD_DATE }])) as jest.Mock;
    const ctx = makeMinimalContext(graphqlFn);
    expect(await isUserReviewerLagged(ctx, "alice", [PR_ONE, { html_url: "https://github.com/owner/repo/pull/2", number: 2 }], REVIEW_DELAY_TOLERANCE)).toBe(
      false
    );
  });

  it("returns false when graphql throws (fail-safe)", async () => {
    const graphqlFn = jest.fn().mockRejectedValue(new Error("Network error")) as jest.Mock;
    const ctx = makeMinimalContext(graphqlFn);
    expect(await isUserReviewerLagged(ctx, "alice", [PR_ONE], REVIEW_DELAY_TOLERANCE)).toBe(false);
  });

  it("returns false when PR has no review threads at all", async () => {
    const graphqlFn = jest.fn().mockResolvedValue(buildThreadsResult([])) as jest.Mock;
    const ctx = makeMinimalContext(graphqlFn);
    expect(await isUserReviewerLagged(ctx, "alice", [PR_ONE], REVIEW_DELAY_TOLERANCE)).toBe(false);
  });
});

describe("handleTaskLimitChecks: reviewer-lag bypass", () => {
  beforeEach(async () => {
    drop(db);
    jest.clearAllMocks();
    jest.resetAllMocks();
    jest.resetModules();
    db.users.create({ id: 1, login: "alice", role: "contributor", created_at: new Date("2020-01-01").toISOString(), xp: 0, wallet: null });
    db.issue.create({ ...issueTemplate, id: 1 });
    db.repo.create({ id: 1, html_url: "", name: "test-repo", owner: { login: "ubiquity", id: 1, type: "Organization" }, issues: [] });
  });

  const OVER_LIMIT_ASSIGNED = [
    { title: "issue 1", html_url: "https://github.com/owner/repo/issues/10" },
    { title: "issue 2", html_url: "https://github.com/owner/repo/issues/11" },
    { title: "issue 3", html_url: "https://github.com/owner/repo/issues/12" },
  ];
  const ONE_PENDING_PR = [PR_ONE];

  it("bypasses the task limit and sets isReviewerLagged=true when all pending PRs are reviewer-lagged", async () => {
    const graphqlFn = jest.fn().mockResolvedValue(buildThreadsResult([{ isResolved: false, authorLogin: "alice", updatedAt: OLD_DATE }]));
    jest.mock(issueUtilsPath, () => ({
      getPendingOpenedPullRequests: jest.fn().mockResolvedValue(ONE_PENDING_PR),
      getAssignedIssues: jest.fn().mockResolvedValue(OVER_LIMIT_ASSIGNED),
      getOwnerRepoFromHtmlUrl: (url: string) => {
        const p = url.split("/");
        return { owner: p[3], repo: p[4] };
      },
      getTimeValue: () => 259200000,
    }));
    jest.mock(userLimitUtilsPath, () => ({ getUserRoleAndTaskLimit: jest.fn().mockResolvedValue({ role: "contributor", limit: 2 }) }));
    jest.mock(assignmentPeriodsPath, () => ({ getAssignmentPeriods: jest.fn().mockResolvedValue({}) }));

    const issue = db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;
    const context = (await createContext(issue, sender, "/start")) as Context & { installOctokit: Context["octokit"] };
    const patchedOctokit = Object.create(context.octokit) as typeof context.octokit;
    (patchedOctokit as { graphql: jest.Mock }).graphql = graphqlFn;
    context.octokit = patchedOctokit;

    const { handleTaskLimitChecks: fn } = await import(checkAssignmentsPath);
    const result = await fn({ context, logger: context.logger, sender: "alice", username: "alice" });

    expect(result.isWithinLimit).toBe(true);
    expect(result.isReviewerLagged).toBe(true);
    expect(result.isUnassigned).toBe(false);
  });

  it("enforces the task limit when the reviewer — not the user — last commented", async () => {
    const graphqlFn = jest.fn().mockResolvedValue(buildThreadsResult([{ isResolved: false, authorLogin: "reviewer", updatedAt: OLD_DATE }]));
    jest.mock(issueUtilsPath, () => ({
      getPendingOpenedPullRequests: jest.fn().mockResolvedValue(ONE_PENDING_PR),
      getAssignedIssues: jest.fn().mockResolvedValue(OVER_LIMIT_ASSIGNED),
      getOwnerRepoFromHtmlUrl: (url: string) => {
        const p = url.split("/");
        return { owner: p[3], repo: p[4] };
      },
      getTimeValue: () => 259200000,
    }));
    jest.mock(userLimitUtilsPath, () => ({ getUserRoleAndTaskLimit: jest.fn().mockResolvedValue({ role: "contributor", limit: 2 }) }));
    jest.mock(assignmentPeriodsPath, () => ({ getAssignmentPeriods: jest.fn().mockResolvedValue({}) }));

    const issue = db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;
    const context = (await createContext(issue, sender, "/start")) as Context & { installOctokit: Context["octokit"] };
    const patchedOctokit = Object.create(context.octokit) as typeof context.octokit;
    (patchedOctokit as { graphql: jest.Mock }).graphql = graphqlFn;
    context.octokit = patchedOctokit;

    const { handleTaskLimitChecks: fn } = await import(checkAssignmentsPath);
    const result = await fn({ context, logger: context.logger, sender: "alice", username: "alice" });

    expect(result.isWithinLimit).toBe(false);
    expect(result.isReviewerLagged).toBe(false);
  });

  it("enforces the task limit when there are no pending PRs to check", async () => {
    jest.mock(issueUtilsPath, () => ({
      getPendingOpenedPullRequests: jest.fn().mockResolvedValue([]),
      getAssignedIssues: jest.fn().mockResolvedValue(OVER_LIMIT_ASSIGNED),
      getOwnerRepoFromHtmlUrl: (url: string) => {
        const p = url.split("/");
        return { owner: p[3], repo: p[4] };
      },
      getTimeValue: () => 259200000,
    }));
    jest.mock(userLimitUtilsPath, () => ({ getUserRoleAndTaskLimit: jest.fn().mockResolvedValue({ role: "contributor", limit: 2 }) }));
    jest.mock(assignmentPeriodsPath, () => ({ getAssignmentPeriods: jest.fn().mockResolvedValue({}) }));

    const issue = db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;
    const context = (await createContext(issue, sender, "/start")) as Context & { installOctokit: Context["octokit"] };

    const { handleTaskLimitChecks: fn } = await import(checkAssignmentsPath);
    const result = await fn({ context, logger: context.logger, sender: "alice", username: "alice" });

    // abs(3 - 0) = 3 >= 2 → over limit; no PRs to check → no bypass
    expect(result.isWithinLimit).toBe(false);
    expect(result.isReviewerLagged).toBe(false);
  });
});
