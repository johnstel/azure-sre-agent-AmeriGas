/**
 * Incident evidence timeline & scorecard rendering.
 *
 * Pure DOM-building functions (no fetch/network calls here — see app.js for
 * wiring) so they can be unit tested the same way public/render-utils.js is:
 * with a minimal fake DOM. All text is set via textContent (never
 * innerHTML) so pod names, log summaries, and any other operator/agent
 * supplied text can never execute as markup.
 */
(function (root) {
  const MILESTONE_LABELS = {
    activation: 'Scenario activated',
    impact_detected: 'First impact observed',
    investigation_started: 'Investigation started',
    evidence_collected: 'Evidence collected',
    root_cause_identified: 'Root cause identified',
    action_proposed: 'Action proposed',
    action_approved: 'Action approved',
    action_denied: 'Action denied',
    action_expired: 'Action expired',
    action_executed: 'Action executed',
    post_action_assertion: 'Post-action assertion',
    recovery: 'Recovery observed',
    final_state: 'Final state',
  };

  const FINAL_STATE_LABELS = {
    recovered: 'Recovered',
    partial_recovery: 'Partial recovery',
    failed: 'Failed',
    denied: 'Denied',
    expired: 'Expired',
    unresolved: 'Unresolved',
  };

  function safeText(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return String(value);
  }

  function milestoneLabel(type) {
    return MILESTONE_LABELS[type] || type;
  }

  function finalStateLabel(state) {
    if (!state) return 'In progress';
    return FINAL_STATE_LABELS[state] || state;
  }

  function finalStateClass(state) {
    if (!state) return 'incident-state-active';
    if (state === 'recovered') return 'incident-state-recovered';
    if (state === 'partial_recovery') return 'incident-state-partial';
    if (['failed', 'denied', 'expired'].includes(state)) return 'incident-state-failed';
    return 'incident-state-unknown';
  }

  /** Build a short, human-readable one-line description of a milestone's data payload. */
  function describeMilestone(milestone) {
    const data = milestone.data || {};
    switch (milestone.type) {
      case 'activation':
        return `${safeText(data.scenarioName, safeText(data.scenarioId, 'scenario'))} (${safeText(data.domain, 'domain unspecified')}) — impacted: ${safeText(data.impactedService, 'unspecified')}`;
      case 'impact_detected':
        return safeText(data.reason, 'impact observed');
      case 'investigation_started':
        return `first evidence tool: ${safeText(data.toolName, 'unknown')}`;
      case 'evidence_collected':
        return `${safeText(data.category, 'evidence')} via ${safeText(data.toolName, 'tool')}`;
      case 'root_cause_identified':
        return safeText(data.statement || data.latestStatement, 'root cause statement not provided');
      case 'action_proposed':
        return `${safeText(data.toolName)} (${safeText(data.runMode, 'run mode unspecified')})`;
      case 'action_approved':
        return `approved by ${safeText(data.approver, 'unknown approver')}`;
      case 'action_denied':
        return `denied by ${safeText(data.approver, 'unknown approver')}`;
      case 'action_expired':
        return `${safeText(data.toolName, 'action')} expired before approval/denial`;
      case 'action_executed':
        return `${safeText(data.toolName)} — ${data.success ? 'success' : 'failed'}`;
      case 'post_action_assertion':
        return `${data.passed ? 'passed' : 'FAILED'} — ${safeText(data.details, '')}`;
      case 'recovery':
        return safeText(data.reason, 'recovery observed');
      case 'final_state':
        return finalStateLabel(data.finalState);
      default:
        return '';
    }
  }

  function createRow(doc, className, children) {
    const row = doc.createElement('div');
    row.className = className;
    children.forEach((child) => { if (child) row.appendChild(child); });
    return row;
  }

  function createLabeledValue(doc, label, value, valueClass) {
    const wrap = doc.createElement('div');
    wrap.className = 'incident-metric';
    const labelEl = doc.createElement('span');
    labelEl.className = 'incident-metric-label';
    labelEl.textContent = label;
    const valueEl = doc.createElement('span');
    valueEl.className = valueClass ? `incident-metric-value ${valueClass}` : 'incident-metric-value';
    valueEl.textContent = safeText(value, '—');
    wrap.appendChild(labelEl);
    wrap.appendChild(valueEl);
    return wrap;
  }

  /** Build the audience-first summary scorecard for a redacted incident snapshot. */
  function buildScorecard(snapshot, doc = root.document) {
    const container = doc.createElement('div');
    container.className = 'incident-scorecard';

    const header = doc.createElement('div');
    header.className = 'incident-header';
    const title = doc.createElement('div');
    title.className = 'incident-title';
    title.textContent = `${safeText(snapshot.scenarioName, safeText(snapshot.scenarioId, 'Incident'))} — ${safeText(snapshot.correlationId)}`;
    const state = doc.createElement('span');
    state.className = `incident-state-badge ${finalStateClass(snapshot.finalState)}`;
    state.textContent = finalStateLabel(snapshot.finalState);
    header.appendChild(title);
    header.appendChild(state);
    container.appendChild(header);

    const rootCauseMilestone = (snapshot.milestones || []).find((m) => m.type === 'root_cause_identified');
    const rootCauseText = rootCauseMilestone
      ? safeText(rootCauseMilestone.data.statement || rootCauseMilestone.data.latestStatement)
      : 'Not yet identified in this run';

    const actionMilestone = [...(snapshot.milestones || [])].reverse().find((m) => m.type === 'action_proposed');
    const actionText = actionMilestone
      ? `${safeText(actionMilestone.data.toolName)} (${safeText(actionMilestone.data.runMode, 'run mode unspecified')})`
      : 'No action proposed in this run';

    const grid = createRow(doc, 'incident-metrics-grid', [
      createLabeledValue(doc, 'Impacted service', snapshot.impactedService),
      createLabeledValue(doc, 'Domain', snapshot.domain),
      createLabeledValue(doc, 'Root cause', rootCauseText),
      createLabeledValue(doc, 'Proposed action', actionText),
      createLabeledValue(doc, 'Time to detect', snapshot.metrics ? (snapshot.metrics.timeToDetect || 'Not observed in this run') : 'Not observed in this run'),
      createLabeledValue(doc, 'Time to root cause', snapshot.metrics ? (snapshot.metrics.timeToRootCause || 'Not observed in this run') : 'Not observed in this run'),
      createLabeledValue(doc, 'Time to recover', snapshot.metrics ? (snapshot.metrics.timeToRecover || 'Not observed in this run') : 'Not observed in this run'),
    ]);
    container.appendChild(grid);

    if (snapshot.relatedIds && snapshot.relatedIds.length > 0) {
      const related = doc.createElement('div');
      related.className = 'incident-related-ids';
      related.textContent = `Related ids: ${snapshot.relatedIds.join(', ')}`;
      container.appendChild(related);
    }

    const disclaimer = doc.createElement('div');
    disclaimer.className = 'incident-disclaimer';
    disclaimer.textContent = 'Only values measured from server timestamps in this run are shown. No human-benchmark or ROI figures are fabricated.';
    container.appendChild(disclaimer);

    return container;
  }

  /** Build the evidence-source usage summary (kubernetes/logs/metrics/traces/knowledge). */
  function buildEvidenceSummary(evidence, doc = root.document) {
    const container = doc.createElement('div');
    container.className = 'incident-evidence-summary';
    (evidence || []).forEach((entry) => {
      const chip = doc.createElement('span');
      const usedClass = entry.used ? 'evidence-used' : (entry.nativeAvailable ? 'evidence-unused' : 'evidence-unavailable');
      chip.className = `evidence-chip ${usedClass}`;
      const countSuffix = entry.used ? ` (${entry.count})` : '';
      chip.textContent = `${entry.category}${countSuffix}`;
      chip.title = entry.used
        ? `Used via: ${entry.toolNames.join(', ') || 'unknown tool'}`
        : (entry.nativeAvailable ? 'Available but not queried in this run' : entry.nativeDescription);
      container.appendChild(chip);
    });
    return container;
  }

  /** Build the chronological milestone timeline list. */
  function buildTimeline(milestones, doc = root.document) {
    const list = doc.createElement('div');
    list.className = 'incident-timeline-list';
    (milestones || []).forEach((milestone) => {
      const row = doc.createElement('div');
      row.className = `incident-timeline-row incident-type-${safeText(milestone.type, 'unknown')}`;

      const time = doc.createElement('span');
      time.className = 'incident-timeline-time';
      time.textContent = safeText(milestone.recordedAt);

      const label = doc.createElement('span');
      label.className = 'incident-timeline-label';
      label.textContent = milestoneLabel(milestone.type);

      const desc = doc.createElement('span');
      desc.className = 'incident-timeline-desc';
      desc.textContent = describeMilestone(milestone);

      row.appendChild(time);
      row.appendChild(label);
      row.appendChild(desc);
      list.appendChild(row);
    });
    return list;
  }

  /** Build safe (http/https, credential-free) links to native SRE Agent thread/analytics, when configured. */
  function buildLinks(links, doc = root.document, toSafeHttpUrl) {
    const container = doc.createElement('div');
    container.className = 'incident-links';
    const safe = typeof toSafeHttpUrl === 'function' ? toSafeHttpUrl : (v) => v;
    const entries = [
      ['SRE Agent thread', links && links.threadUrl],
      ['SRE Agent incident analytics', links && links.analyticsUrl],
    ];
    entries.forEach(([label, url]) => {
      const safeUrl = url ? safe(url) : null;
      if (!safeUrl) return;
      const link = doc.createElement('a');
      link.className = 'incident-link';
      link.setAttribute('href', safeUrl);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = `${label} ↗`;
      container.appendChild(link);
    });
    return container;
  }

  const incidentTimelineUI = {
    milestoneLabel,
    finalStateLabel,
    finalStateClass,
    describeMilestone,
    buildScorecard,
    buildEvidenceSummary,
    buildTimeline,
    buildLinks,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = incidentTimelineUI;
  }
  root.IncidentTimelineUI = incidentTimelineUI;
})(typeof window !== 'undefined' ? window : globalThis);
