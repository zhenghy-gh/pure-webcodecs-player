/**
 * Select the preferred track of a media type, falling back to the first one.
 * Matroska demuxers expose the native FlagDefault spelling as flagDefault;
 * other containers use the canonical default property.
 * @param {Array<object>} tracks
 * @param {'video'|'audio'|'text'} type
 * @param {number|null} [preferredId] Previously or explicitly selected track.
 * @returns {object|undefined}
 */
export function defaultTrackForType(tracks, type, preferredId = null) {
  const matching = (Array.isArray(tracks) ? tracks : []).filter((track) => track?.type === type);
  return (preferredId == null ? undefined : matching.find((track) => track.id === preferredId))
    ?? matching.find((track) => track.default === true || track.flagDefault === true)
    ?? matching[0];
}
