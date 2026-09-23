const defaultTimestamp = () => ({
  time: '00:00:00',
  category: '',
  category_id: null,
  title: '',
});

function normalizeTranscript(transcript = {}) {
  const timestamps =
    Array.isArray(transcript.timestamps) && transcript.timestamps.length > 0
      ? transcript.timestamps.map((ts) => ({ ...defaultTimestamp(), ...ts }))
      : [defaultTimestamp()];

  const first = timestamps[0] || defaultTimestamp();
  first.time = first.time || '00:00:00';

  if (transcript.title && !first.title) first.title = transcript.title;
  if (transcript.category && !first.category)
    first.category = transcript.category;
  if (transcript.category_id != null && first.category_id == null)
    first.category_id = transcript.category_id;

  if (!first.category && transcript.category)
    first.category = transcript.category;
  if (!first.category_id && transcript.category_id != null)
    first.category_id = transcript.category_id;
  if (!first.title && transcript.title) first.title = transcript.title;

  return {
    timestamps,
  };
}

// A transcript is incomplete (and must not be streamed) if any timestamp has no category —
// mirrors backend/utils/transcript.js#transcriptNeedsCategory.
function videoNeedsCategory(transcript) {
  const timestamps = transcript?.timestamps;
  if (!Array.isArray(timestamps) || timestamps.length === 0) return true;
  return timestamps.some((ts) => !ts?.category || !String(ts.category).trim());
}

export { defaultTimestamp, normalizeTranscript, videoNeedsCategory };
