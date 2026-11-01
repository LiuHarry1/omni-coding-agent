/** One policy shared by Skill upload, marketplace install and Cloud copying. */
export const SKILL_PACKAGE_POLICY = {
  maxFiles: 1_000,
  maxDirectories: 1_000,
  maxSingleFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
} as const

/** Compressed transfer cap; extracted content is governed by the policy above. */
export const SKILL_ARCHIVE_DOWNLOAD_LIMIT = 10 * 1024 * 1024
