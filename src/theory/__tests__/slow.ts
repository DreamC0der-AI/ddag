/**
 * Timeouts for the exhaustive explorations. They are sized for a developer
 * machine; a slower runner (CI) multiplies them with DDAG_TEST_TIMEOUT_SCALE
 * instead of failing a proof for being slow.
 */
export const slow = (ms: number): number => ms * Math.max(1, Number(process.env['DDAG_TEST_TIMEOUT_SCALE'] ?? 1) || 1)
