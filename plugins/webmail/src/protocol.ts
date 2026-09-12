/**
 * Connection status vocabulary shared by the server entry and the browser view.
 *
 * The server reports `status` as free text inside its `state` payload, and the
 * view decides whether to colour that chip red by prefix-matching it. That makes
 * the prefix a protocol value rather than prose, so both sides read it from here
 * instead of each keeping their own copy of the string.
 */

/** Reported until an IMAP account has been configured. */
export const STATUS_UNCONFIGURED = "Not configured";

/** Reported after a successful IMAP connection or poll. */
export const STATUS_CONNECTED = "Connected";

/** Prefix of the status reported when a connection or poll fails. */
export const STATUS_FAILED_PREFIX = "Connection failed";

/** Build the failure status for a reason. */
export function failedStatus(reason: string): string {
	return `${STATUS_FAILED_PREFIX}: ${reason}`;
}
