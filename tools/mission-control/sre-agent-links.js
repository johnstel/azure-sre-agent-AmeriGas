/**
 * Safe, credential-free link helpers for the incident evidence timeline.
 *
 * Mission Control must never embed credentials in a link, and must never
 * fabricate a link to a native SRE Agent thread or incident-analytics view
 * that doesn't actually exist. Both links are opt-in via environment
 * variables; if unset or invalid, the corresponding link is simply absent
 * (the UI hides it) rather than pointing at a guessed or generic URL.
 */

/** Validate and normalize a URL: must be http(s), no embedded userinfo. */
function toSafeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Read SRE Agent thread/analytics links from environment configuration.
 * Both are optional; each is independently validated and only returned when
 * safe. No default/fallback URL is ever synthesized.
 */
function getSreAgentLinks(env = process.env) {
  return {
    threadUrl: toSafeHttpUrl(env.MISSION_CONTROL_SRE_AGENT_THREAD_URL),
    analyticsUrl: toSafeHttpUrl(env.MISSION_CONTROL_SRE_AGENT_ANALYTICS_URL),
  };
}

module.exports = { toSafeHttpUrl, getSreAgentLinks };
