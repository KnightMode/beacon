export interface RepoRef {
  fullName: string;
  owner: string;
  name: string;
  id: string;
}

const REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function repoIdFor(fullName: string): string {
  return fullName.trim().toLowerCase();
}

export function isValidRepoFullName(fullName: string): boolean {
  return REPO_FULL_NAME.test(fullName.trim());
}

export function parseRepoRef(fullName: string): RepoRef | null {
  const normalized = fullName.trim();
  if (!isValidRepoFullName(normalized)) return null;
  const [owner, name] = normalized.split('/');
  if (!owner || !name) return null;
  return {
    fullName: normalized,
    owner,
    name,
    id: repoIdFor(normalized),
  };
}
