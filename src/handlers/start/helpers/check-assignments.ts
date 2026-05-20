import { QUERY_PULL_REQUEST_REVIEW_THREADS } from "../../../github-queries";
import { Context } from "../../../types/context";
import { getAssignmentPeriods } from "../../../utils/get-assignment-periods";
import { getUserRoleAndTaskLimit } from "../../../utils/get-user-task-limit-and-role";
import { getAssignedIssues, getOwnerRepoFromHtmlUrl, getPendingOpenedPullRequests, getTimeValue } from "../../../utils/issue";
import { ERROR_MESSAGES } from "./error-messages";

interface ReviewThreadComment {
  author: { login: string } | null;
  updatedAt: string;
}

interface ReviewThreadNode {
  isResolved: boolean;
  comments: { nodes: ReviewThreadComment[] };
}

interface PullRequestReviewThreadsResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: ReviewThreadNode[];
      };
    } | null;
  } | null;
}

async function hasUserBeenUnassigned(context: Context, username: string): Promise<boolean> {
  if ("issue" in context.payload) {
    const { number, html_url } = context.payload.issue;
    const { owner, repo } = getOwnerRepoFromHtmlUrl(html_url);
    const assignmentPeriods = await getAssignmentPeriods(context.octokit, { owner, repo, issue_number: number });
    return assignmentPeriods[username]?.some((period) => period.reason === "bot" || period.reason === "admin");
  }

  return false;
}

async function isPrReviewerLagged(
  context: Context,
  username: string,
  prOwner: string,
  prRepo: string,
  prNumber: number,
  toleranceMs: number
): Promise<boolean> {
  try {
    const result = await context.octokit.graphql<PullRequestReviewThreadsResult>(QUERY_PULL_REQUEST_REVIEW_THREADS, {
      owner: prOwner,
      repo: prRepo,
      prNumber,
    });

    const threads = result?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!threads?.length) return false;

    const unresolvedThreads = threads.filter((t) => !t.isResolved);
    if (!unresolvedThreads.length) return false;

    const now = Date.now();
    return unresolvedThreads.every((thread) => {
      const lastComment = thread.comments.nodes[thread.comments.nodes.length - 1];
      if (!lastComment) return false;
      if (lastComment.author?.login?.toLowerCase() !== username.toLowerCase()) return false;
      return now - new Date(lastComment.updatedAt).getTime() >= toleranceMs;
    });
  } catch {
    return false;
  }
}

export async function isUserReviewerLagged(
  context: Context,
  username: string,
  pendingPullRequests: Array<{ html_url: string; number: number }>,
  reviewDelayTolerance: string
): Promise<boolean> {
  if (!pendingPullRequests.length) return false;

  const toleranceMs = getTimeValue(reviewDelayTolerance);

  for (const pr of pendingPullRequests) {
    const { owner, repo } = getOwnerRepoFromHtmlUrl(pr.html_url);
    const isLagged = await isPrReviewerLagged(context, username, owner, repo, pr.number, toleranceMs);
    if (!isLagged) return false;
  }

  return true;
}

export async function handleTaskLimitChecks({
  context,
  logger,
  sender,
  username,
  roleAndLimit,
}: {
  username: string;
  context: Context & { installOctokit: Context["octokit"] };
  logger: Context["logger"];
  sender: string;
  roleAndLimit?: { role: string; limit: number };
}) {
  const openedPullRequests = (await getPendingOpenedPullRequests(context, username)) || [];
  const assignedIssues = (await getAssignedIssues(context, username)) || [];

  const { limit, role } = roleAndLimit || (await getUserRoleAndTaskLimit(context, username));

  const isWithinLimit = Math.abs(assignedIssues.length - openedPullRequests.length) < limit;

  // Check for unassignment first - this should take precedence over task limit
  if (await hasUserBeenUnassigned(context, username)) {
    logger.warn(ERROR_MESSAGES.UNASSIGNED.replace("{{username}}", username), { username });
    return {
      isUnassigned: true,
      isWithinLimit,
      assignedIssues,
      openedPullRequests,
      role,
      isReviewerLagged: false,
    };
  }

  // check for max and enforce max
  if (!isWithinLimit) {
    const isLagged = await isUserReviewerLagged(context, username, openedPullRequests, context.config.reviewDelayTolerance);
    if (isLagged) {
      logger.info("User's pending PRs are all reviewer-lagged, bypassing task limit.", { username });
      return {
        isUnassigned: false,
        isWithinLimit: true,
        assignedIssues,
        openedPullRequests,
        role,
        isReviewerLagged: true,
      };
    }
    const errorMessage = username === sender ? ERROR_MESSAGES.MAX_TASK_LIMIT_PREFIX : `${username} ${ERROR_MESSAGES.MAX_TASK_LIMIT_TEAMMATE_PREFIX}`;
    logger.warn(errorMessage, {
      assignedIssues: assignedIssues.length,
      openedPullRequests: openedPullRequests.length,
      limit,
    });
  }

  return {
    isUnassigned: false,
    isWithinLimit,
    assignedIssues,
    openedPullRequests,
    role,
    isReviewerLagged: false,
  };
}
