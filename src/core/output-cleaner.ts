/**
 * Output cleaner — strip agent boot/context banner noise from raw chunk
 * streams so downstream consumers (DAG step output, fanout results,
 * async-executor run records, acp_spawn one-shot) receive only the
 * assistant's actual response.
 *
 * Known banner markers (pi agent emits these before the real answer):
 *   - `MCP: N servers connected (N tools)`
 *   - `hindsight:...recall...` status lines
 *
 * Algorithm: find the LAST occurrence of any known marker, return everything
 * after it (trimmed). If no markers found, return text as-is. If stripping
 * would yield empty, return original.
 */

const BANNER_MARKERS = [
	/MCP:\s*\d+\s+servers?\s+connected\s*\(\d+\s+tools?\)/,
	/hindsight:.*recall/i,
];

/**
 * Strip agent boot banner from the beginning of raw agent output.
 * Returns the cleaned text (only the assistant's actual response).
 */
export function stripAgentBootBanner(rawText: string): string {
	if (!rawText) return rawText;

	let lastMarkerEnd = -1;
	for (const pattern of BANNER_MARKERS) {
		const match = rawText.match(pattern);
		if (match && match.index !== undefined) {
			const markerEnd = match.index + match[0].length;
			if (markerEnd > lastMarkerEnd) {
				lastMarkerEnd = markerEnd;
			}
		}
	}

	if (lastMarkerEnd < 0) {
		// No markers found — return as-is.
		return rawText;
	}

	const cleaned = rawText.slice(lastMarkerEnd).trim();
	if (!cleaned) {
		// Stripping would yield empty — return original to avoid data loss.
		return rawText;
	}

	return cleaned;
}
