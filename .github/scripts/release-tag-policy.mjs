const RELEASE_TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/u;

function assertSafeComponent(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  }
  return parsed;
}

export function parseReleaseTag(tag) {
  if (typeof tag !== "string") throw new TypeError("Release tag must be a string");
  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error(
      `Unsupported release tag ${JSON.stringify(tag)}; expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-beta.N`,
    );
  }

  const major = assertSafeComponent(match[1], "major version");
  const minor = assertSafeComponent(match[2], "minor version");
  const patch = assertSafeComponent(match[3], "patch version");
  const beta = match[4] === undefined ? undefined : assertSafeComponent(match[4], "beta number");
  return Object.freeze({
    tag,
    version: tag.slice(1),
    major,
    minor,
    patch,
    beta,
    isBeta: beta !== undefined,
    series: `${major}.${minor}`,
  });
}

export async function assertVerifiedReleaseTag({ github, owner, repo, tag, expectedCommit }) {
  parseReleaseTag(tag);
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
    throw new Error(`Expected release commit must be a full SHA, found ${expectedCommit}`);
  }

  const expectedRef = `refs/tags/${tag}`;
  const { data: ref } = await github.rest.git.getRef({
    owner,
    repo,
    ref: `tags/${tag}`,
  });
  if (ref.ref !== expectedRef) {
    throw new Error(`GitHub returned ${ref.ref} while verifying ${expectedRef}`);
  }
  if (ref.object.type !== "tag") {
    throw new Error(`Release tag ${tag} must be an annotated tag object`);
  }

  const { data: annotatedTag } = await github.rest.git.getTag({
    owner,
    repo,
    tag_sha: ref.object.sha,
  });
  if (annotatedTag.tag !== tag) {
    throw new Error(`Annotated tag identity ${annotatedTag.tag} does not match ${tag}`);
  }
  if (annotatedTag.object.type !== "commit" || annotatedTag.object.sha !== expectedCommit) {
    throw new Error(`Annotated tag ${tag} does not target checked-out commit ${expectedCommit}`);
  }
  if (annotatedTag.verification?.verified !== true) {
    throw new Error(
      `Annotated tag ${tag} does not have a GitHub-verified signature: ${annotatedTag.verification?.reason ?? "missing verification"}`,
    );
  }
  return annotatedTag;
}
