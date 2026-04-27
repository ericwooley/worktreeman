export const DEFAULT_WORKTREEMAN_SETTINGS_BRANCH = "wtm-settings";
export const DEFAULT_WORKTREEMAN_MAIN_BRANCH = "main";
export const DEFAULT_PROJECT_MANAGEMENT_BRANCH = "wtm-project-management";
export const PROJECT_MANAGEMENT_REF = `refs/heads/${DEFAULT_PROJECT_MANAGEMENT_BRANCH}`;
export const WORKTREEMAN_NAMESPACE = "worktreeman";
export const PM2_PROCESS_PREFIX = "wtm:";
export const DEFAULT_GIT_AUTHOR_NAME = "worktreeman";
export const DEFAULT_GIT_AUTHOR_EMAIL = "worktreeman@example.com";
export const WORKTREE_META_DIR = ".worktree-meta";
export const LOGS_DIR = ".logs";
export const PROJECT_MANAGEMENT_BATCH_FILE = "batch.json";
export const PROJECT_MANAGEMENT_SCHEMA_VERSION = 1;
export const DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_ID = "project-outline";
export const DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE = "Project Outline";
export const DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TAG = "plan";
export const PROJECT_MANAGEMENT_DOCUMENT_STATUSES = ["backlog", "todo", "in-progress", "review_passed", "done", "reference"] as const;
export const DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_STATUS = "backlog";
export const DEFAULT_WORKTREE_BASE_DIR = ".";
export const WORKTREEMAN_BARE_DIR = ".bare";
export const WORKTREEMAN_GIT_FILE = ".git";
export const WORKTREEMAN_GIT_FILE_CONTENT = `gitdir: ./${WORKTREEMAN_BARE_DIR}\n`;

export enum Pm2ProcessStatus {
  Online = "online",
  Launching = "launching",
  Stopped = "stopped",
  Errored = "errored",
  Unknown = "unknown",
}
