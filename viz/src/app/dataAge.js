// How old the generated map data is, shared by the toolbar badge and the pipeline warnings.
const MS_PER_DAY = 86400000

export const dataAgeDays = (generatedAt, now = Date.now()) =>
  Math.floor((now - new Date(generatedAt).getTime()) / MS_PER_DAY)

export function daysAgoLabel(days) {
  if (days <= 0) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}
