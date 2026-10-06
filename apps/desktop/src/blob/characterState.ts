export type BlobMood = 'idle' | 'online' | 'thinking' | 'working' | 'tool_activity' | 'file_activity' | 'file_drop' | 'file_preparing' | 'file_ready' | 'file_sending' | 'file_error' | 'permission' | 'success' | 'error' | 'offline' | 'listening' | 'rate_limited' | 'sleeping'

export type FileReferenceStage = 'drop' | 'preparing' | 'ready' | 'sending' | 'error'

const protectedMoods = new Set<BlobMood>([
  'offline', 'permission', 'rate_limited', 'error',
])

/**
 * Local file-reference activity may replace a stale completed success while
 * the user is interacting, but cannot hide a safety, connection, rate-limit,
 * or provider failure state.
 */
export function moodWithFileReference(baseMood: BlobMood, stage?: FileReferenceStage): BlobMood {
  if (!stage || protectedMoods.has(baseMood)) return baseMood
  switch (stage) {
    case 'drop': return 'file_drop'
    case 'preparing': return 'file_preparing'
    case 'ready': return 'file_ready'
    case 'sending': return 'file_sending'
    case 'error': return 'file_error'
  }
}
