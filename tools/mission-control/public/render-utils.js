(function (root) {
  function safeText(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return String(value);
  }

  function statusClass(status) {
    const normalized = safeText(status);
    if (normalized === 'Running' || normalized === 'Succeeded') return 'running';
    if (['Pending', 'ContainerCreating'].includes(normalized) || normalized.startsWith('Init:')) return 'pending';
    return 'failed';
  }

  function badgeClass(status) {
    const normalized = safeText(status);
    if (normalized === 'Running' || normalized === 'Succeeded') return 'badge-running';
    if (['Pending', 'ContainerCreating'].includes(normalized) || normalized.startsWith('Init:')) return 'badge-pending';
    return 'badge-error';
  }

  function toSafeHttpUrl(value) {
    const normalized = safeText(value).trim();
    if (!normalized) return null;
    const candidate = normalized.includes('://') ? normalized : 'http://' + normalized;
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      if (!url.hostname) return null;
      if (url.username || url.password) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  function createCell(doc, tagName, className, text) {
    const cell = doc.createElement(tagName);
    if (className) cell.className = className;
    if (text !== null && text !== undefined) cell.textContent = safeText(text, '');
    return cell;
  }

  function buildPodRow(pod, timeAgoFn, onClick, doc = root.document) {
    const row = doc.createElement('tr');
    row.className = 'status-' + statusClass(pod && pod.status);

    const name = safeText(pod && pod.name);
    const status = safeText(pod && pod.status);
    const ready = safeText(pod && pod.ready);
    const restarts = safeText(pod && pod.restarts);
    const age = timeAgoFn ? timeAgoFn(pod && pod.age) : safeText(pod && pod.age);

    const linkCell = doc.createElement('td');
    const link = doc.createElement('a');
    link.className = 'pod-link';
    link.textContent = name;
    if (onClick) {
      link.addEventListener('click', () => onClick(name));
    }
    linkCell.appendChild(link);

    const statusCell = createCell(doc, 'td');
    const badge = createCell(doc, 'span', 'badge ' + badgeClass(status), status);
    statusCell.appendChild(badge);

    row.appendChild(linkCell);
    row.appendChild(statusCell);
    row.appendChild(createCell(doc, 'td', '', ready));
    row.appendChild(createCell(doc, 'td', '', restarts));
    row.appendChild(createCell(doc, 'td', '', age));
    return row;
  }

  function buildEventRow(event, timeAgoFn, doc = root.document) {
    const row = doc.createElement('div');
    row.className = 'event-row';

    const timestamp = timeAgoFn ? timeAgoFn(event && event.lastTimestamp || event && event.metadata && event.metadata.creationTimestamp) : '';
    const type = safeText(event && event.type);
    const objectName = safeText(event && event.involvedObject && event.involvedObject.name);
    const message = safeText(event && event.message);

    row.appendChild(createCell(doc, 'span', 'event-time', timestamp));
    row.appendChild(createCell(doc, 'span', 'event-type ' + type, type));
    row.appendChild(createCell(doc, 'span', 'event-msg', objectName + ': ' + message));
    return row;
  }

  function buildDeploymentRow(deployment, doc = root.document) {
    const row = doc.createElement('div');
    row.className = 'deploy-row';

    const name = safeText(deployment && deployment.metadata && deployment.metadata.name);
    const desired = Number(deployment && deployment.spec && deployment.spec.replicas) || 0;
    const ready = Number(deployment && deployment.status && deployment.status.readyReplicas) || 0;
    const pct = desired > 0 ? (ready / desired * 100) : 0;
    const color = pct === 100 ? 'var(--green)' : pct > 0 ? 'var(--yellow)' : 'var(--red)';

    row.appendChild(createCell(doc, 'span', 'deploy-name', name));
    const bar = doc.createElement('div');
    bar.className = 'deploy-bar';
    const fill = doc.createElement('div');
    fill.className = 'deploy-fill';
    fill.style.width = pct + '%';
    fill.style.background = color;
    bar.appendChild(fill);
    row.appendChild(bar);
    const nums = doc.createElement('span');
    nums.className = 'deploy-nums';
    nums.style.color = color;
    nums.textContent = ready + '/' + desired;
    row.appendChild(nums);
    return row;
  }

  function buildPortalLink(service, doc = root.document) {
    const ingress = service && service.status && service.status.loadBalancer && service.status.loadBalancer.ingress && service.status.loadBalancer.ingress[0];
    const rawValue = ingress ? (ingress.ip || ingress.hostname || '') : '';
    const label = safeText(rawValue);

    const link = doc.createElement('a');
    link.className = 'value-link';
    if (label) {
      const href = toSafeHttpUrl(label);
      if (href) {
        link.setAttribute('href', href);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
      link.textContent = label + ' ↗';
    } else {
      link.textContent = 'Pending…';
    }
    return link;
  }

  const renderUtils = {
    safeText,
    toSafeHttpUrl,
    buildPodRow,
    buildEventRow,
    buildDeploymentRow,
    buildPortalLink,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = renderUtils;
  }
  root.MissionControlRender = renderUtils;
})(typeof window !== 'undefined' ? window : globalThis);
