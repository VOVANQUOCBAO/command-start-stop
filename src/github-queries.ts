export const QUERY_PULL_REQUEST_REVIEW_THREADS = /* GraphQL */ `
  query pullRequestReviewThreads($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviewThreads(first: 100) {
          nodes {
            isResolved
            comments(last: 1) {
              nodes {
                author {
                  login
                }
                updatedAt
              }
            }
          }
        }
      }
    }
  }
`;

export const QUERY_OPEN_LINKED_PULL_REQUESTS_FOR_ISSUE = /* GraphQL */ `
  query openLinkedPullRequestsForIssue($owner: String!, $repo: String!, $issue_number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issue_number) {
        closedByPullRequestsReferences(first: 100, after: $cursor, includeClosedPrs: false) {
          nodes {
            number
            url
            author {
              login
            }
            repository {
              name
              owner {
                login
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;
